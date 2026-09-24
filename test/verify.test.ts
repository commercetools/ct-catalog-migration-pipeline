/**
 * Verify stage tests.
 *
 * Two halves, split the way the code is. `reconcile` is pure, so the
 * comparison logic is tested against hand-built project snapshots — which is
 * where the subtlety lives, because the API does not return what was sent. An
 * `enum` is written as a key and read back as `{key, label}`, and a verifier
 * that reports every enum attribute in a catalog as differing is a verifier
 * someone switches off. The false-positive cases matter more than the true
 * ones here.
 *
 * `fetchSnapshot` is tested against a fake client, deliberately: the one
 * module with no coverage on the day this pipeline first met a real API was
 * the one that built the client, and it threw before a single request left the
 * process. Anything that touches the network gets a double.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Category,
  Product,
  ProductSelection,
  ProductType,
  StandalonePrice,
  Store,
  Variant,
} from '@commercetools/platform-sdk';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { reconcile, type ProjectSnapshot } from '../src/verify/reconcile.js';
import {
  countInFlight,
  fetchSnapshot,
  keyPredicate,
  KEYS_PER_QUERY,
} from '../src/verify/snapshot.js';
import { attributeDefinitionsOf, pricesOf, variantsOf, type MigrationPlan } from '../src/model/plan.js';
import type { Clients } from '../src/client/factory.js';

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

function fixture(name: string) {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', name, 'migration.config.json'),
  );
  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const model = deriveProductTypes(feed, config);
  return { config, plan: buildPlan(feed, model, config).plan };
}

/**
 * A project snapshot that matches the plan exactly.
 *
 * Built from the plan on purpose, so a test only has to describe the
 * difference it cares about. The read-shape conversions the API really
 * performs are done here — ids for references, `{key, label}` for enums — and
 * those are the assertions that matter: they were confirmed against a live
 * project before this helper was written.
 */
function matchingSnapshot(plan: MigrationPlan, config: ReturnType<typeof fixture>['config']): ProjectSnapshot {
  const categoryIdOf = (key: string) => `cat-id-${key}`;
  const productTypeIdOf = (key: string) => `pt-id-${key}`;

  const productTypes = new Map<string, ProductType>();
  for (const pt of plan.productTypes) {
    productTypes.set(pt.key, {
      id: productTypeIdOf(pt.key),
      version: 1,
      createdAt: '',
      lastModifiedAt: '',
      key: pt.key,
      name: pt.name ?? pt.key,
      description: pt.description ?? '',
      attributes: attributeDefinitionsOf(pt).map((d) => ({
        name: d.name,
        label: d.label ?? {},
        type: d.type,
        isRequired: d.isRequired ?? false,
        attributeConstraint: d.attributeConstraint ?? 'None',
        inputHint: d.inputHint ?? 'SingleLine',
        isSearchable: d.isSearchable ?? true,
        level: d.level ?? 'Variant',
      })) as ProductType['attributes'],
    } as ProductType);
  }

  const categories = new Map<string, Category>();
  for (const c of plan.categories) {
    categories.set(c.key, {
      id: categoryIdOf(c.key),
      version: 1,
      createdAt: '',
      lastModifiedAt: '',
      key: c.key,
      name: c.name,
      slug: c.slug,
      ancestors: [],
      orderHint: c.orderHint ?? '0.5',
      ...(c.parent ? { parent: { typeId: 'category' as const, id: categoryIdOf(c.parent.key!) } } : {}),
    } as Category);
  }

  const definitionsByType = new Map<string, Map<string, string>>();
  for (const pt of plan.productTypes) {
    definitionsByType.set(
      pt.key,
      new Map(attributeDefinitionsOf(pt).map((d) => [d.name, d.type.name])),
    );
  }

  const products = new Map<string, Product>();
  for (const p of plan.products) {
    const defs = definitionsByType.get(p.productType.key) ?? new Map<string, string>();
    // The conversion the API performs: an enum key becomes {key, label}.
    const readVariant = (v: (typeof plan.products)[number]['masterVariant'], id: number) => ({
      id,
      sku: v?.sku,
      key: v?.key,
      prices: (v?.prices ?? []).map((pr, i) => ({ id: `price-${i}`, ...pr })),
      attributes: (v?.attributes ?? []).map((a) => {
        const type = defs.get(a.name!);
        const value = (a as unknown as { value?: unknown }).value;
        return {
          name: a.name!,
          value:
            type === 'enum' || type === 'lenum' ? { key: value, label: 'irrelevant' } : value,
        };
      }),
      images: v?.images ?? [],
      assets: (v?.assets ?? []).map((a) => ({ ...a, id: `asset-${a.key}` })),
    });

    const all = variantsOf(p);
    const master = p.masterVariant ?? all[0];
    const rest = all.filter((v) => v.key !== master?.key);

    products.set(p.key, {
      id: `prod-id-${p.key}`,
      version: 1,
      createdAt: '',
      lastModifiedAt: '',
      key: p.key,
      productType: { typeId: 'product-type', id: productTypeIdOf(p.productType.key) },
      priceMode: config.target.priceMode === 'standalone' ? 'Standalone' : 'Embedded',
      masterData: {
        published: false,
        hasStagedChanges: false,
        current: { name: {}, slug: {}, categories: [], masterVariant: { id: 1 }, variants: [], searchKeywords: {}, attributes: [] },
        staged: {
          name: p.name,
          slug: p.slug,
          categories: (p.categories ?? []).map((c) => ({
            typeId: 'category' as const,
            id: categoryIdOf(c.key),
          })),
          masterVariant: readVariant(master, 1),
          variants: rest.map((v, i) => readVariant(v, i + 2)),
          searchKeywords: {},
          attributes: [],
        },
      },
    } as unknown as Product);
  }

  const standalonePrices = new Map<string, StandalonePrice>();
  for (const sp of plan.standalonePrices) {
    standalonePrices.set(sp.key, {
      id: `sp-id-${sp.key}`,
      version: 1,
      createdAt: '',
      lastModifiedAt: '',
      key: sp.key,
      sku: sp.sku,
      value: sp.value,
      ...(sp.country ? { country: sp.country } : {}),
      ...(sp.validFrom ? { validFrom: sp.validFrom } : {}),
      ...(sp.validUntil ? { validUntil: sp.validUntil } : {}),
    } as StandalonePrice);
  }

  // Modular: the variants are their own resources. A Variant created
  // unpublished holds its data in `current` with `staged` null, which is the
  // opposite precedence from a Product — the reconciler has to read
  // `staged ?? current`, so the snapshot models exactly that.
  const modularVariants = new Map<string, Variant>();
  for (const v of plan.variants) {
    const defs = definitionsByType.get(
      plan.products.find((p) => p.key === v.product.key)!.productType.key,
    ) ?? new Map<string, string>();
    modularVariants.set(v.key, {
      id: `var-id-${v.key}`,
      version: 1,
      createdAt: '',
      lastModifiedAt: '',
      key: v.key,
      variantId: 1,
      product: { typeId: 'product', id: `prod-id-${v.product.key}` },
      published: false,
      current: {
        sku: v.sku,
        images: v.images ?? [],
        assets: (v.assets ?? []).map((a) => ({ ...a, id: `asset-${a.key}` })),
        attributes: (v.attributes ?? []).map((a) => {
          const type = defs.get(a.name!);
          const value = (a as unknown as { value?: unknown }).value;
          return {
            name: a.name!,
            value: type === 'enum' || type === 'lenum' ? { key: value, label: 'x' } : value,
          };
        }),
      },
      staged: undefined,
    } as unknown as Variant);
  }

  return {
    productTypes,
    categories,
    products,
    variants: modularVariants,
    standalonePrices,
    // Mirrors the plan: a selection or store the plan does not declare is
    // simply absent here, and the reconciler reports it as missing.
    productSelections: new Map(
      (plan.productSelections ?? []).map((sel) => [
        sel.key,
        {
          id: `psid-${sel.key}`,
          key: sel.key,
          name: sel.name,
          mode: sel.mode ?? 'Individual',
          productCount: (sel.assignments ?? []).length,
        } as unknown as ProductSelection,
      ]),
    ),
    stores: new Map(
      (plan.prerequisites?.stores ?? []).map((st) => [
        st.key,
        {
          id: `stid-${st.key}`,
          key: st.key,
          languages: st.languages ?? [],
          countries: (st.countries ?? []).map((code) => ({ code })),
          distributionChannels: st.distributionChannels.map((k) => ({
            typeId: 'channel',
            id: `chid-${k}`,
          })),
          supplyChannels: st.supplyChannels.map((k) => ({ typeId: 'channel', id: `chid-${k}` })),
          productSelections: st.productSelections.map((sel) => ({
            productSelection: { typeId: 'product-selection', id: `psid-${sel.key}` },
            active: sel.active,
          })),
        } as unknown as Store,
      ]),
    ),
    categoryKeyById: new Map([...categories].map(([k, c]) => [c.id, k])),
    productTypeKeyById: new Map([...productTypes].map(([k, p]) => [p.id, k])),
    productSelectionKeyById: new Map(
      (plan.productSelections ?? []).map((sel) => [`psid-${sel.key}`, sel.key]),
    ),
  };
}

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

// ---------------------------------------------------------------------------
// A matching project must be silent
// ---------------------------------------------------------------------------

test('verify: a project matching the plan reports nothing at all', () => {
  for (const name of ['declared-types', 'classic-standalone']) {
    const { plan, config } = fixture(name);
    const r = reconcile(plan, matchingSnapshot(plan, config), config);
    assert.deepEqual(codes(r.diagnostics), [], `${name} should reconcile clean`);
    assert.equal(r.found.products, plan.products.length);
  }
});

test('verify: an enum read back as {key, label} is not a difference', () => {
  // The false positive that would get this stage disabled. The fixture's
  // colour attribute is an lenum: the plan writes 'BLK', the API returns
  // {key: 'BLK', label: {...}}.
  const { plan, config } = fixture('declared-types');
  const snapshot = matchingSnapshot(plan, config);

  const product = snapshot.products.get('mig-TEE-CLASSIC')!;
  const colour = product.masterData.staged.masterVariant.attributes!.find(
    (a) => a.name === 'colour',
  );
  assert.ok(colour, 'the fixture has a colour attribute');
  assert.equal(typeof colour.value, 'object', 'and the snapshot models the read shape');
  assert.ok('key' in (colour.value as object));

  const r = reconcile(plan, snapshot, config);
  assert.ok(!codes(r.diagnostics).includes('attribute-value-differs'));
});

test('verify: embedded prices reconcile in embedded mode', () => {
  const { plan, config } = fixture('declared-types');
  const embedded = plan.products
    .flatMap((p) => variantsOf(p))
    .flatMap((v) => pricesOf(v));
  assert.ok(embedded.length > 0, 'the fixture prices its variants');

  const r = reconcile(plan, matchingSnapshot(plan, config), config);
  assert.ok(!codes(r.diagnostics).includes('embedded-price-missing'));
});

// ---------------------------------------------------------------------------
// Every difference has to be found
// ---------------------------------------------------------------------------

test('verify: a resource the project does not have is missing, per kind', () => {
  const { plan, config } = fixture('classic-standalone');

  for (const [kind, expected] of [
    ['productTypes', 'product-type-missing'],
    ['categories', 'category-missing'],
    ['products', 'product-missing'],
    ['standalonePrices', 'standalone-price-missing'],
  ] as const) {
    const snapshot = matchingSnapshot(plan, config);
    const map = snapshot[kind] as Map<string, unknown>;
    const first = [...map.keys()][0];
    map.delete(first);

    const found = codes(reconcile(plan, snapshot, config).diagnostics);
    assert.ok(found.includes(expected), `deleting a ${kind} should report ${expected}`);
  }
});

test('verify: a wrong price amount is reported, in either price mode', () => {
  for (const name of ['declared-types', 'classic-standalone']) {
    const { plan, config } = fixture(name);
    const snapshot = matchingSnapshot(plan, config);

    if (name === 'classic-standalone') {
      const key = [...snapshot.standalonePrices.keys()][0];
      const price = snapshot.standalonePrices.get(key)!;
      snapshot.standalonePrices.set(key, {
        ...price,
        value: { ...price.value, centAmount: 1 },
      } as StandalonePrice);
    } else {
      const product = snapshot.products.get('mig-CAP-LOGO')!;
      const mv = product.masterData.staged.masterVariant;
      mv.prices![0] = { ...mv.prices![0], value: { ...mv.prices![0].value, centAmount: 1 } };
    }

    const found = codes(reconcile(plan, snapshot, config).diagnostics);
    assert.ok(found.includes('price-value-differs'), `${name}: a wrong amount must be caught`);
  }
});

test('verify: an attribute constraint that differs is an error, and says why', () => {
  // The one difference that cannot be corrected in place.
  const { plan, config } = fixture('declared-types');
  const snapshot = matchingSnapshot(plan, config);
  const pt = snapshot.productTypes.get(plan.productTypes[0].key)!;
  const attributes = pt.attributes!.map((a, i) =>
    i === 0 ? { ...a, attributeConstraint: 'None' as const } : a,
  );
  snapshot.productTypes.set(pt.key!, { ...pt, attributes } as ProductType);

  const d = reconcile(plan, snapshot, config).diagnostics.find(
    (x) => x.code === 'attribute-constraint-differs',
  );
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /accepts only 'None'/);
});

test('verify: a price mode that disagrees with the config is an error', () => {
  const { plan, config } = fixture('classic-standalone');
  const snapshot = matchingSnapshot(plan, config);
  const p = snapshot.products.get(plan.products[0].key)!;
  // Unset, which the API treats as Embedded — against a standalone config.
  snapshot.products.set(p.key!, { ...p, priceMode: undefined } as Product);

  const d = reconcile(plan, snapshot, config).diagnostics.find(
    (x) => x.code === 'product-price-mode-differs',
  );
  assert.ok(d);
  assert.match(d.message, /unset, which means Embedded/);
});

test('verify: a variant the plan does not know is a warning, not an error', () => {
  // A leftover from an earlier run is worth surfacing, but it does not mean
  // this plan failed to apply.
  const { plan, config } = fixture('declared-types');
  const snapshot = matchingSnapshot(plan, config);
  const p = snapshot.products.get('mig-JKT-FIELD')!;
  p.masterData.staged.variants.push({ id: 99, sku: 'LEFTOVER', attributes: [], prices: [] });

  const d = reconcile(plan, snapshot, config).diagnostics.find(
    (x) => x.code === 'variant-unexpected',
  );
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /LEFTOVER/);
});

test('verify: a reference attribute is left alone rather than falsely reported', () => {
  // A reference is planned as a key and read back as an id, so comparing the
  // two would report a difference on every reference attribute in the catalog.
  const { plan, config } = fixture('declared-types');
  const snapshot = matchingSnapshot(plan, config);

  const pt = snapshot.productTypes.get(plan.productTypes[0].key)!;
  const name = pt.attributes![0].name;
  const attributes = pt.attributes!.map((a, i) =>
    i === 0 ? { ...a, type: { name: 'reference' as const, referenceTypeId: 'product' as const } } : a,
  );
  snapshot.productTypes.set(pt.key!, { ...pt, attributes } as unknown as ProductType);

  for (const product of snapshot.products.values()) {
    for (const v of [product.masterData.staged.masterVariant, ...product.masterData.staged.variants]) {
      const attr = v.attributes?.find((a) => a.name === name);
      if (attr) (attr as { value: unknown }).value = { typeId: 'product', id: 'some-uuid' };
    }
  }

  const found = codes(reconcile(plan, snapshot, config).diagnostics);
  assert.ok(!found.includes('attribute-value-differs'), `reported: ${found.join(', ')}`);
});

test('verify: staged data is compared, because the load imports unpublished', () => {
  // `current` is empty until something is published. Comparing it would report
  // every product as wrong on a first load.
  const { plan, config } = fixture('declared-types');
  const snapshot = matchingSnapshot(plan, config);
  for (const p of snapshot.products.values()) {
    assert.deepEqual(p.masterData.current.slug, {}, 'the snapshot models an unpublished product');
  }
  assert.deepEqual(codes(reconcile(plan, snapshot, config).diagnostics), []);
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

test('keyPredicate quotes every key and escapes quotes inside them', () => {
  assert.equal(keyPredicate(['a', 'b']), 'key in ("a","b")');
  assert.equal(keyPredicate(['we"ird']), 'key in ("we\\"ird")');
});

interface FakeQuery {
  where: string;
  limit?: number;
}

function fakePlatform(options: { fail?: string; results?: Record<string, unknown[]> } = {}) {
  const queries: { kind: string; query: FakeQuery }[] = [];
  const endpoint = (kind: string) => () => ({
    get: ({ queryArgs }: { queryArgs: FakeQuery }) => ({
      execute: async () => {
        queries.push({ kind, query: queryArgs });
        if (options.fail === kind) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
        return { body: { results: options.results?.[kind] ?? [] } };
      },
    }),
  });
  const platform = {
    productTypes: endpoint('productTypes'),
    categories: endpoint('categories'),
    products: endpoint('products'),
    variants: endpoint('variants'),
    standalonePrices: endpoint('standalonePrices'),
    productSelections: endpoint('productSelections'),
    stores: endpoint('stores'),
  };
  return { queries, clients: { platform, importApi: {} } as unknown as Clients };
}

test('fetch: keys are asked for in chunks, never one enormous predicate', async () => {
  const { plan, config } = fixture('classic-standalone');
  const many = {
    ...plan,
    products: Array.from({ length: KEYS_PER_QUERY * 2 + 5 }, (_, i) => ({
      ...plan.products[0],
      key: `mig-P-${i}`,
    })),
  };
  void config;

  const { queries, clients } = fakePlatform();
  await fetchSnapshot(clients, many);

  const productQueries = queries.filter((q) => q.kind === 'products');
  assert.equal(productQueries.length, 3, '205 keys is three requests of at most 100');
  for (const q of productQueries) {
    const keys = q.query.where.match(/"/g)!.length / 2;
    assert.ok(keys <= KEYS_PER_QUERY, `a predicate carried ${keys} keys`);
  }
});

test('fetch: a read that fails marks the kind unreadable instead of looking empty', async () => {
  // Without this, a missing view scope and an empty project are the same
  // observation, and verify would report the whole catalog as missing.
  const { plan } = fixture('classic-standalone');
  const { clients } = fakePlatform({ fail: 'products' });

  const r = await fetchSnapshot(clients, plan);
  assert.deepEqual(r.unreadable, ['products']);
  const d = r.diagnostics.find((x) => x.code === 'verify-read-failed');
  assert.ok(d);
  assert.match(d.message, /lacks a read scope/);
  assert.match(d.message, /could not be checked/);
});

test('fetch: nothing to ask for means no request at all', async () => {
  const { plan } = fixture('declared-types');
  assert.deepEqual(plan.standalonePrices, [], 'this fixture is embedded-price');

  const { queries, clients } = fakePlatform();
  await fetchSnapshot(clients, plan);
  assert.ok(
    !queries.some((q) => q.kind === 'standalonePrices'),
    'an empty key list must not produce a query',
  );
});

// ---------------------------------------------------------------------------
// The Modular catalog model
// ---------------------------------------------------------------------------

test('verify: a matching Modular project reports nothing', () => {
  const { plan, config } = fixture('modular-standalone');
  assert.ok(plan.variants.length > 0, 'the fixture has detached variants');
  const r = reconcile(plan, matchingSnapshot(plan, config), config);
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.checked.variants, plan.variants.length);
});

test('verify: a Modular variant absent from the project is reported as missing', () => {
  // The failure that matters: a Variant is a separate resource, so it can be
  // rejected while its product imports cleanly — the same asymmetry that made
  // eight prices vanish behind a green load.
  const { plan, config } = fixture('modular-standalone');
  const snapshot = matchingSnapshot(plan, config);
  const gone = [...snapshot.variants.keys()][0];
  snapshot.variants.delete(gone);

  const d = reconcile(plan, snapshot, config).diagnostics.find(
    (x) => x.code === 'variant-missing',
  );
  assert.ok(d);
  assert.match(d.message, /may have been rejected while its product imported cleanly/);
});

test('verify: a Modular variant with a wrong attribute value is caught', () => {
  // Proves the comparison actually reads the detached variant rather than
  // finding nothing and passing.
  const { plan, config } = fixture('modular-standalone');
  const snapshot = matchingSnapshot(plan, config);
  const key = [...snapshot.variants.keys()][0];
  const v = snapshot.variants.get(key)!;
  const attributes = (v.current.attributes ?? []).map((a, i) =>
    i === 0 ? { ...a, value: 'definitely-not-what-was-planned' } : a,
  );
  snapshot.variants.set(key, { ...v, current: { ...v.current, attributes } } as Variant);

  const d = reconcile(plan, snapshot, config).diagnostics.find(
    (x) => x.code === 'attribute-value-differs',
  );
  assert.ok(d, 'a detached variant is still compared field by field');
  assert.match(d.message, /definitely-not-what-was-planned/);
});

test('verify: staged data wins over current on a Modular variant', () => {
  // The precedence is the opposite of a Product's: an unpublished Variant
  // holds its data in `current`, and `staged` appears only once there are
  // unpublished changes — so `staged ?? current` is what the project serves.
  const { plan, config } = fixture('modular-standalone');
  const snapshot = matchingSnapshot(plan, config);
  const key = [...snapshot.variants.keys()][0];
  const v = snapshot.variants.get(key)!;

  snapshot.variants.set(key, {
    ...v,
    staged: { ...v.current, sku: 'STAGED-DIFFERENT-SKU' },
  } as Variant);

  const found = codes(reconcile(plan, snapshot, config).diagnostics);
  assert.ok(found.includes('variant-missing'), `staged must be read: ${found.join(', ')}`);
});

test('verify: no master-variant finding under Modular, where there is none', () => {
  // Modular products have `defaultVariant`, which the Import API cannot set.
  // Reporting a master-variant difference would be inventing a field.
  const { plan, config } = fixture('modular-standalone');
  const found = codes(reconcile(plan, matchingSnapshot(plan, config), config).diagnostics);
  assert.ok(!found.includes('master-variant-differs'));
});

test('fetch: Modular variants are asked for, Classic ones are not', () => {
  // Under Classic the variants live on the product, so a request for them
  // would be a wasted round trip against an endpoint the project may not even
  // expose.
  return (async () => {
    const classic = fixture('declared-types');
    const { queries: classicQueries, clients: c1 } = fakePlatform();
    await fetchSnapshot(c1, classic.plan);
    assert.ok(!classicQueries.some((q) => q.kind === 'variants'));

    const modular = fixture('modular-standalone');
    const { queries: modularQueries, clients: c2 } = fakePlatform();
    await fetchSnapshot(c2, modular.plan);
    assert.ok(
      modularQueries.some((q) => q.kind === 'variants'),
      'a Modular plan has to read the variants endpoint',
    );
  })();
});

test('verify: a missing asset and a wrong source URI are both caught', () => {
  const { plan, config } = fixture('assets');
  assert.ok(
    (plan.products[0].masterVariant?.assets ?? []).length > 0,
    'the fixture carries assets',
  );

  // Matching first: the comparison must not fire on a correct project.
  const clean = matchingSnapshot(plan, config);
  assert.ok(!codes(reconcile(plan, clean, config).diagnostics).includes('asset-missing'));

  // An asset the load never landed.
  const dropped = matchingSnapshot(plan, config);
  const p = dropped.products.get(plan.products[0].key)!;
  (p.masterData.staged.masterVariant as { assets?: unknown[] }).assets = [];
  const d1 = reconcile(plan, dropped, config).diagnostics.find((x) => x.code === 'asset-missing');
  assert.ok(d1);
  assert.match(d1.message, /source\(s\)/);

  // Present, but pointing somewhere else — a broken image nothing else reports.
  const wrong = matchingSnapshot(plan, config);
  const wp = wrong.products.get(plan.products[0].key)!;
  const mv = wp.masterData.staged.masterVariant as {
    assets?: { key?: string; sources?: { uri?: string }[] }[];
  };
  mv.assets = (mv.assets ?? []).map((a, ai) =>
    ai === 0
      ? {
          ...a,
          sources: (a.sources ?? []).map((sc, si) =>
            si === 0 ? { ...sc, uri: 'https://wrong.example.com/oops.jpg' } : sc,
          ),
        }
      : a,
  );
  const d2 = reconcile(plan, wrong, config).diagnostics.find(
    (x) => x.code === 'asset-sources-differ',
  );
  assert.ok(d2);
  assert.match(d2.message, /wrong.example.com/);
});

// ---------------------------------------------------------------------------
// Stores and product selections
// ---------------------------------------------------------------------------

function storeVerifyPlan(): MigrationPlan {
  const base = fixture('declared-types').plan;
  return {
    ...base,
    productSelections: [
      {
        key: 'mig-uk',
        name: { 'en-GB': 'UK' },
        mode: 'Individual',
        assignments: [{ product: { typeId: 'product', key: 'mig-TEE-CLASSIC' } }],
      },
    ],
    prerequisites: {
      channels: [],
      customerGroups: [],
      stores: [
        {
          key: 'northwind-uk',
          distributionChannels: ['retail-uk'],
          supplyChannels: [],
          productSelections: [{ key: 'mig-uk', active: true }],
        },
      ],
    },
  };
}

test('verify: a matching store and selection are silent', () => {
  const plan = storeVerifyPlan();
  const r = reconcile(plan, matchingSnapshot(plan, fixture('declared-types').config), fixture('declared-types').config);
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.found.productSelections, 1);
  assert.equal(r.found.stores, 1);
});

test('verify: a selection whose mode differs cannot be fixed by re-running', () => {
  // No changeMode action exists, so the message has to say "delete and
  // recreate" rather than "re-run".
  const plan = storeVerifyPlan();
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  const sel = snapshot.productSelections.get('mig-uk')!;
  snapshot.productSelections.set('mig-uk', {
    ...sel,
    mode: 'IndividualExclusion',
  } as typeof sel);

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const d = r.diagnostics.find((x) => x.code === 'selection-mode-differs');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /deleted and\s+recreated|deleted and recreated/);
  assert.match(d.message, /assortment is inverted/);
});

test('verify: a selection holding fewer products than planned is reported', () => {
  const plan = storeVerifyPlan();
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  const sel = snapshot.productSelections.get('mig-uk')!;
  snapshot.productSelections.set('mig-uk', { ...sel, productCount: 0 } as typeof sel);

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const d = r.diagnostics.find((x) => x.code === 'selection-assignment-count-differs');
  assert.ok(d);
  assert.match(d.message, /holds 0 product\(s\); the plan assigned 1/);
});

test('verify: an absent store and an absent selection are both reported missing', () => {
  const plan = storeVerifyPlan();
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  snapshot.productSelections.clear();
  snapshot.stores.clear();

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const found = codes(r.diagnostics);
  assert.ok(found.includes('product-selection-missing'), found.join(', '));
  assert.ok(found.includes('store-missing'), found.join(', '));
  assert.equal(r.found.productSelections, 0);
  assert.equal(r.found.stores, 0);
});

test('verify: a store pointing at the wrong selection is reported', () => {
  const plan = storeVerifyPlan();
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  const store = snapshot.stores.get('northwind-uk')!;
  snapshot.stores.set('northwind-uk', {
    ...store,
    productSelections: [],
  } as typeof store);

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const d = r.diagnostics.find((x) => x.code === 'store-product-selections-differ');
  assert.ok(d);
  assert.match(d.message, /never modifies an existing store/);
});

test('verify: an inactive selection on a store is an error, not cosmetic', () => {
  // All-inactive with one Individual means the store offers nothing.
  const plan = storeVerifyPlan();
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  const store = snapshot.stores.get('northwind-uk')!;
  snapshot.stores.set('northwind-uk', {
    ...store,
    productSelections: [
      { productSelection: { typeId: 'product-selection', id: 'psid-mig-uk' }, active: false },
    ],
  } as unknown as typeof store);

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const d = r.diagnostics.find((x) => x.code === 'store-selection-active-differs');
  assert.ok(d);
  assert.match(d.message, /no products at all/);
});

test('verify: supply-channel drift is a warning, because no inventory was imported', () => {
  const plan = storeVerifyPlan();
  plan.prerequisites.stores[0].supplyChannels = ['warehouse-gb'];
  const snapshot = matchingSnapshot(plan, fixture('declared-types').config);
  const store = snapshot.stores.get('northwind-uk')!;
  snapshot.stores.set('northwind-uk', { ...store, supplyChannels: [] } as typeof store);

  const r = reconcile(plan, snapshot, fixture('declared-types').config);
  const d = r.diagnostics.find((x) => x.code === 'store-supply-channels-differ');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /imports no inventory/);
});

test('fetch: stores and selections are asked for only when the plan has them', async () => {
  // Most engagements declare neither, and an unconditional read would spend
  // two requests per verify against endpoints the client may lack scopes for.
  const plain = fixture('declared-types');
  const { queries: q1, clients: c1 } = fakePlatform();
  await fetchSnapshot(c1, plain.plan);
  assert.ok(!q1.some((q) => q.kind === 'stores'));
  assert.ok(!q1.some((q) => q.kind === 'productSelections'));

  const withStores = fixture('stores');
  const { queries: q2, clients: c2 } = fakePlatform();
  await fetchSnapshot(c2, withStores.plan);
  assert.ok(q2.some((q) => q.kind === 'stores'), 'a plan with a store has to read stores');
  assert.ok(q2.some((q) => q.kind === 'productSelections'));

  // Stores are keyed verbatim, so the predicate must not carry the prefix —
  // asking for `mig-northwind-uk` would find nothing and report it missing.
  const storeQuery = q2.find((q) => q.kind === 'stores')!;
  assert.match(String(storeQuery.query.where), /"northwind-uk"/);
  assert.ok(!String(storeQuery.query.where).includes('mig-northwind-uk'));
});

test('fetch: an unreadable store list marks the kind unreadable rather than comparing', async () => {
  const withStores = fixture('stores');
  const { clients } = fakePlatform({ fail: 'stores' });
  const r = await fetchSnapshot(clients, withStores.plan);
  assert.ok(r.unreadable.includes('stores'));
});

// ---------------------------------------------------------------------------
// Operations still in flight
//
// `verify` reads the project, not the Import API. A verify run minutes after a
// load therefore reports every resource whose operation has not resolved as
// missing — and a dogfood run got 98 absent categories and 8 absent products
// on a load that was fine and landed four minutes later. `--wait` drains
// `processing`, not the 48-hour KeyReference window.
// ---------------------------------------------------------------------------

function fakeImportApi(summaries: Record<string, { unresolved?: number; processing?: number }> | Error) {
  const asked: string[] = [];
  const importApi = {
    importContainers: () => ({
      withImportContainerKeyValue: ({ importContainerKey }: { importContainerKey: string }) => ({
        importSummaries: () => ({
          get: () => ({
            execute: async () => {
              asked.push(importContainerKey);
              if (summaries instanceof Error) throw summaries;
              return { body: { states: summaries[importContainerKey] ?? {} } };
            },
          }),
        }),
      }),
    }),
  };
  return { asked, clients: { platform: {}, importApi } as unknown as Clients };
}

test('in-flight: unresolved and processing are summed across containers', async () => {
  const { asked, clients } = fakeImportApi({
    'mig-category': { unresolved: 98 },
    'mig-product-draft': { unresolved: 8, processing: 2 },
  });
  const r = await countInFlight(clients, ['mig-category', 'mig-product-draft']);
  assert.deepEqual(asked, ['mig-category', 'mig-product-draft']);
  assert.equal(r.unresolved, 106);
  assert.equal(r.processing, 2);
  assert.equal(r.readable, true);
});

test('in-flight: a container with nothing pending reports zero, not unreadable', async () => {
  const { clients } = fakeImportApi({ 'mig-category': { unresolved: 0, processing: 0 } });
  const r = await countInFlight(clients, ['mig-category']);
  assert.equal(r.unresolved + r.processing, 0);
  assert.equal(r.readable, true);
});

test('in-flight: a failed read says "cannot say", not "nothing pending"', async () => {
  // An expired container tells us nothing. Reporting zero would let the
  // caller conclude the absences are a real failure.
  const { clients } = fakeImportApi(Object.assign(new Error('gone'), { statusCode: 404 }));
  const r = await countInFlight(clients, ['mig-category']);
  assert.equal(r.readable, false);
});
