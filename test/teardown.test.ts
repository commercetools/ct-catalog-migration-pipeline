/**
 * Teardown against an in-memory project.
 *
 * The fake models the behaviours that make a real cleanup hard, not just the
 * happy path: a delete needs the current version; deleting a product's
 * standalone prices bumps the product's version (the 409 observed in a live
 * cleanup); a category with children, a ProductType in use and a selection
 * held by a store each refuse to be deleted.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { keysOutsidePrefix, renderTeardown, runTeardown, teardownComplete } from '../src/teardown/run.js';
import type { Clients } from '../src/client/factory.js';
import type { MigrationPlan } from '../src/model/plan.js';

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
const SCHEMA = resolve(ROOT, 'schema', 'catalog-feed.schema.json');

function planFor(fixture: string) {
  const { config, feedDir } = loadConfig(resolve(ROOT, 'fixtures', fixture, 'migration.config.json'));
  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const model = deriveProductTypes(feed, config);
  return { config, plan: buildPlan(feed, model, config).plan };
}

// ---------------------------------------------------------------------------
// The fake project
// ---------------------------------------------------------------------------

interface Res {
  id: string;
  key: string;
  version: number;
  [field: string]: unknown;
}

const TREE_BUSY = 'Cannot delete the category while another operation on the category tree is performed.';

class FakeProject {
  kinds = new Map<string, Map<string, Res>>();
  /** `kind:key` per successful delete, in order. */
  log: string[] = [];
  containers = new Set<string>();
  /** Keys whose delete always fails with 500. */
  broken = new Set<string>();
  /** After a selection is deleted, this many product deletes are still refused (the API clears the references asynchronously). */
  clearDelayAttempts = 0;
  private pendingRefusals = 0;
  /** Product delete attempts that reached the API's checks. */
  productDeleteAttempts = 0;
  /** Root ids of category trees with a delete in flight: the API serialises operations on a tree. */
  private treesInFlight = new Set<unknown>();
  /** Category keys whose next N deletes are refused as "tree busy", as another client's operation would. */
  busyTimes = new Map<string, number>();
  /** Of those, the ones that are gone by the time the delete is retried (the tree operation removed them). */
  vanishOnBusy = new Set<string>();
  /** Set to make a category read by parent fail, as a missing scope would. */
  failParentQuery = false;
  /** Every `where` a category list was asked for, to check the foreign-child read is chunked. */
  parentQueries: string[] = [];

  kind(name: string) {
    let m = this.kinds.get(name);
    if (!m) this.kinds.set(name, (m = new Map()));
    return m;
  }

  add(kind: string, key: string, extra: Record<string, unknown> = {}) {
    this.kind(kind).set(key, { id: `id-${kind}-${key}`, key, version: 1, ...extra });
  }

  count(kind: string, prefix = '') {
    return [...this.kind(kind).keys()].filter((k) => k.startsWith(prefix)).length;
  }

  private err(statusCode: number, message: string) {
    return Object.assign(new Error(message), { statusCode });
  }

  endpoint(kind: string) {
    const self = this;
    return () => ({
      get: ({ queryArgs = {} }: { queryArgs?: { where?: string; limit?: number; offset?: number } } = {}) => ({
        execute: async () => {
          const all = [...self.kind(kind).values()];
          const where = queryArgs.where;
          if (kind === 'categories' && where?.startsWith('parent(id in')) {
            // The children of these ids, whoever created them.
            self.parentQueries.push(where);
            if (self.failParentQuery) throw self.err(403, 'insufficient_scope');
            const parents = new Set([...where.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
            const children = all.filter((c) => parents.has(c.parentId as string));
            return {
              body: {
                results: children.map((c) => ({ ...c, parent: { typeId: 'category', id: c.parentId } })),
                total: children.length,
                count: children.length,
              },
            };
          }
          const results = where
            ? (() => {
                const wanted = new Set([...where.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
                return all.filter((r) => wanted.has(r.key));
              })()
            : all.slice(queryArgs.offset ?? 0, (queryArgs.offset ?? 0) + (queryArgs.limit ?? 20));
          return { body: { results, total: where ? results.length : all.length, count: results.length } };
        },
      }),
      withKey: ({ key }: { key: string }) => ({
        get: () => ({
          execute: async () => {
            const r = self.kind(kind).get(key);
            if (!r) throw self.err(404, `no ${kind} ${key}`);
            return { body: r };
          },
        }),
        post: ({ body }: { body: { version: number; actions: { action: string; productSelection: { key: string } }[] } }) => ({
          execute: async () => {
            const r = self.kind(kind).get(key);
            if (!r) throw self.err(404, 'no store');
            if (r.version !== body.version) throw self.err(409, 'ConcurrentModification');
            const gone = new Set(
              body.actions.map((a) => self.kind('productSelections').get(a.productSelection.key)?.id),
            );
            r.productSelections = (r.productSelections as { productSelection: { id: string } }[]).filter(
              (s) => !gone.has(s.productSelection.id),
            );
            r.version++;
            self.log.push(`store-edit:${key}`);
            return { body: r };
          },
        }),
        delete: ({ queryArgs }: { queryArgs: { version: number } }) => ({
          execute: async () => {
            const r = self.kind(kind).get(key);
            if (!r) throw self.err(404, `no ${kind} ${key}`);
            if (self.broken.has(key)) throw self.err(500, 'boom');
            if (r.version !== queryArgs.version) throw self.err(409, 'ConcurrentModification');
            self.refuse(kind, r);
            let tree: unknown;
            if (kind === 'categories') {
              const busy = self.busyTimes.get(key) ?? 0;
              if (busy > 0) {
                self.busyTimes.set(key, busy - 1);
                if (self.vanishOnBusy.has(key)) self.kind(kind).delete(key);
                throw self.err(400, TREE_BUSY);
              }
              // Observed live on 2026-10-07: two deletes in one tree at once, the
              // second is refused. They are one microtask apart here, which is
              // enough for the fake to see them overlap.
              tree = self.rootOf(r);
              if (self.treesInFlight.has(tree)) throw self.err(400, TREE_BUSY);
              self.treesInFlight.add(tree);
              await Promise.resolve();
            }
            self.kind(kind).delete(key);
            self.log.push(`${kind}:${key}`);
            if (kind === 'categories') {
              self.cascade(r.id);
              self.treesInFlight.delete(tree);
            }
            if (kind === 'productSelections') self.pendingRefusals = self.clearDelayAttempts;
            // The observed trap: a price delete changes the product it prices.
            if (kind === 'standalonePrices') for (const p of self.kind('products').values()) p.version++;
            return { body: r };
          },
        }),
      }),
    });
  }

  private rootOf(category: Res): unknown {
    let at = category;
    for (;;) {
      const up = [...this.kind('categories').values()].find((c) => c.id === at.parentId);
      if (!up) return at.id;
      at = up;
    }
  }

  /** Deleting a category deletes its descendants too, without a log entry of their own. */
  private cascade(parentId: unknown) {
    for (const c of [...this.kind('categories').values()]) {
      if (c.parentId === parentId) {
        this.kind('categories').delete(c.key);
        this.cascade(c.id);
      }
    }
  }

  /** The API's own refusals. */
  private refuse(kind: string, r: Res) {
    // Not modelled, on purpose: the API does NOT refuse to delete a category with
    // children. It deletes the whole subtree ("Deleting a root Category deletes
    // the whole Category tree", and probed live on 2026-10-06), see `cascade`.
    if (kind === 'productTypes') {
      const user = [...this.kind('products').values()].find((p) => p.productTypeId === r.id);
      if (user) throw this.err(400, `product type ${r.key} is used by ${user.key}`);
    }
    if (kind === 'products') {
      this.productDeleteAttempts++;
      if (this.pendingRefusals > 0) {
        this.pendingRefusals--;
        throw this.err(400, `product ${r.key} is referenced by product-selection (reference not cleared yet)`);
      }
      // Observed live on 2026-10-06: "Can not delete a product while it is
      // referenced by at least one product-selection." A selection that is
      // still there and lists the product blocks its delete.
      const holder = [...this.kind('productSelections').values()].find((sel) =>
        (sel.assigns as string[] | undefined)?.includes(r.id),
      );
      if (holder) throw this.err(400, `product ${r.key} is referenced by product-selection ${holder.key}`);
    }
    if (kind === 'productSelections') {
      const store = [...this.kind('stores').values()].find((s) =>
        (s.productSelections as { productSelection: { id: string } }[]).some((x) => x.productSelection.id === r.id),
      );
      if (store) throw this.err(400, `selection ${r.key} is used by store ${store.key}`);
    }
  }

  clients(): Clients {
    const self = this;
    const names: Record<string, string> = {
      productTypes: 'productTypes',
      categories: 'categories',
      products: 'products',
      variants: 'variants',
      standalonePrices: 'standalonePrices',
      productSelections: 'productSelections',
      inventory: 'inventory',
      stores: 'stores',
      taxCategories: 'taxCategories',
    };
    const platform = Object.fromEntries(Object.entries(names).map(([n, k]) => [n, self.endpoint(k)]));
    return {
      platform,
      importApi: {
        importContainers: () => ({
          withImportContainerKeyValue: ({ importContainerKey }: { importContainerKey: string }) => ({
            get: () => ({
              execute: async () => {
                if (!self.containers.has(importContainerKey)) throw self.err(404, 'no container');
                return { body: { key: importContainerKey } };
              },
            }),
            delete: () => ({
              execute: async () => {
                if (!self.containers.has(importContainerKey)) throw self.err(404, 'no container');
                self.containers.delete(importContainerKey);
                self.log.push(`container:${importContainerKey}`);
                return {};
              },
            }),
          }),
        }),
      },
    } as unknown as Clients;
  }
}

/** A project that holds everything the plan names, plus things that are not ours. */
function projectHolding(plan: MigrationPlan, prefix: string) {
  const world = new FakeProject();
  for (const t of plan.productTypes) world.add('productTypes', t.key);
  for (const c of plan.categories) {
    const parent = (c.parent as { key?: string } | undefined)?.key;
    world.add('categories', c.key, parent ? { parentId: `id-categories-${parent}` } : {});
  }
  for (const p of plan.products) {
    world.add('products', p.key, { productTypeId: `id-productTypes-${(p.productType as { key: string }).key}` });
  }
  for (const v of plan.variants) world.add('variants', v.key);
  for (const sp of plan.standalonePrices) world.add('standalonePrices', sp.key);
  for (const i of plan.inventory ?? []) world.add('inventory', i.key);
  // A selection lists the products it assigns; the API refuses to delete a
  // product while one does. Modelled conservatively: each selection holds every product.
  const productIds = plan.products.map((p) => `id-products-${p.key}`);
  for (const s of plan.productSelections ?? []) world.add('productSelections', s.key, { assigns: productIds });
  for (const st of plan.prerequisites.stores) {
    world.add('stores', st.key, {
      productSelections: st.productSelections
        .map((s) => world.kind('productSelections').get(s.key))
        .filter((s): s is Res => s !== undefined)
        .map((s) => ({ productSelection: { typeId: 'product-selection', id: s.id }, active: true })),
    });
  }
  // Not ours: a different engagement's resources, and the project's own.
  world.add('products', 'other-1');
  world.add('categories', 'other-cat');
  world.add('productTypes', 'other-type');
  for (const t of plan.prerequisites.taxCategories ?? []) world.add('taxCategories', t.key);
  for (const b of ['product-draft', 'category', 'product-type']) world.containers.add(`${prefix}-${b}`);
  return world;
}

const PREFIX = 'mig';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('teardown: a dry run reports what it would remove and deletes nothing', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  const before = JSON.stringify([...world.kinds].map(([k, m]) => [k, [...m.keys()]]));

  const r = await runTeardown(world.clients(), plan, config, { execute: false });
  assert.equal(r.executed, false);
  assert.equal(r.present.products, plan.products.length);
  assert.equal(r.present.standalonePrices, plan.standalonePrices.length);
  assert.deepEqual(world.log, [], 'a dry run writes nothing');
  assert.equal(JSON.stringify([...world.kinds].map(([k, m]) => [k, [...m.keys()]])), before);
  assert.ok(teardownComplete(r));
});

test('teardown: --execute removes the plan in reverse load order and leaves other resources alone', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, []);
  assert.ok(teardownComplete(r), JSON.stringify(r.remaining));

  // Everything of ours is gone ...
  for (const kind of ['standalonePrices', 'products', 'categories', 'productTypes', 'inventory', 'productSelections']) {
    assert.equal(world.count(kind, `${PREFIX}-`), 0, kind);
  }
  assert.equal(world.containers.size, 0);
  // ... and nothing else was.
  assert.ok(world.kind('products').has('other-1'));
  assert.ok(world.kind('categories').has('other-cat'));
  assert.ok(world.kind('productTypes').has('other-type'));
  for (const t of plan.prerequisites.taxCategories ?? []) {
    assert.ok(world.kind('taxCategories').has(t.key), 'verbatim-keyed tax categories are never touched');
  }

  // Order: prices before products before categories before product types.
  const first = (prefix: string) => world.log.findIndex((e) => e.startsWith(prefix));
  const last = (prefix: string) => world.log.map((e) => e.startsWith(prefix)).lastIndexOf(true);
  assert.ok(last('standalonePrices:') < first('products:'));
  assert.ok(last('products:') < first('categories:'));
  assert.ok(last('categories:') < first('productTypes:'));
});

test('teardown: categories are deleted children first', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  const withChildren = plan.categories.filter((c) => (c.parent as { key?: string } | undefined)?.key);
  assert.ok(withChildren.length > 0, 'the fixture needs a category tree');

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, []);
  // The API deletes a whole subtree with its root, so the order is what keeps a delete
  // from sweeping up children that were meant to be deleted (and logged) one by one.
  const order = world.log.filter((e) => e.startsWith('categories:')).map((e) => e.slice('categories:'.length));
  for (const child of withChildren) {
    const parent = (child.parent as { key: string }).key;
    assert.ok(order.indexOf(child.key) < order.indexOf(parent), `${child.key} before its parent ${parent}`);
  }
});

// ---------------------------------------------------------------------------
// Category trees
// ---------------------------------------------------------------------------

/** The fixture plan with one more level: a category under `<prefix>-tops`. */
function planWithGrandchild() {
  const { config, plan } = planFor('classic-standalone');
  const template = plan.categories[0];
  const grandchild = { ...template, key: `${PREFIX}-sleeves`, parent: { typeId: 'category', key: `${PREFIX}-tops` } };
  return { config, plan: { ...plan, categories: [...plan.categories, grandchild] } as MigrationPlan };
}

test('teardown: sibling categories in one tree are deleted one at a time, not in parallel', async () => {
  // The API serialises operations on a category tree and refuses the second of two
  // concurrent deletes: seen live on 2026-10-07 as a 400 on one of two siblings.
  const { config, plan } = planFor('classic-standalone');
  const parents = plan.categories.map((c) => (c.parent as { key?: string } | undefined)?.key).filter(Boolean);
  assert.ok(new Set(parents).size < parents.length, 'the fixture needs two categories under one parent');
  const world = projectHolding(plan, PREFIX);

  const r = await runTeardown(world.clients(), plan, config, { execute: true, concurrency: 4 });
  assert.deepEqual(r.failed, []);
  assert.equal(world.count('categories', `${PREFIX}-`), 0);
  assert.equal(r.deleted.categories, plan.categories.length, 'each one deleted by its own request, none swept up by a parent');
});

test('teardown: a category refused because its tree is busy is retried', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.busyTimes.set(`${PREFIX}-tops`, 2);

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    treeBusy: { attempts: 5, delayMs: 0 },
  });
  assert.deepEqual(r.failed, []);
  assert.equal(world.count('categories', `${PREFIX}-`), 0);
  assert.equal(r.deleted.categories, plan.categories.length);
});

test('teardown: a category refused as busy that is gone when read again counts as deleted, not failed', async () => {
  // The first live Modular teardown: the 400 was followed by the category
  // disappearing with its parent's tree, and the run reported a failure for a
  // category that no longer existed.
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.busyTimes.set(`${PREFIX}-outerwear`, 1);
  world.vanishOnBusy.add(`${PREFIX}-outerwear`);

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    treeBusy: { attempts: 5, delayMs: 0 },
  });
  assert.deepEqual(r.failed, []);
  assert.equal(r.remaining?.categories, 0);
  assert.equal(teardownComplete(r), true);
});

test('teardown: a tree that stays busy is reported after a bounded wait', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.busyTimes.set(`${PREFIX}-tops`, 1000);

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    treeBusy: { attempts: 3, delayMs: 0 },
  });
  const f = r.failed.find((x) => x.key === `${PREFIX}-tops`);
  assert.ok(f);
  assert.match(f.reason, /category tree/);
  assert.equal(teardownComplete(r), false);
});

test('teardown: a category someone else created under a planned one is left, with its ancestors, and named', async () => {
  const { config, plan } = planWithGrandchild();
  const world = projectHolding(plan, PREFIX);
  // Not ours: a category under `<prefix>-tops`. Deleting `tops` would delete it too.
  world.add('categories', 'colleague-category', { parentId: `id-categories-${PREFIX}-tops` });

  const r = await runTeardown(world.clients(), plan, config, { execute: true });

  assert.ok(world.kind('categories').has('colleague-category'), "someone else's category survives");
  // `tops` holds it, and `apparel` holds `tops`: both stay.
  for (const held of [`${PREFIX}-tops`, `${PREFIX}-apparel`]) {
    assert.ok(world.kind('categories').has(held), `${held} is held back`);
  }
  // Everything that can go still goes: the planned leaf under `tops`, the sibling and the other root.
  for (const gone of [`${PREFIX}-sleeves`, `${PREFIX}-outerwear`, `${PREFIX}-accessories`]) {
    assert.ok(!world.kind('categories').has(gone), `${gone} is deleted`);
  }
  assert.deepEqual(
    r.blockedCategories.map((b) => b.category).sort(),
    [`${PREFIX}-apparel`, `${PREFIX}-tops`],
  );
  assert.deepEqual(r.blockedCategories.find((b) => b.category === `${PREFIX}-tops`)?.below, ['colleague-category']);
  assert.deepEqual(r.blockedCategories.find((b) => b.category === `${PREFIX}-apparel`)?.below, ['colleague-category']);
  assert.equal(r.remaining?.categories, 2);
  assert.equal(teardownComplete(r), false);
  assert.match(renderTeardown(r), /NOT deleted: category '.*tops' .*colleague-category/s);
});

test('teardown: the dry run names the held-back categories and deletes nothing', async () => {
  const { config, plan } = planWithGrandchild();
  const world = projectHolding(plan, PREFIX);
  world.add('categories', 'colleague-category', { parentId: `id-categories-${PREFIX}-tops` });
  const before = world.count('categories');

  const r = await runTeardown(world.clients(), plan, config, { execute: false });
  assert.equal(world.count('categories'), before);
  assert.deepEqual(
    r.blockedCategories.map((b) => b.category).sort(),
    [`${PREFIX}-apparel`, `${PREFIX}-tops`],
  );
});

test('teardown: the foreign-category read is chunked and asks for children by parent id', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);

  await runTeardown(world.clients(), plan, config, { execute: false });
  assert.ok(world.parentQueries.length >= 1);
  for (const where of world.parentQueries) {
    assert.match(where, /^parent\(id in \("id-categories-[^"]+"(, "id-categories-[^"]+")*\)\)$/);
  }
});

test('teardown: a category tree that cannot be read stops the run before any delete', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.failParentQuery = true;

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  const d = r.diagnostics.find((x) => x.code === 'teardown-unreadable');
  assert.ok(d);
  assert.match(d.message, /categor/);
  assert.deepEqual(world.log, []);
});

test('teardown: nothing is held back when every category under a planned one is planned', async () => {
  const { config, plan } = planWithGrandchild();
  const world = projectHolding(plan, PREFIX);
  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.blockedCategories, []);
  assert.equal(world.count('categories', `${PREFIX}-`), 0);
});

test('teardown: a product whose version moved under its price deletes is still removed', async () => {
  // The fake bumps every product's version when a standalone price is deleted.
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  assert.ok(plan.standalonePrices.length > 0);

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, [], 'a stale version must not become a 409 failure');
  assert.equal(world.count('products', `${PREFIX}-`), 0);
});

test('teardown: a plan key outside keys.prefix stops everything before any delete', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  const tampered = { ...plan, products: [{ ...plan.products[0], key: 'not-ours-1' }, ...plan.products.slice(1)] };
  assert.deepEqual(keysOutsidePrefix(tampered, 'mig-'), [{ kind: 'products', key: 'not-ours-1' }]);

  const r = await runTeardown(world.clients(), tampered, config, { execute: true });
  assert.equal(r.diagnostics[0].code, 'teardown-key-outside-prefix');
  assert.deepEqual(world.log, []);
  assert.equal(teardownComplete(r), false);
});

test('teardown: a selection held by a planned store is taken off the store, then deleted', async () => {
  const { config, plan } = planFor('stores');
  assert.ok((plan.productSelections ?? []).length > 0 && plan.prerequisites.stores.length > 0, 'the fixture needs stores and selections');
  const world = projectHolding(plan, PREFIX);
  const store = plan.prerequisites.stores.find((s) => s.productSelections.length > 0)!;

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, []);
  assert.ok(r.storesChanged.some((s) => s.store === store.key), 'the store was edited');
  assert.equal(world.count('productSelections', `${PREFIX}-`), 0);
  assert.ok(world.kind('stores').has(store.key), 'the store itself is never deleted');
  assert.equal((world.kind('stores').get(store.key)!.productSelections as unknown[]).length, 0);
  assert.ok(teardownComplete(r));
});

test('teardown: selections are deleted before the products they list', async () => {
  // The API refuses to delete a product while a product-selection still
  // references it, so the reverse of the load order has selections first.
  // Probed live on 2026-10-06; the first version deleted products first and
  // every selection-carrying plan failed at its products.
  const { config, plan } = planFor('stores');
  assert.ok((plan.productSelections ?? []).length > 0, 'the fixture needs a selection');
  const world = projectHolding(plan, PREFIX);

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, [], JSON.stringify(r.failed));
  assert.equal(world.count('products', `${PREFIX}-`), 0);
  assert.equal(world.count('productTypes', `${PREFIX}-`), 0);
  const first = (prefix: string) => world.log.findIndex((e) => e.startsWith(prefix));
  const last = (prefix: string) => world.log.map((e) => e.startsWith(prefix)).lastIndexOf(true);
  assert.ok(last('productSelections:') < first('products:'), world.log.join(' | '));
  assert.ok(teardownComplete(r));
});

test('teardown: a product refused while the selection reference clears is retried and then deleted', async () => {
  const { config, plan } = planFor('stores');
  const world = projectHolding(plan, PREFIX);
  world.clearDelayAttempts = 3;

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    selectionClear: { attempts: 5, delayMs: 0 },
  });
  assert.deepEqual(r.failed, [], JSON.stringify(r.failed));
  assert.equal(world.count('products', `${PREFIX}-`), 0);
  assert.ok(teardownComplete(r));
  assert.ok(world.productDeleteAttempts > plan.products.length, 'at least one product was retried');
});

test('teardown: a reference that never clears is reported after a bounded wait, not forever', async () => {
  const { config, plan } = planFor('stores');
  const world = projectHolding(plan, PREFIX);
  world.clearDelayAttempts = 1000;

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    selectionClear: { attempts: 2, delayMs: 0 },
  });
  assert.ok(r.failed.some((f) => f.kind === 'products'), 'the product failure is reported');
  assert.equal(teardownComplete(r), false);
  assert.ok(world.productDeleteAttempts <= plan.products.length * 4, `bounded: ${world.productDeleteAttempts}`);
});

test('teardown: a selection stuck behind an outside store does not make products wait', async () => {
  const { config, plan } = planFor('stores');
  const world = projectHolding(plan, PREFIX);
  const sel = [...world.kind('productSelections').values()][0];
  world.add('stores', 'somebody-elses', {
    productSelections: [{ productSelection: { typeId: 'product-selection', id: sel.id }, active: true }],
  });

  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    selectionClear: { attempts: 1000, delayMs: 60_000 },
  });
  assert.equal(r.blocked.length, 1);
  assert.equal(world.productDeleteAttempts, plan.products.length, 'one attempt each, no waiting');
  assert.equal(teardownComplete(r), false);
});

test('teardown: a selection held by a store outside the plan is left, named, and the run is not complete', async () => {
  const { config, plan } = planFor('stores');
  const world = projectHolding(plan, PREFIX);
  const sel = [...world.kind('productSelections').values()][0];
  world.add('stores', 'somebody-elses', {
    productSelections: [{ productSelection: { typeId: 'product-selection', id: sel.id }, active: true }],
  });
  // Also keep it off the planned store, so only the outside store holds it.
  for (const s of world.kind('stores').values()) {
    if (s.key !== 'somebody-elses') {
      s.productSelections = (s.productSelections as { productSelection: { id: string } }[]).filter(
        (x) => x.productSelection.id !== sel.id,
      );
    }
  }

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].selection, sel.key);
  assert.deepEqual(r.blocked[0].stores, ['somebody-elses']);
  assert.ok(world.kind('productSelections').has(sel.key), 'left in place');
  assert.equal(world.kind('stores').get('somebody-elses')!.version, 1, 'a store outside the plan is never edited');
  assert.equal(teardownComplete(r), false);
});

test('teardown: a delete that fails is reported, the rest continues, and the run is not complete', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  const victim = plan.standalonePrices[0].key;
  world.broken.add(victim);

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].key, victim);
  assert.match(r.failed[0].reason, /500/);
  assert.equal(r.remaining!.standalonePrices, 1);
  assert.equal(world.count('products', `${PREFIX}-`), 0, 'the rest went on');
  assert.equal(teardownComplete(r), false);
});

test('teardown: resources already gone, and containers that expired, are not failures', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.containers.clear();
  world.kind('standalonePrices').clear();

  const r = await runTeardown(world.clients(), plan, config, { execute: true });
  assert.deepEqual(r.failed, []);
  assert.ok(teardownComplete(r));
});

test('teardown cli: --execute without --confirm-project is refused before anything is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-teardown-'));
  const env = join(dir, '.env');
  writeFileSync(
    env,
    'CTP_PROJECT_KEY=some-project\nCTP_CLIENT_ID=x\nCTP_CLIENT_SECRET=y\n' +
      'CTP_AUTH_URL=https://auth.example.invalid\nCTP_API_URL=https://api.example.invalid\n' +
      'CTP_IMPORT_URL=https://import.example.invalid\n',
  );
  const cli = resolve(ROOT, 'dist-test', 'src', 'cli.js');
  const run = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [cli, 'teardown', '--execute', '--config', resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json'), '--env', env, ...extra],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    );

  const none = run([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--execute needs --confirm-project some-project/);

  const wrong = run(['--confirm-project', 'another-project']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not match the credentials' project 'some-project'/);
});

test('teardown: the dry run counts only the containers that still exist', async () => {
  const { config, plan } = planFor('classic-standalone');
  const world = projectHolding(plan, PREFIX);
  world.containers.delete(`${PREFIX}-product-draft`);

  const r = await runTeardown(world.clients(), plan, config, { execute: false });
  assert.ok(r.planned.containers > r.present.containers, 'one of the planned containers is already gone');
  assert.equal(r.present.containers, world.containers.size);
});

// ---------------------------------------------------------------------------
// Tax categories a load created
// ---------------------------------------------------------------------------

/** The plan, with one tax category in it, held by the project. */
function withTaxCategory(prefix: string) {
  const { config, plan: base } = planFor('classic-standalone');
  const plan = {
    ...base,
    prerequisites: {
      ...base.prerequisites,
      taxCategories: [{ key: 'standard', name: 'standard', rates: [] }],
    },
  } as MigrationPlan;
  const world = projectHolding(plan, prefix);
  return { config, plan, world };
}

test('teardown: a tax category the load created is reported and left, with the flag that removes it', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: ['standard'],
  });
  assert.deepEqual(r.taxCategories.createdByLoad, ['standard']);
  assert.deepEqual(r.taxCategories.present, ['standard']);
  assert.deepEqual(r.taxCategories.deleted, []);
  assert.ok(world.kind('taxCategories').has('standard'), 'still the project\'s unless asked');
  assert.match(renderTeardown(r), /still in the project: standard.*--include-created-tax-categories/s);
  assert.ok(teardownComplete(r));
});

test('teardown: with the flag the created tax category goes, after the products', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: ['standard'],
    removeCreatedTaxCategories: true,
  });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.taxCategories.deleted, ['standard']);
  assert.equal(world.kind('taxCategories').has('standard'), false);
  assert.ok(world.log.indexOf('taxCategories:standard') > world.log.findLastIndex((e) => e.startsWith('products:')));
  const text = renderTeardown(r);
  assert.match(text, /load created, deleted: standard/);
  assert.doesNotMatch(text, /tax categories: standard/, 'no longer listed as left alone');
  assert.ok(teardownComplete(r));
});

test('teardown: a tax category the plan names but no load of it created is never removed', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: [],
    removeCreatedTaxCategories: true,
  });
  assert.deepEqual(r.taxCategories.createdByLoad, []);
  assert.ok(world.kind('taxCategories').has('standard'), 'it was there before this plan: the project\'s');
});

test('teardown: a recorded key the plan does not name is ignored, not deleted', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  world.add('taxCategories', 'someone-elses');
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: ['someone-elses'],
    removeCreatedTaxCategories: true,
  });
  assert.deepEqual(r.taxCategories.createdByLoad, []);
  assert.ok(world.kind('taxCategories').has('someone-elses'));
});

test('teardown: a dry run with the flag says what it would delete and deletes nothing', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  const r = await runTeardown(world.clients(), plan, config, {
    execute: false,
    createdTaxCategories: ['standard'],
    removeCreatedTaxCategories: true,
  });
  assert.match(renderTeardown(r), /would be deleted: standard/);
  assert.deepEqual(world.log, []);
});

test('teardown: a created tax category that is already gone is neither listed nor a failure', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  world.kind('taxCategories').delete('standard');
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: ['standard'],
    removeCreatedTaxCategories: true,
  });
  assert.deepEqual(r.taxCategories.present, []);
  assert.deepEqual(r.failed, []);
  assert.ok(teardownComplete(r));
});

test('teardown: a tax category the API refuses to delete is reported as a failure, and the run is not complete', async () => {
  const { config, plan, world } = withTaxCategory(PREFIX);
  world.broken.add('standard');
  const r = await runTeardown(world.clients(), plan, config, {
    execute: true,
    createdTaxCategories: ['standard'],
    removeCreatedTaxCategories: true,
  });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].kind, 'taxCategories');
  assert.equal(r.taxCategories.deleted.length, 0);
  assert.equal(teardownComplete(r), false);
});
