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
  Product,
  ProductSelection,
  ProductType,
  StandalonePrice,
  Store,
  Variant,
} from '@commercetools/platform-sdk';

import type { Clients } from '../client/factory.js';
import type { MigrationPlan } from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import type { ProjectSnapshot } from './reconcile.js';

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

function chunk<T>(items: T[], size: number): T[][] {
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
): Promise<{ byKey: Map<string, T>; readable: boolean }> {
  const byKey = new Map<string, T>();
  if (keys.length === 0) return { byKey, readable: true };

  for (const part of chunk(keys, KEYS_PER_QUERY)) {
    try {
      for (const item of await query(keyPredicate(part))) {
        const key = keyOf(item);
        if (key !== undefined) byKey.set(key, item);
      }
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

export interface SnapshotResult {
  snapshot: ProjectSnapshot;
  diagnostics: Diagnostic[];
  /** Kinds that could not be read at all, so a comparison would be misleading. */
  unreadable: string[];
}

export async function fetchSnapshot(
  clients: Clients,
  plan: MigrationPlan,
): Promise<SnapshotResult> {
  const diagnostics: Diagnostic[] = [];
  const unreadable: string[] = [];

  const productTypes = await fetchByKey<ProductType>(
    'product type(s)',
    plan.productTypes.map((p) => p.key),
    async (where) =>
      (await clients.platform.productTypes().get({ queryArgs: { where, limit: KEYS_PER_QUERY } }).execute())
        .body.results,
    (p) => p.key,
    diagnostics,
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
  );
  if (!productSelections.readable) unreadable.push('productSelections');

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
  );
  if (!stores.readable) unreadable.push('stores');

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

  return {
    snapshot: {
      productTypes: productTypes.byKey,
      categories: categories.byKey,
      products: products.byKey,
      variants: variants.byKey,
      standalonePrices: standalonePrices.byKey,
      productSelections: productSelections.byKey,
      stores: stores.byKey,
      categoryKeyById,
      productTypeKeyById,
      productSelectionKeyById,
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
