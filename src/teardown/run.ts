/**
 * Teardown: remove what a migration created, and nothing else.
 *
 * The scope is the **plan's own keys**, every one of which carries
 * `keys.prefix`. `plan.json` rather than `key-map.json`, because the key map
 * holds only categories, products and variants, and a teardown that missed the
 * ProductTypes, prices, stock and selections would leave most of the work
 * behind. Before anything is deleted, every key is checked against the prefix:
 * a plan key without it means the plan is not what this command was written
 * for, and the answer is to stop.
 *
 * What it will not touch, and says so: channels, customer groups, tax
 * categories and stores. They were created with their keys verbatim — they
 * belong to the project, usually shared — and a tax category cannot be deleted
 * while a product or shipping method uses it anyway. The one exception is a
 * store's *list of product selections*: a selection that a planned store
 * points at cannot be deleted, so the selection is removed from that store
 * first. Any other store holding one of ours is reported and the selection is
 * left.
 *
 * Reverse of the load order, because the references run the other way on the
 * way out: prices and stock before the products they price, selections before
 * the products they list, products before the categories and ProductTypes they
 * use, categories children first.
 *
 * A delete needs the resource's current version, and deleting a product's
 * standalone prices bumps the product's version (observed in a live cleanup,
 * as a 409 `ConcurrentModification`). So a version read before the price
 * deletes is stale by the time the product is deleted. Products are read fresh
 * immediately before each delete, and every other kind retries once on a 409
 * with a fresh read.
 *
 * Dry run unless `execute`. A dry run writes nothing at all.
 */

import type { Clients } from '../client/factory.js';
import type { PipelineConfig } from '../model/config.js';
import type { Diagnostic } from '../contract/validate.js';
import type { MigrationPlan } from '../model/plan.js';
import { planBatches } from '../load/batches.js';
import { chunk, fetchSnapshot, KEYS_PER_QUERY } from '../verify/snapshot.js';
import type { ProjectSnapshot } from '../verify/reconcile.js';

/** In deletion order. */
export const TEARDOWN_KINDS = [
  'standalonePrices',
  'inventory',
  'productSelections',
  'variants',
  'products',
  'categories',
  'productTypes',
  'containers',
] as const;

export type TeardownKind = (typeof TEARDOWN_KINDS)[number];

export interface TeardownFailure {
  kind: TeardownKind | 'taxCategories';
  key: string;
  reason: string;
}

export interface TeardownResult {
  prefix: string;
  executed: boolean;
  /** Keys the plan names, per kind. */
  planned: Record<TeardownKind, number>;
  /** Of those, how many the project holds (a container is read by key, one request each). */
  present: Record<TeardownKind, number>;
  deleted: Record<TeardownKind, number>;
  failed: TeardownFailure[];
  /** Stores a planned selection was removed from, before the selection was deleted. */
  storesChanged: { store: string; removed: string[] }[];
  /** Selections left in place because a store outside the plan still holds them. */
  blocked: { selection: string; stores: string[] }[];
  /**
   * Planned categories left in place because deleting one would delete categories
   * the plan does not name: someone else's, created below it. `below` names them.
   */
  blockedCategories: { category: string; below: string[] }[];
  /** Left alone on purpose: verbatim-keyed, and the project's. */
  untouched: {
    channels: string[];
    customerGroups: string[];
    taxCategories: string[];
    stores: string[];
  };
  /**
   * Tax categories a load of this plan created (from `created-prerequisites.json`,
   * limited to keys the plan names), which of them the project holds, and which of
   * those this run deleted. Deleted only with `removeCreatedTaxCategories`.
   */
  taxCategories: { createdByLoad: string[]; present: string[]; deleted: string[]; removing: boolean };
  /** After an execute: planned resources the project still holds, per kind. */
  remaining?: Record<TeardownKind, number>;
  diagnostics: Diagnostic[];
}

export interface TeardownOptions {
  execute: boolean;
  /** Tax category keys a load created, as recorded by `load`. */
  createdTaxCategories?: string[];
  /**
   * Also delete those tax categories. Off by default: a tax category is the
   * project's, and the API refuses the delete while a product or a shipping
   * method uses it.
   */
  removeCreatedTaxCategories?: boolean;
  /** In-flight deletes within one kind. */
  concurrency?: number;
  /**
   * How often, and how long apart, a product delete is retried while the API still
   * says a product-selection references it, after this run deleted the selections.
   * Defaults to 12 tries 5 seconds apart. Tests set the delay to 0.
   */
  selectionClear?: { attempts: number; delayMs: number };
  /**
   * How often, and how long apart, a category delete is retried while the API says
   * another operation on the category tree is running. Defaults to 6 tries 2 seconds
   * apart. Tests set the delay to 0.
   */
  treeBusy?: { attempts: number; delayMs: number };
}

const zero = (): Record<TeardownKind, number> =>
  Object.fromEntries(TEARDOWN_KINDS.map((k) => [k, 0])) as Record<TeardownKind, number>;

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number; body?: { statusCode?: number } };
  return e?.statusCode ?? e?.status ?? e?.body?.statusCode;
}

function describe(err: unknown): string {
  const e = err as { message?: string; body?: { errors?: { message?: string }[] } };
  const status = statusOf(err);
  const detail = e?.body?.errors?.[0]?.message ?? e?.message ?? String(err);
  return status === undefined ? detail : `${status}: ${detail}`;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** The prefix every plan key must start with. */
export function keyPrefix(config: PipelineConfig): string {
  return `${config.keys.prefix}-`;
}

/**
 * Plan keys that do not start with `<keys.prefix>-`, by kind. Anything here
 * stops the teardown before a single delete: the command's whole safety rests
 * on the prefix being on everything it touches.
 */
export function keysOutsidePrefix(
  plan: MigrationPlan,
  prefix: string,
): { kind: TeardownKind; key: string }[] {
  const bad: { kind: TeardownKind; key: string }[] = [];
  const check = (kind: TeardownKind, keys: string[]) => {
    for (const key of keys) if (!key.startsWith(prefix)) bad.push({ kind, key });
  };
  check('standalonePrices', plan.standalonePrices.map((x) => x.key));
  check('inventory', (plan.inventory ?? []).map((x) => x.key));
  check('variants', plan.variants.map((x) => x.key));
  check('products', plan.products.map((x) => x.key));
  check('productSelections', (plan.productSelections ?? []).map((x) => x.key));
  check('categories', plan.categories.map((x) => x.key));
  check('productTypes', plan.productTypes.map((x) => x.key));
  return bad;
}

/** A planned category's planned parent, if it has one: the parent key of a root is not in the plan. */
function plannedParents(plan: MigrationPlan): Map<string, string | undefined> {
  const keys = new Set(plan.categories.map((c) => c.key));
  return new Map(
    plan.categories.map((c) => {
      const parent = (c.parent as { key?: string } | undefined)?.key;
      return [c.key, parent !== undefined && keys.has(parent) ? parent : undefined];
    }),
  );
}

/**
 * The plan's categories grouped by tree, each tree deepest first.
 *
 * Two reasons, both seen live. A parent must go after its children, because
 * deleting a category deletes everything below it. And the API serialises
 * operations on one category tree: two deletes in the same tree at once, such as
 * two siblings, get a 400 on the second ("another operation on the category tree
 * is performed"). So a tree is deleted one category at a time, and trees run
 * side by side.
 */
function categoryTrees(plan: MigrationPlan): string[][] {
  const parentOf = plannedParents(plan);
  const rootAndDepth = (key: string): { root: string; depth: number } => {
    let depth = 0;
    let at = key;
    const seen = new Set<string>([key]);
    for (let up = parentOf.get(at); up !== undefined && !seen.has(up); up = parentOf.get(at)) {
      seen.add(up);
      depth++;
      at = up;
    }
    return { root: at, depth };
  };
  const trees = new Map<string, { key: string; depth: number }[]>();
  for (const c of plan.categories) {
    const { root, depth } = rootAndDepth(c.key);
    trees.set(root, [...(trees.get(root) ?? []), { key: c.key, depth }]);
  }
  return [...trees.values()].map((members) => members.sort((a, b) => b.depth - a.depth).map((m) => m.key));
}

/**
 * Categories in the project, not in the plan, directly below a planned one.
 *
 * Deleting a category deletes its whole subtree ("Deleting a root Category
 * deletes the whole Category tree", and probed live on 2026-10-06), so a category
 * someone else created under one of ours would go with it without being named
 * anywhere. Keyed by the planned parent. A planned category found below a
 * foreign one is not a problem here: its own children are read like any other's.
 */
async function foreignCategoryChildren(
  clients: Clients,
  plan: MigrationPlan,
  snapshot: ProjectSnapshot,
  presentKeys: string[],
): Promise<Map<string, string[]>> {
  const planned = new Set(plan.categories.map((c) => c.key));
  const keyById = new Map<string, string>();
  for (const key of presentKeys) {
    const id = snapshot.categories.get(key)?.id;
    if (id) keyById.set(id, key);
  }
  const PAGE = 500;
  const found = new Map<string, string[]>();
  for (const ids of chunk([...keyById.keys()], KEYS_PER_QUERY)) {
    const where = `parent(id in (${ids.map((id) => JSON.stringify(id)).join(', ')}))`;
    for (let offset = 0; ; offset += PAGE) {
      const page = (
        await clients.platform.categories().get({ queryArgs: { where, limit: PAGE, offset } }).execute()
      ).body.results;
      for (const child of page) {
        if (child.key !== undefined && planned.has(child.key)) continue;
        const parentKey = keyById.get(child.parent?.id ?? '');
        if (parentKey === undefined) continue;
        found.set(parentKey, [...(found.get(parentKey) ?? []), child.key ?? child.id]);
      }
      if (page.length < PAGE) break;
    }
  }
  return found;
}

/**
 * The planned categories that stay, and the foreign ones each would take with it.
 * A planned ancestor of a category that stays has to stay too: its delete would
 * sweep up the same foreign categories.
 */
function categoriesHeldBack(
  plan: MigrationPlan,
  foreign: Map<string, string[]>,
  presentKeys: string[],
): { category: string; below: string[] }[] {
  const parentOf = plannedParents(plan);
  const held = new Map<string, Set<string>>();
  for (const [planned, below] of foreign) {
    const seen = new Set<string>();
    for (let at: string | undefined = planned; at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      const names = held.get(at) ?? new Set<string>();
      for (const b of below) names.add(b);
      held.set(at, names);
    }
  }
  const present = new Set(presentKeys);
  return [...held]
    .filter(([key]) => present.has(key))
    .map(([category, names]) => ({ category, below: [...names].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

interface Remover {
  /** Current version of the resource, or undefined if it is gone. */
  fresh(key: string): Promise<number | undefined>;
  remove(key: string, version: number): Promise<unknown>;
}

function removers(clients: Clients): Record<Exclude<TeardownKind, 'containers'>, Remover> {
  const p = clients.platform;
  const read = async (get: () => Promise<{ body: { version: number } }>) => {
    try {
      return (await get()).body.version;
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  };
  return {
    standalonePrices: {
      fresh: (key) => read(() => p.standalonePrices().withKey({ key }).get().execute()),
      remove: (key, version) => p.standalonePrices().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    inventory: {
      fresh: (key) => read(() => p.inventory().withKey({ key }).get().execute()),
      remove: (key, version) => p.inventory().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    variants: {
      fresh: (key) => read(() => p.variants().withKey({ key }).get().execute()),
      remove: (key, version) => p.variants().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    products: {
      fresh: (key) => read(() => p.products().withKey({ key }).get().execute()),
      remove: (key, version) => p.products().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    productSelections: {
      fresh: (key) => read(() => p.productSelections().withKey({ key }).get().execute()),
      remove: (key, version) => p.productSelections().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    categories: {
      fresh: (key) => read(() => p.categories().withKey({ key }).get().execute()),
      remove: (key, version) => p.categories().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
    productTypes: {
      fresh: (key) => read(() => p.productTypes().withKey({ key }).get().execute()),
      remove: (key, version) => p.productTypes().withKey({ key }).delete({ queryArgs: { version } }).execute(),
    },
  };
}

function taxCategoryRemover(clients: Clients): Remover {
  const p = clients.platform;
  return {
    fresh: async (key) => {
      try {
        return (await p.taxCategories().withKey({ key }).get().execute()).body.version;
      } catch (err) {
        if (statusOf(err) === 404) return undefined;
        throw err;
      }
    },
    remove: (key, version) => p.taxCategories().withKey({ key }).delete({ queryArgs: { version } }).execute(),
  };
}

/** Deletes one resource. A 404 is success (already gone); a 409 is retried with a fresh version. */
async function deleteOne(
  remover: Remover,
  key: string,
  versionHint: number | undefined,
  alwaysFresh: boolean,
  /** Called on a "referenced by a product-selection" refusal; true means wait was done, try again. */
  onSelectionRefusal?: (key: string) => Promise<boolean>,
  /** Called on a "category tree is busy" refusal; true means wait was done, try again. */
  onTreeBusy?: (key: string) => Promise<boolean>,
): Promise<'deleted' | 'gone'> {
  let version = alwaysFresh ? undefined : versionHint;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (version === undefined) {
      version = await remover.fresh(key);
      if (version === undefined) return 'gone';
    }
    try {
      await remover.remove(key, version);
      return 'deleted';
    } catch (err) {
      const status = statusOf(err);
      if (status === 404) return 'gone';
      if (status === 409) {
        version = undefined;
        continue;
      }
      if (
        status === 400 &&
        onSelectionRefusal !== undefined &&
        /product-selection/.test(describe(err)) &&
        (await onSelectionRefusal(key))
      ) {
        attempt--; // waiting for a reference to clear is not a version conflict
        version = undefined;
        continue;
      }
      if (
        status === 400 &&
        onTreeBusy !== undefined &&
        /category tree/.test(describe(err)) &&
        (await onTreeBusy(key))
      ) {
        // Read it again before retrying: whatever held the tree may have removed
        // this category, which is then gone, not failed.
        attempt--;
        version = undefined;
        continue;
      }
      throw err;
    }
  }
  throw new Error('still conflicting after 3 attempts');
}

async function readAllStores(clients: Clients) {
  const out: { id: string; key?: string; version: number; productSelections?: { productSelection: { id: string } }[] }[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const res = await clients.platform
      .stores()
      .get({ queryArgs: { limit, offset, withTotal: true } })
      .execute();
    out.push(...(res.body.results as never[]));
    if (res.body.results.length === 0 || out.length >= (res.body.total ?? out.length)) break;
  }
  return out;
}

function presentKeys(plan: MigrationPlan, snapshot: ProjectSnapshot): Record<Exclude<TeardownKind, 'containers'>, string[]> {
  return {
    standalonePrices: plan.standalonePrices.map((x) => x.key).filter((k) => snapshot.standalonePrices.has(k)),
    inventory: (plan.inventory ?? []).map((x) => x.key).filter((k) => snapshot.inventory.has(k)),
    variants: plan.variants.map((x) => x.key).filter((k) => snapshot.variants.has(k)),
    products: plan.products.map((x) => x.key).filter((k) => snapshot.products.has(k)),
    productSelections: (plan.productSelections ?? []).map((x) => x.key).filter((k) => snapshot.productSelections.has(k)),
    categories: plan.categories.map((x) => x.key).filter((k) => snapshot.categories.has(k)),
    productTypes: plan.productTypes.map((x) => x.key).filter((k) => snapshot.productTypes.has(k)),
  };
}

function versionOf(kind: Exclude<TeardownKind, 'containers'>, snapshot: ProjectSnapshot, key: string): number | undefined {
  const map = {
    standalonePrices: snapshot.standalonePrices,
    inventory: snapshot.inventory,
    variants: snapshot.variants,
    products: snapshot.products,
    productSelections: snapshot.productSelections,
    categories: snapshot.categories,
    productTypes: snapshot.productTypes,
  }[kind] as Map<string, { version: number }>;
  return map.get(key)?.version;
}

export async function runTeardown(
  clients: Clients,
  plan: MigrationPlan,
  config: PipelineConfig,
  options: TeardownOptions,
): Promise<TeardownResult> {
  const prefix = keyPrefix(config);
  const diagnostics: Diagnostic[] = [];
  const result: TeardownResult = {
    prefix: config.keys.prefix,
    executed: options.execute,
    planned: zero(),
    present: zero(),
    deleted: zero(),
    failed: [],
    storesChanged: [],
    blocked: [],
    blockedCategories: [],
    taxCategories: {
      createdByLoad: [],
      present: [],
      deleted: [],
      removing: options.removeCreatedTaxCategories === true,
    },
    untouched: {
      channels: plan.prerequisites.channels.map((c) => c.key),
      customerGroups: plan.prerequisites.customerGroups.map((c) => c.key),
      taxCategories: (plan.prerequisites.taxCategories ?? []).map((t) => t.key),
      stores: plan.prerequisites.stores.map((s) => s.key),
    },
    diagnostics,
  };

  const outside = keysOutsidePrefix(plan, prefix);
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map((o) => `${o.kind} '${o.key}'`).join(', ');
    diagnostics.push({
      severity: 'error',
      code: 'teardown-key-outside-prefix',
      message:
        `${outside.length} key(s) in the plan do not start with '${prefix}': ${sample}` +
        `${outside.length > 5 ? ', ...' : ''}. Teardown is scoped to keys.prefix and deletes by ` +
        'exact key, so a key outside it means this plan is not the one that was loaded under ' +
        'this config. Nothing was deleted.',
    });
    return result;
  }

  const containerKeys = planBatches(plan, config).containers.map((c) => c.key);
  result.planned = {
    standalonePrices: plan.standalonePrices.length,
    inventory: (plan.inventory ?? []).length,
    variants: plan.variants.length,
    products: plan.products.length,
    productSelections: (plan.productSelections ?? []).length,
    categories: plan.categories.length,
    productTypes: plan.productTypes.length,
    containers: containerKeys.length,
  };

  const { snapshot, diagnostics: readDiagnostics, unreadable } = await fetchSnapshot(clients, plan);
  diagnostics.push(...readDiagnostics);
  if (unreadable.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'teardown-unreadable',
      message:
        `Could not read: ${unreadable.join(', ')}. Nothing was deleted: without the read, a ` +
        'missing scope looks exactly like an empty project, and the teardown could not tell what ' +
        'is there to remove.',
    });
    return result;
  }

  const present = presentKeys(plan, snapshot);
  for (const kind of Object.keys(present) as (keyof typeof present)[]) {
    result.present[kind] = present[kind].length;
  }
  // A container is read by key. They are few (one per resource type, split only
  // past the per-container operation limit), so a request each is cheap, and it
  // keeps the dry run honest about containers that already expired.
  const presentContainers: string[] = [];
  for (const key of containerKeys) {
    try {
      await clients.importApi
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: key })
        .get()
        .execute();
      presentContainers.push(key);
    } catch (err) {
      // Anything but "not there" is treated as there, so a delete is attempted
      // and fails loudly rather than the container being silently skipped.
      if (statusOf(err) !== 404) presentContainers.push(key);
    }
  }
  result.present.containers = presentContainers.length;

  // Which stores hold a selection of ours, so the selection can be deleted.
  const selectionIds = new Map<string, string>(); // id -> key
  for (const key of present.productSelections) {
    const id = snapshot.productSelections.get(key)?.id;
    if (id) selectionIds.set(id, key);
  }
  const plannedStoreKeys = new Set(plan.prerequisites.stores.map((s) => s.key));
  const storeActions: { store: string; version: number; selections: string[] }[] = [];
  const blockedBy = new Map<string, string[]>();
  if (selectionIds.size > 0) {
    let stores;
    try {
      stores = await readAllStores(clients);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'teardown-unreadable',
        message:
          `Could not read the project's stores (${describe(err)}), so it is unknown which ` +
          'of them still hold a planned product selection. Nothing was deleted.',
      });
      return result;
    }
    for (const store of stores) {
      const held = (store.productSelections ?? [])
        .map((s) => selectionIds.get(s.productSelection.id))
        .filter((k): k is string => k !== undefined);
      if (held.length === 0) continue;
      if (store.key !== undefined && plannedStoreKeys.has(store.key)) {
        storeActions.push({ store: store.key, version: store.version, selections: held });
      } else {
        for (const sel of held) blockedBy.set(sel, [...(blockedBy.get(sel) ?? []), store.key ?? store.id]);
      }
    }
  }
  for (const [selection, stores] of blockedBy) result.blocked.push({ selection, stores });

  // Deleting a category deletes everything below it, so a planned category with
  // someone else's category beneath it has to stay. Read before the dry run
  // returns, so the dry run says so too.
  if (present.categories.length > 0) {
    try {
      const foreign = await foreignCategoryChildren(clients, plan, snapshot, present.categories);
      result.blockedCategories = categoriesHeldBack(plan, foreign, present.categories);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'teardown-unreadable',
        message:
          `Could not read the categories below the planned ones (${describe(err)}), so it is ` +
          'unknown whether deleting one would also delete a category this plan does not name. ' +
          'Nothing was deleted.',
      });
      return result;
    }
  }

  // The tax categories a load created: read in a dry run too, so it can say
  // they are there and how to remove them.
  const plannedTax = new Set((plan.prerequisites.taxCategories ?? []).map((t) => t.key));
  result.taxCategories.createdByLoad = [...new Set(options.createdTaxCategories ?? [])].filter((k) =>
    plannedTax.has(k),
  );
  const taxRemover = taxCategoryRemover(clients);
  for (const key of result.taxCategories.createdByLoad) {
    try {
      if ((await taxRemover.fresh(key)) !== undefined) result.taxCategories.present.push(key);
    } catch {
      // Not read, so not known to be gone: treated as there, so that asking for
      // the delete fails loudly rather than skipping it.
      result.taxCategories.present.push(key);
    }
  }

  if (!options.execute) return result;

  const concurrency = options.concurrency ?? 4;
  const ops = removers(clients);

  // Deleting a selection clears the references it holds on its products
  // asynchronously: a product delete a moment later can still be refused with
  // "referenced by at least one product-selection" (probed live on 2026-10-06;
  // a second run a minute later found the references gone). So a refused product
  // is retried for a bounded time, but only when this run deleted selections, and
  // not at all once one product has waited out the limit, which is what happens
  // when a selection is stuck behind a store outside the plan.
  const clear = options.selectionClear ?? { attempts: 12, delayMs: 5_000 };
  let selectionsDeleted = false;
  let giveUp = false;
  const waitForSelectionClear = async (key: string): Promise<boolean> => {
    if (!selectionsDeleted || giveUp) return false;
    waits.set(key, (waits.get(key) ?? 0) + 1);
    if ((waits.get(key) ?? 0) > clear.attempts) {
      giveUp = true;
      return false;
    }
    await new Promise((r) => setTimeout(r, clear.delayMs));
    return true;
  };
  const waits = new Map<string, number>();

  // A category delete is refused while another operation runs on its tree. Within
  // this run trees are deleted one category at a time, so what is left is someone
  // else's operation, or two planned trees under one root outside the plan: both
  // pass on their own, so wait a bounded time and read the category again.
  const treeBusy = options.treeBusy ?? { attempts: 6, delayMs: 2_000 };
  const treeWaits = new Map<string, number>();
  const waitForTree = async (key: string): Promise<boolean> => {
    const n = (treeWaits.get(key) ?? 0) + 1;
    treeWaits.set(key, n);
    if (n > treeBusy.attempts) return false;
    await new Promise((r) => setTimeout(r, treeBusy.delayMs));
    return true;
  };

  const deleteKeys = async (kind: Exclude<TeardownKind, 'containers'>, keys: string[]) => {
    await mapLimit(keys, concurrency, async (key) => {
      try {
        const outcome = await deleteOne(
          ops[kind],
          key,
          versionOf(kind, snapshot, key),
          kind === 'products',
          kind === 'products' ? waitForSelectionClear : undefined,
          kind === 'categories' ? waitForTree : undefined,
        );
        if (outcome === 'deleted') result.deleted[kind]++;
      } catch (err) {
        result.failed.push({ kind, key, reason: describe(err) });
      }
    });
  };

  await deleteKeys('standalonePrices', present.standalonePrices);
  await deleteKeys('inventory', present.inventory);

  // A selection a planned store points at cannot be deleted. Take it off the
  // store first — the one place this command edits something it did not create.
  for (const action of storeActions) {
    try {
      await clients.platform
        .stores()
        .withKey({ key: action.store })
        .post({
          body: {
            version: action.version,
            actions: action.selections.map((key) => ({
              action: 'removeProductSelection' as const,
              productSelection: { typeId: 'product-selection' as const, key },
            })),
          },
        })
        .execute();
      result.storesChanged.push({ store: action.store, removed: action.selections });
    } catch (err) {
      for (const sel of action.selections) {
        result.failed.push({ kind: 'productSelections', key: sel, reason: `could not remove it from store '${action.store}': ${describe(err)}` });
        blockedBy.set(sel, [...(blockedBy.get(sel) ?? []), action.store]);
      }
    }
  }
  const failedSelections = new Set(result.failed.filter((f) => f.kind === 'productSelections').map((f) => f.key));
  await deleteKeys(
    'productSelections',
    present.productSelections.filter((k) => !blockedBy.has(k) && !failedSelections.has(k)),
  );
  selectionsDeleted = result.deleted.productSelections > 0 && blockedBy.size === 0;

  // Selections go before the variants and products they point at: the API
  // refuses to delete a product a selection still references ("Can not delete a
  // product while it is referenced by at least one product-selection", probed
  // live on 2026-10-06). The load imports selections after the products, so the
  // way out is the same order reversed, not the order the references suggest.
  await deleteKeys('variants', present.variants);
  await deleteKeys('products', present.products);

  // Trees side by side, each one category at a time and deepest first. A planned
  // category that holds someone else's stays, and so do its planned ancestors; the
  // planned categories below it still go.
  const deletableCategories = new Set(present.categories);
  for (const held of result.blockedCategories) deletableCategories.delete(held.category);
  await mapLimit(categoryTrees(plan), concurrency, async (tree) => {
    for (const key of tree) {
      if (deletableCategories.has(key)) await deleteKeys('categories', [key]);
    }
  });
  await deleteKeys('productTypes', present.productTypes);

  for (const key of presentContainers) {
    try {
      await clients.importApi
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: key })
        .delete()
        .execute();
      result.deleted.containers++;
    } catch (err) {
      // An expired or never-created container is the normal case, not a failure.
      if (statusOf(err) !== 404) result.failed.push({ kind: 'containers', key, reason: describe(err) });
    }
  }

  // After the products: a product holding the category makes the API refuse it.
  if (options.removeCreatedTaxCategories) {
    for (const key of result.taxCategories.present) {
      try {
        const outcome = await deleteOne(taxRemover, key, undefined, true);
        if (outcome === 'deleted') result.taxCategories.deleted.push(key);
      } catch (err) {
        result.failed.push({ kind: 'taxCategories', key, reason: describe(err) });
      }
    }
  }

  // Verified, not assumed: read the project again.
  const after = await fetchSnapshot(clients, plan);
  if (after.unreadable.length === 0) {
    const left = presentKeys(plan, after.snapshot);
    result.remaining = zero();
    for (const kind of Object.keys(left) as (keyof typeof left)[]) result.remaining[kind] = left[kind].length;
  } else {
    diagnostics.push({
      severity: 'warning',
      code: 'teardown-verify-unreadable',
      message: `Could not read ${after.unreadable.join(', ')} afterwards, so what is left is unknown.`,
    });
  }

  return result;
}

/** One screen of text: what was found, what was done, what was left alone. */
export function renderTeardown(result: TeardownResult): string {
  const labels: Record<TeardownKind, string> = {
    standalonePrices: 'standalone prices',
    inventory: 'inventory entries',
    variants: 'variants (Modular)',
    products: 'products',
    productSelections: 'product selections',
    categories: 'categories',
    productTypes: 'product types',
    containers: 'import containers',
  };
  const lines: string[] = [];
  lines.push(
    result.executed
      ? `Teardown of keys.prefix '${result.prefix}' (executed)`
      : `Teardown of keys.prefix '${result.prefix}' (dry run, nothing deleted; add --execute --confirm-project <key>)`,
  );
  lines.push('');
  for (const kind of TEARDOWN_KINDS) {
    if (result.planned[kind] === 0) continue;
    const base = `  ${labels[kind].padEnd(20)} planned ${String(result.planned[kind]).padStart(6)}   in project ${String(result.present[kind]).padStart(6)}`;
    lines.push(
      result.executed
        ? `${base}   deleted ${String(result.deleted[kind]).padStart(6)}` +
            (result.remaining ? `   left ${String(result.remaining[kind] ?? 0).padStart(6)}` : '')
        : base,
    );
  }
  for (const s of result.storesChanged) {
    lines.push('');
    lines.push(`Removed from store '${s.store}' before deleting: ${s.removed.join(', ')}`);
  }
  for (const b of result.blocked) {
    lines.push('');
    lines.push(
      `NOT deleted: product selection '${b.selection}' is still used by store(s) ${b.stores.join(', ')}, ` +
        'which this plan does not list. Take it off the store(s) and run teardown again.',
    );
  }
  for (const b of result.blockedCategories) {
    lines.push('');
    lines.push(
      `NOT deleted: category '${b.category}' has categories below it that this plan does not name ` +
        `(${b.below.join(', ')}), and deleting it would delete them too. Move or delete those, ` +
        'then run teardown again.',
    );
  }
  const t = result.taxCategories;
  if (t.present.length > 0) {
    lines.push('');
    if (result.executed && t.deleted.length > 0) {
      lines.push(`Tax categories this plan's load created, deleted: ${t.deleted.join(', ')}`);
    } else if (!result.executed && t.removing) {
      lines.push(`Tax categories this plan's load created, would be deleted: ${t.present.join(', ')}`);
    } else if (!t.removing) {
      lines.push(
        `Tax categories this plan's load created, still in the project: ${t.present.join(', ')}. ` +
          'Left alone; add --include-created-tax-categories to delete them (the API refuses ' +
          'while a product or a shipping method uses one).',
      );
    }
  }
  const u = result.untouched;
  const taxLeft = u.taxCategories.filter((k) => !t.deleted.includes(k));
  if (u.channels.length + u.customerGroups.length + taxLeft.length + u.stores.length > 0) {
    lines.push('');
    lines.push("Left alone on purpose (verbatim keys, the project's own):");
    const row = (label: string, keys: string[]) => keys.length > 0 && lines.push(`  ${label}: ${keys.join(', ')}`);
    row('channels', u.channels);
    row('customer groups', u.customerGroups);
    row('tax categories', taxLeft);
    row('stores', u.stores);
  }
  if (result.failed.length > 0) {
    lines.push('');
    lines.push(`${result.failed.length} failure(s):`);
    for (const f of result.failed.slice(0, 20)) lines.push(`  ${f.kind} '${f.key}': ${f.reason}`);
    if (result.failed.length > 20) lines.push(`  ... and ${result.failed.length - 20} more (see teardown-result.json)`);
  }
  return lines.join('\n');
}

/** Whether the teardown finished clean: nothing failed, nothing blocked, nothing left. */
export function teardownComplete(result: TeardownResult): boolean {
  if (result.diagnostics.some((d) => d.severity === 'error')) return false;
  if (!result.executed) return true;
  if (result.failed.length > 0 || result.blocked.length > 0 || result.blockedCategories.length > 0) return false;
  if (!result.remaining) return false;
  return TEARDOWN_KINDS.every((k) => (result.remaining![k] ?? 0) === 0);
}
