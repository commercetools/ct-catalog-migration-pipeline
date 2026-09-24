/**
 * Mapping regression tests.
 *
 * The money and order-hint cases are unit tests rather than fixture runs
 * because their failure modes are silent: a wrong minor-unit conversion still
 * produces a valid-looking price, and an order hint ending in zero is only
 * rejected at the API. Both need asserting value by value.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { fromTypedMoney, toTypedMoney } from '../src/map/money.js';
import {
  allocateSlug,
  chooseMasterSku,
  isValidKey,
  orderHint,
  slugify,
} from '../src/map/identity.js';
import {
  attributesOf,
  pricesOf,
  typedAttribute,
  variantsOf,
  type ProductDraftImport,
  type ProductVariantDraftImport,
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

function plan(fixture: string, mutate?: (c: ReturnType<typeof loadConfig>['config']) => void) {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
  );
  mutate?.(config);
  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const model = deriveProductTypes(feed, config);
  return buildPlan(feed, model, config);
}

function product(result: ReturnType<typeof plan>, key: string): ProductDraftImport {
  const found = result.plan.products.find((p) => p.key === key);
  assert.ok(found, `product '${key}' should be in the plan`);
  return found;
}

function variants(p: ProductDraftImport): ProductVariantDraftImport[] {
  return variantsOf(p);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('money: minor units respect the currency, not a hardcoded 2', () => {
  const cases: [string, string, number, number][] = [
    ['19.99', 'GBP', 2, 1999],
    ['0.01', 'GBP', 2, 1],
    ['1000', 'GBP', 2, 100000],
    // The trap: a 0-digit currency defaulted to 2 is 100x too large.
    ['4500', 'JPY', 0, 4500],
    ['12.345', 'BHD', 3, 12345],
    ['0.001', 'BHD', 3, 1],
    ['-5.50', 'EUR', 2, -550],
  ];
  for (const [amount, currency, digits, expected] of cases) {
    const r = toTypedMoney(amount, currency, digits);
    assert.ok(r.ok, `${amount} ${currency} should convert`);
    assert.equal(r.money.centAmount, expected, `${amount} ${currency}`);
    assert.equal(r.money.fractionDigits, digits);
    assert.equal(r.money.type, 'centPrecision');
  }
});

test('money: trailing zeros beyond the currency precision are not a loss', () => {
  const r = toTypedMoney('29.9900', 'GBP', 2);
  assert.ok(r.ok, '29.9900 is exactly 29.99 and must be accepted');
  assert.equal(r.money.centAmount, 2999);
});

test('money: real excess precision is refused rather than rounded', () => {
  const r = toTypedMoney('29.999', 'GBP', 2);
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.match(r.reason, /3 decimal place\(s\) but GBP allows 2/);
  assert.match(r.reason, /Rounding would silently change the price/);
});

test('money: a 0-digit currency refuses any fractional amount', () => {
  const r = toTypedMoney('4500.5', 'JPY', 0);
  assert.equal(r.ok, false);
});

test('money: conversion avoids float error', () => {
  // 0.07 * 100 is 7.000000000000001 in binary floating point; the string path
  // has no such failure mode.
  const r = toTypedMoney('0.07', 'EUR', 2);
  assert.ok(r.ok);
  assert.equal(r.money.centAmount, 7);
  assert.ok(Number.isInteger(r.money.centAmount));
});

test('money: a malformed amount is rejected, not coerced', () => {
  for (const bad of ['', 'abc', '1.2.3', '1,50', ' 1.50', '1e3']) {
    assert.equal(toTypedMoney(bad, 'GBP', 2).ok, false, `'${bad}' should be rejected`);
  }
});

test('money: decoding back to decimal round-trips', () => {
  for (const [amount, currency, digits] of [
    ['19.99', 'GBP', 2],
    ['4500', 'JPY', 0],
    ['12.345', 'BHD', 3],
    ['0.01', 'GBP', 2],
    ['-5.50', 'EUR', 2],
  ] as [string, string, number][]) {
    const r = toTypedMoney(amount, currency, digits);
    assert.ok(r.ok);
    assert.equal(Number(fromTypedMoney(r.money)), Number(amount), amount);
  }
});

// ---------------------------------------------------------------------------
// Order hints
// ---------------------------------------------------------------------------

test('orderHint: strictly inside (0,1) and never ending in zero', () => {
  for (const siblings of [1, 2, 9, 10, 11, 99, 100, 1000]) {
    for (const position of [1, 2, siblings]) {
      const hint = orderHint(position, siblings);
      const value = Number(hint);
      assert.ok(value > 0 && value < 1, `${hint} must be inside (0,1)`);
      assert.ok(
        !hint.endsWith('0'),
        `${hint} ends in 0, which commercetools rejects for order hints`,
      );
    }
  }
});

test('orderHint: sorts in the same order as the positions it encodes', () => {
  for (const siblings of [3, 10, 25, 100]) {
    const hints = Array.from({ length: siblings }, (_, i) => orderHint(i + 1, siblings));
    const numeric = [...hints].sort((a, b) => Number(a) - Number(b));
    const lexical = [...hints].sort();
    assert.deepEqual(numeric, hints, `numeric order breaks at ${siblings} siblings`);
    // Fixed-width padding is what makes these agree; without it "0.10" would
    // sort before "0.2".
    assert.deepEqual(lexical, hints, `lexical order breaks at ${siblings} siblings`);
  }
});

// ---------------------------------------------------------------------------
// Slugs and keys
// ---------------------------------------------------------------------------

test('slugify: strips diacritics instead of dropping the letters', () => {
  assert.equal(slugify('Oberbekleidung für Männer'), 'oberbekleidung-fur-manner');
  assert.equal(slugify('Größe'), 'grosse');
  assert.equal(slugify('Accessoires'), 'accessoires');
  assert.equal(slugify('  Wool  Scarf  '), 'wool-scarf');
  assert.equal(slugify('!!!'), '');
});

test('slugify: output is always a legal key or empty', () => {
  for (const input of ['Field Jacket', 'Größe', 'a/b\\c', '—dash—', 'ÀÉÎÕÜ']) {
    const s = slugify(input);
    if (s !== '') assert.ok(isValidKey(s), `'${s}' from '${input}' must be a legal key`);
  }
});

test('allocateSlug: a collision is resolved with the traceable source code', () => {
  const taken = new Map<string, Set<string>>();
  const first = allocateSlug('mens-acc', { 'en-GB': 'Accessories' }, undefined, ['en-GB'], taken);
  const second = allocateSlug('womens-acc', { 'en-GB': 'Accessories' }, undefined, ['en-GB'], taken);

  assert.equal(first.slug['en-GB'], 'accessories');
  assert.equal(second.slug['en-GB'], 'accessories-womens-acc');
  assert.deepEqual(second.disambiguated, [
    { locale: 'en-GB', slug: 'accessories-womens-acc' },
  ]);
});

test('allocateSlug: a name that slugifies to nothing falls back to the code', () => {
  const r = allocateSlug('symbols', { 'en-GB': '!!!' }, undefined, ['en-GB'], new Map());
  assert.equal(r.slug['en-GB'], 'symbols');
  assert.ok(r.derived.includes('en-GB'));
});

test('allocateSlug: the same slug may repeat across locales', () => {
  const taken = new Map<string, Set<string>>();
  const r = allocateSlug(
    'acc',
    { 'en-GB': 'Accessories', 'de-DE': 'Accessories' },
    undefined,
    ['en-GB', 'de-DE'],
    taken,
  );
  assert.equal(r.slug['en-GB'], 'accessories');
  assert.equal(r.slug['de-DE'], 'accessories', 'uniqueness is per locale, not global');
  assert.deepEqual(r.disambiguated, []);
});

test('chooseMasterSku: an explicit claim wins, otherwise the lowest SKU', () => {
  const skus = ['B-2', 'A-1', 'C-3'];
  assert.deepEqual(chooseMasterSku(skus, 'C-3'), { sku: 'C-3', byFallback: false });
  assert.deepEqual(chooseMasterSku(skus, undefined), { sku: 'A-1', byFallback: true });
  // A claim naming a SKU that is not there must not silently win.
  assert.deepEqual(chooseMasterSku(skus, 'MISSING'), { sku: 'A-1', byFallback: true });
});

test('chooseMasterSku: the fallback does not depend on input order', () => {
  const a = chooseMasterSku(['B-2', 'A-1', 'C-3'], undefined);
  const b = chooseMasterSku(['C-3', 'B-2', 'A-1'], undefined);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

test('plan: the declared fixture maps cleanly', () => {
  const r = plan('declared-types');
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.plan.categories.length, 4);
  assert.equal(r.plan.products.length, 3);
  assert.deepEqual(r.plan.loadOrder, [
    // The first two are created through the platform API, not imported —
    // they lead because prices reference them.
    'channel',
    'customer-group',
    'product-type',
    'category',
    'product-draft',
    'variant',
    'standalone-price',
    'product-selection',
    // Also a platform stage, but *last*: a store references product
    // selections, which the Import API creates asynchronously, so it cannot
    // be created alongside the channels.
    'store',
  ]);
  // Every optional stage is declared but empty here: this fixture is Classic,
  // embedded-price, and declares no assortments.
  assert.deepEqual(r.plan.standalonePrices, []);
  assert.deepEqual(r.plan.variants, []);
  assert.deepEqual(r.plan.productSelections, []);
  assert.deepEqual(r.plan.prerequisites.stores, []);
});

test('plan: every key carries the configured prefix and is legal', () => {
  const r = plan('declared-types');
  for (const c of r.plan.categories) {
    assert.ok(c.key.startsWith('mig-'), `${c.key} must be prefixed for bounded teardown`);
    assert.ok(isValidKey(c.key));
  }
  for (const p of r.plan.products) {
    assert.ok(p.key.startsWith('mig-'));
    assert.ok(isValidKey(p.key));
    for (const v of variants(p)) assert.ok(isValidKey(v.key), `${v.key} must be a legal key`);
  }
});

test('plan: references are KeyReferences, never ids', () => {
  const r = plan('declared-types');
  const outerwear = r.plan.categories.find((c) => c.key === 'mig-outerwear');
  assert.ok(outerwear);
  assert.deepEqual(outerwear.parent, { typeId: 'category', key: 'mig-apparel' });

  const p = product(r, 'mig-JKT-FIELD');
  // Prefixed like every other reference here. It used to read `apparel-basic`,
  // bare, right beside two `mig-` categories: ProductType keys were the one
  // resource that escaped `keys.prefix`, so a teardown scoped to the prefix
  // left them behind and two engagements in one project collided on them.
  assert.deepEqual(p.productType, { typeId: 'product-type', key: 'mig-apparel-basic' });
  assert.deepEqual(p.categories, [{ typeId: 'category', key: 'mig-outerwear' }]);
});

test('plan: order hints are per sibling group, not global', () => {
  const r = plan('declared-types');
  const hint = (key: string) => r.plan.categories.find((c) => c.key === key)!.orderHint!;
  // Two roots and two children of apparel: each group numbers from 1.
  assert.equal(hint('mig-apparel'), hint('mig-tops'));
  assert.notEqual(hint('mig-tops'), hint('mig-outerwear'));
  for (const c of r.plan.categories) assert.ok(!c.orderHint!.endsWith('0'));
});

test('plan: parents are emitted before their children', () => {
  const r = plan('declared-types');
  const position = new Map(r.plan.categories.map((c, i) => [c.key, i]));
  for (const c of r.plan.categories) {
    if (!c.parent) continue;
    assert.ok(
      position.get(c.parent.key)! < position.get(c.key)!,
      `${c.key} is emitted before its parent ${c.parent.key}`,
    );
  }
});

test('plan: product-level attributes are replicated onto every variant', () => {
  const r = plan('declared-types');
  const p = product(r, 'mig-TEE-CLASSIC');
  for (const v of variants(p)) {
    const names = attributesOf(v).map((a) => a.name);
    // SameForAll enforces that variants agree; it does not distribute the value.
    assert.ok(names.includes('material'), `${v.sku} is missing the SameForAll attribute`);
    assert.ok(names.includes('organicCertified'));
  }
});

test('plan: axis codes become attribute values and labels never do', () => {
  const r = plan('declared-types');
  const v = variants(product(r, 'mig-TEE-CLASSIC')).find((x) => x.sku === 'TEE-CLASSIC-NVY-M');
  assert.ok(v);
  const byName = new Map(attributesOf(v).map((a) => [a.name, a.value]));
  assert.equal(byName.get('colour'), 'NVY', 'the enum key is written, not the label');
  assert.equal(byName.get('size'), 'M');
  assert.ok(
    !attributesOf(v).some((a) => typeof a.value === 'object' && a.name === 'colour'),
    'an axis must never be written as a localized value',
  );
});

test('plan: attributes are ordered deterministically', () => {
  const r = plan('declared-types');
  for (const p of r.plan.products) {
    for (const v of variants(p)) {
      const names = attributesOf(v).map((a) => a.name);
      assert.deepEqual(names, [...names].sort(), `${v.sku} attribute order is not stable`);
    }
  }
});

test("plan: the feed's validTo becomes the API's validUntil", () => {
  const r = plan('declared-types');
  const dated = variants(product(r, 'mig-JKT-FIELD'))
    .flatMap((v) => pricesOf(v))
    .find((p) => p.validFrom !== undefined);
  assert.ok(dated, 'the fixture has a promotional price window');
  assert.equal(dated.validFrom, '2026-11-27T00:00:00.000Z');
  assert.equal(dated.validUntil, '2026-12-02T00:00:00.000Z');
  assert.ok(!('validTo' in dated), 'validTo is the feed field name, not the API one');
});

test('plan: products are never published by the import', () => {
  for (const p of plan('declared-types').plan.products) {
    assert.equal(p.publish, false, 'publishing stays a separate, deliberate step');
  }
});

test('plan: the key map covers every resource and is source-keyed', () => {
  const r = plan('declared-types');
  assert.equal(r.plan.keyMap.categories['outerwear'], 'mig-outerwear');
  assert.equal(r.plan.keyMap.products['JKT-FIELD'], 'mig-JKT-FIELD');
  assert.equal(r.plan.keyMap.variants['JKT-FIELD-OAT-L'], 'mig-JKT-FIELD-OAT-L');
  assert.equal(Object.keys(r.plan.keyMap.categories).length, 4);
  assert.equal(Object.keys(r.plan.keyMap.products).length, 3);
  assert.equal(Object.keys(r.plan.keyMap.variants).length, 7);
});

test('plan: externalId preserves the source identifier alongside the key', () => {
  const r = plan('declared-types');
  const tops = r.plan.categories.find((c) => c.key === 'mig-tops');
  assert.equal(tops!.externalId, 'tops', 'downstream systems still join on the source id');
});

test('plan: building is deterministic across runs', () => {
  const a = JSON.stringify(plan('declared-types').plan);
  const b = JSON.stringify(plan('declared-types').plan);
  assert.equal(a, b, 'two runs of the same feed must produce byte-identical plans');
});

// ---------------------------------------------------------------------------
// Standalone prices
//
// The same feed, mapped under both price modes. These are compared against
// each other deliberately: the prices themselves must not change, only where
// they are written.
// ---------------------------------------------------------------------------

test('standalone: prices leave the variants and become their own resources', () => {
  const r = plan('classic-standalone');
  assert.deepEqual(r.diagnostics, []);

  const embeddedCount = r.plan.products
    .flatMap((p) => variants(p))
    .flatMap((v) => pricesOf(v)).length;
  assert.equal(embeddedCount, 0, 'a price in both places would be imported twice');

  const embedded = plan('declared-types');
  const expected = embedded.plan.products
    .flatMap((p) => variants(p))
    .flatMap((v) => pricesOf(v)).length;
  assert.ok(expected > 0, 'the fixture has prices at all');
  assert.equal(
    r.plan.standalonePrices.length,
    expected,
    'every price the embedded mode writes has to survive the switch',
  );
});

test('standalone: every product declares the Standalone price mode', () => {
  // Price selection reads only the kind of price the product declares, so a
  // product left on the default would import fine and then show no price.
  for (const p of plan('classic-standalone').plan.products) {
    assert.equal(p.priceMode, 'Standalone');
  }
  for (const p of plan('declared-types').plan.products) {
    assert.equal(p.priceMode, 'Embedded');
  }
});

test('standalone: each price carries the SKU of the variant it priced', () => {
  const r = plan('classic-standalone');
  const skus = new Set(
    r.plan.products.flatMap((p) => variants(p)).map((v) => v.sku),
  );
  for (const price of r.plan.standalonePrices) {
    assert.ok(
      skus.has(price.sku),
      `${price.key} references SKU '${price.sku}', which is not in the plan`,
    );
  }
});

test('standalone: the key and scope are identical to the embedded price', () => {
  // The key is what makes a re-run an update rather than a duplicate, so it
  // must not depend on the price mode.
  const standalone = plan('classic-standalone').plan.standalonePrices;
  const embedded = plan('declared-types')
    .plan.products.flatMap((p) => variants(p))
    .flatMap((v) => pricesOf(v));

  assert.deepEqual(
    standalone.map((p) => p.key).sort(),
    embedded.map((p) => p.key).sort(),
  );

  const byKey = new Map(standalone.map((p) => [p.key, p]));
  for (const price of embedded) {
    const same = byKey.get(price.key)!;
    assert.deepEqual(same.value, price.value, `${price.key}: the money must be untouched`);
    assert.equal(same.country, price.country);
    assert.equal(same.validFrom, price.validFrom);
    assert.equal(same.validUntil, price.validUntil);
  }
});

test('standalone: the scope requirement is recorded as a decision', () => {
  const decisions = plan('classic-standalone').plan.decisions;
  const pricing = decisions.find((d) => d.subject === 'pricing');
  assert.ok(pricing, 'a reviewer has to learn about this before the load fails on it');
  assert.match(pricing.rationale, /manage_standalone_prices/);
  assert.equal(pricing.review, true);

  assert.ok(
    !plan('declared-types').plan.decisions.some((d) => d.subject === 'pricing'),
    'embedded pricing needs no extra scope, so it earns no decision',
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('plan: slug collisions across branches are resolved and recorded as lossy', () => {
  const r = plan('plan-edges');
  const slugs = r.plan.categories.map((c) => c.slug['en-GB']);
  assert.deepEqual([...new Set(slugs)].sort(), [...slugs].sort(), 'slugs must be unique');
  assert.ok(slugs.includes('accessories-womens-acc'));

  const d = r.plan.decisions.find(
    (x) => x.outcome.includes('disambiguated') && x.subject === 'category:womens-acc',
  );
  assert.ok(d, 'a changed URL is information loss and has to be recorded');
  assert.equal(d.lossy, true);
});

test('plan: two products sharing a name get distinct slugs', () => {
  const r = plan('plan-edges');
  const slugs = r.plan.products.map((p) => p.slug['en-GB']);
  assert.deepEqual([...new Set(slugs)].sort(), [...slugs].sort());
});

test('plan: mixed-precision currencies convert independently', () => {
  const r = plan('plan-edges');
  const prices = r.plan.products
    .flatMap((p) => variants(p))
    .flatMap((v) => pricesOf(v))
    .map((p) => [p.value.currencyCode, p.value.centAmount] as const);

  assert.ok(
    prices.some(([c, a]) => c === 'JPY' && a === 4500),
    'JPY has 0 fraction digits: 4500 must stay 4500, not become 450000',
  );
  assert.ok(prices.some(([c, a]) => c === 'BHD' && a === 12345));
  assert.ok(prices.some(([c, a]) => c === 'GBP' && a === 2999));
});

test('plan: an unconvertible amount blocks the plan', () => {
  const r = plan('plan-money-error');
  const d = r.diagnostics.find((x) => x.code === 'money-precision');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /SCARF-B-M/);
});

test("plan: the 'native' product-level strategy is refused rather than mismapped", () => {
  const r = plan('declared-types', (c) => {
    c.productTypes.productLevelStrategy = 'native';
  });
  const d = r.diagnostics.find((x) => x.code === 'native-product-level-not-mapped');
  assert.ok(d, 'writing Product-level values is a different shape and is not built yet');
  assert.equal(d.severity, 'error');
});

test('plan: a single-variant product has no extra variants', () => {
  const r = plan('declared-types');
  const cap = product(r, 'mig-CAP-LOGO');
  assert.equal((cap.variants ?? []).length, 0);
  assert.equal(cap.masterVariant!.sku, 'CAP-LOGO-OS');
});

test('plan: an image with no dimensions defaults to 0x0 and is recorded as lossy', () => {
  const r = plan('declared-types');
  const withImages = variants(product(r, 'mig-TEE-CLASSIC')).filter(
    (v) => (v.images ?? []).length > 0,
  );
  assert.ok(withImages.length > 0);
  // The fixture supplies dimensions, so nothing should be flagged here.
  for (const v of withImages) {
    for (const img of v.images ?? []) {
      assert.ok(img.dimensions.w > 0 && img.dimensions.h > 0);
    }
  }
  assert.ok(
    !r.plan.decisions.some((d) => d.outcome.includes('image dimensions defaulted')),
    'no dimension decision expected when the feed supplies them',
  );
});

// ---------------------------------------------------------------------------
// The Modular catalog model
//
// The same feed, mapped for both models. Compared against each other on
// purpose: nothing about the catalog changes, only the shape it is written in.
// ---------------------------------------------------------------------------

test('modular: products become containers and carry no variant data', () => {
  // The API refuses masterVariant and variants on a Modular product. Sending
  // them would be rejected per record, so their absence is the requirement.
  const r = plan('modular-standalone');
  assert.deepEqual(r.diagnostics, []);

  for (const p of r.plan.products) {
    assert.equal(p.masterVariant, undefined, `${p.key} must not carry a master variant`);
    assert.equal(p.variants, undefined, `${p.key} must not carry variants`);
    assert.ok(p.name, 'the shared data still belongs on the product');
    assert.ok(p.slug);
  }
});

test('modular: every variant becomes its own resource, keyed to its product', () => {
  const modular = plan('modular-standalone');
  const classic = plan('declared-types');

  const classicVariants = classic.plan.products.flatMap((p) => variants(p));
  assert.ok(classicVariants.length > 0);
  assert.equal(
    modular.plan.variants.length,
    classicVariants.length,
    'no variant may be lost in the switch',
  );

  const productKeys = new Set(modular.plan.products.map((p) => p.key));
  for (const v of modular.plan.variants) {
    assert.equal(v.product.typeId, 'product');
    assert.ok(productKeys.has(v.product.key), `${v.key} references an unknown product`);
    assert.ok(v.sku, 'a Modular variant requires a SKU');
    assert.equal(v.publish, false, 'staged, like everything else this pipeline imports');
  }
});

test('modular: keys and SKUs are identical to the Classic shape', () => {
  // The key is what makes a re-run an update. Moving a variant out of its
  // product must not change its identity.
  const modular = plan('modular-standalone').plan;
  const classic = plan('declared-types').plan;

  const classicByKey = new Map(
    classic.products.flatMap((p) => variants(p)).map((v) => [v.key, v]),
  );
  assert.equal(modular.variants.length, classicByKey.size);

  for (const v of modular.variants) {
    const same = classicByKey.get(v.key);
    assert.ok(same, `${v.key} has no Classic counterpart`);
    assert.equal(v.sku, same.sku);
    assert.deepEqual(v.attributes, same.attributes, `${v.key}: attributes must be untouched`);
    assert.deepEqual(v.images, same.images);
  }
});

test('modular: a variant resource has no price field, ever', () => {
  // Modular pricing is exclusively Standalone. VariantImport has no `prices`,
  // so a price that failed to move would be silently dropped rather than
  // rejected — which is why the count is asserted on both sides.
  const r = plan('modular-standalone').plan;
  for (const v of r.variants) {
    assert.ok(!('prices' in v), `${v.key} must not carry prices`);
  }

  const expected = plan('declared-types')
    .plan.products.flatMap((p) => variants(p))
    .flatMap((v) => pricesOf(v)).length;
  assert.equal(
    r.standalonePrices.length,
    expected,
    'every embedded price has to reappear as a Standalone Price',
  );
});

test('modular: the key map still covers every variant', () => {
  // Under Modular the variants are not inside the products, so a key map built
  // by walking products alone would silently lose all of them — and a teardown
  // reads the key map to find what this migration created.
  const r = plan('modular-standalone').plan;
  assert.equal(Object.keys(r.keyMap.variants).length, r.variants.length);
  assert.equal(r.keyMap.variants['JKT-FIELD-OAT-L'], 'mig-JKT-FIELD-OAT-L');
});

test('modular: the unsettable defaultVariant is declared as information loss', () => {
  // The master-variant choice is still made and logged, and then cannot be
  // written: Product.defaultVariant appears nowhere in the Import API. Silently
  // dropping a decision the pipeline advertises would be the worse outcome.
  const decisions = plan('modular-standalone').plan.decisions;
  const d = decisions.find((x) => x.subject === 'defaultVariant');
  assert.ok(d, 'a choice that cannot be imported has to be declared');
  assert.equal(d.lossy, true);
  assert.equal(d.review, true);
  assert.match(d.rationale, /no field for it/);

  assert.ok(
    !plan('declared-types').plan.decisions.some((x) => x.subject === 'defaultVariant'),
    'Classic sets a master variant, so there is nothing to declare',
  );
});

test('a set of localized strings survives the contract and maps to ltext-set', () => {
  // The Import API has `LocalizableTextSetAttribute` (`ltext-set`), and
  // `typedAttribute` already emitted it — but the schema's attributeValue only
  // allowed arrays of scalars, so the shape was unrepresentable in the feed. A
  // dogfood engagement hit this on a multiValued localized hybris attribute
  // and dropped the localized dimension to get past it, for no good reason.
  const attribute = typedAttribute(
    'pocketStyles',
    { name: 'set', elementType: { name: 'ltext' } },
    [
      { 'en-GB': 'Patch pocket', 'de-DE': 'Aufgesetzte Tasche' },
      { 'en-GB': 'Welt pocket', 'de-DE': 'Paspeltasche' },
    ],
  );
  assert.ok(attribute);
  assert.equal(attribute.type, 'ltext-set', 'the discriminator carries the -set suffix');
  assert.equal((attribute as { value: unknown[] }).value.length, 2);

  // And the schema accepts it, which is the half that was missing.
  const dir = mkdtempSync(join(tmpdir(), 'ct-ltextset-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(
    join(feedDir, 'catalog.ndjson'),
    [
      {
        _type: 'attributeDefinition',
        name: 'pocketStyles',
        type: 'ltext',
        level: 'product',
        set: true,
      },
      {
        _type: 'product',
        code: 'P1',
        name: { 'en-GB': 'One' },
        attributes: { pocketStyles: [{ 'en-GB': 'Patch' }, { 'en-GB': 'Welt' }] },
      },
      { _type: 'variant', sku: 'P1-A', product: 'P1' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );

  const config = JSON.parse(
    readFileSync(resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json'), 'utf8'),
  );
  config.feed.dir = feedDir;
  const configPath = join(dir, 'migration.config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const loaded = loadConfig(configPath);

  const r = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  assert.equal(
    r.rejected,
    0,
    `a set of localized strings must not be a schema violation: ${JSON.stringify(r.diagnostics)}`,
  );

  // An empty set must stay legal too — the reason this is one array branch
  // rather than two: `[]` would match both and oneOf would reject it.
  const empty = typedAttribute('pocketStyles', { name: 'set', elementType: { name: 'ltext' } }, []);
  assert.deepEqual((empty as { value: unknown[] }).value, []);
});

// ---------------------------------------------------------------------------
// Relative media URLs
//
// The source stores a site-relative path and keeps the host somewhere the
// export does not reach. The host therefore cannot be derived, only supplied —
// and the old contract made a relative URL a schema violation, so the only way
// to get a feed to validate was to invent a hostname. An engagement did.
// ---------------------------------------------------------------------------

/** A feed with one relative and one absolute image, plus an optional baseUrl. */
function mediaFixture(baseUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-media-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(
    join(feedDir, 'catalog.ndjson'),
    [
      { _type: 'attributeDefinition', name: 'material', type: 'text', level: 'product' },
      { _type: 'product', code: 'P1', name: { 'en-GB': 'One' }, attributes: { material: 'Cotton' } },
      {
        _type: 'variant',
        sku: 'P1-A',
        product: 'P1',
        images: [
          { url: '/medias/sys_master/root/h9c/product.jpg', label: 'front' },
          { url: 'https://other.example.com/already-absolute.jpg' },
        ],
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );

  const config = JSON.parse(
    readFileSync(resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json'), 'utf8'),
  );
  config.feed.dir = feedDir;
  if (baseUrl !== undefined) config.media = { baseUrl };
  const configPath = join(dir, 'migration.config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return loadConfig(configPath);
}

test('media: a relative URL is expressible, not a schema violation', () => {
  // It used to be `format: uri`. The schema rejecting it is what forced the
  // guess: there was no way to carry the source's own value through the feed.
  const loaded = mediaFixture('https://cdn.example.com/');
  const r = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  assert.equal(r.rejected, 0, JSON.stringify(r.diagnostics));
});

test('media: relative URLs with no baseUrl stop the run and name the decision', () => {
  const loaded = mediaFixture(undefined);
  const r = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  const d = r.diagnostics.find((x) => x.code === 'media-base-url-required');
  assert.ok(d, 'the user has to be told before proceeding');
  assert.equal(d.severity, 'error', 'a warning would be stepped over');
  assert.match(d.message, /1 media URL\(s\) are relative/);
  assert.match(d.message, /1 other media URL\(s\) are already absolute/);
  assert.match(d.message, /the image on variant:P1-A/, 'it names the kind of media and its owner');
  assert.match(d.message, /must not be guessed/);
  // The remedy has to be stated, including the shape of the config value.
  assert.match(d.message, /"media": \{ "baseUrl"/);
  // And the alternative, for a source that genuinely has no host.
  assert.match(d.message, /drop the media in the adapter/);
  assert.ok(d.file, 'it points at the offending variant');
});

test('media: a configured baseUrl resolves relative URLs and leaves absolute ones', () => {
  const loaded = mediaFixture('https://cdn.example.com/');
  const { feed } = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  const model = deriveProductTypes(feed, loaded.config);
  const { plan: p, diagnostics } = buildPlan(feed, model, loaded.config);
  assert.deepEqual(
    diagnostics.filter((d) => d.severity === 'error'),
    [],
  );

  const images = variants(p.products[0])[0].images ?? [];
  assert.deepEqual(
    images.map((i) => i.url),
    [
      'https://cdn.example.com/medias/sys_master/root/h9c/product.jpg',
      'https://other.example.com/already-absolute.jpg',
    ],
    'the relative one is resolved; the absolute one is untouched',
  );
  assert.equal(images[0].label, 'front', 'the label survives resolution');

  // Recorded once with a count, not per image — the decision is the host.
  const d = p.decisions.find((x) => x.subject === 'media');
  assert.ok(d);
  assert.equal(d.review, true);
  assert.match(d.outcome, /1 relative image URL\(s\) resolved against/);
  assert.match(d.rationale, /every one of those images 404s/);
});

test('media: a base with a path keeps it, and no double slash appears', () => {
  // RFC 3986 discards a base's last segment unless it ends in `/`, which is
  // correct and almost never what was meant — so the base gets one added.
  for (const base of ['https://cdn.example.com/assets', 'https://cdn.example.com/assets/']) {
    const loaded = mediaFixture(base);
    const { feed } = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
    const model = deriveProductTypes(feed, loaded.config);
    const { plan: p } = buildPlan(feed, model, loaded.config);
    const url = (variants(p.products[0])[0].images ?? [])[0].url;
    // The feed's URL is root-relative, so it correctly ignores the base path.
    assert.equal(url, 'https://cdn.example.com/medias/sys_master/root/h9c/product.jpg', base);
    assert.ok(!url.includes('//medias'), `double slash in ${url}`);
  }
});

test('media: an unusable baseUrl is refused at config load', () => {
  assert.throws(
    () => mediaFixture('cdn.example.com'),
    /not an absolute http\(s\) URL/,
    'a bare hostname would leave the URLs relative',
  );
});

test('media: a feed with only absolute URLs needs no baseUrl at all', () => {
  const r = run_('declared-types');
  assert.ok(!codes_(r.diagnostics).includes('media-base-url-required'));
});

function run_(fixture: string) {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
  );
  return validateFeed(feedDir, SCHEMA, config);
}
function codes_(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

// ---------------------------------------------------------------------------
// Assets
//
// commercetools variants and categories both have them, and the feed carried
// only `images` — which holds exactly one URL per entry, so a source with
// thumbnail/product/zoom renditions had to discard two of them.
// ---------------------------------------------------------------------------

test('assets: one asset carries every rendition as a source', () => {
  // The reason assets exist rather than more images. A hybris MediaContainer,
  // or any format table, is one asset with one source per format.
  const r = plan('assets');
  assert.deepEqual(r.diagnostics, []);

  const variant = variants(product(r, 'mig-TEE'))[0];
  const assets = variant.assets ?? [];
  assert.equal(assets.length, 2);

  const shot = assets.find((a) => a.key === 'mig-TEE-1-shot-01');
  assert.ok(shot, 'the asset key is prefixed like every other key');
  assert.deepEqual(
    shot.sources.map((s) => s.key),
    ['thumbnail', 'product', 'zoom'],
    'all three renditions survive, in order',
  );
  assert.deepEqual(shot.sources[1].dimensions, { w: 515, h: 515 });
  assert.equal(shot.sources[0].contentType, undefined);
  assert.deepEqual(shot.name, { 'en-GB': 'Front', 'de-DE': 'Vorderseite' });
  assert.deepEqual(shot.tags, ['front', 'pdp']);
  assert.equal(shot.description?.['en-GB'], 'Front of the tee');
});

test('assets: source URIs follow the same media resolution as images', () => {
  // Assets are media. A second media path with its own rules is how one of
  // them ends up unresolved.
  const r = plan('assets');
  const shot = (variants(product(r, 'mig-TEE'))[0].assets ?? []).find(
    (a) => a.key === 'mig-TEE-1-shot-01',
  )!;
  assert.deepEqual(
    shot.sources.map((s) => s.uri),
    [
      'https://cdn.example.com/media/p/tee-front-thumb.jpg',
      'https://cdn.example.com/media/p/tee-front.jpg',
      'https://other.example.com/tee-front-zoom.jpg',
    ],
    'relative resolved against media.baseUrl; already-absolute untouched',
  );
});

test('assets: a relative asset source with no baseUrl stops the run', () => {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'assets', 'migration.config.json'),
  );
  const withoutBase = { ...config, media: undefined };
  const r = validateFeed(feedDir, SCHEMA, withoutBase);
  const d = r.diagnostics.find((x) => x.code === 'media-base-url-required');
  assert.ok(d, 'asset sources count as media, not just images');
  assert.match(d.message, /asset '.*' source/);
});

test('assets: a missing name is derived from the code and recorded as lossy', () => {
  const r = plan('assets');
  const derived = (variants(product(r, 'mig-TEE'))[0].assets ?? []).find(
    (a) => a.key === 'mig-TEE-1-shot-02',
  )!;
  assert.deepEqual(derived.name, { 'en-GB': 'TEE-1-shot-02' }, 'the default locale carries it');

  const d = r.plan.decisions.find((x) => /asset 'TEE-1-shot-02' named from its code/.test(x.outcome));
  assert.ok(d, 'a name nobody chose is information loss');
  assert.equal(d.lossy, true);
  assert.equal(d.review, true);
});

test('assets: categories carry them too', () => {
  const r = plan('assets');
  const tops = r.plan.categories.find((c) => c.key === 'mig-tops')!;
  const assets = (tops as { assets?: { key: string; sources: { uri: string }[] }[] }).assets ?? [];
  assert.equal(assets.length, 1);
  assert.equal(assets[0].key, 'mig-tops-hero');
  assert.equal(assets[0].sources[0].uri, 'https://cdn.example.com/media/cat/tops-hero.jpg');
});

test('assets: a Modular plan carries them onto the detached variant', () => {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'assets', 'migration.config.json'),
  );
  const modular = {
    ...config,
    target: { catalogModel: 'Modular' as const, priceMode: 'standalone' as const },
  };
  const { feed } = validateFeed(feedDir, SCHEMA, modular);
  const model = deriveProductTypes(feed, modular);
  const { plan: p } = buildPlan(feed, model, modular);

  assert.equal(p.variants.length, 1);
  assert.equal(p.variants[0].assets?.length, 2, 'assets must not be lost when variants detach');
  assert.equal(p.variants[0].assets?.[0].sources.length, 3);
});

// ---------------------------------------------------------------------------
// Product selections
// ---------------------------------------------------------------------------

test('selections: product-side membership inverts into one resource per selection', () => {
  // The feed authors membership on the product; the Import API wants
  // assignments on the selection. The inversion is mandatory, not stylistic:
  // the Import API replaces omitted fields, so a selection's assignments
  // cannot be split across resources.
  const r = plan('stores');
  assert.equal(r.plan.productSelections.length, 1);

  const sel = r.plan.productSelections[0];
  assert.equal(sel.key, 'mig-uk-assortment', 'created by the migration, so prefixed');
  assert.equal(sel.mode, 'Individual');
  assert.deepEqual(sel.assignments, [
    {
      product: { typeId: 'product', key: 'mig-TEE' },
      variantSelection: { type: 'includeOnly', skus: ['TEE-S'] },
    },
  ]);
});

test('selections: a store keeps its own key but prefixes its selection references', () => {
  // A store's key belongs to the project — like a channel's. Its selections
  // are resources this migration creates, so those are prefixed.
  const r = plan('stores');
  const store = r.plan.prerequisites.stores[0];
  assert.equal(store.key, 'northwind-uk');
  assert.deepEqual(store.productSelections, [{ key: 'mig-uk-assortment', active: true }]);
  assert.deepEqual(store.distributionChannels, ['retail-uk']);
});

test('selections: a permanent mode is recorded as an irreversible decision', () => {
  // There is no update action that changes a selection's mode, so the choice
  // is in the same class as an attribute constraint.
  const r = plan('stores');
  const d = r.plan.decisions.find(
    (x) => x.subject === 'productSelection:uk-assortment' && x.irreversible,
  );
  assert.ok(d, 'a permanent choice has to reach MODEL-REVIEW.md');
  assert.match(d.rationale, /fixed when it is created/);
});
