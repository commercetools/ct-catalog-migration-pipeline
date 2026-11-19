/**
 * Tests of the EXAMPLE Magento adapter (src/examples/magento/).
 *
 * The fixture is a hand-written mysqldump of made-up products. The tests check
 * that the example's feed passes the pipeline's own contract checks, that the
 * dump and the NDJSON table shapes give the same feed, and that each data trap
 * the example knows about stops the run or is counted, as its comments say.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { AdapterStop, OPTIONAL_TABLES, REQUIRED_TABLES, convert, keyFromLabel, type AdapterOptions } from '../src/examples/magento/adapter.js';
import { parseValues, readSnapshot, type Row, type Tables } from '../src/examples/magento/tables.js';
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
const FIXTURE = resolve(ROOT, 'fixtures', 'magento-example');
const DUMP = join(FIXTURE, 'snapshot.sql');
const WANTED = new Set<string>([...REQUIRED_TABLES, ...OPTIONAL_TABLES]);
const OPTIONS = JSON.parse(readFileSync(join(FIXTURE, 'adapter-options.json'), 'utf8')) as AdapterOptions;

async function fixtureTables(): Promise<Tables> {
  return readSnapshot(DUMP, WANTED);
}

/** A deep copy, so a test can break one table without touching the others' fixture. */
function copy(tables: Tables): Tables {
  return new Map([...tables].map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]));
}

function rowsOf(tables: Tables, name: string): Row[] {
  const rows = tables.get(name);
  assert.ok(rows, `fixture has ${name}`);
  return rows;
}

function stops(tables: Tables, pattern: RegExp, options: AdapterOptions = OPTIONS): void {
  assert.throws(() => convert(tables, options), (e: unknown) => e instanceof AdapterStop && pattern.test(e.message));
}

const byType = (records: Record<string, unknown>[], type: string) => records.filter((r) => r._type === type);

test('magento example: the dump reader skips unwanted tables and keeps values as written', async () => {
  const tables = await fixtureTables();
  assert.equal(tables.has('customer_entity'), false, 'a table nobody asked for is not parsed');
  const price = rowsOf(tables, 'catalog_product_entity_decimal').find((r) => r.entity_id === '3' && r.attribute_id === '77');
  assert.equal(price?.value, '31.500000', 'a DECIMAL keeps its digits');
  const text = rowsOf(tables, 'catalog_product_entity_text').find((r) => r.entity_id === '1');
  assert.equal(text?.value, '<p>It\'s light, and it\'s "quick-dry".</p>\n<p>Machine wash &amp; tumble dry.</p>');
  assert.deepEqual(rowsOf(tables, 'catalog_category_entity_text'), [], 'a defined table without rows is present and empty');
  assert.equal(rowsOf(tables, 'eav_attribute_label')[1].value, 'Größe', 'a column-list INSERT maps by name');
});

test('magento example: parseValues handles NULL, escapes and doubled quotes, and refuses _binary', () => {
  const line = "INSERT INTO `t` VALUES (1,NULL,'a\\'b','c''d','x\\\\y\\nz',-2.50),(2,'',0x0A,'é',3,4);";
  const start = line.indexOf('VALUES ') + 'VALUES '.length;
  assert.deepEqual(parseValues(line, start, 't'), [
    ['1', null, "a'b", "c'd", 'x\\y\nz', '-2.50'],
    ['2', '', '0x0A', 'é', '3', '4'],
  ]);
  assert.throws(() => parseValues("(1,_binary 'x');", 0, 't'), /--hex-blob/);
  assert.throws(() => parseValues("(1,'open);", 0, 't'), /unterminated/);
});

test('magento example: the feed passes the contract checks', async () => {
  const { records, report } = convert(await fixtureTables(), OPTIONS);
  const dir = mkdtempSync(join(tmpdir(), 'magento-example-'));
  mkdirSync(join(dir, 'feed'));
  writeFileSync(join(dir, 'feed', 'catalog.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'migration.config.json'), readFileSync(join(FIXTURE, 'migration.config.json')));
  const { config, feedDir } = loadConfig(join(dir, 'migration.config.json'));
  const result = validateFeed(feedDir, resolve(ROOT, 'schema', 'catalog-feed.schema.json'), config);
  assert.equal(hasErrors(result.diagnostics), false, JSON.stringify(result.diagnostics, null, 1));
  assert.deepEqual(result.diagnostics.map((d) => d.code), []);
  assert.deepEqual(report.counts, { taxCategory: 1, category: 3, attributeDefinition: 5, product: 2, variant: 3, inventoryEntry: 3 });
  assert.match(report.notice, /EXAMPLE/);
});

test('magento example: what the feed says about the fixture', async () => {
  const { records, report } = convert(await fixtureTables(), OPTIONS);
  const tee = byType(records, 'product').find((p) => p.code === 'MT01');
  assert.deepEqual(tee?.name, { 'en-US': 'Trail Tee', 'de-DE': 'Wander-Shirt' }, 'a mapped store view translates');
  assert.deepEqual(tee?.axes, ['color', 'size'], 'axes follow the super attribute position');
  assert.deepEqual(tee?.attributes, { material: ['wool', 'organic-cottontm'] });
  assert.deepEqual(tee?.categories, ['men', 'tops'], 'a variant category is merged into its product');

  const bag = byType(records, 'product').find((p) => p.code === 'MB01');
  assert.deepEqual(bag?.name, { 'en-US': 'Summit Duffle®', 'de-DE': 'Summit Duffle®' }, 'entities are decoded in names');
  const bagVariant = byType(records, 'variant').find((v) => v.sku === 'MB01');
  assert.deepEqual(bagVariant?.prices, [
    { currency: 'USD', amount: '45.00' },
    { currency: 'USD', amount: '39.99', validFrom: '2026-11-01T00:00:00.000Z', validTo: '2026-12-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(bagVariant?.images, [{ url: 'm/b/mb01.jpg', label: 'Front' }, { url: 'm/b/mb01-back.jpg', label: 'Back' }], 'leading slash removed, gallery order kept');

  const desc = (tee?.description as Record<string, string>)['en-US'];
  assert.match(desc, /&amp;/, 'HTML descriptions are not decoded');
  assert.equal(byType(records, 'variant').find((v) => v.sku === 'MT01-S-Blue')?.isMaster, true);
  assert.equal(byType(records, 'product').some((p) => p.code === 'MB02-old'), false, 'a disabled product is skipped');

  assert.equal(report.losses['product-position-within-category (not in the feed contract)']?.count, 2);
  assert.equal(report.losses['bundle-product-not-carried (its components load as products of their own)']?.count, 1);
  assert.equal(report.losses['store-view-value-of-an-attribute-not-carried (msrp_display_actual_price_type)']?.count, 1);
  assert.equal(report.decisions['unused-duplicate-option-dropped']?.count, 1);
  assert.ok(report.decisions['admin-text-used-for-de-DE (no translation in the snapshot)']?.count);
  assert.equal(report.decisions['stock-row-of-a-product-that-is-no-variant-skipped']?.count, 3);
});

test('magento example: a gzipped dump and an NDJSON table directory give the same feed', async () => {
  const fromDump = convert(await fixtureTables(), OPTIONS);
  const dir = mkdtempSync(join(tmpdir(), 'magento-tables-'));
  writeFileSync(join(dir, 'snapshot.sql.gz'), gzipSync(readFileSync(DUMP)));
  assert.deepEqual(convert(await readSnapshot(join(dir, 'snapshot.sql.gz'), WANTED), OPTIONS), fromDump);

  const tableDir = join(dir, 'tables');
  mkdirSync(tableDir);
  for (const [name, rows] of await fixtureTables()) {
    // Integers as JSON numbers, everything else as strings: what a copy script writes.
    const lines = rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && /^-?\d+$/.test(v) && v.length < 15 ? Number(v) : v]))));
    writeFileSync(join(tableDir, `${name}.ndjson`), lines.join('\n') + '\n');
  }
  assert.deepEqual(convert(await readSnapshot(tableDir, WANTED), OPTIONS), fromDump);

  writeFileSync(join(tableDir, 'catalog_product_entity_decimal.ndjson'), '{"value_id":1,"attribute_id":77,"store_id":0,"entity_id":1,"value":29.5}\n');
  await assert.rejects(readSnapshot(tableDir, WANTED), /Write DECIMAL and FLOAT columns as strings/);
});

test('magento example: stops on a missing table and on Adobe Commerce staging tables', async () => {
  const missing = copy(await fixtureTables());
  missing.delete('catalog_product_super_link');
  stops(missing, /lacks 1 table\(s\).*catalog_product_super_link.*mysqldump/);

  const staged = copy(await fixtureTables());
  for (const r of rowsOf(staged, 'catalog_product_entity')) r.row_id = r.entity_id;
  stops(staged, /row_id.*Adobe Commerce/);
});

test('magento example: two used options with one label stop; an unknown entity stops', async () => {
  const twins = copy(await fixtureTables());
  rowsOf(twins, 'catalog_product_entity_varchar').push({ value_id: '99', attribute_id: '136', store_id: '0', entity_id: '4', value: '71' });
  stops(twins, /material: options 70, 71 share the label.*all in use/);

  const entity = copy(await fixtureTables());
  const name = rowsOf(entity, 'catalog_product_entity_varchar').find((r) => r.value_id === '10');
  assert.ok(name);
  name.value = 'Summit Duffle&spades;';
  stops(entity, /unknown HTML entity &spades;/);
});

test('magento example: a store-view value the feed cannot hold stops the run', async () => {
  const price = copy(await fixtureTables());
  rowsOf(price, 'catalog_product_entity_decimal').push({ value_id: '99', attribute_id: '77', store_id: '1', entity_id: '4', value: '49.000000' });
  stops(price, /MB01: price in store view "default" is "49.000000".*one value per product/);

  // A translation on a store view no locale is mapped to would be dropped silently.
  const { german: _german, ...withoutGerman } = OPTIONS.locales;
  stops(await fixtureTables(), /MT01: name in store view "german" is "Wander-Shirt".*options\.locales/, { ...OPTIONS, locales: withoutGerman });
});

test('magento example: money, stock and multi-source inventory', async () => {
  const digits = copy(await fixtureTables());
  const price = rowsOf(digits, 'catalog_product_entity_decimal').find((r) => r.value_id === '4');
  assert.ok(price);
  price.value = '45.125000';
  stops(digits, /MB01 price: "45.125000" has more decimal places than USD allows/);

  const fractional = copy(await fixtureTables());
  const stock = rowsOf(fractional, 'cataloginventory_stock_item').find((r) => r.product_id === '4');
  assert.ok(stock);
  stock.qty = '2.5000';
  stops(fractional, /MB01: stock quantity "2.5000" is not a whole number/);

  const msi = copy(await fixtureTables());
  msi.set('inventory_source_item', [
    { source_item_id: '1', source_code: 'default', sku: 'MB01', quantity: '60.0000', status: '1' },
    { source_item_id: '2', source_code: 'berlin', sku: 'MB01', quantity: '40.0000', status: '1' },
  ]);
  stops(msi, /berlin not in options\.stockSources/);
  const { records } = convert(msi, { ...OPTIONS, stockSources: { default: 'warehouse-main', berlin: 'store-berlin' } });
  assert.deepEqual(byType(records, 'channel').map((c) => c.code), ['warehouse-main', 'store-berlin']);
  assert.deepEqual(byType(records, 'inventoryEntry'), [
    { _type: 'inventoryEntry', sku: 'MB01', quantityOnStock: 60, supplyChannel: 'warehouse-main' },
    { _type: 'inventoryEntry', sku: 'MB01', quantityOnStock: 40, supplyChannel: 'store-berlin' },
  ]);
});

test('magento example: keyFromLabel', () => {
  assert.equal(keyFromLabel('Wool ½'), 'wool-1-2');
  assert.equal(keyFromLabel('Crème Brûlée'), 'creme-brulee');
  assert.equal(keyFromLabel('★'), '');
});

test('magento example: custom options and product links are counted as losses', async () => {
  const tables = copy(await fixtureTables());
  tables.set('catalog_product_option', [{ option_id: '1', product_id: '4', type: 'field' }]);
  tables.set('catalog_product_link', [{ link_id: '1', product_id: '1', linked_product_id: '4', link_type_id: '1' }]);
  const { report } = convert(tables, OPTIONS);
  assert.equal(report.losses['custom-options (not carried by this example)']?.count, 1);
  assert.equal(report.losses['product-links: related, up-sell, cross-sell (not carried by this example)']?.count, 1);
});

test('magento example: a configurable product is taxed by its variants, and variants that disagree stop', async () => {
  const tables = copy(await fixtureTables());
  // The variants carry the class; the configurable product has none of its own.
  const ints = rowsOf(tables, 'catalog_product_entity_int');
  const parentClass = ints.find((r) => r.value_id === '11');
  assert.ok(parentClass);
  parentClass.value = '0';
  ints.push({ value_id: '90', attribute_id: '132', store_id: '0', entity_id: '2', value: '2' }, { value_id: '91', attribute_id: '132', store_id: '0', entity_id: '3', value: '2' });
  const { records } = convert(tables, OPTIONS);
  assert.equal(byType(records, 'product').find((p) => p.code === 'MT01')?.taxCategory, 'taxable-goods');

  rowsOf(tables, 'tax_class').push({ class_id: '5', class_name: 'Reduced', class_type: 'PRODUCT' });
  const red = ints.find((r) => r.value_id === '91');
  assert.ok(red);
  red.value = '5';
  stops(tables, /MT01: its variants carry different tax classes \(2: MT01-S-Blue; 5: MT01-M-Red\)/);
});
