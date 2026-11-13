/**
 * Customers: an opt-in entity, through every stage.
 *
 * The people in these tests are invented. Every email is on example.com.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Customer } from '@commercetools/platform-sdk';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig, type PipelineConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { auditPlan } from '../src/audit/gate.js';
import { loadPlan } from '../src/audit/load-plan.js';
import { writePlan } from '../src/map/report.js';
import { planBatches } from '../src/load/batches.js';
import { reconcile, type ProjectSnapshot } from '../src/verify/reconcile.js';
import { fetchSnapshot } from '../src/verify/snapshot.js';
import { keysOutsidePrefix, TEARDOWN_KINDS } from '../src/teardown/run.js';
import { LOAD_ORDER, type CustomerImport, type MigrationPlan } from '../src/model/plan.js';
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

const ADA = {
  _type: 'customer',
  code: 'C-1001',
  email: 'ada.example@example.com',
  firstName: 'Ada',
  lastName: 'Example',
  customerGroup: 'trade',
  addresses: [
    { code: 'home', country: 'GB', city: 'Leeds' },
    { code: 'office', country: 'GB', city: 'York' },
  ],
  defaultShippingAddress: 'office',
  defaultBillingAddress: 'home',
  shippingAddresses: ['home', 'office'],
  billingAddresses: ['home'],
};

const GROUP = { _type: 'customerGroup', code: 'trade', name: 'Trade' };

function config(customers?: unknown): PipelineConfig {
  const { config: base } = loadConfig(STORES_CONFIG);
  return customers === undefined ? base : { ...base, entities: { customers } as never };
}

function validate(lines: unknown[], cfg: PipelineConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-customers-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(join(feedDir, 'feed.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return validateFeed(feedDir, SCHEMA, cfg);
}

function plan(lines: unknown[], cfg = config(true)) {
  const result = validate(lines, cfg);
  const model = deriveProductTypes(result.feed, cfg);
  return { ...buildPlan(result.feed, model, cfg), validation: result, config: cfg };
}

const codes = (d: { code: string }[]) => d.map((x) => x.code);

// ---------------------------------------------------------------------------
// The opt-in
// ---------------------------------------------------------------------------

test('customers: refused while entities.customers is unset, once for the whole feed', () => {
  const r = validate([...CATALOG, GROUP, ADA, { ...ADA, code: 'C-1002', email: 'b@example.com' }], config());
  const refused = r.diagnostics.filter((d) => d.code === 'customers-not-in-scope');
  assert.equal(refused.length, 1, 'one finding, not one per customer');
  assert.equal(refused[0].severity, 'error');
  assert.match(refused[0].message, /2 customer record\(s\)/);
  assert.match(refused[0].message, /DECISIONS\.md/);
  assert.match(refused[0].message, /set it to false and they are ignored/);
});

test('customers: the refusal is reported even when another record fails', () => {
  // The integrity checks wait for a clean parse; the opt-in does not, because
  // it is a decision, not a consequence of a broken record.
  const r = validate([...CATALOG, { _type: 'product' }, GROUP, ADA], config());
  assert.ok(codes(r.diagnostics).includes('schema-violation'));
  assert.ok(codes(r.diagnostics).includes('customers-not-in-scope'));
});

test('customers: entities.customers false ignores them with one warning, and plans none', () => {
  const r = validate(
    [...CATALOG, GROUP, ADA, { ...ADA, code: 'C-1002', stores: ['nowhere'] }],
    config(false),
  );
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  const ignored = r.diagnostics.filter((d) => d.code === 'customers-ignored');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].severity, 'warning');
  assert.match(ignored[0].message, /2 customer record\(s\)/);
  assert.ok(!codes(r.diagnostics).some((c) => c.startsWith('customer-')), 'ignored customers are not checked');
  assert.ok(!('customers' in plan([...CATALOG, GROUP, ADA], config(false)).plan));
});

test('customers: a feed without customers is untouched by the switch', () => {
  assert.ok(!codes(validate(CATALOG, config()).diagnostics).includes('customers-not-in-scope'));
});

test('config: entities.customers must be a boolean, and unknown entities are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-customers-config-'));
  const raw = JSON.parse(readFileSync(STORES_CONFIG, 'utf8'));
  const write = (entities: unknown) => {
    const path = join(dir, `c-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ ...raw, entities }));
    return path;
  };
  assert.throws(() => loadConfig(write({ customers: 'yes' })), /entities\.customers is "yes"/);
  assert.throws(() => loadConfig(write({ customer: true })), /entities\.customer is not a known entity/);
  assert.doesNotThrow(() => loadConfig(write({ customers: true })));
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

test('customers: a clean opted-in feed validates without findings', () => {
  const r = validate([...CATALOG, GROUP, ADA], config(true));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.equal(r.feed.customers.size, 1);
});

test('customers: the schema has no password field', () => {
  const r = validate([...CATALOG, GROUP, { ...ADA, password: 'hunter2' }], config(true));
  const d = r.diagnostics.find((x) => x.code === 'schema-violation');
  assert.ok(d, 'a password is refused at the contract');
  assert.match(d.message, /password/);
});

test('customers: one email on two global customers is refused, case-insensitively', () => {
  const r = validate(
    [...CATALOG, GROUP, ADA, { ...ADA, code: 'C-1002', email: 'ADA.Example@example.com' }],
    config(true),
  );
  const d = r.diagnostics.find((x) => x.code === 'customer-email-duplicate');
  assert.ok(d);
  assert.match(d.message, /'C-1001', 'C-1002'/);
});

test('customers: one email in two different Stores is allowed; in a shared Store it is not', () => {
  const stores = [{ _type: 'store', code: 'uk' }, { _type: 'store', code: 'de' }];
  const uk = { ...ADA, stores: ['uk'] };
  const de = { ...ADA, code: 'C-1002', stores: ['de'] };
  assert.ok(
    !codes(validate([...CATALOG, GROUP, ...stores, uk, de], config(true)).diagnostics).includes(
      'customer-email-duplicate',
    ),
  );
  const both = { ...ADA, code: 'C-1003', stores: ['de', 'uk'] };
  assert.ok(
    codes(validate([...CATALOG, GROUP, ...stores, uk, both], config(true)).diagnostics).includes(
      'customer-email-duplicate',
    ),
  );
  // A global customer can sign in through every Store, so it clashes with any.
  const global = { ...ADA, code: 'C-1004' };
  assert.ok(
    codes(validate([...CATALOG, GROUP, ...stores, uk, global], config(true)).diagnostics).includes(
      'customer-email-duplicate',
    ),
  );
});

test('customers: undeclared group, undeclared store and unknown address codes are errors', () => {
  const r = validate(
    [
      ...CATALOG,
      { ...ADA, stores: ['nowhere'], defaultBillingAddress: 'holiday' },
    ],
    config(true),
  );
  const found = codes(r.diagnostics);
  assert.ok(found.includes('customer-group-not-declared'));
  assert.ok(found.includes('customer-store-not-declared'));
  assert.ok(found.includes('customer-address-unknown'));
});

test('customers: a default address that is not in its list is an error, whether the list is absent or does not name it', () => {
  // The Import API refuses the whole request ("defaultShippingAddress must be a valid
  // index in shipping addresses array"), and nothing else offline said so.
  const { shippingAddresses: _s, billingAddresses: _b, ...bare } = ADA;
  const absent = validate([...CATALOG, GROUP, bare], config(true));
  const found = absent.diagnostics.filter((d) => d.code === 'customer-default-address-not-listed');
  assert.equal(found.length, 2, 'both the shipping and the billing default');
  assert.match(found[0].message, /defaultShippingAddress 'office' but has no shippingAddresses/);
  assert.match(found[1].message, /defaultBillingAddress 'home' but has no billingAddresses/);
  assert.match(found[0].message, /Add 'office' to shippingAddresses/);

  const elsewhere = validate(
    [...CATALOG, GROUP, { ...ADA, shippingAddresses: ['home'], billingAddresses: ['office'] }],
    config(true),
  );
  const named = elsewhere.diagnostics.filter((d) => d.code === 'customer-default-address-not-listed');
  assert.equal(named.length, 2);
  assert.match(named[0].message, /does not list it in shippingAddresses/);
  assert.match(named[1].message, /does not list it in billingAddresses/);
  assert.equal(elsewhere.diagnostics.find((d) => d.code === 'customer-default-address-not-listed')?.severity, 'error');
});

test('customers: listed defaults, no defaults and unknown addresses raise no not-listed error', () => {
  const clean = validate([...CATALOG, GROUP, ADA], config(true));
  assert.ok(!codes(clean.diagnostics).includes('customer-default-address-not-listed'));

  // A customer with addresses and no default is fine: the rule is about a default that is set.
  const { defaultShippingAddress: _d, defaultBillingAddress: _e, shippingAddresses: _s, billingAddresses: _b, ...none } = ADA;
  const noDefaults = validate([...CATALOG, GROUP, none], config(true));
  assert.ok(!codes(noDefaults.diagnostics).includes('customer-default-address-not-listed'));

  // An address that does not exist is reported once, as unknown, and not again as unlisted.
  const unknown = validate([...CATALOG, GROUP, { ...ADA, defaultBillingAddress: 'holiday' }], config(true));
  assert.ok(codes(unknown.diagnostics).includes('customer-address-unknown'));
  assert.ok(!codes(unknown.diagnostics).includes('customer-default-address-not-listed'));
});

test('customers: duplicate address codes and customer numbers are errors', () => {
  const r = validate(
    [
      ...CATALOG,
      GROUP,
      { ...ADA, customerNumber: 'N1', addresses: [ADA.addresses[0], ADA.addresses[0]], defaultShippingAddress: 'home', shippingAddresses: ['home'] },
      { ...ADA, code: 'C-1002', email: 'b@example.com', customerNumber: 'N1' },
    ],
    config(true),
  );
  assert.ok(codes(r.diagnostics).includes('customer-address-duplicate'));
  assert.ok(codes(r.diagnostics).includes('customer-number-duplicate'));
});

test('customers: no diagnostic ever prints an email', () => {
  const r = validate(
    [...CATALOG, ADA, { ...ADA, code: 'C-1002', stores: ['nowhere'], defaultShippingAddress: 'x' }],
    config(true),
  );
  assert.ok(r.diagnostics.length > 0);
  for (const d of r.diagnostics) assert.doesNotMatch(d.message, /@example\.com/i);
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

test('plan: a customer becomes a CustomerImport under ExternalAuth with no password', () => {
  const r = plan([...CATALOG, GROUP, ADA]);
  const [c] = r.plan.customers!;
  assert.equal(c.key, 'mig-C-1001');
  assert.equal(c.authenticationMode, 'ExternalAuth');
  assert.ok(!('password' in c));
  assert.ok(!('code' in c) && !('_type' in c));
  assert.deepEqual(c.customerGroup, { typeId: 'customer-group', key: 'trade' });
  assert.deepEqual(c.addresses!.map((a) => a.key), ['home', 'office']);
  // Codes become positions in the address list.
  assert.equal(c.defaultShippingAddress, 1);
  assert.equal(c.defaultBillingAddress, 0);
  assert.deepEqual(c.shippingAddresses, [0, 1]);
});

test('plan: Store-specific customers reference their stores verbatim', () => {
  const r = plan([...CATALOG, GROUP, { _type: 'store', code: 'uk' }, { ...ADA, stores: ['uk'] }]);
  assert.deepEqual(r.plan.customers![0].stores, [{ typeId: 'store', key: 'uk' }]);
});

test('plan: the review decision carries counts, never an email or a name', () => {
  const r = plan([...CATALOG, GROUP, ADA]);
  const d = r.plan.decisions.find((x) => x.subject === 'customers');
  assert.ok(d);
  assert.equal(d.review, true);
  assert.match(d.outcome, /1 customer\(s\)/);
  assert.doesNotMatch(JSON.stringify(d), /example\.com|Ada/);
});

test('plan: no customers field without customers, so a catalog plan is unchanged', () => {
  const r = plan(CATALOG);
  assert.ok(!('customers' in r.plan));
});

test('plan: customers load after the catalog and before the stores they name', () => {
  const at = (s: string) => LOAD_ORDER.indexOf(s as (typeof LOAD_ORDER)[number]);
  assert.ok(at('customer') > at('product-selection'));
  assert.ok(at('customer') < at('store'));
});

test('load: customers batch into their own container as customer requests', () => {
  const r = plan([...CATALOG, GROUP, ADA]);
  const batches = planBatches(r.plan, r.config);
  const container = batches.containers.find((c) => c.stage === 'customer');
  assert.ok(container);
  assert.equal(container.key, 'mig-customer');
  assert.equal(container.resourceType, 'customer');
  const batch = batches.batches.find((b) => b.stage === 'customer')!;
  assert.equal(batch.body.type, 'customer');
  assert.deepEqual(batch.resourceKeys, ['mig-C-1001']);
});

test('plan: customers survive the round trip through plan.json', () => {
  // audit, load, verify and teardown all read the written file, not the
  // mapper's result. writePlan names its fields, and one it leaves out is a
  // collection every later stage silently sees as empty.
  const r = plan([...CATALOG, GROUP, ADA]);
  const out = mkdtempSync(join(tmpdir(), 'ct-customers-out-'));
  writePlan(out, r.plan, false);
  const back = loadPlan(out);
  assert.deepEqual(back.customers, r.plan.customers);
  assert.equal(auditPlan(back, r.config).checked.customers, 1);
});

test(
  'plan: the out/ it creates and the files it writes are readable by their owner only',
  { skip: process.platform === 'win32' ? 'no POSIX file modes on Windows' : false },
  () => {
    // plan.json now holds names, emails and addresses.
    const out = join(mkdtempSync(join(tmpdir(), 'ct-customers-out-')), 'migration', 'out');
    writePlan(out, plan([...CATALOG, GROUP, ADA]).plan, false);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    for (const file of ['plan.json', 'key-map.json', 'decisions.json']) {
      assert.equal(statSync(join(out, file)).mode & 0o777, 0o600, file);
    }
  },
);

test('plan: a catalog-only plan.json carries no customers key', () => {
  const out = mkdtempSync(join(tmpdir(), 'ct-customers-out-'));
  writePlan(out, plan(CATALOG).plan, false);
  assert.ok(!('customers' in JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'))));
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Mutable copy for tests that break a resource on purpose; the SDK types are read-only. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

function auditCustomers(mutate: (c: Writable<CustomerImport>) => void, cfg = config(true)) {
  const r = plan([...CATALOG, GROUP, ADA]);
  const customers = r.plan.customers!.map((c) => {
    const copy = structuredClone(c) as Writable<CustomerImport>;
    mutate(copy);
    return copy;
  });
  return auditPlan({ ...r.plan, customers }, cfg);
}

test('audit: a clean customer plan passes, and is counted', () => {
  const a = auditCustomers(() => {});
  assert.deepEqual(codes(a.diagnostics).filter((c) => c.startsWith('customer')), []);
  assert.equal(a.checked.customers, 1);
});

test('audit: a password that reached the plan is refused', () => {
  const a = auditCustomers((c) => Object.assign(c, { password: 'x' }));
  assert.ok(codes(a.diagnostics).includes('customer-password-present'));
});

test('audit: any authentication mode but ExternalAuth is refused', () => {
  const a = auditCustomers((c) => { c.authenticationMode = 'Password'; });
  assert.ok(codes(a.diagnostics).includes('customer-authentication-mode'));
});

test('audit: an address position outside the list is refused', () => {
  const a = auditCustomers((c) => { c.defaultShippingAddress = 2; });
  assert.ok(codes(a.diagnostics).includes('customer-address-position'));
});

test('audit: a default address position that is not in its list is refused, absent list included', () => {
  const missing = auditCustomers((c) => { delete c.shippingAddresses; });
  const a = missing.diagnostics.filter((d) => d.code === 'customer-default-address-not-listed');
  assert.equal(a.length, 1);
  assert.match(a[0].message, /defaultShippingAddress to position 1 but has no shippingAddresses/);

  const elsewhere = auditCustomers((c) => { c.shippingAddresses = [0]; });
  assert.match(
    elsewhere.diagnostics.find((d) => d.code === 'customer-default-address-not-listed')!.message,
    /does not list it in shippingAddresses/,
  );
});

test('audit: a default address position outside the address list is the position error, not also the not-listed one', () => {
  const a = auditCustomers((c) => { c.defaultShippingAddress = 2; });
  assert.ok(codes(a.diagnostics).includes('customer-address-position'));
  assert.ok(!codes(a.diagnostics).includes('customer-default-address-not-listed'));
});

test('audit: a plan with customers and the switch off is refused', () => {
  const a = auditCustomers(() => {}, config());
  assert.ok(codes(a.diagnostics).includes('customers-not-in-scope'));
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

function emptySnapshot(): ProjectSnapshot {
  return {
    productTypes: new Map(),
    categories: new Map(),
    products: new Map(),
    variants: new Map(),
    standalonePrices: new Map(),
    productSelections: new Map(),
    inventory: new Map(),
    stores: new Map(),
    categoryKeyById: new Map(),
    productTypeKeyById: new Map(),
    productSelectionKeyById: new Map(),
  };
}

/** The customer as the API returns it: address ids, group as an id reference. */
function asLoaded(planned: CustomerImport): Customer {
  const addresses = (planned.addresses ?? []).map((a, i) => ({ ...a, id: `addr-${i}` }));
  const idAt = (i: number | undefined) => (i === undefined ? undefined : `addr-${i}`);
  return {
    id: 'cust-1',
    version: 1,
    createdAt: '',
    lastModifiedAt: '',
    key: planned.key,
    email: planned.email,
    addresses,
    shippingAddressIds: [],
    billingAddressIds: [],
    isEmailVerified: false,
    stores: (planned.stores ?? []).map((s) => ({ typeId: 'store', key: s.key })),
    authenticationMode: 'ExternalAuth',
    ...(planned.customerGroup ? { customerGroup: { typeId: 'customer-group', id: 'grp-1' } } : {}),
    ...(idAt(planned.defaultShippingAddress) ? { defaultShippingAddressId: idAt(planned.defaultShippingAddress) } : {}),
    ...(idAt(planned.defaultBillingAddress) ? { defaultBillingAddressId: idAt(planned.defaultBillingAddress) } : {}),
  } as unknown as Customer;
}

function customersOnly(): { plan: MigrationPlan; cfg: PipelineConfig; planned: CustomerImport } {
  const r = plan([...CATALOG, GROUP, ADA]);
  const only: MigrationPlan = {
    ...r.plan,
    productTypes: [],
    categories: [],
    products: [],
    variants: [],
    standalonePrices: [],
  };
  return { plan: only, cfg: r.config, planned: r.plan.customers![0] };
}

test('verify: a customer that landed as planned reconciles', () => {
  const { plan: p, cfg, planned } = customersOnly();
  const snapshot = {
    ...emptySnapshot(),
    customers: new Map([[planned.key, asLoaded(planned)]]),
    customerGroupKeyById: new Map([['grp-1', 'trade']]),
  };
  const r = reconcile(p, snapshot, cfg);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.found.customers, 1);
  assert.equal(r.checked.customers, 1);
});

test('verify: a missing customer is reported by key, pointing at the import summary', () => {
  const { plan: p, cfg, planned } = customersOnly();
  const r = reconcile(p, emptySnapshot(), cfg);
  const d = r.diagnostics.find((x) => x.code === 'customer-missing');
  assert.ok(d);
  assert.match(d.message, new RegExp(planned.key));
  assert.doesNotMatch(d.message, /@/);
});

test('verify: a wrong default address, group or Store is a difference', () => {
  const { plan: p, cfg, planned } = customersOnly();
  const loaded = asLoaded(planned) as Writable<Customer>;
  loaded.defaultShippingAddressId = 'addr-0';
  loaded.stores = [{ typeId: 'store', key: 'de' }];
  const snapshot = {
    ...emptySnapshot(),
    customers: new Map([[planned.key, loaded]]),
    customerGroupKeyById: new Map([['grp-1', 'retail']]),
  };
  const messages = reconcile(p, snapshot, cfg)
    .diagnostics.filter((d) => d.code === 'customer-differs')
    .map((d) => d.message)
    .join('\n');
  assert.match(messages, /default shipping address/);
  assert.match(messages, /customer group/);
  assert.match(messages, /Stores/);
});

test('verify: a catalog-only plan reads no customers, so it needs no customer scope', async () => {
  const queried: string[] = [];
  const endpoint = (kind: string) => () => ({
    get: () => ({
      execute: async () => {
        queried.push(kind);
        return { body: { results: [] } };
      },
    }),
  });
  const platform = new Proxy({}, { get: (_t, kind: string) => endpoint(kind) });
  const clients = { platform, importApi: {} } as unknown as Clients;
  const { plan: p } = plan(CATALOG, config());
  await fetchSnapshot(clients, p);
  assert.ok(!queried.includes('customers'));
  assert.ok(!queried.includes('customerGroups'));

  const { plan: withCustomers } = customersOnly();
  queried.length = 0;
  await fetchSnapshot(clients, withCustomers);
  assert.ok(queried.includes('customers'));
  assert.ok(queried.includes('customerGroups'));
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test('teardown: customers are removed right after orders and checked against the prefix', () => {
  assert.deepEqual(TEARDOWN_KINDS.slice(0, 2), ['orders', 'customers']);
  const { plan: p } = customersOnly();
  const outside = { ...p, customers: [{ ...p.customers![0], key: 'other-C-1001' }] };
  assert.deepEqual(
    keysOutsidePrefix(outside, 'mig-').filter((x) => x.kind === 'customers'),
    [{ kind: 'customers', key: 'other-C-1001' }],
  );
});

test('fixtures: every email in this file is on example.com', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const m of self.matchAll(/[\w.+-]+@([\w-]+\.[\w.]+)/g)) {
    assert.match(m[1], /^example\.com$/);
  }
});
