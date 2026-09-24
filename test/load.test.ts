/**
 * Load stage tests.
 *
 * The batch planner is pure, so chunking, container assignment and ordering are
 * tested directly — those are the decisions the SDK does not make for us, and
 * they are exactly where a mistake is expensive.
 *
 * Execution is tested against a fake Import API root that records every call.
 * No network, no credentials, no project.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportSummary, OperationStates } from '@commercetools/importapi-sdk';

import type { Clients } from '../src/client/factory.js';
import { loadConfig } from '../src/model/config.js';
import { validateFeed } from '../src/contract/validate.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import {
  containerKey,
  planBatches,
  summarise,
  MAX_RESOURCES_PER_REQUEST,
} from '../src/load/batches.js';
import { runLoad } from '../src/load/run.js';
import { renderLoad, writeLoadArtefacts } from '../src/load/report.js';
import type { MigrationPlan, ProductDraftImport } from '../src/model/plan.js';

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the package root');
    dir = parent;
  }
  return dir;
}

const ROOT = packageRoot();

function config() {
  return loadConfig(resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json')).config;
}

/**
 * A real plan, built end to end from the clean fixture. Deliberately not the
 * audit-violations plan: that one contains a duplicated key on purpose, which
 * would make a uniqueness assertion here fail for the wrong reason.
 */
function basePlan(): MigrationPlan {
  const { config: cfg, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json'),
  );
  const { feed } = validateFeed(feedDir, resolve(ROOT, 'schema', 'catalog-feed.schema.json'), cfg);
  const model = deriveProductTypes(feed, cfg);
  return buildPlan(feed, model, cfg).plan;
}

/** A plan with `count` distinct products, for batching arithmetic. */
function planWithProducts(count: number): MigrationPlan {
  const plan = basePlan();
  const template = plan.products[0];
  const products: ProductDraftImport[] = Array.from({ length: count }, (_, i) => ({
    ...template,
    key: `mig-P-${String(i).padStart(4, '0')}`,
  }));
  return { ...plan, products };
}

// ---------------------------------------------------------------------------
// Batch planning
// ---------------------------------------------------------------------------

test('batches: no request carries more than 20 resources', () => {
  const cfg = config();
  for (const count of [1, 19, 20, 21, 45, 199, 200]) {
    const { batches } = planBatches(planWithProducts(count), cfg);
    for (const b of batches) {
      assert.ok(
        b.resourceKeys.length <= MAX_RESOURCES_PER_REQUEST,
        `a request carried ${b.resourceKeys.length} resources`,
      );
    }
    const drafts = batches.filter((b) => b.stage === 'product-draft');
    assert.equal(
      drafts.reduce((n, b) => n + b.resourceKeys.length, 0),
      count,
      'every resource must appear exactly once',
    );
    assert.equal(drafts.length, Math.ceil(count / 20), `${count} products`);
  }
});

test('batches: a configured batch size above 20 is clamped, not trusted', () => {
  const cfg = config();
  // The config loader rejects >20, but a hand-edited config should not be able
  // to produce an illegal request either.
  cfg.load.batchSize = 500;
  const { batches } = planBatches(planWithProducts(50), cfg);
  for (const b of batches) {
    assert.ok(b.resourceKeys.length <= MAX_RESOURCES_PER_REQUEST);
  }
});

test('batches: every resource key appears exactly once across all requests', () => {
  const { batches } = planBatches(planWithProducts(137), config());
  const keys = batches.flatMap((b) => b.resourceKeys);
  assert.equal(keys.length, new Set(keys).size, 'no resource may be submitted twice');
});

test('batches: containers are named by resource type, not by run', () => {
  const { containers } = planBatches(basePlan(), config());
  assert.deepEqual(
    containers.map((c) => c.key),
    ['mig-product-type', 'mig-category', 'mig-product-draft'],
  );
  // Stable across runs is the point: a timestamped container would exhaust the
  // 1000-container limit and hide the previous run's work.
  const again = planBatches(basePlan(), config());
  assert.deepEqual(
    again.containers.map((c) => c.key),
    containers.map((c) => c.key),
  );
});

test('batches: each container is restricted to its resource type', () => {
  const { containers } = planBatches(basePlan(), config());
  for (const c of containers) {
    assert.equal(c.resourceType, c.stage, 'a mistyped batch should be rejected by the container');
  }
});

test('batches: a stage beyond the operation limit splits into numbered containers', () => {
  const cfg = config();
  cfg.load.maxOperationsPerContainer = 50;
  const { containers, batches, warnings } = planBatches(planWithProducts(120), cfg);

  const draftContainers = containers.filter((c) => c.stage === 'product-draft');
  assert.deepEqual(
    draftContainers.map((c) => c.key),
    ['mig-product-draft', 'mig-product-draft-2', 'mig-product-draft-3'],
  );
  assert.deepEqual(
    draftContainers.map((c) => c.operations),
    [50, 50, 20],
  );
  assert.ok(warnings.some((w) => /split across 3 containers/.test(w)));

  // A request must never straddle two containers.
  for (const b of batches) {
    const container = containers.find((c) => c.key === b.containerKey);
    assert.ok(container, `${b.containerKey} should be a planned container`);
  }
});

test('batches: containerKey numbers only from the second part', () => {
  assert.equal(containerKey('mig', 'product-draft', 1), 'mig-product-draft');
  assert.equal(containerKey('mig', 'product-draft', 2), 'mig-product-draft-2');
  assert.equal(containerKey('acme', 'category', 1), 'acme-category');
});

test('batches: ordering follows the plan, product types before products', () => {
  const { batches } = planBatches(basePlan(), config());
  const stages = [...new Set(batches.map((b) => b.stage))];
  assert.deepEqual(stages, ['product-type', 'category', 'product-draft']);
});

test('batches: the request envelope type matches the stage', () => {
  const { batches } = planBatches(basePlan(), config());
  for (const b of batches) {
    assert.equal(b.body.type, b.stage, 'the envelope type is what routes the request');
  }
});

test('batches: an empty stage produces no container and no request', () => {
  const plan = { ...basePlan(), categories: [] };
  const { containers, batches } = planBatches(plan, config());
  assert.ok(!containers.some((c) => c.stage === 'category'));
  assert.ok(!batches.some((b) => b.stage === 'category'));
});

// ---------------------------------------------------------------------------
// Standalone prices
// ---------------------------------------------------------------------------

function standaloneConfig() {
  return loadConfig(resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json'));
}

/** A real standalone-priced plan, built end to end from the same feed. */
function standalonePlan(): MigrationPlan {
  const { config: cfg, feedDir } = standaloneConfig();
  const { feed } = validateFeed(feedDir, resolve(ROOT, 'schema', 'catalog-feed.schema.json'), cfg);
  const model = deriveProductTypes(feed, cfg);
  return buildPlan(feed, model, cfg).plan;
}

test('batches: standalone prices get their own container, after the products', () => {
  const { config: cfg } = standaloneConfig();
  const { containers } = planBatches(standalonePlan(), cfg);
  assert.deepEqual(
    containers.map((c) => c.key),
    ['mig-product-type', 'mig-category', 'mig-product-draft', 'mig-standalone-price'],
  );
  const prices = containers.find((c) => c.stage === 'standalone-price');
  assert.equal(
    prices!.resourceType,
    'standalone-price',
    'the container has to reject anything else, which is the cheap guard on a batching slip',
  );
});

test('batches: the standalone stage uses the standalone-price envelope', () => {
  const { config: cfg } = standaloneConfig();
  const { batches } = planBatches(standalonePlan(), cfg);
  const prices = batches.filter((b) => b.stage === 'standalone-price');
  assert.ok(prices.length > 0, 'the fixture prices something');
  for (const b of prices) {
    assert.equal(b.body.type, 'standalone-price');
    assert.ok(b.resourceKeys.length <= MAX_RESOURCES_PER_REQUEST);
  }
});

test('batches: an embedded-price plan creates no standalone container at all', () => {
  const { containers, batches } = planBatches(basePlan(), config());
  assert.ok(!containers.some((c) => c.stage === 'standalone-price'));
  assert.ok(!batches.some((b) => b.stage === 'standalone-price'));
});

test('execute: standalone prices are posted last, to their own endpoint', async () => {
  const { config: cfg } = standaloneConfig();
  const { clients, recorded } = fakeClients();
  await runLoad(clients, standalonePlan(), cfg, { execute: true, concurrency: 1 });

  const posted = [...new Set(recorded.posts.map((p) => p.stage))];
  assert.deepEqual(posted, ['product-type', 'category', 'product-draft', 'standalone-price']);

  assert.ok(
    recorded.containerCreates.includes('mig-standalone-price'),
    'the container is created before the stage that fills it',
  );
  assert.ok(
    recorded.sequence.indexOf('container:mig-standalone-price') <
      recorded.sequence.indexOf('post:standalone-price'),
  );
});

test('summarise: totals match the batches', () => {
  const batches = planBatches(planWithProducts(45), config());
  const s = summarise(batches);
  assert.equal(s.requests, batches.batches.length);
  assert.equal(s.byStage['product-draft'].resources, 45);
  assert.equal(s.byStage['product-draft'].requests, 3);
});

// ---------------------------------------------------------------------------
// The fake Import API
// ---------------------------------------------------------------------------

interface Recorded {
  /** Keyed reads of prerequisites, to prove nothing is posted blindly. */
  prerequisiteReads: { kind: string; where: string }[];
  created: { kind: string; body: Record<string, unknown> }[];
  containerCreates: string[];
  /** Container reads, which only happen when a create failed. */
  containerReads: string[];
  posts: { stage: string; containerKey: string; resources: number }[];
  summaryReads: string[];
  /** Call order, to check stages are not interleaved wrongly. */
  sequence: string[];
}

interface FakeOptions {
  /** What the project already holds, per kind. */
  existing?: {
    stores?: { key: string; productSelections?: unknown[] }[] | Error;
    channels?: { key: string; roles: string[] }[] | Error;
    customerGroups?: { key: string }[] | Error;
  };
  /** Per kind, so a test can fail one create without failing the other. */
  createError?: Partial<Record<'channels' | 'customerGroups' | 'stores', unknown>>;
  containerError?: unknown;
  /** True when the container is already there, i.e. any run after the first. */
  containerExists?: boolean;
  /** Fails posts whose resource list includes this key. */
  failResourceKey?: string;
  states?: Partial<OperationStates>;
  /** Summaries report processing until this many reads have happened. */
  processingUntilRead?: number;
  summaryError?: unknown;
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function states(overrides: Partial<OperationStates> = {}): OperationStates {
  return {
    processing: 0,
    validationFailed: 0,
    unresolved: 0,
    waitForMasterVariant: 0,
    imported: 0,
    rejected: 0,
    canceled: 0,
    partiallyImported: 0,
    ...overrides,
  };
}

function fakeClients(options: FakeOptions = {}): { clients: Clients; recorded: Recorded } {
  const recorded: Recorded = {
    prerequisiteReads: [],
    created: [],
    containerCreates: [],
    containerReads: [],
    posts: [],
    summaryReads: [],
    sequence: [],
  };

  const stagePoster = (stage: string) => () => ({
    importContainers: () => ({
      withImportContainerKeyValue: ({ importContainerKey }: { importContainerKey: string }) => ({
        post: ({ body }: { body: { resources: { key: string }[] } }) => ({
          execute: async () => {
            if (
              options.failResourceKey &&
              body.resources.some((r) => r.key === options.failResourceKey)
            ) {
              throw httpError(400, 'InvalidInput');
            }
            recorded.posts.push({
              stage,
              containerKey: importContainerKey,
              resources: body.resources.length,
            });
            recorded.sequence.push(`post:${stage}`);
            return { body: { operationStatus: [] } };
          },
        }),
      }),
    }),
  });

  const importApi = {
    importContainers: () => ({
      post: ({ body }: { body: { key: string } }) => ({
        execute: async () => {
          if (options.containerError) throw options.containerError;
          recorded.containerCreates.push(body.key);
          recorded.sequence.push(`container:${body.key}`);
          return { body: { key: body.key, version: 1 } };
        },
      }),
      withImportContainerKeyValue: ({ importContainerKey }: { importContainerKey: string }) => ({
        // Reading a container is how `ensureContainer` establishes that a
        // failed create was really "it already exists". Absent by default,
        // which is the state of a first run into a fresh project.
        get: () => ({
          execute: async () => {
            recorded.containerReads.push(importContainerKey);
            if (!options.containerExists) throw httpError(404, 'Not Found');
            return { body: { key: importContainerKey, resourceType: 'product-draft', version: 1 } };
          },
        }),
        importSummaries: () => ({
          get: () => ({
            execute: async () => {
              if (options.summaryError) throw options.summaryError;
              recorded.summaryReads.push(importContainerKey);
              const reads = recorded.summaryReads.filter(
                (k) => k === importContainerKey,
              ).length;
              const stillProcessing =
                options.processingUntilRead !== undefined &&
                reads < options.processingUntilRead;
              const summary: ImportSummary = {
                total: 1,
                states: stillProcessing
                  ? states({ processing: 1 })
                  : states(options.states),
              };
              return { body: summary };
            },
          }),
        }),
      }),
    }),
    productTypes: stagePoster('product-type'),
    categories: stagePoster('category'),
    productDrafts: stagePoster('product-draft'),
    standalonePrices: stagePoster('standalone-price'),
    productSelections: stagePoster('product-selection'),
    variants: stagePoster('variant'),
  };

  const platformStage = (kind: 'channels' | 'customerGroups' | 'stores') => () => ({
    get: ({ queryArgs }: { queryArgs: { where: string } }) => ({
      execute: async () => {
        recorded.prerequisiteReads.push({ kind, where: queryArgs.where });
        recorded.sequence.push(`read:${kind}`);
        const existing = options.existing?.[kind];
        if (existing instanceof Error) throw existing;
        return { body: { results: existing ?? [] } };
      },
    }),
    post: ({ body }: { body: Record<string, unknown> }) => ({
      execute: async () => {
        const failure = options.createError?.[kind];
        if (failure !== undefined) throw failure;
        recorded.created.push({ kind, body });
        recorded.sequence.push(`create:${kind}`);
        return { body: { ...body, id: 'new-id', version: 1 } };
      },
    }),
  });

  const platform = new Proxy(
    {
      channels: platformStage('channels'),
      customerGroups: platformStage('customerGroups'),
      stores: platformStage('stores'),
    },
    {
      // Stubbed properties fall through to the target; anything else throws, so
      // a new platform call in load shows up as a named failure rather than an
      // `undefined is not a function`.
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        throw new Error(`fakeClients: platform.${String(prop)} is not used by load`);
      },
    },
  );

  return { clients: { platform, importApi } as unknown as Clients, recorded };
}

const noSleep = async () => {};

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('dry run: sends absolutely nothing', async () => {
  const { clients, recorded } = fakeClients();
  const result = await runLoad(clients, basePlan(), config());

  assert.equal(result.executed, false);
  assert.deepEqual(recorded.containerCreates, []);
  assert.deepEqual(recorded.posts, []);
  assert.deepEqual(recorded.summaryReads, []);
  assert.deepEqual(result.summaries, []);
});

test('dry run: still reports what would be sent, per stage', async () => {
  const { clients } = fakeClients();
  const result = await runLoad(clients, planWithProducts(45), config());
  const drafts = result.stages.find((s) => s.stage === 'product-draft');
  assert.ok(drafts);
  assert.equal(drafts.requests, 3);
  assert.equal(drafts.resources, 45);
  assert.equal(drafts.accepted, 0, 'nothing was accepted because nothing was sent');
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('execute: creates one container per resource type, then posts', async () => {
  const { clients, recorded } = fakeClients();
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });

  assert.equal(result.executed, true);
  assert.deepEqual(recorded.containerCreates, [
    'mig-product-type',
    'mig-category',
    'mig-product-draft',
  ]);
  assert.deepEqual(
    recorded.posts.map((p) => p.stage),
    ['product-type', 'category', 'product-draft'],
  );
});

test('execute: a stage container is created before that stage posts', async () => {
  const { clients, recorded } = fakeClients();
  await runLoad(clients, basePlan(), config(), { execute: true, sleep: noSleep });

  const order = recorded.sequence;
  for (const stage of ['product-type', 'category', 'product-draft']) {
    const container = order.indexOf(`container:mig-${stage}`);
    const firstPost = order.indexOf(`post:${stage}`);
    assert.ok(container >= 0 && firstPost >= 0);
    assert.ok(container < firstPost, `${stage} posted before its container existed`);
  }
});

test('execute: a 409 on create is reused without even reading the container', async () => {
  const { clients, recorded } = fakeClients({
    containerError: httpError(409, 'Conflict'),
  });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  assert.ok(!result.diagnostics.some((d) => d.code === 'container-unavailable'));
  assert.deepEqual(recorded.containerReads, [], 'a 409 is unambiguous; no read needed');
  assert.ok(recorded.posts.length > 0, 'the load should continue');
});

test('execute: the real "already exists" response is reused, whatever it says', async () => {
  // The message the API actually returns, which is what broke this: the guard
  // used to match /[Dd]uplicate/ against the message, and a live re-run got
  // `400 Import container key already exists` with no structured code — so
  // every run after the first reported four errors for the normal case.
  //
  // Both messages are asserted together on purpose. The fix must not depend
  // on the prose at all: what settles it is that the container reads back.
  for (const message of ['Import container key already exists', 'something else entirely']) {
    const { clients, recorded } = fakeClients({
      containerError: httpError(400, message),
      containerExists: true,
    });
    const result = await runLoad(clients, basePlan(), config(), {
      execute: true,
      sleep: noSleep,
    });
    assert.ok(
      !result.diagnostics.some((d) => d.code === 'container-unavailable'),
      `a container that already exists is the normal case (${message})`,
    );
    assert.ok(recorded.containerReads.length > 0, 'it should establish this by reading');
    assert.ok(recorded.posts.length > 0, 'the load should continue');
  }
});

test('execute: a create failure with no container to find is still an error', async () => {
  // The other half: the read must not turn every failure into a pass.
  const { clients } = fakeClients({
    containerError: httpError(400, 'Import container key already exists'),
    containerExists: false,
  });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  assert.ok(
    result.diagnostics.some((d) => d.code === 'container-unavailable'),
    'no container and no create means the load cannot proceed',
  );
});

test('execute: a container that genuinely cannot be created is an error', async () => {
  const { clients } = fakeClients({ containerError: httpError(403, 'insufficient_scope') });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  const d = result.diagnostics.find((x) => x.code === 'container-unavailable');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /manage_import_containers/);
});

test('execute: one failed request does not abort the stage, and names its resources', async () => {
  const plan = planWithProducts(45);
  const doomed = plan.products[25].key;
  const { clients, recorded } = fakeClients({ failResourceKey: doomed });

  const result = await runLoad(clients, plan, config(), { execute: true, sleep: noSleep });
  const drafts = result.stages.find((s) => s.stage === 'product-draft');
  assert.ok(drafts);
  assert.equal(drafts.requests, 3);
  assert.equal(drafts.accepted, 2);
  assert.equal(drafts.failed.length, 1);
  assert.ok(drafts.failed[0].resourceKeys.includes(doomed));

  // The other two requests still went.
  assert.equal(recorded.posts.filter((p) => p.stage === 'product-draft').length, 2);

  const d = result.diagnostics.find((x) => x.code === 'import-request-failed');
  assert.ok(d);
  assert.match(d.message, new RegExp(doomed));
});

test('execute: concurrency is bounded and every request still goes exactly once', async () => {
  const plan = planWithProducts(100);
  const { clients, recorded } = fakeClients();
  await runLoad(clients, plan, config(), { execute: true, concurrency: 3, sleep: noSleep });

  const drafts = recorded.posts.filter((p) => p.stage === 'product-draft');
  assert.equal(drafts.length, 5, '100 products in batches of 20');
  assert.equal(
    drafts.reduce((n, p) => n + p.resources, 0),
    100,
  );
});

// ---------------------------------------------------------------------------
// Operation states
// ---------------------------------------------------------------------------

test('states: unresolved is a warning, because it resolves itself', async () => {
  const { clients } = fakeClients({ states: { unresolved: 7, imported: 3 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  const d = result.diagnostics.find((x) => x.code === 'operations-unresolved');
  assert.ok(d);
  assert.equal(d.severity, 'warning', 'an unresolved KeyReference is not a failure');
  assert.match(d.message, /within 48 hours/);
});

test('states: rejected is an error and says it is the resubmittable one', async () => {
  const { clients } = fakeClients({ states: { rejected: 4 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  const d = result.diagnostics.find((x) => x.code === 'operations-rejected');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /only state worth\s+resubmitting/);
});

test('states: validationFailed and partiallyImported are errors', async () => {
  const { clients } = fakeClients({ states: { validationFailed: 2, partiallyImported: 1 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  assert.ok(
    codes(result.diagnostics).includes('operations-validation-failed'),
  );
  const partial = result.diagnostics.find(
    (x) => x.code === 'operations-partially-imported',
  );
  assert.ok(partial);
  assert.equal(partial.severity, 'error');
  assert.match(partial.message, /half-written/);
});

test('states: waitForMasterVariant is explained rather than reported as broken', async () => {
  const { clients } = fakeClients({ states: { waitForMasterVariant: 5 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  const d = result.diagnostics.find(
    (x) => x.code === 'operations-wait-for-master-variant',
  );
  assert.ok(d);
  assert.equal(d.severity, 'warning');
});

test('states: a clean import produces no findings', async () => {
  const { clients } = fakeClients({ states: { imported: 8 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  assert.deepEqual(codes(result.diagnostics), []);
});

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

test('wait: absent by default, so the load does not serialise on polling', async () => {
  const { clients, recorded } = fakeClients({ processingUntilRead: 5 });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });

  // One summary read per container, and no retry loop.
  assert.equal(recorded.summaryReads.length, result.batches.containers.length);
  assert.ok(result.diagnostics.some((d) => d.code === 'operations-processing'));
  assert.equal(result.waited, false);
});

test('wait: polls until nothing is processing', async () => {
  const waits: number[] = [];
  const { clients, recorded } = fakeClients({ processingUntilRead: 3, states: { imported: 1 } });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    wait: true,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(result.waited, true);
  // Three reads per container: two processing, one settled.
  assert.equal(recorded.summaryReads.filter((k) => k === 'mig-category').length, 3);
  // Backoff doubles rather than polling tightly.
  assert.deepEqual(waits.slice(0, 2), [2000, 4000]);
  assert.ok(!result.diagnostics.some((d) => d.code === 'operations-processing'));
});

test('wait: a timeout says the import continues server-side', async () => {
  const { clients } = fakeClients({ processingUntilRead: 1000 });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    wait: true,
    waitTimeoutMs: -1,
    sleep: noSleep,
  });
  const d = result.diagnostics.find((x) => x.code === 'wait-timed-out');
  assert.ok(d);
  assert.match(d.message, /continues server-side/);
});

test('summaries: an unreadable summary is a warning, not a failed load', async () => {
  const { clients } = fakeClients({ summaryError: httpError(403, 'insufficient_scope') });
  const result = await runLoad(clients, basePlan(), config(), {
    execute: true,
    sleep: noSleep,
  });
  assert.ok(result.diagnostics.some((d) => d.code === 'summary-unavailable'));
  assert.ok(
    !result.diagnostics.some((d) => d.severity === 'error'),
    'the resources were still submitted',
  );
});

// ---------------------------------------------------------------------------
// The Modular catalog model
// ---------------------------------------------------------------------------

function modularConfig() {
  return loadConfig(resolve(ROOT, 'fixtures', 'modular-standalone', 'migration.config.json'));
}

function modularPlan(): MigrationPlan {
  const { config: cfg, feedDir } = modularConfig();
  const { feed } = validateFeed(feedDir, resolve(ROOT, 'schema', 'catalog-feed.schema.json'), cfg);
  const model = deriveProductTypes(feed, cfg);
  return buildPlan(feed, model, cfg).plan;
}

test('batches: Modular adds a variant stage between products and prices', () => {
  // A VariantImport references its product by key, so it has to follow the
  // product draft; a StandalonePrice references a SKU, so it follows the
  // variant.
  const { config: cfg } = modularConfig();
  const { containers, batches } = planBatches(modularPlan(), cfg);

  assert.deepEqual(
    containers.map((c) => c.key),
    [
      'mig-product-type',
      'mig-category',
      'mig-product-draft',
      'mig-variant',
      'mig-standalone-price',
    ],
  );

  const stages = [...new Set(batches.map((b) => b.stage))];
  assert.deepEqual(stages, [
    'product-type',
    'category',
    'product-draft',
    'variant',
    'standalone-price',
  ]);

  const variantStage = containers.find((c) => c.stage === 'variant');
  assert.ok(variantStage);
  assert.equal(variantStage.resourceType, 'variant');
});

test('batches: the variant stage uses the variant envelope', () => {
  const { config: cfg } = modularConfig();
  const { batches } = planBatches(modularPlan(), cfg);
  const variantBatches = batches.filter((b) => b.stage === 'variant');
  assert.ok(variantBatches.length > 0, 'the fixture has variants');
  for (const b of variantBatches) {
    assert.equal(b.body.type, 'variant');
    assert.ok(b.resourceKeys.length <= MAX_RESOURCES_PER_REQUEST);
  }
});

test('batches: a Classic plan creates no variant container', () => {
  const { containers, batches } = planBatches(basePlan(), config());
  assert.ok(!containers.some((c) => c.stage === 'variant'));
  assert.ok(!batches.some((b) => b.stage === 'variant'));
});

test('execute: Modular posts variants after products and before prices', async () => {
  const { config: cfg } = modularConfig();
  const { clients, recorded } = fakeClients();
  await runLoad(clients, modularPlan(), cfg, { execute: true, concurrency: 1 });

  const posted = [...new Set(recorded.posts.map((p) => p.stage))];
  assert.deepEqual(posted, [
    'product-type',
    'category',
    'product-draft',
    'variant',
    'standalone-price',
  ]);

  // The container has to exist before the stage that fills it.
  assert.ok(
    recorded.sequence.indexOf('container:mig-variant') <
      recorded.sequence.indexOf('post:variant'),
  );
  // And a variant cannot resolve its product reference before the product is
  // submitted, so the order between those two stages is load-bearing.
  assert.ok(
    recorded.sequence.indexOf('post:product-draft') < recorded.sequence.indexOf('post:variant'),
  );
});

// ---------------------------------------------------------------------------
// Prerequisites: created through the platform API
//
// The Import API has no channel or customer-group resource, so these two load
// stages use a different mechanism entirely — no container, no batching, no
// operation states, and a synchronous result.
// ---------------------------------------------------------------------------

function planNeedingPrerequisites(): MigrationPlan {
  return {
    ...basePlan(),
    prerequisites: {
      channels: [
        { key: 'retail-uk', roles: ['ProductDistribution'], name: { 'en-GB': 'Retail UK' } },
      ],
      customerGroups: [{ key: 'trade', name: 'Trade' }],
      stores: [],
    },
  };
}

test('prerequisites: absent ones are created, present ones are left alone', async () => {
  const { clients, recorded } = fakeClients({
    existing: { channels: [], customerGroups: [{ key: 'trade' }] },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    concurrency: 1,
    sleep: noSleep,
  });

  const channels = r.prerequisites.find((p) => p.stage === 'channel')!;
  assert.deepEqual(channels.created, ['retail-uk']);
  assert.deepEqual(channels.existing, []);

  const groups = r.prerequisites.find((p) => p.stage === 'customer-group')!;
  assert.deepEqual(groups.existing, ['trade'], 'already there, so untouched');
  assert.deepEqual(groups.created, []);

  assert.deepEqual(
    recorded.created.map((c) => c.kind),
    ['channels'],
    'only the missing one is posted',
  );
  assert.deepEqual(recorded.created[0].body, {
    key: 'retail-uk',
    roles: ['ProductDistribution'],
    name: { 'en-GB': 'Retail UK' },
  });
});

test('prerequisites: existence is read, never inferred from a failed POST', async () => {
  // Posting blindly and reading "already exists" off an error message would
  // mean matching error prose — which is exactly what broke the container
  // check. A keyed query answers it as a fact.
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [] },
  });
  await runLoad(clients, planNeedingPrerequisites(), config(), { execute: true, sleep: noSleep });

  assert.equal(recorded.prerequisiteReads.length, 2, 'one keyed read per kind');
  assert.match(recorded.prerequisiteReads[0].where, /key in \("retail-uk"\)/);
  assert.ok(
    !recorded.created.some((c) => c.kind === 'channels'),
    'an existing channel must not be posted at all',
  );
});

test('prerequisites: they run before anything is imported', async () => {
  // A price whose channel does not exist yet becomes an operation that expires
  // unresolved after 48 hours, so the ordering is load-bearing.
  const { clients, recorded } = fakeClients({
    existing: { channels: [], customerGroups: [] },
  });
  await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    concurrency: 1,
    sleep: noSleep,
  });

  const firstImport = recorded.sequence.findIndex((e) => e.startsWith('post:'));
  const lastCreate = recorded.sequence.reduce(
    (last, e, i) => (e.startsWith('create:') ? i : last),
    -1,
  );
  assert.ok(lastCreate >= 0 && firstImport >= 0);
  assert.ok(lastCreate < firstImport, 'every prerequisite lands before the first import');
});

test('prerequisites: a dry run says what it would create and posts nothing', async () => {
  const { clients, recorded } = fakeClients({ existing: { channels: [], customerGroups: [] } });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), { sleep: noSleep });

  assert.equal(r.executed, false);
  assert.deepEqual(
    r.prerequisites.find((p) => p.stage === 'channel')!.created,
    ['retail-uk'],
    'reported as would-create',
  );
  assert.deepEqual(recorded.created, [], 'and nothing was actually posted');
  // It still reads the project, which costs only GETs and is what makes the
  // dry run's answer true rather than a guess.
  assert.equal(recorded.prerequisiteReads.length, 2);
});

test('prerequisites: an existing channel missing a role is reported, not patched', async () => {
  // Roles govern stores and inventory too, so widening them is a project
  // decision rather than something a catalog load does in passing.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: [{ key: 'retail-uk', roles: ['InventorySupply'] }],
      customerGroups: [{ key: 'trade' }],
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  const channels = r.prerequisites.find((p) => p.stage === 'channel')!;
  assert.deepEqual(channels.existing, ['retail-uk']);
  assert.deepEqual(channels.unusable, [
    { key: 'retail-uk', reason: 'missing role(s) [ProductDistribution]' },
  ]);
  assert.deepEqual(recorded.created, [], 'nothing was modified');

  const d = r.diagnostics.find((x) => x.code === 'channel-roles-insufficient');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /Not modified/);
});

test('prerequisites: an unreadable list attempts no creation', async () => {
  // Creating without knowing what exists is how duplicates happen.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: Object.assign(new Error('Insufficient scope'), { statusCode: 403 }),
      customerGroups: [],
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  const d = r.diagnostics.find((x) => x.code === 'prerequisite-read-failed');
  assert.ok(d);
  assert.match(d.message, /nothing was attempted/i);
  assert.ok(!recorded.created.some((c) => c.kind === 'channels'));
});

test('prerequisites: an unreadable list in a dry run degrades to a warning', async () => {
  // A dry run sends no writes, so a failed read costs it accuracy, not
  // correctness. Making it an error would mean an unreachable project yields
  // no dry run at all — and inspecting the requests offline is half the point
  // of one.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: Object.assign(new Error('Insufficient scope'), { statusCode: 403 }),
      customerGroups: [],
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), { sleep: noSleep });

  const d = r.diagnostics.find((x) => x.code === 'prerequisite-read-failed');
  assert.ok(d);
  assert.equal(d.severity, 'warning', 'a dry run is not wrong, just less informative');
  assert.match(d.message, /cannot say which of the 1 planned channel\(s\) already exist/);

  const channels = r.prerequisites.find((p) => p.stage === 'channel')!;
  assert.deepEqual(channels.unknown, ['retail-uk']);
  assert.deepEqual(channels.created, [], 'it must not claim it would create them');
  assert.deepEqual(channels.existing, []);
  assert.deepEqual(recorded.created, []);

  // The dry run still completes, and the batches are still reported.
  assert.equal(r.executed, false);
  assert.ok(r.batches.batches.length > 0);
});

test('prerequisites: a 403 names the scope it needs, not the import scopes', async () => {
  // The generic 403 describer lists manage_import_containers and standalone
  // prices. On a customer-group read every one of those is a red herring, and
  // the scope actually missing is view_customer_groups.
  const { clients } = fakeClients({
    existing: {
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }],
      customerGroups: Object.assign(new Error('Insufficient scope'), { statusCode: 403 }),
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  const d = r.diagnostics.find((x) => x.code === 'prerequisite-read-failed')!;
  assert.match(d.message, /view_customer_groups/);
  assert.match(d.message, /manage_customer_groups/);
  assert.ok(
    !/manage_import_containers/.test(d.message),
    'the import scopes are irrelevant to a customer-group read',
  );
  assert.ok(!/manage_standalone_prices/.test(d.message));
});

test('prerequisites: an unmet one stops the import before it starts', async () => {
  // The alternative is importing prices scoped to something that does not
  // exist: operations that sit unresolved for 48 hours, then expire, on a run
  // that reported every request accepted.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: [{ key: 'retail-uk', roles: ['InventorySupply'] }], // wrong role
      customerGroups: [{ key: 'trade' }],
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  assert.deepEqual(r.stages, [], 'no import stage ran');
  assert.ok(
    !recorded.sequence.some((e) => e.startsWith('post:')),
    'not a single import request was sent',
  );
  assert.ok(
    !recorded.sequence.some((e) => e.startsWith('container:')),
    'and no container was created either',
  );

  const d = r.diagnostics.find((x) => x.code === 'prerequisites-unmet')!;
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /Nothing was imported: channel retail-uk/);
  assert.match(d.message, /re-run updates rather than duplicates/);
});

test('prerequisites: a failed creation stops the import too', async () => {
  const { clients, recorded } = fakeClients({
    existing: { channels: [], customerGroups: [] },
    createError: { channels: Object.assign(new Error('Forbidden'), { statusCode: 403 }) },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  assert.deepEqual(r.stages, []);
  assert.ok(!recorded.sequence.some((e) => e.startsWith('post:')));
  assert.ok(r.diagnostics.some((x) => x.code === 'prerequisite-create-failed'));
  assert.ok(r.diagnostics.some((x) => x.code === 'prerequisites-unmet'));
});

test('prerequisites: one unreadable stage creates nothing in the other', async () => {
  // The case the trial project produced: manage_products can create channels,
  // but the client had no view_customer_groups. Reading and creating per stage
  // in turn meant the channel was created and *then* the run aborted — a load
  // that imported nothing yet left a resource behind.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: [],
      customerGroups: Object.assign(new Error('Insufficient scope'), { statusCode: 403 }),
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  assert.deepEqual(recorded.created, [], 'not even the readable stage may be applied');
  const channels = r.prerequisites.find((p) => p.stage === 'channel')!;
  assert.deepEqual(channels.created, []);
  assert.deepEqual(channels.deferred, ['retail-uk']);
  assert.deepEqual(r.stages, [], 'and nothing was imported');
  assert.ok(r.diagnostics.some((x) => x.code === 'prerequisites-unmet'));
});

test('prerequisites: every read happens before any create', async () => {
  const { clients, recorded } = fakeClients({ existing: { channels: [], customerGroups: [] } });
  await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    concurrency: 1,
    sleep: noSleep,
  });

  const lastRead = recorded.sequence.reduce(
    (last, e, i) => (e.startsWith('read:') ? i : last),
    -1,
  );
  const firstCreate = recorded.sequence.findIndex((e) => e.startsWith('create:'));
  assert.ok(lastRead >= 0 && firstCreate >= 0, 'both kinds of call must appear');
  assert.ok(lastRead < firstCreate, 'a later read must not follow an earlier create');
});

test('prerequisites: a customer group is posted as groupName, not name', async () => {
  // CustomerGroupDraft spells it differently from every other draft here, and
  // `name` would be silently dropped as an unknown field.
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [] },
  });
  await runLoad(clients, planNeedingPrerequisites(), config(), { execute: true, sleep: noSleep });

  const posted = recorded.created.find((c) => c.kind === 'customerGroups')!;
  assert.deepEqual(posted.body, { key: 'trade', groupName: 'Trade' });
  assert.ok(!('name' in posted.body));
});

test('prerequisites: a plan with none does no platform calls at all', async () => {
  const { clients, recorded } = fakeClients();
  const r = await runLoad(clients, basePlan(), config(), { execute: true, sleep: noSleep });
  assert.deepEqual(r.prerequisites, []);
  assert.deepEqual(recorded.prerequisiteReads, []);
});

// ---------------------------------------------------------------------------
// The reported artefact
//
// `load-requests.json` is documented as what will be sent, so anything the run
// will do that is not in it is a gap in the only thing a reviewer reads before
// authorising an --execute. Channels and customer groups are the sharpest case:
// they are created outside any container and cannot be rolled back by letting
// the import operations expire.
// ---------------------------------------------------------------------------

test('artefact: a dry run names the prerequisites it would create', async () => {
  const { clients } = fakeClients({ existing: { channels: [], customerGroups: [{ key: 'trade' }] } });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), { sleep: noSleep });

  const dir = mkdtempSync(resolve(tmpdir(), 'load-artefact-'));
  const path = writeLoadArtefacts(dir, r);
  assert.match(path, /load-requests\.json$/);

  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.executed, false);
  assert.ok(written.prerequisites, 'the artefact must state them, not only the terminal output');
  const channel = written.prerequisites.find((p: { stage: string }) => p.stage === 'channel');
  assert.deepEqual(channel.created, ['retail-uk']);
  const group = written.prerequisites.find((p: { stage: string }) => p.stage === 'customer-group');
  assert.deepEqual(group.existing, ['trade']);
});

test('artefact: an executed run records what was created', async () => {
  const { clients } = fakeClients({ existing: { channels: [], customerGroups: [] } });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  const dir = mkdtempSync(resolve(tmpdir(), 'load-artefact-'));
  const path = writeLoadArtefacts(dir, r);
  assert.match(path, /load-result\.json$/);

  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.executed, true);
  assert.deepEqual(
    written.prerequisites.flatMap((p: { created: string[] }) => p.created).sort(),
    ['retail-uk', 'trade'],
  );
});

test('artefact: a halted run does not render as "Load executed"', async () => {
  const { clients } = fakeClients({
    existing: {
      channels: [{ key: 'retail-uk', roles: ['InventorySupply'] }],
      customerGroups: [{ key: 'trade' }],
    },
  });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), {
    execute: true,
    sleep: noSleep,
  });

  const text = renderLoad(r).join('\n');
  assert.ok(!/^Load executed\.$/m.test(text), 'a stopped run must not read as a finished one');
  assert.match(text, /LOAD STOPPED before the first import/);
  assert.match(text, /none was created/, 'the planned containers must be marked as unused');
});

test('artefact: the terminal output puts prerequisites before the containers', async () => {
  // They run first, so reading them second invites the conclusion that the
  // import created them.
  const { clients } = fakeClients({ existing: { channels: [], customerGroups: [] } });
  const r = await runLoad(clients, planNeedingPrerequisites(), config(), { sleep: noSleep });

  const lines = renderLoad(r);
  const prereq = lines.findIndex((l) => l.startsWith('Prerequisites'));
  const containers = lines.findIndex((l) => l.startsWith('Containers'));
  assert.ok(prereq >= 0 && containers >= 0);
  assert.ok(prereq < containers);
});

// ---------------------------------------------------------------------------
// Stores
//
// The one platform stage that cannot go first. A store references product
// selections, the Import API creates those asynchronously, and a store cannot
// be created pointing at one that does not exist yet.
// ---------------------------------------------------------------------------

function planWithStore(selections = 1): MigrationPlan {
  const base = basePlan();
  return {
    ...base,
    productSelections: selections > 0
      ? [{ key: 'mig-uk', name: { 'en-GB': 'UK' }, mode: 'Individual', assignments: [] }]
      : [],
    prerequisites: {
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }],
      customerGroups: [],
      stores: [
        {
          key: 'northwind-uk',
          distributionChannels: ['retail-uk'],
          supplyChannels: [],
          productSelections: selections > 0 ? [{ key: 'mig-uk', active: true }] : [],
        },
      ],
    },
  };
}

test('stores: a store referencing selections refuses to load without --wait', async () => {
  // Without waiting there is no moment at which the store stage is safe, so
  // this is the last cheap place to stop — and it stops before the *first
  // write*, not merely before the imports. A live run revealed the earlier
  // placement created two channels and then refused, leaving resources behind
  // from a load that did nothing.
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  const r = await runLoad(clients, planWithStore(), config(), { execute: true, sleep: noSleep });

  const d = r.diagnostics.find((x) => x.code === 'stores-require-wait');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /--wait/);
  assert.deepEqual(r.stages, [], 'nothing imported');
  assert.ok(!recorded.sequence.some((e) => e.startsWith('post:')));
  assert.deepEqual(recorded.created, [], 'and nothing created either — not even a channel');
  assert.deepEqual(recorded.prerequisiteReads, [], 'the check needs only the plan');
  assert.match(d.message, /Nothing was created and nothing was imported/);
});

test('stores: a store with no selections loads without --wait', async () => {
  // Nothing asynchronous to wait for, so the restriction would be noise.
  const { clients } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  const r = await runLoad(clients, planWithStore(0), config(), { execute: true, sleep: noSleep });
  assert.ok(!r.diagnostics.some((x) => x.code === 'stores-require-wait'));
  const stores = r.prerequisites.find((p) => p.stage === 'store')!;
  assert.deepEqual(stores.created, ['northwind-uk']);
});

test('stores: the store stage runs after every import, not before', async () => {
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  await runLoad(clients, planWithStore(), config(), {
    execute: true,
    wait: true,
    concurrency: 1,
    sleep: noSleep,
  });

  const storeCreate = recorded.sequence.lastIndexOf('create:stores');
  const lastImport = recorded.sequence.reduce(
    (last, e, i) => (e.startsWith('post:') ? i : last),
    -1,
  );
  assert.ok(storeCreate >= 0, 'the store should have been created');
  assert.ok(lastImport >= 0, 'something should have been imported');
  assert.ok(lastImport < storeCreate, 'the store must be wired only once its selections exist');
});

test('stores: an existing store with different wiring is reported, never modified', async () => {
  // setProductSelections replaces the whole array, so applying the plan would
  // discard whatever the project's own setup put there.
  const { clients, recorded } = fakeClients({
    existing: {
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }],
      customerGroups: [],
      stores: [{ key: 'northwind-uk', productSelections: [] }],
    },
  });
  const r = await runLoad(clients, planWithStore(), config(), {
    execute: true,
    wait: true,
    sleep: noSleep,
  });

  const stores = r.prerequisites.find((p) => p.stage === 'store')!;
  assert.deepEqual(stores.existing, ['northwind-uk']);
  assert.deepEqual(stores.created, []);
  assert.equal(stores.unusable.length, 1);
  assert.ok(!recorded.created.some((c) => c.kind === 'stores'), 'not modified');

  const d = r.diagnostics.find((x) => x.code === 'store-wiring-differs')!;
  assert.ok(d);
  assert.match(d.message, /replaces the whole array/);
});

test('stores: product selections are imported as their own stage', async () => {
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  const r = await runLoad(clients, planWithStore(), config(), {
    execute: true,
    wait: true,
    sleep: noSleep,
  });
  const stage = r.stages.find((st) => st.stage === 'product-selection');
  assert.ok(stage, 'product-selection is an Import API stage, not a platform one');
  assert.equal(stage.resources, 1);
  assert.ok(recorded.sequence.includes('post:product-selection'));
});

test('stores: a dry run reports the store it would create', async () => {
  // Stores are created last on the executed path, so the dry run has to ask
  // for them separately — otherwise `load-requests.json`, documented as what
  // the run will do, reports every stage except that one.
  const { clients, recorded } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  const r = await runLoad(clients, planWithStore(), config(), { sleep: noSleep });

  assert.equal(r.executed, false);
  const stores = r.prerequisites.find((p) => p.stage === 'store');
  assert.ok(stores, 'the dry run must say what it would do about stores');
  assert.deepEqual(stores.created, ['northwind-uk']);
  assert.deepEqual(recorded.created, [], 'and create nothing');
});

test('stores: a dry run does not demand --wait', async () => {
  // Nothing is written, so there is no selection that could fail to resolve.
  const { clients } = fakeClients({
    existing: { channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }], customerGroups: [], stores: [] },
  });
  const r = await runLoad(clients, planWithStore(), config(), { sleep: noSleep });
  assert.ok(!r.diagnostics.some((x) => x.code === 'stores-require-wait'));
});
