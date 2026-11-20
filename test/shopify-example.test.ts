/**
 * Tests of the EXAMPLE Shopify adapter and extractor (src/examples/shopify/).
 *
 * The fixture is a hand-written export of made-up products, in the shape the
 * extractor writes (shop.json plus Admin API bulk JSONL). The tests check that
 * the example's feed passes the pipeline's own contract checks, that each data
 * trap the example knows about stops the run or is counted, as its comments
 * say, and that the extractor stays read-only against a fake Admin API.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterStop, convert, keyFromLabel, type AdapterOptions } from '../src/examples/shopify/adapter.js';
import { readExport, type Obj, type ShopifyExport } from '../src/examples/shopify/export.js';
import { BULK_QUERIES, ExtractStop, extract } from '../src/examples/shopify/extract.js';
import { hasErrors, validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';

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
const FIXTURE = resolve(ROOT, 'fixtures', 'shopify-example');
const OPTIONS = JSON.parse(readFileSync(join(FIXTURE, 'adapter-options.json'), 'utf8')) as AdapterOptions;

/** A fresh, deep copy of the fixture, so a test can break one line without touching the others. */
function fixture(): ShopifyExport {
  return structuredClone(readExport(join(FIXTURE, 'export')));
}

function product(source: ShopifyExport, handle: string): Obj {
  const p = source.products.find((x) => x.handle === handle);
  assert.ok(p, `fixture has ${handle}`);
  return p;
}

function children(source: ShopifyExport, handle: string, type: string): Obj[] {
  return (source.childrenOf.get(String(product(source, handle).id)) ?? []).filter((c) => String(c.id).includes(`/${type}/`));
}

function stops(source: ShopifyExport, pattern: RegExp, options: AdapterOptions = OPTIONS): void {
  assert.throws(() => convert(source, options), (e: unknown) => e instanceof AdapterStop && pattern.test(e.message));
}

const byType = (records: Record<string, unknown>[], type: string) => records.filter((r) => r._type === type);

test('shopify example: the export reader regroups bulk lines by __parentId', () => {
  const source = fixture();
  assert.equal(source.products.length, 5);
  assert.equal(children(source, 'trail-jacket', 'ProductVariant').length, 4);
  assert.equal(children(source, 'trail-jacket', 'Collection').length, 3);
  assert.equal(source.variants.get('gid://shopify/ProductVariant/11')?.levels.length, 1);
  assert.equal(source.variants.get('gid://shopify/ProductVariant/11')?.media.length, 1);
  assert.equal(source.collections.get('gid://shopify/Collection/102')?.sortOrder, 'PRICE_ASC');
});

test('shopify example: the feed passes the contract checks', () => {
  const { records, report } = convert(fixture(), OPTIONS);
  const dir = mkdtempSync(join(tmpdir(), 'shopify-example-'));
  mkdirSync(join(dir, 'feed'));
  writeFileSync(join(dir, 'feed', 'catalog.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'migration.config.json'), readFileSync(join(FIXTURE, 'migration.config.json')));
  const { config, feedDir } = loadConfig(join(dir, 'migration.config.json'));
  const result = validateFeed(feedDir, resolve(ROOT, 'schema', 'catalog-feed.schema.json'), config);
  assert.equal(hasErrors(result.diagnostics), false, JSON.stringify(result.diagnostics, null, 1));
  assert.deepEqual(result.diagnostics.map((d) => d.code), []);
  assert.deepEqual(report.counts, { taxCategory: 2, category: 3, attributeDefinition: 4, product: 3, variant: 7, inventoryEntry: 6 });
  assert.match(report.notice, /EXAMPLE/);
  assert.equal(report.source.currency, 'GBP');
});

test('shopify example: what the feed says about the fixture', () => {
  const { records, report } = convert(fixture(), OPTIONS);
  const jacket = byType(records, 'product').find((p) => p.code === 'trail-jacket');
  assert.deepEqual(jacket?.axes, ['color', 'size'], 'axes follow the option position');
  assert.deepEqual(jacket?.categories, ['outerwear', 'sale'], 'frontpage is excluded by the options');
  assert.deepEqual(jacket?.attributes, { vendor: 'Northwind', material: 'Recycled polyester' });
  assert.equal((jacket?.description as Record<string, string>)['en-GB'], '<p>Waterproof &amp; breathable.</p>', 'HTML is passed through');

  const beanie = byType(records, 'product').find((p) => p.code === 'wool-beanie');
  assert.equal(beanie?.axes, undefined, 'a product with only the default variant has no axis');
  const beanieVariant = byType(records, 'variant').find((v) => v.sku === 'BEANIE-01');
  assert.deepEqual(beanieVariant?.prices, [{ currency: 'GBP', amount: '18.50' }], 'money padded on the digit string');
  assert.equal(beanieVariant?.isMaster, true);

  const mossM = byType(records, 'variant').find((v) => v.sku === 'TJ-MOSS-M');
  assert.equal(mossM?.isMaster, true, 'the first variant in Shopify order fronts the product');
  assert.deepEqual(
    (mossM?.images as { url: string }[]).map((i) => i.url.split('/').pop()),
    ['tj-moss.jpg', 'tj-front.jpg'],
    "the variant's own image first, then the product's, without repeats",
  );
  assert.equal(mossM?.attributes, undefined, 'compare-at price dropped by default');
  const slateL = byType(records, 'variant').find((v) => v.sku === 'TJ-SLATE-L');
  assert.equal((slateL?.images as unknown[]).length, 2, 'a variant without its own image gets the product images');

  const size = byType(records, 'attributeDefinition').find((d) => d.name === 'size');
  assert.deepEqual((size?.values as { key: string }[]).map((v) => v.key), ['m', 'l', '350-ml', '500-ml'], 'one Size attribute for jacket and mug');

  assert.equal(byType(records, 'product').some((p) => p.code === 'gift-card'), false);
  assert.equal(byType(records, 'product').some((p) => p.code === 'old-tent'), false);
  assert.equal(byType(records, 'product').find((p) => p.code === 'camp-mug')?.taxCategory, 'not-taxable');
  assert.equal(byType(records, 'inventoryEntry').some((e) => e.sku === 'MUG-350'), false, 'an untracked variant gets no entry, not a zero');
  assert.deepEqual(byType(records, 'inventoryEntry').find((e) => e.sku === 'TJ-MOSS-M'), { _type: 'inventoryEntry', sku: 'TJ-MOSS-M', quantityOnStock: 5 });

  assert.equal(report.losses['gift-card-product-not-carried']?.count, 1);
  assert.equal(report.decisions['product-skipped-by-status (ARCHIVED)']?.count, 1);
  assert.equal(report.decisions['rule-based-collection-loaded-as-static-category (its rules are not carried)']?.count, 1);
  assert.equal(report.decisions['image-urls-point-at-shopify-cdn (re-host before the store closes)']?.count, 2, 'once per product');
  assert.equal(report.decisions['vendor-spellings-differ-only-in-case-or-punctuation (passed through as is)']?.count, 1);
  assert.equal(report.decisions['compare-at-price-not-above-price-dropped']?.count, 1);
  assert.equal(report.losses['compare-at-price (no commercetools field; options.compareAtPrice = "attribute" carries it)']?.count, 2);
  assert.equal(report.losses['metafield-not-carried (reviews.rating)']?.count, 1);
  assert.equal(report.losses['translations-not-read (published locales besides the primary one)']?.examples[0], 'de');
  assert.equal(report.losses['continue-selling-when-out-of-stock (no equivalent on an inventory entry)']?.count, 1);
  assert.equal(report.losses['media-Video']?.count, 1);
  assert.equal(report.losses.weight?.count, 4);
});

test('shopify example: on_hand and the compare-at attribute are options, not defaults', () => {
  const { records } = convert(fixture(), { ...OPTIONS, stockQuantity: 'on_hand', compareAtPrice: 'attribute' });
  assert.equal(byType(records, 'inventoryEntry').find((e) => e.sku === 'TJ-MOSS-M')?.quantityOnStock, 7);
  assert.deepEqual(byType(records, 'variant').find((v) => v.sku === 'TJ-MOSS-M')?.attributes, { compareAtPrice: { currency: 'GBP', amount: '149.00' } });
  assert.ok(byType(records, 'attributeDefinition').some((d) => d.name === 'compareAtPrice' && d.type === 'money' && d.level === 'variant'));
  stops(fixture(), /stockQuantity must be/, { ...OPTIONS, stockQuantity: undefined as unknown as 'available' });
});

test('shopify example: an empty SKU stops unless derivation was agreed, and duplicates stop', () => {
  const source = fixture();
  for (const v of children(source, 'trail-jacket', 'ProductVariant')) v.sku = '';
  stops(source, /has no SKU, and SKUs become variant keys/);
  const { records, report } = convert(structuredClone(source), { ...OPTIONS, skus: 'derive' });
  assert.ok(byType(records, 'variant').some((v) => v.sku === 'TRAIL-JACKET-MOSS-M'));
  assert.equal(report.decisions['sku-derived-from-handle-and-option-values (one-shot load only)']?.count, 4);

  const dup = fixture();
  children(dup, 'camp-mug', 'ProductVariant')[0].sku = 'BEANIE-01';
  stops(dup, /The SKU "BEANIE-01" is on a variant of wool-beanie and of camp-mug/);
});

test('shopify example: the shop language, mixed taxable flags and two values with one key stop', () => {
  const de = fixture();
  de.shop.shopLocales = [{ locale: 'de', primary: true, published: true }];
  stops(de, /primary locale is de/);

  const tax = fixture();
  children(tax, 'trail-jacket', 'ProductVariant')[1].taxable = false;
  stops(tax, /some variants are taxable and some are not/);

  const twin = fixture();
  const v = children(twin, 'camp-mug', 'ProductVariant')[1];
  v.selectedOptions = [{ name: 'Size', value: '350 ML' }];
  stops(twin, /"350 ml" and "350 ML" both become the key "350-ml"/);
});

test('shopify example: stock in several locations needs a channel per location; oversold stock stops', () => {
  const two = fixture();
  two.variants.get('gid://shopify/ProductVariant/13')!.levels.push({
    location: { id: 'gid://shopify/Location/2', name: 'Shop floor' },
    quantities: [{ name: 'available', quantity: 1 }, { name: 'on_hand', quantity: 1 }],
  });
  stops(two, /Shop floor not in options.locations/);
  const { records } = convert(structuredClone(two), { ...OPTIONS, locations: { 'Main warehouse': 'warehouse', 'Shop floor': 'shop-floor' } });
  assert.deepEqual(byType(records, 'channel').map((c) => c.code).sort(), ['shop-floor', 'warehouse']);
  assert.ok(byType(records, 'inventoryEntry').every((e) => typeof e.supplyChannel === 'string'));

  const oversold = fixture();
  (oversold.variants.get('gid://shopify/ProductVariant/52')!.levels.push({
    location: { id: 'gid://shopify/Location/1', name: 'Main warehouse' },
    quantities: [{ name: 'available', quantity: -2 }],
  }));
  stops(oversold, /available is -2 at Main warehouse, oversold/);
});

test('shopify example: money with too many digits and an unmapped metafield type stop', () => {
  const money = fixture();
  children(money, 'wool-beanie', 'ProductVariant')[0].price = '18.505';
  stops(money, /more decimal places than GBP allows/);
  stops(fixture(), /reviews.rating has the type "rating"/, { ...OPTIONS, metafields: { 'reviews.rating': 'rating' } });
});

test('shopify example: keyFromLabel', () => {
  assert.equal(keyFromLabel('350 ml'), '350-ml');
  assert.equal(keyFromLabel('Crème Brûlée'), 'creme-brulee');
  assert.equal(keyFromLabel('£25'), '25');
});

// ---------------------------------------------------------------- extractor

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: { query: string; variables?: Record<string, unknown> };
}

function fakeShop(opts: { scopes?: string[]; served?: string; status?: string; noLocales?: boolean } = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const json = (data: unknown, served = opts.served ?? '2026-10') =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json', 'x-shopify-api-version': served } });
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? (JSON.parse(String(init.body)) as Call['body']) : undefined;
    calls.push({ url, headers, body });
    if (url.startsWith('https://storage.example/')) return new Response('{"id":"gid://shopify/Product/1"}\n', { status: 200 });
    const q = body?.query ?? '';
    if (q.includes('currentAppInstallation')) {
      return json({
        shop: { name: 'Example', currencyCode: 'GBP', taxesIncluded: true, ianaTimezone: 'Europe/London' },
        locations: { edges: [{ node: { id: 'gid://shopify/Location/1', name: 'Main', isActive: true } }] },
        currentAppInstallation: { accessScopes: (opts.scopes ?? ['read_products', 'read_inventory']).map((handle) => ({ handle })) },
      });
    }
    if (q.includes('shopLocales')) {
      if (opts.noLocales) {
        return new Response(JSON.stringify({ errors: [{ message: 'Access denied for shopLocales field.', extensions: { code: 'ACCESS_DENIED' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-shopify-api-version': opts.served ?? '2026-10' },
        });
      }
      return json({ shopLocales: [{ locale: 'en', primary: true, published: true }] });
    }
    if (q.includes('bulkOperationRunQuery')) return json({ bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${++n}`, status: 'CREATED' }, userErrors: [] } });
    if (q.includes('BulkOperation')) {
      return json({ node: { status: opts.status ?? 'COMPLETED', errorCode: null, objectCount: '1', url: `https://storage.example/result-${n}.jsonl`, partialDataUrl: null } });
    }
    throw new Error(`unexpected request ${url} ${q.slice(0, 80)}`);
  }) as typeof fetch;
  return { fetch: fake, calls };
}

test('shopify example: the extractor writes the export, read-only, and keeps the token on the shop host', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'shopify-extract-')), 'export');
  const shop = fakeShop();
  const counts = await extract({ domain: 'example.myshopify.com', token: 'shpat_test', apiVersion: '2026-10', out, fetch: shop.fetch, pollMs: 0, log: () => {} });
  assert.deepEqual(counts, { products: 1, collections: 1, variants: 1 });
  for (const f of ['shop.json', 'products.jsonl', 'collections.jsonl', 'variants.jsonl']) assert.ok(existsSync(join(out, f)), f);
  if (process.platform !== 'win32') assert.equal(statSync(join(out, 'shop.json')).mode & 0o777, 0o600);

  for (const c of shop.calls) {
    if (c.url.startsWith('https://storage.example/')) assert.equal(c.headers['x-shopify-access-token'], undefined, 'no token to the download host');
    else assert.equal(c.url, 'https://example.myshopify.com/admin/api/2026-10/graphql.json');
    const q = c.body?.query ?? '';
    const mutations = [...q.matchAll(/mutation[^{]*\{\s*(\w+)/g)].map((m) => m[1]);
    assert.ok(mutations.every((m) => m === 'bulkOperationRunQuery'), `only bulkOperationRunQuery is sent as a mutation, got ${mutations.join(', ')}`);
  }
  assert.equal(shop.calls.filter((c) => c.body?.query.includes('bulkOperationRunQuery')).length, Object.keys(BULK_QUERIES).length);  assert.deepEqual(JSON.parse(readFileSync(join(out, 'shop.json'), 'utf8')).shopLocales, [{ locale: 'en', primary: true, published: true }]);

  const lines: string[] = [];
  const out2 = join(mkdtempSync(join(tmpdir(), 'shopify-extract-')), 'export');
  await extract({ domain: 'example.myshopify.com', token: 'shpat_test', apiVersion: '2026-10', out: out2, fetch: fakeShop({ noLocales: true }).fetch, pollMs: 0, log: (l) => lines.push(l) });
  assert.equal(JSON.parse(readFileSync(join(out2, 'shop.json'), 'utf8')).shopLocales, undefined, 'without read_locales the export goes on');
  assert.ok(lines.some((l) => /read_locales/.test(l)));
});

test('shopify example: the extractor refuses a write scope, a served version that differs, an old version, a foreign host and a failed operation', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'shopify-extract-')), 'export');
  const base = { token: 'shpat_test', apiVersion: '2026-10', out, pollMs: 0, log: () => {} };
  await assert.rejects(extract({ ...base, domain: 'example.myshopify.com', fetch: fakeShop({ scopes: ['read_products', 'write_products'] }).fetch }), (e: unknown) => e instanceof ExtractStop && /write_products/.test(e.message));
  await assert.rejects(extract({ ...base, domain: 'example.myshopify.com', fetch: fakeShop({ served: '2027-01' }).fetch }), /the shop served 2027-01/);
  await assert.rejects(extract({ ...base, domain: 'shop.example.com', fetch: fakeShop().fetch }), /not a \*\.myshopify\.com domain/);
  await assert.rejects(extract({ ...base, domain: 'example.myshopify.com', apiVersion: '2026-11', fetch: fakeShop().fetch }), /not a Shopify API version/);
  await assert.rejects(extract({ ...base, domain: 'example.myshopify.com', fetch: fakeShop({ status: 'FAILED' }).fetch }), /ended FAILED/);
  await assert.rejects(extract({ ...base, domain: 'example.myshopify.com', apiVersion: '2026-04', fetch: fakeShop().fetch }), /hides collections that use sub-collections/);
  for (const q of Object.values(BULK_QUERIES)) assert.doesNotMatch(q, /\b(barcode|ruleSet|taxCode)\b/, 'no deprecated field in a bulk query');
  const variantNode = BULK_QUERIES.products.slice(BULK_QUERIES.products.indexOf('variants {'), BULK_QUERIES.products.indexOf('collections {'));
  assert.doesNotMatch(variantNode, /\bimage\b/, 'ProductVariant.image is deprecated; variant media come from the variants query');
});
