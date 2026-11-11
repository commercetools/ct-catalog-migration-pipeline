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

import type {
  ImportOperation,
  ImportOperationStatus,
  ImportSummary,
  OperationStates,
} from '@commercetools/importapi-sdk';

import type { Clients } from '../client/factory.js';
import type { PipelineConfig } from '../model/config.js';
import {
  platformStages,
  type LoadStage,
  type MigrationPlan,
  type PlannedTaxCategory,
} from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import { planBatches, summarise, type Batch, type LoadBatches } from './batches.js';
import { formatDuration, noProgress, type Activity, type Progress } from '../progress/progress.js';

export interface LoadOptions {
  /** False — the default — sends nothing. */
  execute?: boolean;
  /** Poll Import Summaries until nothing is processing. Costs throughput. */
  wait?: boolean;
  /** In-flight Import Requests. */
  concurrency?: number;
  /**
   * Run only these stages, in plan order, and touch nothing else: the platform
   * stages are skipped unless named, so a resend of one stage cannot create,
   * update or unpublish what an earlier stage left in the project.
   */
  only?: LoadStage[];
  /** Ceiling on --wait, in milliseconds. */
  waitTimeoutMs?: number;
  /** How long the first record of a customer or order stage may stay `processing`. */
  canaryTimeoutMs?: number;
  /** Reports on ticks where the load is, including what `--wait` is waiting for. */
  progress?: Progress;
  sleep?: (ms: number) => Promise<void>;
}

/** What the platform stages did, or would do on a dry run. */
export interface PrerequisiteOutcome {
  stage: 'channel' | 'customer-group' | 'tax-category' | 'store';
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
  /** Set when `--only` restricted the run: the stages it was allowed to run. */
  only?: LoadStage[];
  /** Order numbers the project already held, so they were not sent again. */
  skippedOrders?: string[];
  /** Set when the first record of a stage was refused, unresolved or unreadable. */
  canary?: CanaryOutcome;
}

/** What the one-record first request of a stage came back as. */
export interface CanaryOutcome {
  stage: LoadStage;
  /** The record that decided the verdict, or the first one when all agreed. */
  resourceKey: string;
  /** Every record of the first request. */
  resourceKeys: string[];
  /** The operation's state, or why it could not be read. */
  state: string;
  /** Whether the rest of the stage was sent. */
  proceeded: boolean;
  errors?: string[];
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CANARY_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

export async function runLoad(
  clients: Clients,
  plan: MigrationPlan,
  config: PipelineConfig,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const diagnostics: Diagnostic[] = [];
  const only = options.only;
  // Every stage decision below reads `scoped.loadOrder`, so `--only` narrows the
  // import stages and the platform stages with one filter.
  let scoped: MigrationPlan = only
    ? { ...plan, loadOrder: plan.loadOrder.filter((s) => only.includes(s)) }
    : plan;
  let batches = planBatches(scoped, config);
  const skippedOrders: string[] = [];
  // Marks what restricted or shortened the run on every result it returns.
  const tag = (r: LoadResult): LoadResult => ({
    ...r,
    ...(only ? { only } : {}),
    ...(skippedOrders.length > 0 ? { skippedOrders } : {}),
  });
  const progress = options.progress ?? noProgress;
  const activity = progress.activity('load');
  // Counters move as often as the work does; a tick prints them (see progress.ts).
  let live: { stage: string; number: number; of: number; outcome?: StageOutcome } | undefined;
  activity.status(() =>
    live?.outcome
      ? `pushing ${live.stage} (stage ${live.number}/${live.of}): ` +
        `${live.outcome.accepted + live.outcome.failed.length}/${live.outcome.requests} request(s), ` +
        `${live.outcome.resources.toLocaleString('en-US')} resource(s) in the stage`
      : live
        ? `preparing the import containers for ${live.stage} (stage ${live.number}/${live.of})`
        : 'checking and creating channels, customer groups and tax categories',
  );

  if (only) {
    const left = plan.loadOrder.filter((s) => !only.includes(s));
    diagnostics.push({
      severity: 'warning',
      code: 'only-stages',
      message:
        `--only ${only.join(',')}: ${left.length} stage(s) not run (${left.join(', ')}). ` +
        'This run assumes the project already holds what they create; read it back with `verify`.',
    });
  }

  // A store referencing product selections cannot be created until those
  // selections exist — and they are imported *asynchronously*, so without
  // waiting there is no moment at which the store stage is safe to run.
  // Refusing up front rather than half-loading: this is the last cheap place
  // to say so.
  const storesNeedingSelections = (plan.prerequisites?.stores ?? []).filter(
    (st) =>
      st.productSelections.length > 0 &&
      scoped.loadOrder.includes('store') &&
      scoped.loadOrder.includes('product-selection'),
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
    return tag({
      executed: true,
      prerequisites: [],
      batches,
      stages: [],
      summaries: [],
      diagnostics,
      waited: false,
    });
  }


  // Orders are create-only: a number the project holds is rejected, never
  // updated. Read which ones it holds before any write, so a resend sends only
  // what is missing and an unreadable project stops an `--execute` while
  // nothing has been created yet.
  const plannedOrders = scoped.loadOrder.includes('order') ? (plan.orders ?? []) : [];
  if (plannedOrders.length > 0) {
    const read = await readExistingOrderNumbers(
      clients,
      plannedOrders.map((o) => o.orderNumber),
    );
    if (read.found === undefined) {
      diagnostics.push({
        severity: options.execute ? 'error' : 'warning',
        code: 'orders-unreadable',
        message:
          `The orders the project already holds could not be read (${prerequisiteError(read.error)}). ` +
          (options.execute
            ? 'Nothing was created and nothing was imported: without that read, orders already ' +
              'there would be sent again and rejected. Fix the cause (the credentials need ' +
              'view_orders or manage_orders) and re-run.'
            : 'This dry run lists every planned order as new.'),
      });
      if (options.execute) {
        return tag({
          executed: true,
          prerequisites: [],
          batches,
          stages: [],
          summaries: [],
          diagnostics,
          waited: false,
        });
      }
    } else if (read.found.size > 0) {
      skippedOrders.push(...plannedOrders.map((o) => o.orderNumber).filter((n) => read.found!.has(n)));
      scoped = { ...scoped, orders: plannedOrders.filter((o) => !read.found!.has(o.orderNumber)) };
      batches = planBatches(scoped, config);
      diagnostics.push({
        severity: 'warning',
        code: 'orders-already-in-project',
        message:
          `${skippedOrders.length} of ${plannedOrders.length} order number(s) are already in the ` +
          'project and are not sent again (orders are create-only; a number the project holds ' +
          'is rejected). `verify` compares them with the plan.',
      });
    }
  }

  for (const warning of batches.warnings) {
    diagnostics.push({ severity: 'warning', code: 'batching', message: warning });
  }

  // Platform stages first, on both paths: a dry run has to say what it would
  // create, and reading the project to find out costs only GETs.
  const prerequisites = await runPrerequisites(clients, scoped, options, diagnostics);

  if (!options.execute) {
    // Stores are created last on the executed path, so the dry run has to ask
    // for them separately or it would report every stage but that one — and
    // `load-requests.json` is documented as what the run will do. Reading
    // costs GETs; the `--wait` requirement does not apply, because a dry run
    // creates nothing that could point at a missing selection.
    if (platformStages(scoped.loadOrder, 'after').includes('store')) {
      const wantedStores = plan.prerequisites?.stores ?? [];
      if (wantedStores.length > 0) {
        prerequisites.push(await ensureStores(clients, wantedStores, options, diagnostics));
      }
    }

    // The dry run still reports per-stage totals, because the useful question
    // before a load is "how many requests, into which containers".
    return tag({
      executed: false,
      prerequisites,
      batches,
      stages: dryRunStages(batches),
      summaries: [],
      diagnostics,
      waited: false,
    });
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
        '      A price or product referencing a channel, group or tax category the ' +
        'project does not hold becomes an operation that expires unresolved after 48 ' +
        'hours, so the import is not worth starting. Resolve the above and re-run — keys are deterministic, so a re-run ' +
        'updates rather than duplicates.',
    });
    return tag({
      executed: true,
      prerequisites,
      batches,
      stages: [],
      summaries: [],
      diagnostics,
      waited: false,
    });
  }

  const stages: StageOutcome[] = [];
  let canary: CanaryOutcome | undefined;
  const waited = options.wait === true;
  const expected = new Map<string, ExpectedOperations>();
  const stagesWithRequests = scoped.loadOrder.filter((s) => batches.batches.some((b) => b.stage === s));

  for (const stage of scoped.loadOrder) {
    const stageBatches = batches.batches.filter((b) => b.stage === stage);
    if (stageBatches.length === 0) continue;
    live = { stage, number: stagesWithRequests.indexOf(stage) + 1, of: stagesWithRequests.length };

    const containers = [...new Set(stageBatches.map((b) => b.containerKey))];
    for (const key of containers) {
      const container = batches.containers.find((c) => c.key === key)!;
      await ensureContainer(clients, key, container.resourceType, diagnostics);
      // Before anything is posted: the summary counts operations over 48 hours,
      // earlier runs included, so "registered" has to be measured from here.
      if (waited && !expected.has(key)) {
        expected.set(key, { baseline: await readSummaryTotal(clients, key), operations: 0 });
      }
    }

    const track = (o: StageOutcome) => {
      live!.outcome = o;
    };
    // The first request of a customer or order stage holds one record. Its result
    // is read before the rest goes out, so a shape the API refuses costs one
    // failed operation, not one per record.
    const canaryBatch = stageBatches[0].canary ? stageBatches[0] : undefined;
    const rest = canaryBatch ? stageBatches.slice(1) : stageBatches;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    let outcome: StageOutcome;
    let sent = stageBatches;
    let stopped = false;

    if (canaryBatch) {
      const statuses: ImportOperationStatus[] = [];
      const first = await pushStage(clients, stage, [canaryBatch], 1, track, progress, statuses);
      const verdict = await judgeCanary(
        clients,
        stage,
        canaryBatch,
        first,
        statuses,
        options.canaryTimeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS,
        options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      );
      canary = verdict.outcome;
      for (const d of verdict.diagnostics) diagnostics.push(d);
      if (verdict.outcome.proceeded && rest.length > 0) {
        const others = await pushStage(clients, stage, rest, concurrency, (o) => track(mergeOutcomes(first, o)), progress);
        outcome = mergeOutcomes(first, others);
      } else {
        outcome = { ...first, requests: stageBatches.length, resources: stageBatches.reduce((n, b) => n + b.resourceKeys.length, 0) };
      }
      if (!verdict.outcome.proceeded) {
        stopped = true;
        sent = [canaryBatch];
      }
    } else {
      outcome = await pushStage(clients, stage, stageBatches, concurrency, track, progress);
    }
    outcome.containers = containers;
    stages.push(outcome);

    if (waited) {
      for (const batch of sent) {
        expected.get(batch.containerKey)!.operations += batch.resourceKeys.length;
      }
      // A rejected request registers no operations, so it is not waited for.
      for (const failure of outcome.failed) {
        expected.get(failure.containerKey)!.operations -= failure.resourceKeys.length;
      }
    }

    for (const failure of outcome.failed) {
      diagnostics.push({
        severity: 'error',
        code: 'import-request-failed',
        message:
          `A ${stage} request into '${failure.containerKey}' was rejected: ` +
          `${failure.message}\n      Resources: ${failure.resourceKeys.join(', ')}`,
      });
    }
    if (stopped) break;
  }

  live = undefined;
  const summaries = await readSummaries(
    clients,
    batches,
    diagnostics,
    waited,
    expected,
    options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    progress,
    activity,
  );

  reportStates(summaries, diagnostics);
  await sampleOperationErrors(clients, summaries, diagnostics);

  // Last, and only now: every selection a store points at has either resolved
  // or been reported above.
  // Not after a stopped load: the stores belong to a load that completed.
  if (canary?.proceeded !== false && platformStages(scoped.loadOrder, 'after').includes('store')) {
    const wanted = plan.prerequisites?.stores ?? [];
    if (wanted.length > 0) {
      activity.status(() => 'creating the stores');
      prerequisites.push(await ensureStores(clients, wanted, options, diagnostics));
    }
  }

  return tag({
    executed: true,
    prerequisites,
    batches,
    stages,
    summaries,
    diagnostics,
    waited,
    ...(canary ? { canary } : {}),
  });
}

/**
 * Channels, customer groups and tax categories, created if absent.
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
 * catalog load should do on the way past. A tax category present with other
 * rates is left alone for the same reason and a stronger one — its rates also
 * tax shipping, and they belong to whoever owns tax.
 */
async function runPrerequisites(
  clients: Clients,
  plan: MigrationPlan,
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome[]> {
  const wanted = plan.prerequisites ?? { channels: [], customerGroups: [], stores: [] };
  const taxCategories = wanted.taxCategories ?? [];
  const staged = new Set(platformStages(plan.loadOrder, 'before'));

  const doChannels = staged.has('channel') && wanted.channels.length > 0;
  const doGroups = staged.has('customer-group') && wanted.customerGroups.length > 0;
  const doTax = staged.has('tax-category') && taxCategories.length > 0;

  // Every read first, then every create. Interleaving them meant a run doomed
  // by the *second* read had already created the first stage's resources — so
  // a load that imported nothing still left a channel behind, and the abort it
  // reported was only half true. Reads are GETs and cost nothing to front-load.
  const channelsFound = doChannels ? await readChannels(clients, wanted.channels) : undefined;
  const groupsFound = doGroups ? await readCustomerGroups(clients, wanted.customerGroups) : undefined;
  const taxFound = doTax ? await readTaxCategories(clients, taxCategories) : undefined;

  const out: PrerequisiteOutcome[] = [];
  const unreadable = [channelsFound, groupsFound, taxFound].some((r) => r?.error !== undefined);

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
  if (doTax) {
    out.push(
      await ensureTaxCategories(clients, taxCategories, taxFound!, unreadable, options, diagnostics),
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

async function readTaxCategories(
  clients: Clients,
  wanted: PlannedTaxCategory[],
): Promise<ReadResult<unknown>> {
  try {
    const res = await clients.platform
      .taxCategories()
      .get({ queryArgs: { where: keysPredicate(wanted.map((t) => t.key)), limit: 500 } })
      .execute();
    return {
      found: new Map(
        res.body.results
          .filter((t) => t.key !== undefined)
          .map((t) => [t.key as string, t as unknown]),
      ),
    };
  } catch (err) {
    return { error: err };
  }
}

/** Order numbers per read: keeps the `where` predicate well under URL limits. */
const ORDER_READ_CHUNK = 100;

/**
 * Which of these order numbers the project already holds. Orders are
 * create-only and have no key, so the number is the only way to ask.
 */
async function readExistingOrderNumbers(
  clients: Clients,
  numbers: string[],
): Promise<{ found?: Set<string>; error?: unknown }> {
  const found = new Set<string>();
  try {
    for (let i = 0; i < numbers.length; i += ORDER_READ_CHUNK) {
      const slice = numbers.slice(i, i + ORDER_READ_CHUNK);
      const res = await clients.platform
        .orders()
        .get({
          queryArgs: {
            where: `orderNumber in (${slice.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(',')})`,
            limit: slice.length,
            withTotal: false,
          },
        })
        .execute();
      for (const order of res.body.results) {
        if (order.orderNumber !== undefined) found.add(order.orderNumber);
      }
    }
    return { found };
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

/**
 * Tax categories, created with the plan's rates if absent.
 *
 * Present means untouched, rates included. That is the whole policy, and it is
 * the one a catalog load has to follow: a tax category also taxes shipping,
 * its rates are set by whoever owns tax, and `replaceTaxRate` on the way past
 * would change what every existing cart is charged. `preflight` names any
 * difference in advance; this only creates what is missing.
 *
 * The name has to be unique in the project as well as the key, so a create can
 * fail on a category this read did not find — one with the same name under
 * another key. The API refuses that one, and it is reported as a failed create
 * rather than guessed around.
 */
async function ensureTaxCategories(
  clients: Clients,
  wanted: PlannedTaxCategory[],
  read: ReadResult<unknown>,
  anyReadFailed: boolean,
  options: LoadOptions,
  diagnostics: Diagnostic[],
): Promise<PrerequisiteOutcome> {
  const outcome: PrerequisiteOutcome = {
    stage: 'tax-category',
    existing: [],
    created: [],
    unusable: [],
  };

  if (read.error !== undefined) {
    diagnostics.push({
      severity: options.execute ? 'error' : 'warning',
      code: 'prerequisite-read-failed',
      message:
        `Could not read tax categories: ${prerequisiteError(read.error)}\n` +
        '      Reading needs view_tax_categories and creating needs ' +
        'manage_tax_categories; manage_products also grants both, for backward ' +
        'compatibility.' +
        (options.execute
          ? ' Nothing was attempted, because creating without knowing what exists ' +
            'risks duplicates.'
          : ` This dry run therefore cannot say which of the ${wanted.length} planned ` +
            'tax category(ies) already exist. Nothing was written either way.'),
    });
    outcome.unknown = wanted.map((t) => t.key);
    return outcome;
  }
  const found = read.found!;

  if (anyReadFailed) {
    for (const category of wanted) {
      if (found.has(category.key)) outcome.existing.push(category.key);
      else (outcome.deferred ??= []).push(category.key);
    }
    return outcome;
  }

  for (const category of wanted) {
    if (found.has(category.key)) {
      outcome.existing.push(category.key);
      continue;
    }
    if (!options.execute) {
      outcome.created.push(category.key);
      continue;
    }
    try {
      await clients.platform
        .taxCategories()
        .post({
          body: {
            key: category.key,
            name: category.name,
            ...(category.description ? { description: category.description } : {}),
            rates: category.rates.map((r) => ({ ...r })),
          },
        })
        .execute();
      outcome.created.push(category.key);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'prerequisite-create-failed',
        message:
          `Could not create tax category '${category.key}': ${prerequisiteError(err)}\n` +
          '      Creating one needs manage_tax_categories (or manage_products). A likely ' +
          `cause is another tax category already named '${category.name}' — the name is ` +
          'unique per project, not only the key. Products referencing this category ' +
          'would sit unresolved for 48 hours and then expire, so nothing was imported.',
      });
      (outcome.failed ??= []).push(category.key);
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
    case 'inventory':
      return clients.importApi
        .inventories()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'order':
      return clients.importApi
        .orders()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'customer':
      return clients.importApi
        .customers()
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: containerKey })
        .post({ body: batch.body as never });
    case 'channel':
    case 'customer-group':
    case 'tax-category':
    case 'store':
      // Unreachable: `planBatches` only produces batches for Import API
      // stages, and these four are created through the platform API. Throwing
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
function mergeOutcomes(a: StageOutcome, b: StageOutcome): StageOutcome {
  return {
    stage: a.stage,
    containers: [],
    requests: a.requests + b.requests,
    resources: a.resources + b.resources,
    accepted: a.accepted + b.accepted,
    failed: [...a.failed, ...b.failed],
  };
}

/**
 * Reads the result of the one record a canary request carried, and says whether
 * the rest of the stage may go.
 *
 * `imported` goes. `unresolved` and `waitForMasterVariant` go too, with a
 * warning: the API took the record and is waiting for a reference that arrives on
 * its own, which is what a customer imported a moment ago looks like to an order.
 * `validationFailed`, `rejected`, `partiallyImported` and `canceled` stop the
 * stage, and so does a result that cannot be read, because sending the rest
 * without knowing is the thing the canary exists to prevent. `processing` is
 * waited out, with a ceiling.
 */
async function judgeCanary(
  clients: Clients,
  stage: LoadStage,
  batch: Batch,
  pushed: StageOutcome,
  statuses: ImportOperationStatus[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ outcome: CanaryOutcome; diagnostics: Diagnostic[] }> {
  const keys = batch.resourceKeys;
  // One record is "the first record"; several are one request that together shows
  // every structure of the stage (see pickCanary).
  const named = (key: string) =>
    keys.length === 1
      ? `first ${stage} record (${key})`
      : `first ${stage} request (${keys.length} records that together show every structure of the stage; ${key} among them)`;
  const later = `the rest of the ${stage} stage was not sent, and no later stage ran`;
  const resend = `Fix the cause and resend with \`load --only ${stage} --execute\`.`;
  const stop = (key: string, state: string, message: string, errors?: string[]) => ({
    outcome: {
      stage,
      resourceKey: key,
      resourceKeys: keys,
      state,
      proceeded: false,
      ...(errors ? { errors } : {}),
    },
    diagnostics: [{ severity: 'error' as const, code: 'canary-stopped', message: `${message} ${later}.` }],
  });

  if (pushed.failed.length > 0) {
    return stop(
      keys[0],
      'rejected',
      `The ${named(keys[0])} was rejected: ${pushed.failed[0].message}. ${resend} Nothing was imported from it;`,
    );
  }

  const errorsOf = (list?: { code: string; message?: string }[]): string[] | undefined =>
    list && list.length > 0
      ? list.map((e) => `${e.code}${e.message ? `: ${e.message}` : ''}`.slice(0, 600))
      : undefined;

  interface Watched {
    key: string;
    id?: string;
    state: string;
    errors?: string[];
    unresolved?: ImportOperation['unresolvedReferences'];
  }
  // The statuses come back in the order of the resources in the request.
  const watched: Watched[] = keys.map((key, i) => ({
    key,
    id: statuses[i]?.operationId,
    state: (statuses[i]?.state as string | undefined) ?? 'unreadable',
    errors: errorsOf(statuses[i]?.errors),
  }));

  const noId = watched.find((w) => w.id === undefined);
  if (noId) {
    return stop(
      noId.key,
      'unreadable',
      `The Import API gave no operation id for the ${named(noId.key)}, so its result cannot be read.` +
        ` Read the container's operations, then resend with \`load --only ${stage} --execute\`;`,
    );
  }

  let waitedMs = 0;
  let delay = 500;
  for (;;) {
    const pending = watched.filter((w) => w.state === 'processing');
    if (pending.length === 0) break;
    if (waitedMs >= timeoutMs) {
      return stop(
        pending[0].key,
        'processing',
        `The ${named(pending[0].key)} was still processing after ${Math.round(timeoutMs / 1000)} seconds. ` +
          `Check its operation (${pending[0].id}) and resend with \`load --only ${stage} --execute\` once it has settled;`,
      );
    }
    await sleep(delay);
    waitedMs += delay;
    delay = Math.min(delay * 2, 5_000);
    for (const w of pending) {
      try {
        const op = (await clients.importApi.importOperations().withIdValue({ id: w.id! }).get().execute()).body;
        w.state = op.state as string;
        w.errors = errorsOf(op.errors) ?? w.errors;
        w.unresolved = op.unresolvedReferences;
      } catch (err) {
        return stop(
          w.key,
          'unreadable',
          `The result of the ${named(w.key)} could not be read (${describeError(err)}). ` +
            `Its operation is ${w.id}; resend with \`load --only ${stage} --execute\` once it is readable;`,
        );
      }
    }
  }

  const open = (w: Watched) => w.state === 'unresolved' || w.state === 'waitForMasterVariant';
  const refused = watched.filter((w) => w.state !== 'imported' && !open(w));
  if (refused.length > 0) {
    const w = refused[0];
    const others = refused.length > 1 ? ` (${refused.length} of its ${keys.length} records were refused)` : '';
    return stop(
      w.key,
      w.state,
      `The ${named(w.key)} was refused by the Import API (${w.state})${others}` +
        `${w.errors ? `: ${w.errors.join('; ')}` : ''}. ${resend}`,
      w.errors,
    );
  }

  const waiting = watched.filter(open);
  if (waiting.length > 0) {
    const w = waiting[0];
    const refs = (w.unresolved ?? []).map((u) => `${u.typeId} ${u.key}`).join(', ');
    return {
      outcome: { stage, resourceKey: w.key, resourceKeys: keys, state: w.state, proceeded: true },
      diagnostics: [
        {
          severity: 'warning',
          code: 'canary-unresolved',
          message:
            `The ${named(w.key)} is ${w.state}${refs ? `, waiting for ${refs}` : ''}. ` +
            'The API accepted its shape; the rest was sent, and `--wait` and `verify` show whether the reference arrives.',
        },
      ],
    };
  }
  return {
    outcome: { stage, resourceKey: keys[0], resourceKeys: keys, state: 'imported', proceeded: true },
    diagnostics: [],
  };
}

async function pushStage(
  clients: Clients,
  stage: LoadStage,
  batches: Batch[],
  concurrency: number,
  onOutcome?: (outcome: StageOutcome) => void,
  progress?: Progress,
  statuses?: ImportOperationStatus[],
): Promise<StageOutcome> {
  const outcome: StageOutcome = {
    stage,
    containers: [],
    requests: batches.length,
    resources: batches.reduce((n, b) => n + b.resourceKeys.length, 0),
    accepted: 0,
    failed: [],
  };
  onOutcome?.(outcome);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const response = await poster(clients, batch).execute();
        outcome.accepted++;
        const status = (response?.body as { operationStatus?: ImportOperationStatus[] } | undefined)
          ?.operationStatus;
        if (statuses && status) statuses.push(...status);
      } catch (err) {
        outcome.failed.push({
          containerKey: batch.containerKey,
          resourceKeys: batch.resourceKeys,
          message: describeError(err),
        });
      }
      progress?.poll();
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

/**
 * What `--wait` has to see in a container's Import Summary before it can trust
 * `processing === 0`.
 *
 * The Import API registers operations a moment after it accepts the request,
 * so a summary read straight after the push can show `total: 0` with nothing
 * processing — which looks exactly like "finished". The summary is also
 * cumulative over 48 hours, so "this run's operations are in" means the total
 * has risen by this run's count above what it was before the push.
 */
interface ExpectedOperations {
  /** The container's total before this run posted anything; undefined if unreadable. */
  baseline: number | undefined;
  /** Resources in accepted requests: one operation each. */
  operations: number;
}

async function readSummaryTotal(clients: Clients, key: string): Promise<number | undefined> {
  try {
    return (
      await clients.importApi
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: key })
        .importSummaries()
        .get()
        .execute()
    ).body.total;
  } catch {
    // Not an error here: the read after the push reports it as
    // `summary-unavailable`, and the wait falls back to `processing` alone.
    return undefined;
  }
}

function operationsRegistered(
  summary: ImportSummary,
  expected: ExpectedOperations | undefined,
): boolean {
  if (expected === undefined || expected.baseline === undefined) return true;
  return summary.total >= expected.baseline + expected.operations;
}

async function readSummaries(
  clients: Clients,
  batches: LoadBatches,
  diagnostics: Diagnostic[],
  wait: boolean,
  expected: Map<string, ExpectedOperations>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  progress: Progress,
  activity: Activity,
): Promise<LoadResult['summaries']> {
  const out: LoadResult['summaries'] = [];

  let containerNumber = 0;
  for (const container of batches.containers) {
    containerNumber++;
    let summary: ImportSummary | undefined;
    const deadline = Date.now() + timeoutMs;
    let delay = 2_000;

    // What a tick says while this container is read or waited on. `reads` and
    // `changedAt` exist so that "unchanged for" is only claimed once a second
    // read has confirmed it: the plateaus the Import API shows are normal, and
    // the time a count has sat flat is what tells one from a stall.
    let latest: ImportSummary | undefined;
    let reads = 0;
    let lastStates = '';
    let changedAt = progress.now();
    const position = `${containerNumber}/${batches.containers.length}`;
    activity.status(() => {
      if (latest === undefined) return `reading the import summary of ${container.key} (container ${position})`;
      const s = latest.states;
      const parts = [
        `${wait ? 'waiting on' : 'read'} ${container.key} (container ${position})`,
        `${s.imported}/${latest.total} imported`,
        `${s.unresolved} unresolved`,
        `${s.processing} processing`,
      ];
      if (s.rejected > 0) parts.push(`${s.rejected} rejected`);
      if (s.validationFailed > 0) parts.push(`${s.validationFailed} validation failed`);
      const flat = progress.now() - changedAt;
      if (wait && reads > 1 && flat >= 1000) parts.push(`unchanged for ${formatDuration(flat)}`);
      return parts.join(' · ');
    });

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

      latest = summary;
      reads++;
      const states = JSON.stringify(summary.states);
      if (states !== lastStates) {
        lastStates = states;
        changedAt = progress.now();
      }

      const settled =
        operationsRegistered(summary, expected.get(container.key)) &&
        summary.states.processing === 0;
      if (!wait || settled || Date.now() > deadline) break;

      // Backing off rather than polling tightly: the docs are explicit that
      // frequent summary polling slows the import it is measuring.
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
      progress.poll();
    }

    if (summary) out.push({ containerKey: container.key, summary });
  }

  if (wait) {
    const stillProcessing = out.filter((s) => s.summary.states.processing > 0);
    const notRegistered = out.filter(
      (s) => !operationsRegistered(s.summary, expected.get(s.containerKey)),
    );
    if (stillProcessing.length > 0 || notRegistered.length > 0) {
      const what: string[] = [];
      if (notRegistered.length > 0) {
        what.push(
          `${notRegistered.length} container(s) that had not registered all of this run's operations`,
        );
      }
      if (stillProcessing.length > 0) {
        what.push(`${stillProcessing.length} container(s) still processing`);
      }
      diagnostics.push({
        severity: 'warning',
        code: 'wait-timed-out',
        message:
          `Stopped waiting with ${what.join(' and ')}. ` +
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
/** How many failing operations per container and state are read to say why they failed. */
const OPERATION_SAMPLE = 20;
/** At most this many distinct reasons are printed per container. */
const OPERATION_REASONS_SHOWN = 5;

/**
 * Says why operations failed, from a bounded sample: a container whose summary shows
 * failures has its failing operations read (the first few, per state) and the
 * errors grouped, so the diagnostic names the reason, the count in the sample and
 * one record. The summary only counts; run 16 and run 17 each had to read the
 * operations by hand to learn what the same count meant. A read that fails adds
 * nothing and never hides the counts.
 */
async function sampleOperationErrors(
  clients: Clients,
  summaries: LoadResult['summaries'],
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const { containerKey, summary } of summaries) {
    const failing = (['validationFailed', 'rejected', 'partiallyImported'] as const).filter(
      (state) => summary.states[state] > 0,
    );
    if (failing.length === 0) continue;
    const groups = new Map<string, { state: string; count: number; example: string }>();
    let seen = 0;
    for (const state of failing) {
      try {
        const res = await clients.importApi
          .importContainers()
          .withImportContainerKeyValue({ importContainerKey: containerKey })
          .importOperations()
          .get({ queryArgs: { state, limit: OPERATION_SAMPLE } })
          .execute();
        for (const op of res.body.results) {
          seen++;
          const reasons = (op.errors ?? []).map((e) =>
            [e.code, e.message].filter((part) => part !== undefined && part !== '').join(': ').slice(0, 400),
          );
          for (const reason of reasons.length > 0 ? reasons : ['(no error was recorded on the operation)']) {
            const key = `${state}\u0000${reason}`;
            const found = groups.get(key);
            if (found) found.count++;
            else groups.set(key, { state, count: 1, example: op.resourceKey });
          }
        }
      } catch {
        // Not read: the counts above stand, and nothing is claimed about the cause.
      }
    }
    if (groups.size === 0) continue;
    const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
    const lines = ranked.slice(0, OPERATION_REASONS_SHOWN).map(([key, g]) => {
      const reason = key.slice(key.indexOf('\u0000') + 1);
      return `      ${g.count} x ${g.state}: ${reason} (for example ${g.example})`;
    });
    diagnostics.push({
      severity: 'warning',
      code: 'operation-errors',
      message:
        `Why operations in '${containerKey}' failed, from the first ${seen} failing operation(s) read:\n` +
        lines.join('\n') +
        (ranked.length > OPERATION_REASONS_SHOWN ? `\n      ... and ${ranked.length - OPERATION_REASONS_SHOWN} more reason(s)` : ''),
    });
  }
}

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
        `${total.validationFailed} operation(s) failed validation. \`operation-errors\` below ` +
        'says why, from a sample; the operations hold the rest. The audit gate should have ' +
        'caught anything structural, so these are worth feeding back into it as a new check.\n' +
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
  const base = (err as { message?: string }).message ?? String(err);
  const detail = errorDetail(err);
  // The API's top-level message is generic ("Import request has some invalid
  // fields"); the field and the reason are in the body's `errors`.
  return detail !== undefined && !base.includes(detail) ? `${base} (${detail})` : base;
}

/** At most this many entries of an error body's `errors` are printed. */
const ERROR_DETAILS_SHOWN = 5;

/**
 * What the Import or platform API said was wrong, from the `errors` of the response
 * body the SDK keeps on the error it throws: `InvalidField: defaultShippingAddress
 * must be a valid index in shipping addresses array`. Without it a refused request
 * says only that some field was invalid, and the reader has to send one record by
 * hand to find out which.
 */
function errorDetail(err: unknown): string | undefined {
  const e = err as { body?: { errors?: unknown }; error?: { errors?: unknown } } | null | undefined;
  const list = e?.body?.errors ?? e?.error?.errors;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const lines = list
    .slice(0, ERROR_DETAILS_SHOWN)
    .map((x) => {
      const o = x as { code?: unknown; message?: unknown; detailedErrorMessage?: unknown };
      const text = o.detailedErrorMessage ?? o.message;
      return [typeof o.code === 'string' ? o.code : undefined, typeof text === 'string' ? text : undefined]
        .filter((part): part is string => part !== undefined)
        .join(': ');
    })
    .filter((line) => line !== '')
    .map((line) => line.slice(0, 400));
  if (lines.length === 0) return undefined;
  return lines.join('; ') + (list.length > ERROR_DETAILS_SHOWN ? ` (and ${list.length - ERROR_DETAILS_SHOWN} more)` : '');
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
