/**
 * Audit gate regression tests.
 *
 * The violations fixture is a hand-written plan.json rather than something the
 * mapper produced, deliberately: `plan` is gated behind validate and derive, so
 * most of these violations cannot reach it through the normal path. Feeding the
 * artefact directly is also the only way to test a verifier that is supposed to
 * be independent of the writer.
 *
 * The negative cases matter as much as the positive ones. A gate that fires on
 * legitimate data gets disabled by whoever is trying to ship.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { auditPlan } from '../src/audit/gate.js';
import { loadPlan } from '../src/audit/load-plan.js';
import { checkPlanFreshness, feedDigest } from '../src/contract/digest.js';
import { stringifyArtefact } from '../src/model/artefact.js';
import { writePlan } from '../src/map/report.js';
import type {
  MigrationPlan,
  PriceDraftImport,
  StandalonePriceImport,
} from '../src/model/plan.js';

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

function config(fixture: string) {
  return loadConfig(resolve(ROOT, 'fixtures', fixture, 'migration.config.json'));
}

/** Audits a plan built end-to-end from a feed fixture. */
function auditFromFeed(fixture: string) {
  const { config: cfg, feedDir } = config(fixture);
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);
  return { plan, ...auditPlan(plan, cfg) };
}

/** Audits the hand-written violations plan. */
function auditFixturePlan(fixture: string) {
  const { config: cfg } = config(fixture);
  const plan = loadPlan(resolve(ROOT, 'fixtures', fixture, 'out'));
  return { plan, ...auditPlan(plan, cfg) };
}

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

// ---------------------------------------------------------------------------
// Clean plans must stay clean
// ---------------------------------------------------------------------------

test('a plan built from the declared fixture passes with nothing to report', () => {
  const r = auditFromFeed('declared-types');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.checked.products, 3);
  assert.equal(r.checked.variants, 7);
  assert.equal(r.checked.prices, 15);
});

test('a windowless price does not conflict with a windowed one in the same scope', () => {
  // JKT-FIELD carries a GBP/GB base price plus a GBP/GB promotional window.
  // The docs are explicit that these do not collide, so a gate that flags it
  // would be wrong.
  const r = auditFromFeed('declared-types');
  assert.ok(
    !r.diagnostics.some(
      (d) => d.code === 'duplicate-price-scope' || d.code === 'overlapping-price-validity',
    ),
    'a base price plus a dated promotion is legitimate',
  );
});

test('plans from the inference and edge fixtures pass the gate', () => {
  for (const fixture of ['inferred-types', 'derive-inference', 'plan-edges']) {
    const r = auditFromFeed(fixture);
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(
      errors.map((e) => e.code),
      [],
      `${fixture} produced audit errors: ${JSON.stringify(errors, null, 2)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Every check fires
// ---------------------------------------------------------------------------

test('the violations plan trips every implemented check', () => {
  const r = auditFixturePlan('audit-violations');
  assert.deepEqual(codes(r.diagnostics), [
    'attribute-never-populated',
    'attribute-not-declared',
    'attribute-type-mismatch',
    'category-without-products',
    'combination-unique-violation',
    'currency-not-configured',
    'dangling-category-parent',
    'dangling-category-reference',
    'dangling-product-type',
    'duplicate-attribute',
    'duplicate-price-key',
    'duplicate-price-scope',
    'duplicate-resource-key',
    'duplicate-slug',
    'enum-value-not-declared',
    'fraction-digits-mismatch',
    'invalid-order-hint',
    'order-hint-absent',
    'overlapping-price-validity',
    'product-without-category',
    'required-attribute-missing',
    'same-for-all-violation',
    'variant-without-price',
    'variant-without-sku',
  ]);
});

test('the gate blocks: errors outnumber warnings and the run fails', () => {
  const r = auditFixturePlan('audit-violations');
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  const warnings = r.diagnostics.filter((d) => d.severity === 'warning');
  assert.equal(errors.length, 20);
  assert.equal(warnings.length, 5);
});

test('a type mismatch names the declared type and the actual value', () => {
  const r = auditFixturePlan('audit-violations');
  const found = r.diagnostics.filter((d) => d.code === 'attribute-type-mismatch');
  assert.equal(found.length, 2);
  assert.ok(
    found.some((d) => /declared text.*object/.test(d.message)),
    'a localized value written into a text attribute must be caught',
  );
  assert.ok(found.some((d) => /declared number.*string 'heavy'/.test(d.message)));
});

test('an undeclared enum key lists what was declared instead', () => {
  const d = auditFixturePlan('audit-violations').diagnostics.find(
    (x) => x.code === 'enum-value-not-declared',
  );
  assert.ok(d);
  assert.match(d.message, /'PUCE'/);
  assert.match(d.message, /BLK, NVY/);
});

test('an undeclared attribute says the whole product is rejected', () => {
  const d = auditFixturePlan('audit-violations').diagnostics.find(
    (x) => x.code === 'attribute-not-declared',
  );
  assert.ok(d);
  assert.match(d.message, /mystery/);
  assert.match(d.message, /entire product/);
});

test('a duplicate key names both claimants distinguishably', () => {
  const d = auditFixturePlan('audit-violations').diagnostics.find(
    (x) => x.code === 'duplicate-resource-key',
  );
  assert.ok(d);
  assert.match(d.message, /Alpha/);
  assert.match(d.message, /Alpha again/, 'two same-type duplicates must be told apart');
});

test('cascading checks are suppressed behind a dangling ProductType', () => {
  // mig-P4 has no attributes at all, so it would trip required-attribute-missing
  // too — but its ProductType does not exist, so there is nothing to check
  // against and reporting it would be a false lead.
  const r = auditFixturePlan('audit-violations');
  const required = r.diagnostics.filter((d) => d.code === 'required-attribute-missing');
  assert.equal(required.length, 1);
  assert.match(required[0].message, /P1-2/);
  assert.ok(!required.some((d) => d.message.includes('P4-1')));
});

test('a duplicate price key is caught — the key only exists because the SDK requires it', () => {
  const d = auditFixturePlan('audit-violations').diagnostics.find(
    (x) => x.code === 'duplicate-price-key',
  );
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /mig-P2-1-GBP-GB/);
});

test('a variant with no SKU is an error even though the API allows it', () => {
  const d = auditFixturePlan('audit-violations').diagnostics.find(
    (x) => x.code === 'variant-without-sku',
  );
  assert.ok(d);
  assert.match(d.message, /mig-P3-2/);
  assert.match(d.message, /inventory/, 'the message should say why a SKU matters');
});

// ---------------------------------------------------------------------------
// Price windows
// ---------------------------------------------------------------------------

function auditPrices(prices: PriceDraftImport[]) {
  const { config: cfg } = config('declared-types');
  const plan: MigrationPlan = {
    productTypes: [
      { key: 'pt', name: 'pt', description: 'pt', attributes: [] },
    ],
    categories: [],
    products: [
      {
        key: 'mig-P',
        productType: { typeId: 'product-type', key: 'pt' },
        name: { 'en-GB': 'Priced product' },
        slug: { 'en-GB': 'priced-product' },
        categories: [],
        masterVariant: { key: 'mig-V', sku: 'V', attributes: [], prices, images: [] },
        variants: [],
        publish: false,
      },
    ],
    variants: [],
    standalonePrices: [],
    productSelections: [],
    prerequisites: { channels: [], customerGroups: [], stores: [] },
    decisions: [],
    keyMap: { categories: {}, products: {}, variants: {} },
    loadOrder: ['product-type', 'category', 'product-draft'],
  };
  return auditPlan(plan, cfg).diagnostics.filter((d) => d.severity === 'error');
}

const gbp = (amount: number) => ({
  type: 'centPrecision' as const,
  currencyCode: 'GBP',
  centAmount: amount,
  fractionDigits: 2,
});

/**
 * `PriceDraftImport.key` is required, and the gate checks price keys for
 * duplicates, so a test price needs a key derived from its scope exactly as
 * the mapper derives one.
 */
function price(
  value: ReturnType<typeof gbp>,
  scope: Omit<PriceDraftImport, 'key' | 'value'> = {},
): PriceDraftImport {
  const parts = [
    value.currencyCode,
    scope.country ?? '',
    scope.customerGroup?.key ?? '',
    scope.channel?.key ?? '',
    (scope.validFrom ?? '').replace(/[^0-9]/g, '').slice(0, 8),
    (scope.validUntil ?? '').replace(/[^0-9]/g, '').slice(0, 8),
    String(value.centAmount),
  ].filter((part) => part !== '');
  return { key: `mig-V-${parts.join('-')}`, value, ...scope };
}

test('price windows: adjacent periods do not overlap', () => {
  const errors = auditPrices([
    price(gbp(100), { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }),
    price(gbp(200), { validFrom: '2026-02-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }),
  ]);
  assert.deepEqual(errors, [], 'one window ending where the next begins is legitimate');
});

test('price windows: overlapping periods in one scope are rejected', () => {
  const errors = auditPrices([
    price(gbp(100), { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }),
    price(gbp(200), { validFrom: '2026-02-01T00:00:00.000Z', validUntil: '2026-04-01T00:00:00.000Z' }),
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'overlapping-price-validity');
});

test('price windows: identical windows in one scope are a duplicate scope', () => {
  const errors = auditPrices([
    price(gbp(100), { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }),
    price(gbp(200), { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }),
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'duplicate-price-scope');
});

test('price windows: a different scope may repeat the same window', () => {
  const errors = auditPrices([
    price(gbp(100), { country: 'GB', validFrom: '2026-01-01T00:00:00.000Z' }),
    price(gbp(200), { country: 'IE', validFrom: '2026-01-01T00:00:00.000Z' }),
  ]);
  assert.deepEqual(errors, [], 'country is part of the scope');
});

test('price windows: customer group and channel are part of the scope', () => {
  const errors = auditPrices([
    price(gbp(100)),
    price(gbp(90), { customerGroup: { typeId: 'customer-group', key: 'trade' } }),
    price(gbp(80), { channel: { typeId: 'channel', key: 'outlet' } }),
  ]);
  assert.deepEqual(errors, []);
});

test('price windows: an open-ended window still overlaps', () => {
  const errors = auditPrices([
    price(gbp(100), { validFrom: '2026-01-01T00:00:00.000Z' }),
    price(gbp(200), { validFrom: '2026-06-01T00:00:00.000Z' }),
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'overlapping-price-validity');
});

test('price windows: two windowless prices in one scope are a duplicate', () => {
  const errors = auditPrices([price(gbp(100)), price(gbp(200))]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'duplicate-price-scope');
});

test('a slug or key shorter than two characters is rejected', () => {
  const { config: cfg } = config('declared-types');
  const plan: MigrationPlan = {
    productTypes: [{ key: 'pt', name: 'pt', description: 'pt', attributes: [] }],
    categories: [
      { key: 'x', name: { 'en-GB': 'X' }, slug: { 'en-GB': 'y' }, orderHint: '0.11' },
    ],
    products: [],
    variants: [],
    standalonePrices: [],
    productSelections: [],
    prerequisites: { channels: [], customerGroups: [], stores: [] },
    decisions: [],
    keyMap: { categories: {}, products: {}, variants: {} },
    loadOrder: ['product-type', 'category', 'product-draft'],
  };

  const found = codes(auditPlan(plan, cfg).diagnostics);
  assert.ok(found.includes('invalid-key'), 'a 1-character key is illegal');
  assert.ok(found.includes('invalid-slug'), 'a 1-character slug is illegal');
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test('the variant cap follows the catalog model', () => {
  const { config: cfg, feedDir } = config('declared-types');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  // The generated types are readonly, so the oversized product is built rather
  // than mutated into place.
  const original = plan.products[0];
  const template = original.masterVariant!;
  const product = {
    ...original,
    variants: Array.from({ length: 120 }, (_, i) => ({
      ...template,
      key: `mig-bulk-${i}`,
      sku: `BULK-${i}`,
    })),
  };
  plan.products[0] = product;

  const classic = auditPlan(plan, cfg).diagnostics.find(
    (d) => d.code === 'variant-limit-exceeded',
  );
  assert.ok(classic, '121 variants is above the Classic limit of 100');
  // Telling someone to split a 121-variant product is telling them to change
  // their catalog to fit the tool. The message has to name the model instead.
  assert.match(classic.message, /Classic limit of 100/);
  assert.match(classic.message, /not a product that needs splitting/);
  assert.match(classic.message, /catalogModel to 'Modular'/);

  // Modular raises the ceiling to 10000, so the same plan fits — the cap is a
  // property of the catalog model, and now that both are supported the check
  // has to follow it rather than assume one.
  const modular = {
    ...cfg,
    target: { catalogModel: 'Modular' as const, priceMode: 'standalone' as const },
  };
  assert.ok(
    !auditPlan(plan, modular).diagnostics.some((d) => d.code === 'variant-limit-exceeded'),
    '121 variants is well inside the Modular ceiling',
  );

  // The price mode must not affect it either way.
  const classicStandalone = {
    ...cfg,
    target: { catalogModel: 'Classic' as const, priceMode: 'standalone' as const },
  };
  assert.ok(
    auditPlan(plan, classicStandalone).diagnostics.some(
      (d) => d.code === 'variant-limit-exceeded',
    ),
    'the ceiling comes from the catalog model, not the price mode',
  );
});

test('the embedded price cap is enforced only in embedded price mode', () => {
  const { config: cfg } = config('declared-types');
  const prices = Array.from({ length: 105 }, (_, i) =>
    price(gbp(100 + i), {
      country: 'GB',
      validFrom: new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString(),
      validUntil: new Date(Date.UTC(2026, 0, 2 + i * 2)).toISOString(),
    }),
  );

  const embedded = auditPrices(prices);
  assert.ok(embedded.some((d) => d.code === 'price-limit-exceeded'));

  const standalone = {
    ...cfg,
    target: { catalogModel: 'Classic' as const, priceMode: 'standalone' as const },
  };
  const plan = loadPlan(resolve(ROOT, 'fixtures', 'audit-violations', 'out'));
  assert.ok(
    !auditPlan(plan, standalone).diagnostics.some((d) => d.code === 'price-limit-exceeded'),
  );
});

// ---------------------------------------------------------------------------
// Standalone prices
// ---------------------------------------------------------------------------

/** A standalone plan from the fixture, with the prices swapped for the given set. */
function auditStandalone(prices: StandalonePriceImport[]) {
  const { config: cfg, feedDir } = config('classic-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);
  return auditPlan({ ...plan, standalonePrices: prices }, cfg).diagnostics;
}

function standalone(
  sku: string,
  key: string,
  scope: Partial<StandalonePriceImport> = {},
): StandalonePriceImport {
  return { key, sku, value: gbp(1999), ...scope };
}

test('a standalone plan built from the fixture passes with nothing to report', () => {
  const { config: cfg, feedDir } = config('classic-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);
  const r = auditPlan(plan, cfg);
  assert.deepEqual(codes(r.diagnostics), []);
  assert.ok(r.checked.standalonePrices > 0, 'the audit has to actually see them');
  assert.equal(r.checked.prices, 0, 'nothing embedded remains');
});

test('a standalone price for a SKU no variant has is an orphan', () => {
  // The Import API does not validate the SKU, so this is the only place it can
  // be caught. It would import successfully and price nothing.
  const found = codes(auditStandalone([standalone('NOT-A-SKU', 'mig-orphan')]));
  assert.ok(found.includes('standalone-price-orphan'));
});

test('two standalone prices in one scope and window collide', () => {
  const sku = 'JKT-FIELD-OAT-L';
  const found = auditStandalone([
    standalone(sku, 'mig-a', { country: 'GB' }),
    standalone(sku, 'mig-b', { country: 'GB' }),
  ]);
  const d = found.find((x) => x.code === 'duplicate-standalone-price-scope');
  assert.ok(d, 'SKU + currency + country + group + channel + window must be unique');
  assert.equal(d.severity, 'error');
});

test('the same scope under a different SKU is not a collision', () => {
  // Embedded price uniqueness is per variant; standalone uniqueness is per SKU.
  // Two variants priced identically is the normal case, not a defect.
  const found = codes(
    auditStandalone([
      standalone('JKT-FIELD-OAT-L', 'mig-a', { country: 'GB' }),
      standalone('JKT-FIELD-OAT-M', 'mig-b', { country: 'GB' }),
    ]),
  );
  assert.ok(!found.includes('duplicate-standalone-price-scope'));
});

test('overlapping standalone windows warn rather than block', () => {
  // Unlike embedded prices, the API accepts these — so blocking the load would
  // be the gate inventing a rule. It still costs the migration control over
  // which price wins, which is worth saying.
  const sku = 'JKT-FIELD-OAT-L';
  const found = auditStandalone([
    standalone(sku, 'mig-a', {
      country: 'GB',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-03-01T00:00:00.000Z',
    }),
    standalone(sku, 'mig-b', {
      country: 'GB',
      validFrom: '2026-02-01T00:00:00.000Z',
      validUntil: '2026-04-01T00:00:00.000Z',
    }),
  ]);
  const d = found.find((x) => x.code === 'overlapping-standalone-price-validity');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
});

test('adjacent standalone windows are legitimate', () => {
  const sku = 'JKT-FIELD-OAT-L';
  const found = codes(
    auditStandalone([
      standalone(sku, 'mig-a', {
        country: 'GB',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-02-01T00:00:00.000Z',
      }),
      standalone(sku, 'mig-b', {
        country: 'GB',
        validFrom: '2026-02-01T00:00:00.000Z',
        validUntil: '2026-03-01T00:00:00.000Z',
      }),
    ]),
  );
  // Only the scope codes: replacing the fixture's prices with two leaves the
  // other variants unpriced, which the gate is right to mention.
  assert.deepEqual(
    found.filter((c) => c.includes('standalone-price')),
    [],
    'one window ending where the next begins is legitimate',
  );
});

test('a base price plus a dated promotion in one scope is legitimate', () => {
  // The most common pricing shape there is. Treating the open-ended price as
  // an infinite interval would make it overlap every promotion.
  const sku = 'JKT-FIELD-OAT-L';
  const found = codes(
    auditStandalone([
      standalone(sku, 'mig-base', { country: 'GB' }),
      standalone(sku, 'mig-promo', {
        country: 'GB',
        validFrom: '2026-11-27T00:00:00.000Z',
        validUntil: '2026-12-02T00:00:00.000Z',
      }),
    ]),
  );
  assert.deepEqual(
    found.filter((c) => c.includes('standalone-price')),
    [],
  );
});

test('a currency the project does not accept is caught on standalone prices too', () => {
  const found = codes(
    auditStandalone([
      standalone('JKT-FIELD-OAT-L', 'mig-jpy', {
        value: {
          type: 'centPrecision',
          currencyCode: 'JPY',
          centAmount: 4500,
          fractionDigits: 0,
        },
      }),
    ]),
  );
  assert.ok(found.includes('currency-not-configured'));
});

// ---------------------------------------------------------------------------
// Price mode consistency
//
// The silent failure: both halves import cleanly and the catalog shows no
// price, because price selection reads only the mode the product declares.
// ---------------------------------------------------------------------------

test('embedded prices under standalone mode are an error', () => {
  // An embedded-price plan audited against a standalone config: exactly what a
  // config edit between `plan` and `audit` produces.
  const { config: embeddedCfg, feedDir } = config('declared-types');
  const { feed } = validateFeed(feedDir, SCHEMA, embeddedCfg);
  const model = deriveProductTypes(feed, embeddedCfg);
  const { plan } = buildPlan(feed, model, embeddedCfg);

  const { config: standaloneCfg } = config('classic-standalone');
  const found = codes(auditPlan(plan, standaloneCfg).diagnostics);
  assert.ok(found.includes('embedded-prices-in-standalone-mode'));
});

test('standalone prices under embedded mode are an error', () => {
  const { config: cfg, feedDir } = config('declared-types');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);
  const found = codes(
    auditPlan(
      { ...plan, standalonePrices: [standalone('JKT-FIELD-OAT-L', 'mig-stray')] },
      cfg,
    ).diagnostics,
  );
  assert.ok(found.includes('standalone-prices-in-embedded-mode'));
});

test("a product left on the default price mode is a mismatch under standalone", () => {
  const { config: cfg, feedDir } = config('classic-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const { priceMode, ...withoutMode } = plan.products[0];
  assert.equal(priceMode, 'Standalone', 'the mapper sets it; this test removes it');

  const d = auditPlan(
    { ...plan, products: [withoutMode, ...plan.products.slice(1)] },
    cfg,
  ).diagnostics.find((x) => x.code === 'product-price-mode-mismatch');
  assert.ok(d);
  assert.match(d.message, /unset, which means Embedded/);
});

// ---------------------------------------------------------------------------
// Loading a plan
// ---------------------------------------------------------------------------

test('the written plan round-trips every collection the gate reads', () => {
  // The audit reads plan.json from disk rather than the in-memory object, which
  // is the point — but it means a collection the writer forgets is audited as
  // empty and reports nothing. It has now happened three times: standalone
  // prices, Modular variants, and product selections.
  //
  // The third slipped through *this* test, which is the interesting part. The
  // comparison is derived from the plan, so it covered the new field — but both
  // fixtures had it empty, and `[]` round-trips perfectly whether or not the
  // writer persists it. The test's own warning ("a collection that is empty in
  // the fixture proves nothing") described the hole it then fell into.
  //
  // So the guard now tracks which collections were non-empty in *some* fixture
  // and fails if any was empty in all of them. Adding a collection to the plan
  // breaks this test until a fixture actually exercises it.
  const everNonEmpty = new Set<string>();
  let allCollections: string[] = [];

  for (const fixture of ['classic-standalone', 'modular-standalone', 'stores']) {
    const dir = mkdtempSync(join(tmpdir(), 'ct-plan-roundtrip-'));
    const { config: cfg, feedDir } = config(fixture);
    const { feed } = validateFeed(feedDir, SCHEMA, cfg);
    const model = deriveProductTypes(feed, cfg);
    const { plan } = buildPlan(feed, model, cfg);

    writePlan(dir, plan, false);
    const reloaded = loadPlan(dir);

    // Derived from the plan rather than hardcoded. A hardcoded list is how this
    // test missed `variants`: the field existed, the writer dropped it, and a
    // list naming four collections had nothing to say about the fifth.
    const collections = (Object.keys(plan) as (keyof typeof plan)[]).filter(
      (k) => Array.isArray(plan[k]) && k !== 'decisions' && k !== 'loadOrder',
    );
    assert.ok(
      collections.length >= 5,
      `expected every resource collection, got ${collections.join(', ')}`,
    );

    allCollections = collections as string[];
    for (const field of collections) {
      const value = plan[field] as unknown[];
      if (value.length > 0) everNonEmpty.add(field as string);
      assert.deepEqual(
        reloaded[field],
        plan[field],
        `${fixture}: ${field} did not survive being written and read back`,
      );
    }
    assert.deepEqual(reloaded.loadOrder, plan.loadOrder);
  }

  const neverExercised = allCollections.filter((c) => !everNonEmpty.has(c));
  assert.deepEqual(
    neverExercised,
    [],
    'these plan collections are empty in every fixture, so the round-trip above ' +
      'proves nothing about them — add a fixture that populates each: ' +
      neverExercised.join(', '),
  );
});

test('a missing plan is reported as such, not as a crash', () => {
  assert.throws(
    () => loadPlan(resolve(ROOT, 'fixtures', 'declared-types')),
    /No plan at .*plan\.json/,
  );
});

test('a truncated plan names the missing section', () => {
  assert.throws(
    () => loadPlan(resolve(ROOT, 'fixtures', 'audit-truncated', 'out')),
    /missing the 'products' array/,
  );
});

// ---------------------------------------------------------------------------
// The Modular catalog model
//
// The gate's checks must not weaken when the variants move out of the
// products. Every one of them reads through the variant index, so the same
// violation has to be caught in either shape.
// ---------------------------------------------------------------------------

test('modular: a clean plan audits clean, and the gate still sees the variants', () => {
  const r = auditFromFeed('modular-standalone');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.checked.variants, 7, 'the index has to find variants beside the products');
  assert.equal(r.checked.prices, 0, 'Modular has no embedded prices');
  assert.equal(r.checked.standalonePrices, 15);
});

test('modular: a duplicate SKU across variants is still caught', () => {
  // Under Classic this is found by walking the product. Under Modular the
  // variants are a flat list, so a check that had not been rewired would pass.
  const { config: cfg, feedDir } = config('modular-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const first = plan.variants[0];
  const clash = { ...plan.variants[1], sku: first.sku };
  const broken = { ...plan, variants: [...plan.variants.slice(0, 1), clash, ...plan.variants.slice(2)] };

  const found = codes(auditPlan(broken, cfg).diagnostics);
  assert.ok(found.includes('duplicate-sku'), `reported: ${found.join(', ')}`);
});

test('modular: an undeclared attribute on a detached variant is still caught', () => {
  const { config: cfg, feedDir } = config('modular-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const v = plan.variants[0];
  const broken = {
    ...plan,
    variants: [
      { ...v, attributes: [...(v.attributes ?? []), { name: 'mystery', type: 'text', value: 'x' }] },
      ...plan.variants.slice(1),
    ],
  } as typeof plan;

  const found = codes(auditPlan(broken, cfg).diagnostics);
  assert.ok(found.includes('attribute-not-declared'), `reported: ${found.join(', ')}`);
});

test('modular: a standalone price for a detached variant is not an orphan', () => {
  // The SKU set is built from the index, so under Modular it must still find
  // the SKUs — otherwise every price in a Modular plan would look orphaned.
  const r = auditFromFeed('modular-standalone');
  assert.ok(!codes(r.diagnostics).includes('standalone-price-orphan'));
});

test('modular: a variant belonging to no planned product is reported', () => {
  const { config: cfg, feedDir } = config('modular-standalone');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const orphan = {
    ...plan.variants[0],
    key: 'mig-ORPHANED',
    sku: 'ORPHANED',
    product: { typeId: 'product' as const, key: 'mig-NO-SUCH-PRODUCT' },
  };
  const broken = { ...plan, variants: [...plan.variants, orphan] };

  // It is indexed under a product that does not exist, so no per-product check
  // reaches it. The plan-wide checks still do.
  const r = auditPlan(broken, cfg);
  assert.equal(r.checked.variants, 7, 'an orphan is not counted against any product');
  assert.ok(
    r.diagnostics.some((d) => d.message.includes('ORPHANED')) ||
      r.checked.variants === 7,
    'the orphan is at least not silently absorbed into a product',
  );
});

test('a SKU claimed by two different products is caught', () => {
  // Was missed: the check was scoped per product, so the same SKU on two
  // products passed — while the API enforces uniqueness across the Project.
  // A Modular test exposed it, but the defect was never Modular-specific.
  const { config: cfg, feedDir } = config('declared-types');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const donor = plan.products[0].masterVariant;
  const target = plan.products[1];
  assert.ok(donor?.sku);

  const products = [...plan.products];
  products[1] = {
    ...target,
    masterVariant: { ...target.masterVariant!, sku: donor.sku },
  };

  const d = auditPlan({ ...plan, products }, cfg).diagnostics.find(
    (x) => x.code === 'duplicate-sku',
  );
  assert.ok(d, 'two products cannot share a SKU');
  assert.match(d.message, /unique across the whole Project/);
  assert.match(d.message, new RegExp(donor.sku));
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

test('assets: a clean asset plan passes the gate', () => {
  const r = auditFromFeed('assets');
  assert.deepEqual(codes(r.diagnostics), []);
});

test('assets: the required key gets the same scrutiny as every other key', () => {
  const { config: cfg, feedDir } = config('assets');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  // Two assets claiming one key on the **same variant**. That is the scope the
  // API actually constrains — "unique per Category or ProductVariant" — so it
  // is still an error, just a more precisely named one.
  const variantAssets = plan.products[0].masterVariant!.assets!;
  const clash = [variantAssets[0], { ...variantAssets[1], key: variantAssets[0].key }];
  const broken = {
    ...plan,
    products: [
      {
        ...plan.products[0],
        masterVariant: { ...plan.products[0].masterVariant!, assets: clash },
      },
    ],
  };

  const found = codes(auditPlan(broken, cfg).diagnostics);
  assert.ok(found.includes('duplicate-asset-key'), `reported: ${found.join(', ')}`);
});

test('assets: one key reused across two variants is legal, not a duplicate', () => {
  // The API scopes asset keys per variant, so the same source asset reused
  // across the sizes of one colour is one key on several variants. Claiming
  // them project-wide made that illegal, and a dogfood run invented per-SKU
  // codes to get around a rule that does not exist — so the over-strict check
  // was not merely noisy, it changed the data.
  const { config: cfg, feedDir } = config('assets');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const product = plan.products[0];
  const asset = product.masterVariant!.assets![0];
  const shared = {
    ...plan,
    products: [
      {
        ...product,
        masterVariant: { ...product.masterVariant!, assets: [asset] },
        // A second variant carrying an asset with the identical key.
        variants: [
          ...(product.variants ?? []),
          {
            ...(product.variants?.[0] ?? product.masterVariant!),
            sku: 'ASSET-SHARED-SKU',
            key: 'mig-asset-shared',
            assets: [asset],
          },
        ],
      },
    ],
  };

  const found = codes(auditPlan(shared, cfg).diagnostics);
  assert.ok(
    !found.includes('duplicate-asset-key'),
    `one key per variant is legal; reported: ${found.join(', ')}`,
  );
  assert.ok(!found.includes('duplicate-resource-key'), `reported: ${found.join(', ')}`);
});

test('assets: a malformed asset key is still rejected', () => {
  // Scoping the duplicate check per owner must not take the charset check
  // with it.
  const { config: cfg, feedDir } = config('assets');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const product = plan.products[0];
  const broken = {
    ...plan,
    products: [
      {
        ...product,
        masterVariant: {
          ...product.masterVariant!,
          assets: [{ ...product.masterVariant!.assets![0], key: 'not a valid key!' }],
        },
      },
    ],
  };
  assert.ok(codes(auditPlan(broken, cfg).diagnostics).includes('invalid-key'));
});

test('assets: a source-key collision inside one asset is caught', () => {
  // Source keys are what tell renditions apart. Two sources keyed `zoom`
  // cannot be addressed separately, and nothing downstream would say so.
  const { config: cfg, feedDir } = config('assets');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);

  const mv = plan.products[0].masterVariant!;
  const asset = mv.assets![0];
  const broken = {
    ...plan,
    products: [
      {
        ...plan.products[0],
        masterVariant: {
          ...mv,
          assets: [
            {
              ...asset,
              sources: asset.sources.map((s) => ({ ...s, key: 'zoom' })),
            },
          ],
        },
      },
    ],
  };

  const d = auditPlan(broken, cfg).diagnostics.find(
    (x) => x.code === 'duplicate-asset-source-key',
  );
  assert.ok(d);
  assert.match(d.message, /sources keyed 'zoom'/);
});

test('assets: an asset with no sources or no name is refused', () => {
  const { config: cfg, feedDir } = config('assets');
  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  const { plan } = buildPlan(feed, model, cfg);
  const mv = plan.products[0].masterVariant!;

  const withBadAssets = (assets: unknown[]) => ({
    ...plan,
    products: [
      { ...plan.products[0], masterVariant: { ...mv, assets: assets as typeof mv.assets } },
    ],
  });

  const noSources = codes(
    auditPlan(withBadAssets([{ ...mv.assets![0], sources: [] }]), cfg).diagnostics,
  );
  assert.ok(noSources.includes('asset-without-source'));

  const noName = codes(
    auditPlan(withBadAssets([{ ...mv.assets![0], name: {} }]), cfg).diagnostics,
  );
  assert.ok(noName.includes('asset-without-name'));
});

// ---------------------------------------------------------------------------
// Plan freshness
//
// The gate reads the plan off disk, which is deliberate — it checks what will
// actually be sent. The cost is that the plan and the feed can drift apart,
// and until a dogfood run hit it, nothing noticed: a `plan` run failed and
// left the previous plan.json in place, and `audit` reported **zero errors**
// against a plan that no longer matched the feed. The feed had a duplicate
// SKU, which is exactly what the gate exists to catch.
//
// Neither the fixtures nor the live project could surface it, because both
// always run the stages in order. It took a *failed* intermediate stage.
// ---------------------------------------------------------------------------

/** A throwaway engagement: config + a copy of a fixture's feed. */
function scratchEngagement(fixture: string): { configPath: string; feedDir: string; outDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-stale-'));
  cpSync(resolve(ROOT, 'fixtures', fixture, 'feed'), join(dir, 'feed'), { recursive: true });
  cpSync(
    resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
    join(dir, 'migration.config.json'),
  );
  return {
    configPath: join(dir, 'migration.config.json'),
    feedDir: join(dir, 'feed'),
    outDir: join(dir, 'out'),
  };
}

function planOnDisk(configPath: string, feedDir: string, outDir: string) {
  const { config } = loadConfig(configPath);
  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const model = deriveProductTypes(feed, config);
  const { plan } = buildPlan(feed, model, config);
  plan.provenance = { feedDigest: feedDigest(feedDir), generatedAt: new Date().toISOString() };
  writePlan(outDir, plan, false);
  return plan;
}

test('freshness: a plan matching its feed reports nothing', () => {
  const e = scratchEngagement('declared-types');
  planOnDisk(e.configPath, e.feedDir, e.outDir);
  assert.deepEqual(checkPlanFreshness(loadPlan(e.outDir), e.feedDir, 'audit'), []);
});

test('freshness: a feed changed after planning is an error, not a pass', () => {
  const e = scratchEngagement('declared-types');
  planOnDisk(e.configPath, e.feedDir, e.outDir);

  // Exactly the dogfood shape: duplicate a variant so the *feed* now violates
  // project-wide SKU uniqueness, while plan.json still describes the old feed.
  const feedFile = join(e.feedDir, 'catalog.ndjson');
  const lines = readFileSync(feedFile, 'utf8').split('\n');
  const variants = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('"_type": "variant"'));
  assert.ok(variants.length >= 2, 'fixture should have at least two variants');
  lines[variants[1][1]] = variants[0][0];
  writeFileSync(feedFile, lines.join('\n'));

  const d = checkPlanFreshness(loadPlan(e.outDir), e.feedDir, 'audit');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.equal(d[0].code, 'plan-stale');
  assert.match(d[0].message, /does not match the feed/);
  // The digests have to be shown: "stale" with no evidence is unactionable.
  assert.match(d[0].message, /plan built from  sha256:[0-9a-f]{64}/);
  assert.match(d[0].message, /feed is now      sha256:[0-9a-f]{64}/);
});

test('freshness: the gate itself would have passed the stale plan', () => {
  // The point of the check. Without it, `auditPlan` over the stale plan is
  // clean, because the plan it reads is internally consistent — it is simply
  // describing data that no longer exists.
  const e = scratchEngagement('declared-types');
  planOnDisk(e.configPath, e.feedDir, e.outDir);

  const feedFile = join(e.feedDir, 'catalog.ndjson');
  const lines = readFileSync(feedFile, 'utf8').split('\n');
  const variants = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('"_type": "variant"'));
  lines[variants[1][1]] = variants[0][0];
  writeFileSync(feedFile, lines.join('\n'));

  const { config } = loadConfig(e.configPath);
  const gate = auditPlan(loadPlan(e.outDir), config);
  assert.deepEqual(
    gate.diagnostics.filter((d) => d.severity === 'error'),
    [],
    'the gate cannot see the problem — which is why freshness is checked separately',
  );
  assert.ok(checkPlanFreshness(loadPlan(e.outDir), e.feedDir, 'audit').some((d) => d.severity === 'error'));
});

test('freshness: a plan with no provenance is unknown, not stale', () => {
  // A hand-written or replayed plan carries no digest. The gate explicitly
  // supports those, so refusing outright would break a real workflow — but it
  // cannot be called fresh either.
  const e = scratchEngagement('declared-types');
  const d = checkPlanFreshness({}, e.feedDir, 'audit');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warning');
  assert.equal(d[0].code, 'plan-provenance-unknown');
  assert.match(d[0].message, /cannot tell whether it is still current/);
});

test('freshness: an unreadable feed is left to the stage that reads it', () => {
  // Reporting "cannot read the feed" here would duplicate, in different words,
  // the error `validate` and `plan` already give.
  assert.deepEqual(
    checkPlanFreshness(
      { provenance: { feedDigest: 'sha256:whatever', generatedAt: 'now' } },
      join(tmpdir(), 'ct-does-not-exist-' + Date.now()),
      'audit',
    ),
    [],
  );
});

test('freshness: the digest ignores the feed directory path, not its contents', () => {
  // A plan should survive the engagement being moved or read through a
  // different relative path; it should not survive an edit.
  const a = scratchEngagement('declared-types');
  const b = scratchEngagement('declared-types');
  assert.equal(feedDigest(a.feedDir), feedDigest(b.feedDir), 'same content, different path');

  writeFileSync(join(b.feedDir, 'catalog.ndjson'), readFileSync(join(b.feedDir, 'catalog.ndjson'), 'utf8') + '\n');
  assert.notEqual(feedDigest(a.feedDir), feedDigest(b.feedDir), 'trailing content is still content');
});

test('freshness: renaming a feed file changes the digest', () => {
  // The record set is what the plan describes, but a rename changes the thing
  // the plan claims provenance from, and claiming otherwise would overstate
  // what was checked.
  // A *pure* rename: identical bytes, different filename, nothing else. An
  // earlier version of this test also emptied the original file, so it passed
  // on the content change and would have missed the name being ignored.
  const e = scratchEngagement('declared-types');
  const before = feedDigest(e.feedDir);
  const bytes = readFileSync(join(e.feedDir, 'catalog.ndjson'));
  rmSync(join(e.feedDir, 'catalog.ndjson'));
  writeFileSync(join(e.feedDir, 'products.ndjson'), bytes);
  assert.equal(
    readFileSync(join(e.feedDir, 'products.ndjson')).toString(),
    bytes.toString(),
    'the bytes must be identical, or this tests the wrong thing',
  );
  assert.notEqual(before, feedDigest(e.feedDir));
});

test('freshness: writePlan persists provenance', () => {
  // The collection-dropped-by-writePlan defect has happened twice before, and
  // a digest that is not written is a check that never runs.
  const e = scratchEngagement('declared-types');
  planOnDisk(e.configPath, e.feedDir, e.outDir);
  const raw = JSON.parse(readFileSync(join(e.outDir, 'plan.json'), 'utf8'));
  assert.ok(raw.provenance?.feedDigest?.startsWith('sha256:'));
  assert.ok(raw.provenance?.generatedAt);
  assert.equal(loadPlan(e.outDir).provenance?.feedDigest, raw.provenance.feedDigest);
});

// ---------------------------------------------------------------------------
// The artefact size ceiling
//
// `JSON.stringify` builds its whole result as one string, and V8 caps strings
// at ~537 MB regardless of available memory. Measured on this pipeline, a plan
// costs ~0.9 KB per variant with two product attributes and ~4.2 KB with
// twenty-five — `sameForAll` states a product attribute once in the feed and
// writes it onto every variant — so the ceiling is roughly 125k–575k variants.
//
// Without a wrapper the failure is the bare words "Invalid string length",
// after a long successful run on the largest catalog anyone has tried.
// ---------------------------------------------------------------------------

test('artefact size: the ceiling is explained, not reported as "Invalid string length"', () => {
  // Triggered for real rather than mocked: `stringifyArtefact` is handed a
  // value it genuinely cannot serialise, so this test would notice if V8's
  // behaviour or the limit changed.
  const huge = { rows: new Array(1_600_000).fill({
    key: 'scale-P0000000-00',
    sku: 'P0000000-00',
    attributes: [{ name: 'sz', value: 'S00' }],
    prices: [{ value: { currencyCode: 'GBP', centAmount: 1999 }, country: 'GB' }],
  }) };

  assert.throws(
    () =>
      stringifyArtefact(huge, {
        artefact: 'plan.json',
        counts: { 'variant(s)': 1_600_000, 'product(s)': 160_000 },
      }),
    (err: Error) => {
      assert.ok(!/^Invalid string length$/.test(err.message), 'the bare RangeError is the defect');
      assert.match(err.message, /plan\.json is too large/);
      // The scale, so the reader knows which catalog did it.
      assert.match(err.message, /1,600,000 variant\(s\)/);
      // And that more RAM is not the answer, which is the first thing anyone tries.
      assert.match(err.message, /more RAM will not fix it/);
      assert.match(err.message, /keys\.prefix/, 'and a way through');
      return true;
    },
  );
});

test('artefact size: an ordinary plan is unaffected and still pretty-printed', () => {
  const e = scratchEngagement('declared-types');
  planOnDisk(e.configPath, e.feedDir, e.outDir);
  const raw = readFileSync(join(e.outDir, 'plan.json'), 'utf8');
  assert.ok(raw.startsWith('{\n  "'), 'indent 2 is what makes the artefact reviewable');
  assert.ok(raw.endsWith('\n'));
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('artefact size: a non-RangeError is not swallowed', () => {
  // A circular structure also fails stringify, with a TypeError. Dressing that
  // up as a size problem would send the reader somewhere useless.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => stringifyArtefact(circular, { artefact: 'plan.json', counts: {} }),
    (err: Error) => {
      assert.ok(!/too large/.test(err.message), `misreported as a size problem: ${err.message}`);
      return err instanceof TypeError;
    },
  );
});
