/**
 * Running the load.
 *
 * Dry run by default. `--execute` is the only thing that writes catalog data,
 * matching how `preflight --apply` works: a stage that can destroy a project's
 * catalog should not be the default behaviour of typing a command.
 *
 * Three design decisions that the Import API's semantics force:
 *
 * 1. **Containers are created once, by resource type**, and reused across runs.
 *    A container already existing is the normal case, not an error.
 *
 * 2. **Stages are pushed in dependency order but not awaited to completion.**
 *    An Import Operation whose KeyReference is missing goes `unresolved` and
 *    resolves itself when the target arrives, any time inside 48 hours — so
 *    polling each stage to completion before starting the next serialises a
 *    design that is meant to pipeline. The docs also warn that frequent polling
 *    of the summary endpoint actively slows the import.
 *
 * 3. **Only `rejected` is worth resubmitting.** Other states are retried
 *    internally, up to five times. `unresolved` must be left alone. Because
 *    every key is deterministic, resubmitting is just running `load` again.
 */

import type { ImportSummary, OperationStates } from '@commercetools/importapi-sdk';

import type { Clients } from '../client/factory.js';
import type { PipelineConfig } from '../model/config.js';
import { platformStages, type LoadStage, type MigrationPlan } from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import { planBatches, summarise, type Batch, type LoadBatches } from './batches.js';

export interface LoadOptions {
  /** False — the default — sends nothing. */
  execute?: boolean;
  /** Poll Import Summaries until nothing is processing. Costs throughput. */
  wait?: boolean;
  /** In-flight Import Requests. */
  concurrency?: number;
  /** Ceiling on --wait, in milliseconds. */
  waitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** What the platform stages did, or would do on a dry run. */
export interface PrerequisiteOutcome {
  stage: 'channel' | 'customer-group' | 'store';
  /** Already in the project, so untouched. */
  existing: string[];
  /** Created by this run, or that would be on `--execute`. */
  created: string[];
  /** Present but not usable as planned — reported, never mutated. */
  unusable: { key: string; reason: string }[];
  /**
   * Planned, but the read that would say whether they exist failed. Only a dry
   * run gets here: on `--execute` a failed read is an error and the load stops.
   */
  unknown?: string[];
  /** Attempted and refused by the API. */
  failed?: string[];
  /**
   * Missing, and deliberately not created: another prerequisite stage could
   * not be read, so this run stops before importing and creating these would
   * leave resources behind from a load that did nothing.
   */
  deferred?: string[];
}

export interface StageOutcome {
  stage: LoadStage;
  containers: string[];
  requests: number;
  resources: number;
  /** Requests the API accepted. */
  accepted: number;
  /** Requests that failed outright, with the resource keys they carried. */
  failed: { containerKey: string; resourceKeys: string[]; message: string }[];
}

export interface LoadResult {
  executed: boolean;
  /** The platform-API stages, which run before anything is imported. */
  prerequisites: PrerequisiteOutcome[];
  batches: LoadBatches;
  stages: StageOutcome[];
  /** Per container, when a summary could be read. */
  summaries: { containerKey: string; summary: ImportSummary }[];
  diagnostics: Diagnostic[];
  waited: boolean;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

export async function runLoad(
  clients: Clients,
  plan: MigrationPlan,
  config: PipelineConfig,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const diagnostics: Diagnostic[] = [];
  const batches = planBatches(plan, config);

  for (const warning of batches.warnings) {
    diagnostics.push({ severity: 'warning', code: 'batching', message: warning });
  }

  // A store referencing product selections cannot be created until those
  // selections exist — and they are imported *asynchronously*, so without
  // waiting there is no moment at which the store stage is safe to run.
  // Refusing up front rather than half-loading: this is the last cheap place
  // to say so.
  const storesNeedingSelections = (plan.prerequisites?.stores ?? []).filter(
    (st) => st.productSelections.length > 0,
  );
  // Only when executing: a dry run writes nothing, so there is no selection
  // that could fail to resolve and nothing to protect.
  if (options.execute && storesNeedingSelections.length > 0 && options.wait !== true) {
    diagnostics.push({
      severity: 'error',
      code: 'stores-require-wait',
      message:
        `${storesNeedingSelections.length} store(s) reference product selections ` +
        `(${storesNeedingSelections.map((st) => st.key).join(', ')}), and selections are ` +
        'imported asynchronously. A store cannot be created pointing at a selection that ' +
        'does not exist yet, so the store stage has to run after those operations ' +
        'resolve.\n' +
        '      Re-run with --wait. Nothing was created and nothing was imported — this ' +
        'check needs only the plan, so it runs before the first write.',
    });
    return {
      executed: true,
      prerequisites: [],
      batches,
      stages: [],
      summaries: [],
      diagnostics,
      waited: false,
    };
  }


  // Platform stages first, on both paths: a dry run has to say what it would
  // create, and reading the project to find out costs only GETs.
  const prerequisites = await runPrerequisites(clients, plan, options, diagnostics);

  if (!options.execute) {
    // Stores are created last on the executed path, so the dry run has to ask
    // for them separately or it would report every stage but that one — and
    // `load-requests.json` is documented as what the run will do. Reading
    // costs GETs; the `--wait` requirement does not apply, because a dry run
    // creates nothing that could point at a missing selection.
    if (platformStages(plan.loadOrder, 'after').includes('store')) {
      const wantedStores = plan.prerequisites?.stores ?? [];
      if (wantedStores.length > 0) {
        prerequisites.push(await ensureStores(clients, wantedStores, options, diagnostics));
      }
    }

    // The dry run still reports per-stage totals, because the useful question
    // before a load is "how many requests, into which containers".
    return {
      executed: false,
      prerequisites,
      batches,
      stages: dryRunStages(batches),
      summaries: [],
      diagnostics,
      waited: false,
    };
  }

  // A prerequisite that is missing, unusable or unreadable stops the import
  // before it starts. Proceeding would import prices scoped to something that
  // does not exist, and those operations sit `unresolved` for 48 hours and
  // then expire — a run that reports every request accepted and leaves a
  // partly priced catalog, with no signal by the time anyone looks.
  //
  // Stopping costs nothing that a re-run does not recover: every key is
  // deterministic, so a second load updates rather than duplicates.
  const blocked = prerequisites.filter(
    (p) =>
      p.unusable.length > 0 ||
      (p.failed?.length ?? 0) > 0 ||
      (p.unknown?.length ?? 0) > 0 ||
      (p.deferred?.length ?? 0) > 0,
  );
  if (blocked.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'prerequisites-unmet',
      message:
        'Nothing was imported: ' +
        blocked
          .map((p) => {
            const keys = [
              ...p.unusable.map((u) => u.key),
              ...(p.failed ?? []),
              ...(p.unknown ?? []),
              ...(p.deferred ?? []),
            ];
            return `${p.stage} ${keys.join(', ')}`;
          })
          .join('; ') +
        '.\n' +
        '      Prices scoped to a channel or group the project does not hold become ' +
        'operations that expire unresolved after 48 hours, so the import is not worth ' +
        'starting. Resolve the above and re-run — keys are deterministic, so a re-run ' +
        'updates rather than duplicates.',
    });
    return {
      executed: true,
      prerequisites,
      batches,
      stages: [],
      summaries: [],
      diagnostics,
      waited: false,
    };
  }

  const stages: StageOutcome[] = [];

  for (const stage of plan.loadOrder) {
    const stageBatches = batches.batches.filter((b) => b.stage === stage);
    if (stageBatches.length === 0) continue;

    const containers = [...new Set(stageBatches.map((b) => b.containerKey))];
    for (const key of containers) {
      const container = batches.containers.find((c) => c.key === key)!;
      await ensureContainer(clients, key, container.resourceType, diagnostics);
    }

    const outcome = await pushStage(
      clients,
      stage,
      stageBatches,
      options.concurrency ?? DEFAULT_CONCURRENCY,
    );
    outcome.containers = containers;
    stages.push(outcome);

    for (const failure of outcome.failed) {
      diagnostics.push({
        severity: 'error',
        code: 'import-request-failed',
        message:
          `A ${stage} request into '${failure.containerKey}' was rejected: ` +
          `${failure.message}\n      Resources: ${failure.resourceKeys.join(', ')}`,
      });
    }
  }

  const waited = options.wait === true;
  const summaries = await readSummaries(
    clients,
    batches,
    diagnostics,
    waited,
    options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  );

  reportStates(summaries, diagnostics);

  // Last, and only now: every selection a store points at has either resolved
  // or been reported above.
  if (platformStages(plan.loadOrder, 'after').includes('store')) {
    const wanted = plan.prerequisites?.stores ?? [];
    if (wanted.length > 0) {
      prerequisites.push(await ensureStores(clients, wanted, options, diagnostics));
    }
  }

  return { executed: true, prerequisites, batches, stages, summaries, diagnostics, waited };
}

/**
 * Channels and customer groups, created if absent.
 *
 * Through the **platform API**: the Import API has no resource for either, so
 * none of the import machinery applies — no containers, no batching, no
 * operation states, and no asynchronous validation. A POST here succeeds or
 * fails synchronously.
 *
 * **Read first, then create only what is missing.** Posting blindly and
 * treating a duplicate as success would mean matching an error message to tell
 * "already exists" from "rejected", and matching error prose is exactly what
 * broke the container check once already. A key query answers it as a fact.
 *
 * Existing resources are never modified. A channel present but missing a role
 * the plan needs is reported, not patched: its roles also govern stores and
 * inventory, so widening them is a project decision rather than something a
 * catalog load should do on the way past.
 */
async function runPrerequisites(
  clients: Clients,
  plan: MigrationPlan,
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome[]> {
  const wanted = plan.prerequisites ?? { channels: [], customerGroups: [], stores: [] };
  const staged = new Set(platformStages(plan.loadOrder, 'before'));

  const doChannels = staged.has('channel') && wanted.channels.length > 0;
  const doGroups = staged.has('customer-group') && wanted.customerGroups.length > 0;

  // Every read first, then every create. Interleaving them meant a run doomed
  // by the *second* read had already created the first stage's resources — so
  // a load that imported nothing still left a channel behind, and the abort it
  // reported was only half true. Reads are GETs and cost nothing to front-load.
  const channelsFound = doChannels ? await readChannels(clients, wanted.channels) : undefined;
  const groupsFound = doGroups ? await readCustomerGroups(clients, wanted.customerGroups) : undefined;

  const out: PrerequisiteOutcome[] = [];
  const unreadable = [channelsFound, groupsFound].some((r) => r?.error !== undefined);

  if (doChannels) {
    out.push(
      await ensureChannels(
        clients,
        wanted.channels,
        channelsFound!,
        unreadable,
        options,
        diagnostics,
      ),
    );
  }
  if (doGroups) {
    out.push(
      await ensureCustomerGroups(
        clients,
        wanted.customerGroups,
        groupsFound!,
        unreadable,
        options,
        diagnostics,
      ),
    );
  }
  return out;
}

/** The outcome of one keyed read: what was found, or why it could not be. */
interface ReadResult<T> {
  found?: Map<string, T>;
  error?: unknown;
}

async function readChannels(
  clients: Clients,
  wanted: MigrationPlan['prerequisites']['channels'],
): Promise<ReadResult<{ roles?: string[] }>> {
  try {
    const res = await clients.platform
      .channels()
      .get({ queryArgs: { where: keysPredicate(wanted.map((c) => c.key)), limit: 500 } })
      .execute();
    return {
      found: new Map(
        res.body.results
          .filter((c) => c.key !== undefined)
          .map((c) => [c.key, c as { roles?: string[] }]),
      ),
    };
  } catch (err) {
    return { error: err };
  }
}

async function readCustomerGroups(
  clients: Clients,
  wanted: MigrationPlan['prerequisites']['customerGroups'],
): Promise<ReadResult<unknown>> {
  try {
    const res = await clients.platform
      .customerGroups()
      .get({ queryArgs: { where: keysPredicate(wanted.map((g) => g.key)), limit: 500 } })
      .execute();
    return {
      found: new Map(
        res.body.results
          .filter((g) => g.key !== undefined)
          .map((g) => [g.key as string, g as unknown]),
      ),
    };
  } catch (err) {
    return { error: err };
  }
}

/** `key in ("a","b")`, chunked — the same predicate shape `verify` uses. */
function keysPredicate(keys: string[]): string {
  return `key in (${keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',')})`;
}

async function ensureChannels(
  clients: Clients,
  wanted: MigrationPlan['prerequisites']['channels'],
  read: ReadResult<{ roles?: string[] }>,
  anyReadFailed: boolean,
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome> {
  const outcome: PrerequisiteOutcome = {
    stage: 'channel',
    existing: [],
    created: [],
    unusable: [],
  };

  if (read.error !== undefined) {
    // A dry run reads too — it is the only way it can name which channels it
    // would create rather than guessing. But a dry run sends no writes, so a
    // failed read costs it accuracy, not correctness: report it as a warning
    // and say plainly that the created/existing split is unknown.
    diagnostics.push({
      severity: options.execute ? 'error' : 'warning',
      code: 'prerequisite-read-failed',
      message:
        `Could not read channels: ${prerequisiteError(read.error)}\n` +
        '      Reading and creating channels both need manage_products (view_products is ' +
        'enough to read).' +
        (options.execute
          ? ' Without knowing what exists, creating would risk duplicates, so ' +
            'nothing was attempted.'
          : ` This dry run therefore cannot say which of the ${wanted.length} planned ` +
            'channel(s) already exist. Nothing was written either way.'),
    });
    outcome.unknown = wanted.map((c) => c.key);
    return outcome;
  }
  const found = read.found!;

  // Another stage could not be read, so this run will stop before importing.
  // Creating here anyway would leave resources behind from a load that did
  // nothing — report what would have happened and write nothing.
  if (anyReadFailed) {
    for (const channel of wanted) {
      if (found.has(channel.key)) outcome.existing.push(channel.key);
      else (outcome.deferred ??= []).push(channel.key);
    }
    return outcome;
  }

  for (const channel of wanted) {
    const existing = found.get(channel.key);
    if (existing) {
      outcome.existing.push(channel.key);
      const missingRoles = channel.roles.filter((r) => !(existing.roles ?? []).includes(r));
      if (missingRoles.length > 0) {
        outcome.unusable.push({
          key: channel.key,
          reason: `missing role(s) [${missingRoles.join(', ')}]`,
        });
        diagnostics.push({
          severity: 'error',
          code: 'channel-roles-insufficient',
          message:
            `Channel '${channel.key}' exists with roles ` +
            `[${(existing.roles ?? []).join(', ')}] and the plan needs ` +
            `[${channel.roles.join(', ')}]. Not modified: a channel's roles also govern ` +
            'stores and inventory, so widening them is a project decision, not something ' +
            'a catalog load should do in passing.\n' +
            '      Add the role in the project, or drop the channel from those prices. ' +
            'The API refuses a Standalone Price referencing a channel without ' +
            'ProductDistribution.',
        });
      }
      continue;
    }

    if (!options.execute) {
      outcome.created.push(channel.key);
      continue;
    }

    try {
      await clients.platform
        .channels()
        .post({
          body: {
            key: channel.key,
            roles: channel.roles as never,
            ...(channel.name ? { name: channel.name } : {}),
          },
        })
        .execute();
      outcome.created.push(channel.key);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'prerequisite-create-failed',
        message:
          `Could not create channel '${channel.key}': ${prerequisiteError(err)}\n` +
          '      Creating a channel needs manage_products. Prices scoped to it would sit ' +
          'unresolved for 48 hours and then expire, so nothing was imported.',
      });
      (outcome.failed ??= []).push(channel.key);
    }
  }

  return outcome;
}

/**
 * Stores, created if absent — and never modified if present.
 *
 * The platform API again, like channels and customer groups, but at the other
 * end of the run. A store's `productSelections` reference resources the Import
 * API creates asynchronously, so this cannot go first; `runLoad` refuses the
 * whole run without `--wait` rather than creating a store wired to a selection
 * that may never arrive.
 *
 * An existing store is left exactly as found, which is the same policy as an
 * existing channel and for a stronger reason: a store's channel and selection
 * lists decide what an entire storefront sells, and `setDistributionChannels`
 * or `setProductSelections` **replace** the whole array. Merging would mean
 * guessing which of the project's own settings this migration is entitled to
 * overwrite. Reporting the difference and letting a human decide is the only
 * defensible behaviour.
 */
async function ensureStores(
  clients: Clients,
  wanted: MigrationPlan['prerequisites']['stores'],
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome> {
  const outcome: PrerequisiteOutcome = {
    stage: 'store',
    existing: [],
    created: [],
    unusable: [],
  };

  let found: Map<string, { productSelections?: unknown[]; distributionChannels?: unknown[] }>;
  try {
    const res = await clients.platform
      .stores()
      .get({ queryArgs: { where: keysPredicate(wanted.map((st) => st.key)), limit: 500 } })
      .execute();
    found = new Map(
      res.body.results
        .filter((st) => st.key !== undefined)
        .map((st) => [st.key, st as { productSelections?: unknown[] }]),
    );
  } catch (err) {
    diagnostics.push({
      severity: options.execute ? 'error' : 'warning',
      code: 'prerequisite-read-failed',
      message:
        `Could not read stores: ${prerequisiteError(err)}\n` +
        '      Reading needs view_stores; creating needs manage_stores. Neither is ' +
        'granted by manage_products.' +
        (options.execute
          ? ' Nothing was attempted, because creating without knowing what exists risks ' +
            'duplicates.'
          : ` This dry run therefore cannot say which of the ${wanted.length} planned ` +
            'store(s) already exist.'),
    });
    outcome.unknown = wanted.map((st) => st.key);
    return outcome;
  }

  for (const store of wanted) {
    const existing = found.get(store.key);
    if (existing) {
      outcome.existing.push(store.key);
      // Not modified, but the difference is worth naming: a store that already
      // exists with different wiring is a store selling something other than
      // what this plan describes, and nothing downstream will notice.
      const currentSelections = (existing.productSelections ?? []).length;
      if (store.productSelections.length > 0 && currentSelections !== store.productSelections.length) {
        outcome.unusable.push({
          key: store.key,
          reason:
            `has ${currentSelections} product selection(s), the plan describes ` +
            `${store.productSelections.length}`,
        });
        diagnostics.push({
          severity: 'error',
          code: 'store-wiring-differs',
          message:
            `Store '${store.key}' already exists with ${currentSelections} product ` +
            `selection(s); this plan describes ${store.productSelections.length}. Not ` +
            'modified: `setProductSelections` replaces the whole array, so applying the ' +
            "plan would discard whatever the project's own setup put there — and a store's " +
            'selections decide what the storefront sells.\n' +
            '      Reconcile it deliberately, or drop the store from the feed and let ' +
            'whoever owns the storefront wire it.',
        });
      }
      continue;
    }

    if (!options.execute) {
      outcome.created.push(store.key);
      continue;
    }

    try {
      await clients.platform
        .stores()
        .post({
          body: {
            key: store.key,
            ...(store.name ? { name: store.name } : {}),
            ...(store.languages ? { languages: store.languages } : {}),
            ...(store.countries
              ? { countries: store.countries.map((code) => ({ code })) }
              : {}),
            distributionChannels: store.distributionChannels.map((key) => ({
              typeId: 'channel',
              key,
            })),
            supplyChannels: store.supplyChannels.map((key) => ({ typeId: 'channel', key })),
            productSelections: store.productSelections.map((sel) => ({
              productSelection: { typeId: 'product-selection', key: sel.key },
              active: sel.active,
            })),
          } as never,
        })
        .execute();
      outcome.created.push(store.key);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'prerequisite-create-failed',
        message:
          `Could not create store '${store.key}': ${prerequisiteError(err)}\n` +
          '      Creating one needs manage_stores. A likely cause is a product selection ' +
          'that has not finished importing: the store references it by key, and the ' +
          'reference has to resolve at creation time — unlike an Import API ' +
          'KeyReference, there is no 48-hour window here.',
      });
      (outcome.failed ??= []).push(store.key);
    }
  }

  return outcome;
}

async function ensureCustomerGroups(
  clients: Clients,
  wanted: MigrationPlan['prerequisites']['customerGroups'],
  read: ReadResult<unknown>,
  anyReadFailed: boolean,
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome> {
  const outcome: PrerequisiteOutcome = {
    stage: 'customer-group',
    existing: [],
    created: [],
    unusable: [],
  };

  if (read.error !== undefined) {
    diagnostics.push({
      severity: options.execute ? 'error' : 'warning',
      code: 'prerequisite-read-failed',
      message:
        `Could not read customer groups: ${prerequisiteError(read.error)}\n` +
        '      Reading needs view_customer_groups and creating needs ' +
        'manage_customer_groups — neither is granted by manage_products.' +
        (options.execute
          ? ' Nothing was attempted, because creating without knowing what exists ' +
            'risks duplicates.'
          : ` This dry run therefore cannot say which of the ${wanted.length} planned ` +
            'group(s) already exist. Nothing was written either way.'),
    });
    outcome.unknown = wanted.map((g) => g.key);
    return outcome;
  }
  const found = read.found!;

  if (anyReadFailed) {
    for (const group of wanted) {
      if (found.has(group.key)) outcome.existing.push(group.key);
      else (outcome.deferred ??= []).push(group.key);
    }
    return outcome;
  }

  for (const group of wanted) {
    if (found.has(group.key)) {
      outcome.existing.push(group.key);
      continue;
    }
    if (!options.execute) {
      outcome.created.push(group.key);
      continue;
    }
    try {
      // `groupName`, not `name`: CustomerGroupDraft spells it differently from
      // every other draft in this pipeline.
      await clients.platform
        .customerGroups()
        .post({ body: { key: group.key, groupName: group.name } })
        .execute();
      outcome.created.push(group.key);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'prerequisite-create-failed',
        message:
          `Could not create customer group '${group.key}': ${prerequisiteError(err)}\n` +
          '      Creating one needs manage_customer_groups, which manage_products does ' +
          'not grant. Nothing was imported.',
      });
      (outcome.failed ??= []).push(group.key);
    }
  }

  return outcome;
}

function dryRunStages(batches: LoadBatches): StageOutcome[] {
  const { byStage } = summarise(batches);
  return Object.entries(byStage).map(([stage, totals]) => ({
    stage: stage as LoadStage,
    containers: [
      ...new Set(
        batches.batches.filter((b) => b.stage === stage).map((b) => b.containerKey),
      ),
    ],
    requests: totals.requests,
    resources: totals.resources,
    accepted: 0,
    failed: [],
  }));
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * Creates a container, treating "already exists" as success.
 *
 * Containers are keyed by resource type and reused, so on every run after the
 * first the create fails with a conflict — which is the expected path, not an
 * error. Restricting `resourceType` makes the container reject a resource of
 * the wrong kind, which is a cheap guard against a batching mistake.
 */
async function ensureContainer(
  clients: Clients,
  key: string,
  resourceType: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  try {
    await clients.importApi
      .importContainers()
      .post({ body: { key, resourceType: resourceType as never } })
      .execute();
    return;
  } catch (err) {
    if (statusOf(err) === 409) return;

    // Anything else: establish whether the container is there rather than
    // guessing from the error. This used to match the message against
    // /[Dd]uplicate/, and the API actually answers `400 Import container key
    // already exists` with no structured code — so every run after the first
    // reported four errors for the one state this function exists to treat as
    // normal. A read answers the question as a fact; it costs one GET, and
    // only on the path that was already failing.
    if (await containerExists(clients, key)) return;

    diagnostics.push({
      severity: 'error',
      code: 'container-unavailable',
      message:
        `Could not create or reuse Import Container '${key}': ${describeError(err)}\n` +
        '      Creating containers needs manage_import_containers.',
    });
  }
}

async function containerExists(clients: Clients, key: string): Promise<boolean> {
  try {
    await clients.importApi
      .importContainers()
      .withImportContainerKeyValue({ importContainerKey: key })
      .get()
      .execute();
    return true;
  } catch {
    // Unreadable is not the same as absent — it could be a missing
    // view_import_containers scope — but either way the create failed and we
    // cannot confirm the container, so the original error stands.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

function poster(clients: Clients, batch: Batch) {
  const containerKey = batch.containerKey;
  switch (batch.stage) {
    case 'product-type':
      return clients.importApi
        .productTypes()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'category':
      return clients.importApi
        .categories()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'product-draft':
      return clients.importApi
        .productDrafts()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'variant':
      return clients.importApi
        .variants()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'standalone-price':
      return clients.importApi
        .standalonePrices()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'product-selection':
      return clients.importApi
        .productSelections()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'channel':
    case 'customer-group':
    case 'store':
      // Unreachable: `planBatches` only produces batches for Import API
      // stages, and these three are created through the platform API. Throwing
      // rather than returning undefined keeps the switch exhaustive, so adding
      // a stage is a compile error instead of a runtime one.
      throw new Error(
        `Stage '${batch.stage}' is created through the platform API and has no Import ` +
          'Request. This is a bug: it should never have been batched.',
      );
  }
}

/**
 * Pushes one stage's requests with bounded concurrency.
 *
 * A failed request is recorded with the keys it carried rather than aborting
 * the stage: one bad batch out of two thousand should not stop the other
 * 1,999, and the keys are what a targeted re-run needs.
 */
async function pushStage(
  clients: Clients,
  stage: LoadStage,
  batches: Batch[],
  concurrency: number,
): Promise<StageOutcome> {
  const outcome: StageOutcome = {
    stage,
    containers: [],
    requests: batches.length,
    resources: batches.reduce((n, b) => n + b.resourceKeys.length, 0),
    accepted: 0,
    failed: [],
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        await poster(clients, batch).execute();
        outcome.accepted++;
      } catch (err) {
        outcome.failed.push({
          containerKey: batch.containerKey,
          resourceKeys: batch.resourceKeys,
          message: describeError(err),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker),
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

async function readSummaries(
  clients: Clients,
  batches: LoadBatches,
  diagnostics: Diagnostic[],
  wait: boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<LoadResult['summaries']> {
  const out: LoadResult['summaries'] = [];

  for (const container of batches.containers) {
    let summary: ImportSummary | undefined;
    const deadline = Date.now() + timeoutMs;
    let delay = 2_000;

    for (;;) {
      try {
        summary = (
          await clients.importApi
            .importContainers()
            .withImportContainerKeyValue({ importContainerKey: container.key })
            .importSummaries()
            .get()
            .execute()
        ).body;
      } catch (err) {
        diagnostics.push({
          severity: 'warning',
          code: 'summary-unavailable',
          message:
            `Could not read the Import Summary for '${container.key}': ` +
            `${describeError(err)} The load may still be progressing.`,
        });
        break;
      }

      if (!wait || summary.states.processing === 0 || Date.now() > deadline) break;

      // Backing off rather than polling tightly: the docs are explicit that
      // frequent summary polling slows the import it is measuring.
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    if (summary) out.push({ containerKey: container.key, summary });
  }

  if (wait) {
    const stillProcessing = out.filter((s) => s.summary.states.processing > 0);
    if (stillProcessing.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'wait-timed-out',
        message:
          `Stopped waiting with ${stillProcessing.length} container(s) still processing. ` +
          'The import continues server-side; re-read the summaries later.',
      });
    }
  }

  return out;
}

/**
 * Turns operation states into findings.
 *
 * The distinction that matters: `unresolved` is not a failure. It means a
 * KeyReference target has not arrived yet, and the operation will complete on
 * its own if it does within 48 hours. `rejected` and `validationFailed` are
 * real failures.
 */
function reportStates(
  summaries: LoadResult['summaries'],
  diagnostics: Diagnostic[],
): void {
  const total = summaries.reduce<OperationStates>(
    (acc, s) => ({
      processing: acc.processing + s.summary.states.processing,
      validationFailed: acc.validationFailed + s.summary.states.validationFailed,
      unresolved: acc.unresolved + s.summary.states.unresolved,
      waitForMasterVariant:
        acc.waitForMasterVariant + s.summary.states.waitForMasterVariant,
      imported: acc.imported + s.summary.states.imported,
      rejected: acc.rejected + s.summary.states.rejected,
      canceled: acc.canceled + s.summary.states.canceled,
      partiallyImported: acc.partiallyImported + s.summary.states.partiallyImported,
    }),
    {
      processing: 0,
      validationFailed: 0,
      unresolved: 0,
      waitForMasterVariant: 0,
      imported: 0,
      rejected: 0,
      canceled: 0,
      partiallyImported: 0,
    },
  );

  if (total.rejected > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'operations-rejected',
      message:
        `${total.rejected} operation(s) were rejected. This is the only state worth ` +
        'resubmitting: every other failing state is retried internally. Because keys are ' +
        'deterministic, resubmitting means running `load --execute` again once the cause ' +
        'is fixed.',
    });
  }

  if (total.validationFailed > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'operations-validation-failed',
      message:
        `${total.validationFailed} operation(s) failed validation. Read the errors on the ` +
        'Import Operations — the audit gate should have caught anything structural, so ' +
        'these are worth feeding back into it as a new check.\n' +
        '      Note these counts are per container and cumulative: operations are retained ' +
        '48 hours, so a failure from an earlier run is still counted after a later run ' +
        'fixed it. Compare the operations\' resource keys and timestamps against this run ' +
        'before treating them as new — `verify` is what will reconcile this properly.',
    });
  }

  if (total.partiallyImported > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'operations-partially-imported',
      message:
        `${total.partiallyImported} operation(s) imported only partially, so those ` +
        'resources are in a half-written state. Inspect them before treating the load as ' +
        'complete.',
    });
  }

  if (total.unresolved > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'operations-unresolved',
      message:
        `${total.unresolved} operation(s) are unresolved, waiting for a KeyReference ` +
        'target. This is not a failure: they complete automatically if the target arrives ' +
        'within 48 hours of the operation being created. If they expire instead, something ' +
        'the plan referenced was never imported.',
    });
  }

  if (total.waitForMasterVariant > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'operations-wait-for-master-variant',
      message:
        `${total.waitForMasterVariant} operation(s) are waiting for a master variant. ` +
        'A product cannot exist without one, so these resolve when the master variant ' +
        'import lands.',
    });
  }

  if (total.processing > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'operations-processing',
      message:
        `${total.processing} operation(s) are still processing. The import is ` +
        'asynchronous — re-read the summaries, or use --wait.',
    });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status;
}

function messageOf(err: unknown): string {
  return (err as { message?: string }).message ?? String(err);
}

/**
 * Errors from the platform stages. Deliberately not `describeError`: that one
 * names the Import API's scopes, and every prerequisite diagnostic already
 * states the scope it actually needs. Appending both taught the reader to look
 * for `manage_import_containers` when the missing scope was
 * `view_customer_groups` — the same mistake preflight made.
 */
function prerequisiteError(err: unknown): string {
  const status = statusOf(err);
  const message = messageOf(err);
  return status === undefined ? message : `${status}: ${message}`;
}

function describeError(err: unknown): string {
  const status = statusOf(err);
  const message = messageOf(err);
  if (status === 403) {
    return (
      `${message} — the API Client lacks a required scope. The load needs ` +
      'manage_import_containers, plus manage_products for the category, product-type ' +
      'and product-draft import requests. Standalone Prices need ' +
      'manage_standalone_prices, which manage_products does NOT grant — a client set up ' +
      'for an embedded-price load will fail on that stage alone.'
    );
  }
  if (status === 404) {
    return `${message} — the container may have expired; containers are deleted after their retention period.`;
  }
  return status === undefined ? message : `${status}: ${message}`;
}
