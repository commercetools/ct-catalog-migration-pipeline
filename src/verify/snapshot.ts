/**
 * Reading the project back, for exactly the resources the plan names.
 *
 * Two ways to do this and only one of them scales. Fetching every resource and
 * filtering locally reads a whole catalog to check three products; asking for
 * the planned keys asks for what is needed. So each kind is fetched with a
 * `key in (...)` predicate, chunked, because a predicate carrying 20,000 keys
 * is a URL nobody's gateway will accept.
 *
 * Every call here is a GET. `verify` never writes — it is the one credentialed
 * stage that cannot change anything, which is what makes it safe to run
 * against production while a load is still in question.
 */

import type {
  Category,
  InventoryEntry,
  Product,
  ProductSelection,
  ProductType,
  StandalonePrice,
  Store,
  TaxCategory,
  Variant,
} from '@commercetools/platform-sdk';

import type { Clients } from '../client/factory.js';
import type { MigrationPlan } from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import type { ProjectSnapshot } from './reconcile.js';
import { noProgress, type Progress } from '../progress/progress.js';

/**
 * Keys per `key in (...)` predicate.
 *
 * Conservative on purpose: 100 keys of ~30 characters is a predicate of about
 * 3kB, comfortably inside any URL limit, and the request count stays sane for
 * a catalog of any size. Raising it trades a smaller number of requests for a
 * cliff nobody discovers until a large engagement.
 */
export const KEYS_PER_QUERY = 100;

/** `key in ("a","b")`, with quotes escaped. */
export function keyPredicate(keys: string[]): string {
  const quoted = keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',');
  return `key in (${quoted})`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Pages one resource kind by key.
 *
 * A read that fails is a diagnostic rather than a throw: a verification that
 * dies halfway is less useful than one that reports what it could not see.
 * The reconciler would otherwise read an empty map as "everything is missing"
 * and bury the real cause — so a failed fetch marks the kind unreadable and
 * the caller skips comparing it.
 */
async function fetchByKey<T>(
  kind: string,
  keys: string[],
  query: (predicate: string) => Promise<T[]>,
  keyOf: (item: T) => string | undefined,
  diagnostics: Diagnostic[],
  track?: ReadTracker,
): Promise<{ byKey: Map<string, T>; readable: boolean }> {
  const byKey = new Map<string, T>();
  if (keys.length === 0) return { byKey, readable: true };
  if (track) Object.assign(track, { kind, done: 0, total: keys.length });

  for (const part of chunk(keys, KEYS_PER_QUERY)) {
    track?.poll?.();
    try {
      for (const item of await query(keyPredicate(part))) {
        const key = keyOf(item);
        if (key !== undefined) byKey.set(key, item);
      }
      if (track) track.done += part.length;
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'verify-read-failed',
        message:
          `Could not read ${kind} from the project: ${describeError(err)}\n` +
          `      ${keys.length} planned ${kind} could not be checked. Verification needs ` +
          'view_products for the catalog and view_standalone_prices for prices — reading ' +
          'is a different scope set from writing.',
      });
      return { byKey, readable: false };
    }
  }

  return { byKey, readable: true };
}

/** What a tick says about the read in progress: counters only, updated freely and printed on ticks. */
interface ReadTracker {
  kind: string;
  done: number;
  total: number;
  /** Lets a tick fall due before each read, so it names the read that is about to wait. */
  poll?: () => void;
}

export interface SnapshotResult {
  snapshot: ProjectSnapshot;
  diagnostics: Diagnostic[];
  /** Kinds that could not be read at all, so a comparison would be misleading. */
  unreadable: string[];
}

export async function fetchSnapshot(
  clients: Clients,
  plan: MigrationPlan,
  progress: Progress = noProgress,
): Promise<SnapshotResult> {
  const diagnostics: Diagnostic[] = [];
  const unreadable: string[] = [];
  const track: ReadTracker = { kind: 'the project', done: 0, total: 0, poll: () => progress.poll() };
  const activity = progress.activity('read project');
  activity.status(
    () =>
      `reading ${track.kind}: ${track.done.toLocaleString('en-US')}/${track.total.toLocaleString('en-US')} planned key(s)`,
  );

  const productTypes = await fetchByKey<ProductType>(
    'product type(s)',
    plan.productTypes.map((p) => p.key),
    async (where) =>
      (await clients.platform.productTypes().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (p) => p.key,
    diagnostics,
    track,
  );
  if (!productTypes.readable) unreadable.push('productTypes');

  const categories = await fetchByKey<Category>(
    'category(ies)',
    plan.categories.map((c) => c.key),
    async (where) =>
      (await clients.platform.categories().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (c) => c.key,
    diagnostics,
    track,
  );
  if (!categories.readable) unreadable.push('categories');

  const products = await fetchByKey<Product>(
    'product(s)',
    plan.products.map((p) => p.key),
    async (where) =>
      (await clients.platform.products().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (p) => p.key,
    diagnostics,
    track,
  );
  if (!products.readable) unreadable.push('products');

  // Modular only: under Classic `plan.variants` is empty and no request is
  // made. A Modular product carries no variants, so reading them off the
  // product — which is what the Classic path does — would report every planned
  // variant as missing.
  const variants = await fetchByKey<Variant>(
    'variant(s)',
    plan.variants.map((v) => v.key),
    async (where) =>
      (await clients.platform.variants().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (v) => v.key,
    diagnostics,
    track,
  );
  if (!variants.readable) unreadable.push('variants');

  const standalonePrices = await fetchByKey<StandalonePrice>(
    'standalone price(s)',
    plan.standalonePrices.map((p) => p.key),
    async (where) =>
      (
        await clients.platform
          .standalonePrices()
          .get({ queryArgs: { where, limit: KEYS_PER_QUERY } })
          .execute()
      ).body.results,
    (p) => p.key,
    diagnostics,
    track,
  );
  if (!standalonePrices.readable) unreadable.push('standalonePrices');

  const productSelections = await fetchByKey<ProductSelection>(
    'product selection(s)',
    (plan.productSelections ?? []).map((sel) => sel.key),
    async (where) =>
      (
        await clients.platform
          .productSelections()
          .get({ queryArgs: { where, limit: KEYS_PER_QUERY } })
          .execute()
      ).body.results,
    (sel) => sel.key,
    diagnostics,
    track,
  );
  if (!productSelections.readable) unreadable.push('productSelections');

  const inventory = await fetchByKey<InventoryEntry>(
    'inventory entry(ies)',
    (plan.inventory ?? []).map((entry) => entry.key),
    async (where) =>
      (
        await clients.platform
          .inventory()
          .get({ queryArgs: { where, limit: KEYS_PER_QUERY } })
          .execute()
      ).body.results,
    (entry) => entry.key,
    diagnostics,
    track,
  );
  if (!inventory.readable) unreadable.push('inventory');

  // Stores are keyed verbatim, not prefixed, so the predicate is built from
  // the prerequisite list rather than from a prefixed plan collection.
  const stores = await fetchByKey<Store>(
    'store(s)',
    (plan.prerequisites?.stores ?? []).map((st) => st.key),
    async (where) =>
      (await clients.platform.stores().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (st) => st.key,
    diagnostics,
    track,
  );
  if (!stores.readable) unreadable.push('stores');

  // Verbatim keys again, from the prerequisites. Read even though `load` never
  // modifies one: a product's taxCategory comes back as an id, and this is
  // what turns it into a key the plan can be compared against.
  const taxCategories = await fetchByKey<TaxCategory>(
    'tax category(ies)',
    (plan.prerequisites?.taxCategories ?? []).map((t) => t.key),
    async (where) =>
      (await clients.platform.taxCategories().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (t) => t.key,
    diagnostics,
    track,
  );
  if (!taxCategories.readable) unreadable.push('taxCategories');

  // References come back as ids. These maps are built from what was just
  // fetched, so a reference to something outside the plan stays unresolved —
  // which is information, not a gap: the reconciler reports it as unplanned
  // rather than silently treating it as a match.
  const categoryKeyById = new Map<string, string>();
  for (const [key, category] of categories.byKey) categoryKeyById.set(category.id, key);

  const productTypeKeyById = new Map<string, string>();
  for (const [key, productType] of productTypes.byKey) {
    productTypeKeyById.set(productType.id, key);
  }

  // A store's productSelections come back as id references, so verifying that
  // a store points at the *planned* selection needs the reverse map.
  const productSelectionKeyById = new Map<string, string>();
  for (const [key, sel] of productSelections.byKey) productSelectionKeyById.set(sel.id, key);

  const taxCategoryKeyById = new Map<string, string>();
  for (const [key, category] of taxCategories.byKey) taxCategoryKeyById.set(category.id, key);

  activity.done();

  return {
    snapshot: {
      productTypes: productTypes.byKey,
      categories: categories.byKey,
      products: products.byKey,
      variants: variants.byKey,
      standalonePrices: standalonePrices.byKey,
      productSelections: productSelections.byKey,
      inventory: inventory.byKey,
      stores: stores.byKey,
      taxCategories: taxCategories.byKey,
      categoryKeyById,
      productTypeKeyById,
      productSelectionKeyById,
      taxCategoryKeyById,
    },
    diagnostics,
    unreadable,
  };
}

function describeError(err: unknown): string {
  const e = err as { statusCode?: number; status?: number; message?: string };
  const status = e.statusCode ?? e.status;
  const message = e.message ?? String(err);
  if (status === 403) {
    return `${message} — the API Client lacks a read scope.`;
  }
  return status === undefined ? message : `${status}: ${message}`;
}

/**
 * How many import operations are still in flight for this plan's containers.
 *
 * `verify` reads the project, not the Import API — that separation is the
 * point. But it means a verify run minutes after a load reports every resource
 * whose operation has not resolved as **missing**, with wording written for a
 * genuine failure.
 *
 * A dogfood run hit exactly that: `load --execute --wait` returned with 106
 * operations `unresolved` (categories waiting for parents, products waiting
 * for categories), and the verify straight afterwards reported 98 absent
 * categories and 8 absent products. All of them landed four minutes later.
 * `--wait` drains `processing`; it does not wait out the 48-hour KeyReference
 * window, which is correct and was nowhere stated.
 *
 * So this is read only when the comparison found something absent — on the
 * happy path it would be requests spent to learn nothing.
 */
export async function countInFlight(
  clients: Clients,
  containerKeys: string[],
): Promise<{ unresolved: number; processing: number; readable: boolean }> {
  let unresolved = 0;
  let processing = 0;
  for (const key of containerKeys) {
    try {
      const summary = (
        await clients.importApi
          .importContainers()
          .withImportContainerKeyValue({ importContainerKey: key })
          .importSummaries()
          .get()
          .execute()
      ).body;
      unresolved += summary.states.unresolved ?? 0;
      processing += summary.states.processing ?? 0;
    } catch {
      // A container that has expired or was never created tells us nothing,
      // and this is a diagnostic aid rather than a gate — so a failed read
      // means "cannot say", not "nothing in flight".
      return { unresolved, processing, readable: false };
    }
  }
  return { unresolved, processing, readable: true };
}

/**
 * The note `verify` prints when something is absent and operations are in flight.
 *
 * The count of unresolved operations plateaus: a live load sat at 96 for five
 * minutes, resolved on its own, and was flat again for another five before it
 * reached 104 of 104. So "the count did not fall between two runs" is not a
 * stall, and a rule worded that way sent a session off to resubmit twice. A stall
 * is a count that has not fallen over a window, so the note says so and stamps the
 * time of the read, which is what lets two outputs be compared.
 */
export function describeInFlight(
  flight: { unresolved: number; processing: number },
  absent: number,
  now: Date,
): string {
  const pending = flight.unresolved + flight.processing;
  const readAt = `${now.toISOString().slice(11, 19)}Z`;
  return (
    `${pending} import operation(s) are still in flight for this plan ` +
    `(${flight.unresolved} unresolved, ${flight.processing} processing; read at ${readAt}), and ` +
    `${absent} planned resource(s) are reported absent below.\n` +
    '      Those two facts are probably the same fact. An `unresolved` operation is ' +
    'waiting for a KeyReference target — a category for its parent, a product for ' +
    'its category — and completes on its own once the target lands, any time within ' +
    '48 hours of the operation being created.\n' +
    '      `--wait` does **not** cover this: it drains `processing`, not the ' +
    'resolution window. Wait and re-run `verify` before treating the absences below ' +
    'as a failed load.\n' +
    '      The count can sit flat for several minutes and then fall on its own, so do not ' +
    'read two runs a few minutes apart as a stall. Judge it over a window of about 15 ' +
    'minutes: only if the unresolved count has not fallen at all across that span, ' +
    'something the plan referenced was never imported.'
  );
}
