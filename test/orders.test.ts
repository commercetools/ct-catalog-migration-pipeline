/**
 * Orders: an opt-in entity, imported as snapshots with verbatim numbers.
 *
 * The people in these tests are invented. Every email is on example.com.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Order } from '@commercetools/platform-sdk';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig, type PipelineConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { writePlan } from '../src/map/report.js';
import { loadPlan } from '../src/audit/load-plan.js';
import { auditPlan } from '../src/audit/gate.js';
import { planBatches } from '../src/load/batches.js';
import { reconcile, type ProjectSnapshot } from '../src/verify/reconcile.js';
import { keysOutsidePrefix, renderTeardown, runTeardown } from '../src/teardown/run.js';
import { LOAD_ORDER, type MigrationPlan, type OrderImport } from '../src/model/plan.js';
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
const STORES_CONFIG = resolve(ROOT, 'fixtures', 'stores', 'migration.config.json');

const CATALOG = [
  { _type: 'attributeDefinition', name: 'sz', type: 'text', level: 'variant', axis: true },
  { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'] },
  {
    _type: 'variant', sku: 'TEE-S', product: 'TEE', axisValues: { sz: 'S' },
    prices: [{ currency: 'GBP', amount: '10.00' }],
  },
];
const CUSTOMER = { _type: 'customer', code: 'C-1', email: 'ada@example.com' };
const VAT = { name: 'VAT 20%', amount: 0.2, includedInPrice: true, country: 'GB' };
const ORDER = {
  _type: 'order',
  orderNumber: '100045',
  currency: 'GBP',
  totalPrice: '24.95',
  customer: 'C-1',
  completedAt: '2024-03-01T10:00:00Z',
  orderState: 'Complete',
  shipmentState: 'Shipped',
  paymentState: 'Paid',
  shippingAddress: { country: 'GB', city: 'Leeds' },
  lineItems: [
    { sku: 'TEE-S', name: { 'en-GB': 'Tee' }, quantity: 2, price: '10.00', taxRate: VAT },
    // Discontinued: not in the feed.
    { sku: 'OLD/MUG', name: { 'en-GB': 'Mug' }, quantity: 1, price: '4.95' },
  ],
};

function config(entities: Record<string, boolean> = { customers: true, orders: true }): PipelineConfig {
  return { ...loadConfig(STORES_CONFIG).config, entities };
}

function validate(lines: unknown[], cfg = config()) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-orders-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(join(feedDir, 'feed.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return validateFeed(feedDir, SCHEMA, cfg);
}

function plan(lines: unknown[], cfg = config()) {
  const v = validate(lines, cfg);
  return { ...buildPlan(v.feed, deriveProductTypes(v.feed, cfg), cfg), validation: v, config: cfg };
}

const codes = (d: { code: string }[]) => d.map((x) => x.code);

// ---------------------------------------------------------------------------
// The opt-in and validate
// ---------------------------------------------------------------------------

test('orders: refused while entities.orders is unset, once for the whole feed', () => {
  const r = validate([...CATALOG, CUSTOMER, ORDER, { ...ORDER, orderNumber: '100046' }], config({ customers: true }));
  const refused = r.diagnostics.filter((d) => d.code === 'orders-not-in-scope');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].severity, 'error');
  assert.match(refused[0].message, /set it to false and they are ignored/);
  assert.match(refused[0].message, /2 order record\(s\)/);
});

test('orders: entities.orders false ignores them with one warning, and plans none', () => {
  // The source keeps emitting its history; the decision not to load it is the
  // config's, so nothing fails and nothing about the orders is checked.
  const cfg = config({ customers: true, orders: false });
  const r = validate([...CATALOG, CUSTOMER, ORDER, { ...ORDER, orderNumber: '100046', totalPrice: '-1' }], cfg);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  const ignored = r.diagnostics.filter((d) => d.code === 'orders-ignored');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].severity, 'warning');
  assert.match(ignored[0].message, /2 order record\(s\)/);
  assert.ok(!codes(r.diagnostics).some((c) => c.startsWith('order-')), 'ignored orders are not checked');
  assert.ok(!('orders' in plan([...CATALOG, CUSTOMER, ORDER], cfg).plan));
});

test('orders: a clean opted-in order validates; the total that includes no shipping line is a warning, once', () => {
  const r = validate([...CATALOG, CUSTOMER, ORDER, { ...ORDER, orderNumber: '100046', totalPrice: '29.90' }]);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  const differ = r.diagnostics.filter((d) => d.code === 'order-total-differs-from-lines');
  assert.equal(differ.length, 1);
  assert.match(differ[0].message, /1 of 2 order/);
});

test('orders: a store, a payment or an inventory mode cannot be expressed in the feed', () => {
  for (const extra of [{ store: 'uk' }, { inventoryMode: 'TrackOnly' }, { paymentInfo: {} }]) {
    const r = validate([...CATALOG, CUSTOMER, { ...ORDER, ...extra }]);
    assert.ok(codes(r.diagnostics).includes('schema-violation'), JSON.stringify(extra));
  }
});

test('orders: negative amounts, unconfigured currencies and too many decimals are errors', () => {
  const r = validate([
    ...CATALOG, CUSTOMER,
    { ...ORDER, orderNumber: 'A', totalPrice: '-5.00' },
    { ...ORDER, orderNumber: 'B', currency: 'JPY' },
    { ...ORDER, orderNumber: 'C', totalPrice: '24.955' },
  ]);
  const found = codes(r.diagnostics);
  assert.ok(found.includes('order-amount-negative'));
  assert.ok(found.includes('order-currency-not-configured'));
  assert.ok(found.includes('order-amount-invalid'));
});

test('orders: an undeclared customer or group is an error; no customer at all is a warning', () => {
  const r = validate([
    ...CATALOG,
    { ...ORDER, orderNumber: 'A', customer: 'nobody' },
    { ...ORDER, orderNumber: 'B', customer: undefined, customerGroup: 'trade' },
  ]);
  const found = codes(r.diagnostics);
  assert.ok(found.includes('order-customer-not-declared'));
  assert.ok(found.includes('order-customer-group-not-declared'));
  assert.ok(found.includes('order-without-customer'));
});

test('orders: a duplicate order number and a missing completedAt are reported', () => {
  const { completedAt: _c, ...undated } = ORDER;
  const r = validate([...CATALOG, CUSTOMER, undated, ORDER]);
  assert.ok(codes(r.diagnostics).includes('duplicate-record'));
  const dated = validate([...CATALOG, CUSTOMER, undated]);
  assert.ok(codes(dated.diagnostics).includes('order-without-completed-at'));
});

test('orders: no diagnostic prints an email', () => {
  const r = validate([...CATALOG, { ...ORDER, customer: 'nobody', customerEmail: 'guest@example.com', totalPrice: '-1' }]);
  assert.ok(r.diagnostics.length > 0);
  for (const d of r.diagnostics) assert.doesNotMatch(d.message, /@example\.com/);
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

test('plan: an order keeps its number, links known SKUs, and turns unknown ones into custom lines', () => {
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  const [o] = r.plan.orders!;
  assert.equal(o.orderNumber, '100045');
  assert.deepEqual(o.totalPrice, { type: 'centPrecision', currencyCode: 'GBP', centAmount: 2495, fractionDigits: 2 });
  assert.deepEqual(o.customer, { typeId: 'customer', key: 'mig-C-1' });
  assert.equal(o.lineItems!.length, 1);
  assert.deepEqual(o.lineItems![0].product, { typeId: 'product', key: 'mig-TEE' });
  assert.deepEqual(o.lineItems![0].variant, { sku: 'TEE-S' });
  assert.equal(o.lineItems![0].price.value.centAmount, 1000);
  assert.deepEqual(o.lineItems![0].taxRate, VAT);
  const [c] = o.customLineItems!;
  assert.equal(c.slug, 'OLD-MUG-2');
  assert.equal(c.money.centAmount, 495);
  assert.equal(c.totalPrice.centAmount, 495);
  assert.ok(!('inventoryMode' in o) && !('store' in o));
});

test('plan: the custom lines are a lossy decision with a count; the order decision names no email', () => {
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  const lossy = r.plan.decisions.find((d) => d.subject === 'orders:custom-line-items');
  assert.ok(lossy?.lossy);
  assert.match(lossy.outcome, /1 line\(s\) for 1 SKU/);
  const orders = r.plan.decisions.find((d) => d.subject === 'orders');
  assert.ok(orders?.review);
  assert.match(orders.rationale, /OrderImported/);
  assert.doesNotMatch(JSON.stringify(r.plan.decisions), /@example\.com/);
});

test('plan: orders load after customers and before stores, and survive plan.json', () => {
  const at = (s: string) => LOAD_ORDER.indexOf(s as (typeof LOAD_ORDER)[number]);
  assert.ok(at('order') > at('customer') && at('order') < at('store'));
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  const out = mkdtempSync(join(tmpdir(), 'ct-orders-out-'));
  writePlan(out, r.plan, false);
  assert.deepEqual(loadPlan(out).orders, r.plan.orders);
});

test('load: orders batch into their own container, identified by order number', () => {
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  const b = planBatches(r.plan, r.config);
  const container = b.containers.find((c) => c.stage === 'order')!;
  assert.equal(container.key, 'mig-order');
  assert.equal(container.resourceType, 'order');
  const batch = b.batches.find((x) => x.stage === 'order')!;
  assert.equal(batch.body.type, 'order');
  assert.deepEqual(batch.resourceKeys, ['100045']);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function auditOrder(mutate: (o: Writable<OrderImport>) => void, cfg = config()) {
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  const orders = r.plan.orders!.map((o) => {
    const copy = structuredClone(o) as Writable<OrderImport>;
    mutate(copy);
    return copy;
  });
  return auditPlan({ ...r.plan, orders }, cfg);
}

test('audit: a clean order passes and is counted', () => {
  const a = auditOrder(() => {});
  assert.deepEqual(codes(a.diagnostics).filter((c) => c.startsWith('order')), []);
  assert.equal(a.checked.orders, 1);
});

test('audit: inventoryMode and store are refused', () => {
  assert.ok(codes(auditOrder((o) => Object.assign(o, { inventoryMode: 'TrackOnly' })).diagnostics).includes('order-inventory-mode'));
  assert.ok(codes(auditOrder((o) => Object.assign(o, { store: { typeId: 'store', key: 'uk' } })).diagnostics).includes('order-store-set'));
});

test('audit: mixed currencies, a wrong custom line total and unplanned references are refused', () => {
  const found = codes(
    auditOrder((o) => {
      o.totalPrice = { ...o.totalPrice, currencyCode: 'EUR' };
      o.customLineItems![0] = { ...o.customLineItems![0], totalPrice: { ...o.customLineItems![0].totalPrice, centAmount: 1 } };
      o.customer = { typeId: 'customer', key: 'mig-nobody' };
    }).diagnostics,
  );
  assert.ok(found.includes('order-currency-mixed'));
  assert.ok(found.includes('order-custom-line-total'));
  assert.ok(found.includes('order-customer-unplanned'));
});

test('audit: a plan with orders and the switch off is refused', () => {
  assert.ok(codes(auditOrder(() => {}, config({ customers: true })).diagnostics).includes('orders-not-in-scope'));
});

// ---------------------------------------------------------------------------
// Verify and teardown
// ---------------------------------------------------------------------------

function emptySnapshot(): ProjectSnapshot {
  return {
    productTypes: new Map(), categories: new Map(), products: new Map(), variants: new Map(),
    standalonePrices: new Map(), productSelections: new Map(), inventory: new Map(), stores: new Map(),
    categoryKeyById: new Map(), productTypeKeyById: new Map(), productSelectionKeyById: new Map(),
  };
}

function asLoaded(planned: OrderImport, overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', version: 3, createdAt: '', lastModifiedAt: '',
    orderNumber: planned.orderNumber,
    totalPrice: planned.totalPrice,
    lineItems: (planned.lineItems ?? []).map(() => ({})),
    customLineItems: (planned.customLineItems ?? []).map(() => ({})),
    orderState: planned.orderState,
    shipmentState: planned.shipmentState,
    paymentState: planned.paymentState,
    ...overrides,
  } as unknown as Order;
}

function ordersOnly(): { plan: MigrationPlan; cfg: PipelineConfig; planned: OrderImport } {
  const r = plan([...CATALOG, CUSTOMER, ORDER]);
  return {
    plan: { ...r.plan, productTypes: [], categories: [], products: [], variants: [], standalonePrices: [], customers: [] },
    cfg: r.config,
    planned: r.plan.orders![0],
  };
}

test('verify: an order as planned reconciles; a missing one is reported by number', () => {
  const { plan: p, cfg, planned } = ordersOnly();
  const ok = reconcile(p, { ...emptySnapshot(), orders: new Map([[planned.orderNumber, asLoaded(planned)]]) }, cfg);
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.found.orders, 1);
  const gone = reconcile(p, emptySnapshot(), cfg);
  assert.ok(gone.diagnostics.some((d) => d.code === 'order-missing' && d.message.includes('100045')));
});

test('verify: a different total, line count or state is a difference', () => {
  const { plan: p, cfg, planned } = ordersOnly();
  const loaded = asLoaded(planned, {
    totalPrice: { ...planned.totalPrice, centAmount: 1 } as Order['totalPrice'],
    customLineItems: [],
    shipmentState: 'Pending',
  });
  const messages = reconcile(p, { ...emptySnapshot(), orders: new Map([[planned.orderNumber, loaded]]) }, cfg)
    .diagnostics.map((d) => d.message).join('\n');
  assert.match(messages, /the total/);
  assert.match(messages, /the lines/);
  assert.match(messages, /shipmentState/);
});

test('teardown: orders are outside the prefix check, and one that no longer matches is held back', async () => {
  const { plan: p, cfg, planned } = ordersOnly();
  assert.deepEqual(keysOutsidePrefix(p, 'mig-').filter((x) => (x.kind as string) === 'orders'), []);

  const other = { ...planned, orderNumber: '200001' };
  const two = { ...p, orders: [planned, other] };
  const project = new Map<string, Order>([
    [planned.orderNumber, asLoaded(planned)],
    // Same number, someone else's order: a different total.
    [other.orderNumber, asLoaded(other, { totalPrice: { ...other.totalPrice, centAmount: 99 } as Order['totalPrice'] })],
  ]);
  const deleted: { orderNumber: string; dataErasure?: boolean }[] = [];
  const results = (kind: string) => (kind === 'orders' ? [...project.values()] : []);
  const endpoint = (kind: string) => () => ({
    get: () => ({ execute: async () => ({ body: { results: results(kind), total: results(kind).length } }) }),
    withOrderNumber: ({ orderNumber }: { orderNumber: string }) => ({
      get: () => ({ execute: async () => ({ body: project.get(orderNumber) }) }),
      delete: ({ queryArgs }: { queryArgs: { dataErasure?: boolean } }) => ({
        execute: async () => {
          deleted.push({ orderNumber, dataErasure: queryArgs.dataErasure });
          project.delete(orderNumber);
          return { body: {} };
        },
      }),
    }),
  });
  const platform = new Proxy({}, { get: (_t, kind: string) => endpoint(kind) });
  const importApi = new Proxy({}, {
    get: () => () => ({
      withImportContainerKeyValue: () => ({
        get: () => ({ execute: async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }); } }),
      }),
    }),
  });
  const clients = { platform, importApi } as unknown as Clients;

  const result = await runTeardown(clients, two, cfg, { execute: true });
  assert.deepEqual(deleted, [{ orderNumber: '100045', dataErasure: true }]);
  assert.deepEqual(result.heldBackOrders.map((o) => o.orderNumber), ['200001']);
  assert.match(renderTeardown(result), /NOT deleted: order '200001' has a different total/);
});

test('fixtures: every email in this file is on example.com', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const m of self.matchAll(/[\w.+-]+@([\w-]+\.[\w.]+)/g)) assert.match(m[1], /^example\.com$/);
});
