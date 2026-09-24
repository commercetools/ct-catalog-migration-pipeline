/**
 * Credentials and preflight tests.
 *
 * The transport tests that used to live here are gone. Token lifecycle, retry,
 * backoff and status-code handling now belong to `@commercetools/ts-client`,
 * and re-testing a dependency's HTTP layer is how a suite gets slow and
 * pointless. What remains is everything the SDK cannot decide for us.
 *
 * The seam is a fake `Clients`: preflight uses a handful of request-builder
 * calls, so a double covering exactly those tests our logic without exercising
 * anyone's transport. Unstubbed paths throw a named error rather than returning
 * undefined, so a new call site fails loudly instead of silently.
 *
 * The most important assertion in the file is still that `--apply` sends the
 * *union* of existing and needed values. `changeLanguages` and
 * `changeCurrencies` replace the whole array, so sending only the missing
 * entries would delete every locale and currency the project already had.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Project, ProjectUpdate } from '@commercetools/platform-sdk';

import {
  describeCredentials,
  loadCredentials,
  MissingCredentialsError,
  parseEnvFile,
} from '../src/client/credentials.js';
import { createClients, type Clients } from '../src/client/factory.js';
import { effectiveCatalogModel, preflight } from '../src/preflight/check.js';
import { loadConfig } from '../src/model/config.js';
import { loadPlan } from '../src/audit/load-plan.js';

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

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('parseEnvFile handles quotes, export prefixes, comments and blanks', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'PLAIN=value',
      'QUOTED="with spaces"',
      "SINGLE='single'",
      'export EXPORTED=yes',
      '  SPACED  =  trimmed  ',
      'EMPTY=',
      'not a line',
    ].join('\n'),
  );
  assert.equal(parsed.PLAIN, 'value');
  assert.equal(parsed.QUOTED, 'with spaces');
  assert.equal(parsed.SINGLE, 'single');
  assert.equal(parsed.EXPORTED, 'yes');
  assert.equal(parsed.SPACED, 'trimmed');
  assert.equal(parsed.EMPTY, '');
  assert.ok(!('not a line' in parsed));
});

test('credentials: a region derives all three hosts', () => {
  const c = loadCredentials('/nonexistent', {
    CTP_PROJECT_KEY: 'p',
    CTP_CLIENT_ID: 'i',
    CTP_CLIENT_SECRET: 's',
    CTP_REGION: 'europe-west1.gcp',
    CTP_AMBIENT_OK: '1',
  });
  assert.equal(c.authUrl, 'https://auth.europe-west1.gcp.commercetools.com');
  assert.equal(c.apiUrl, 'https://api.europe-west1.gcp.commercetools.com');
  assert.equal(c.importUrl, 'https://import.europe-west1.gcp.commercetools.com');
});

test('credentials: the import host is derived from the API host when absent', () => {
  // The conventional commercetools environment set has no import URL, so an
  // existing setup has to keep working.
  const c = loadCredentials('/nonexistent', {
    CTP_PROJECT_KEY: 'p',
    CTP_CLIENT_ID: 'i',
    CTP_CLIENT_SECRET: 's',
    CTP_AUTH_URL: 'https://auth.europe-west1.gcp.commercetools.com',
    CTP_API_URL: 'https://api.europe-west1.gcp.commercetools.com',
    CTP_AMBIENT_OK: '1',
  });
  assert.equal(c.importUrl, 'https://import.europe-west1.gcp.commercetools.com');
});

test('credentials: an underivable import host says so instead of blaming the region', () => {
  assert.throws(
    () =>
      loadCredentials('/nonexistent', {
        CTP_PROJECT_KEY: 'p',
        CTP_CLIENT_ID: 'i',
        CTP_CLIENT_SECRET: 's',
        CTP_AUTH_URL: 'http://localhost:8080',
        CTP_API_URL: 'http://localhost:8080',
        CTP_AMBIENT_OK: '1',
      }),
    /CTP_IMPORT_URL \(it could not be derived/,
  );
});

test('credentials: no env file plus an ambient project is refused', () => {
  // The dogfood-run accident. A directory with no credentials of its own ran
  // against whatever project the operator had exported, and the disagreement
  // check could not fire because there was no file to disagree with. What
  // saved it was preflight printing the project name — luck, not a guard.
  try {
    loadCredentials('/nonexistent/.env', {
      CTP_PROJECT_KEY: 'someone-elses-project',
      CTP_CLIENT_ID: 'i',
      CTP_CLIENT_SECRET: 's',
      CTP_REGION: 'europe-west1.gcp',
    });
    assert.fail('should have refused');
  } catch (err) {
    assert.ok(err instanceof MissingCredentialsError);
    assert.match(err.message, /someone-elses-project/, 'name the project it would have used');
    assert.match(err.message, /CTP_AMBIENT_OK=1/, 'and how to opt in deliberately');
  }
});

test('credentials: ambient credentials are allowed when declared deliberately', () => {
  // CI and containers legitimately have no file. Refusing outright would break
  // them, so the escape hatch has to exist — it just has to be explicit.
  const c = loadCredentials('/nonexistent/.env', {
    CTP_PROJECT_KEY: 'ci-project',
    CTP_CLIENT_ID: 'i',
    CTP_CLIENT_SECRET: 's',
    CTP_REGION: 'europe-west1.gcp',
    CTP_AMBIENT_OK: '1',
  });
  assert.equal(c.projectKey, 'ci-project');
});

test('credentials: an env file naming the project needs no opt-in', () => {
  // The normal local path. The file is the deliberate act, so nothing to ask.
  const dir = mkdtempSync(join(tmpdir(), 'ct-creds-'));
  const path = join(dir, '.env');
  writeFileSync(path, 'CTP_PROJECT_KEY=chosen\nCTP_CLIENT_ID=i\nCTP_CLIENT_SECRET=s\nCTP_REGION=europe-west1.gcp\n');
  const c = loadCredentials(path, {});
  assert.equal(c.projectKey, 'chosen');
});

test('credentials: an absent file with no ambient project still reports what is missing', () => {
  // Not the ambient case at all — nothing is configured anywhere, and the
  // reader needs the list of variables, not a lecture about provenance.
  try {
    loadCredentials('/nonexistent/.env', {});
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof MissingCredentialsError);
    assert.match(err.message, /CTP_PROJECT_KEY/);
    assert.ok(!/CTP_AMBIENT_OK/.test(err.message), 'no project to borrow, so no provenance warning');
  }
});

test('credentials: two disagreeing project keys are refused, not resolved', () => {
  // The realistic accident: working credentials exported in a shell, a second
  // project written into a file, `--env` pointing at the file, and the load
  // going to the first project while the operator reads the second one's name
  // off their own screen. Precedence is the wrong tool for project identity.
  const dir = mkdtempSync(join(tmpdir(), 'ct-creds-'));
  const path = join(dir, '.env.trial');
  writeFileSync(
    path,
    'CTP_PROJECT_KEY=trial-modular\nCTP_CLIENT_ID=i2\nCTP_CLIENT_SECRET=s2\nCTP_REGION=europe-west1.gcp\n',
  );

  try {
    loadCredentials(path, {
      CTP_PROJECT_KEY: 'production-live',
      CTP_CLIENT_ID: 'i1',
      CTP_CLIENT_SECRET: 's1',
      CTP_REGION: 'europe-west1.gcp',
    });
    assert.fail('should have refused');
  } catch (err) {
    assert.ok(err instanceof MissingCredentialsError);
    assert.match(err.message, /Two different projects are configured/);
    // Both names have to appear: knowing which one would have won is the point.
    assert.match(err.message, /production-live/);
    assert.match(err.message, /trial-modular/);
    assert.match(err.message, /unset CTP_PROJECT_KEY/);
  }
});

test('credentials: agreeing project keys are fine, and the file still fills gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-creds-'));
  const path = join(dir, '.env');
  writeFileSync(path, 'CTP_PROJECT_KEY=same\nCTP_CLIENT_SECRET=from-file\n');

  const c = loadCredentials(path, {
    CTP_PROJECT_KEY: 'same',
    CTP_CLIENT_ID: 'from-env',
    CTP_REGION: 'europe-west1.gcp',
  });
  assert.equal(c.projectKey, 'same');
  assert.equal(c.clientId, 'from-env', 'the environment still wins where they agree');
  assert.equal(c.clientSecret, 'from-file', 'and the file still supplies what is absent');
});

test('credentials: missing values are listed together, not one at a time', () => {
  try {
    loadCredentials('/nonexistent', { CTP_REGION: 'europe-west1.gcp' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof MissingCredentialsError);
    for (const name of ['CTP_PROJECT_KEY', 'CTP_CLIENT_ID', 'CTP_CLIENT_SECRET']) {
      assert.match(err.message, new RegExp(name));
    }
    assert.match(err.message, /view_project_settings/, 'the message should name the scopes');
  }
});

test('credentials: an unknown region is rejected with the valid list', () => {
  assert.throws(
    () =>
      loadCredentials('/nonexistent', {
        CTP_PROJECT_KEY: 'p',
        CTP_CLIENT_ID: 'i',
        CTP_CLIENT_SECRET: 's',
        CTP_REGION: 'eu-west-9.gcp',
        CTP_AMBIENT_OK: '1',
      }),
    /not a known region[\s\S]*europe-west1\.gcp/,
  );
});

test('credentials: trailing slashes are stripped so paths do not double up', () => {
  const c = loadCredentials('/nonexistent', {
    CTP_PROJECT_KEY: 'p',
    CTP_CLIENT_ID: 'i',
    CTP_CLIENT_SECRET: 's',
    CTP_AUTH_URL: 'https://auth.test/',
    CTP_API_URL: 'https://api.test//',
    CTP_IMPORT_URL: 'https://import.test/',
    CTP_AMBIENT_OK: '1',
  });
  assert.equal(c.apiUrl, 'https://api.test');
  assert.equal(c.authUrl, 'https://auth.test');
});

test('describeCredentials never reveals the secret', () => {
  const described = describeCredentials({
    projectKey: 'demo',
    clientId: 'ABCDEF',
    clientSecret: 'TOPSECRET',
    authUrl: 'https://auth.test',
    apiUrl: 'https://api.test',
    importUrl: 'https://import.test',
  });
  assert.ok(!described.includes('TOPSECRET'));
  assert.match(described, /demo/);
});

// ---------------------------------------------------------------------------
// The fake Clients
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  version: 7,
  key: 'demo',
  name: 'Demo project',
  countries: ['GB', 'DE'],
  currencies: ['GBP', 'EUR'],
  languages: ['en-GB', 'de-DE'],
  productCatalogModel: 'Classic',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: { enabled: false, deleteDaysAfterCreation: 15 },
  carts: { deleteDaysAfterLastModification: 90 },
  inventory: { releaseExpiredReservations: false },
  discounts: { discountCombinationMode: 'Stacking' },
};

interface FakeOptions {
  project?: Partial<Project>;
  /** Totals per resource; a number throws nothing, an Error rejects. */
  counts?: { productTypes?: number | Error; categories?: number | Error; products?: number | Error };
  /**
   * ProductTypes the project already holds, with attributes — what the
   * project-wide attribute name→type check compares the plan against.
   */
  existingProductTypes?:
    | { key?: string; name: string; attributes?: { name: string; type: { name: string; elementType?: { name: string }; referenceTypeId?: string }; isSearchable?: boolean }[] }[]
    | Error;
  /** Product selections the project holds. Mode is what matters: it is immutable. */
  existingSelections?: { key: string; mode?: string }[] | Error;
  /** Stores the project holds. */
  existingStores?: { key: string; productSelections?: unknown[] }[] | Error;
  /** Channels the project holds, as the API would return them. */
  channels?: { key: string; roles: string[] }[] | Error;
  customerGroups?: { key: string }[] | Error;
  /** Thrown instead of returning the project. */
  projectError?: unknown;
  /** Thrown on the first update attempt. */
  updateError?: unknown;
}

interface Recorded {
  updates: ProjectUpdate[];
  projectReads: number;
  /** Resource-count reads, to prove preflight still tries them when degraded. */
  countReads: number;
  /** Full ProductType reads, for the attribute name→type check. */
  productTypeReads: number;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * A double for the parts of `Clients` that preflight actually uses. Anything
 * else throws, so a new call site surfaces immediately rather than silently
 * returning undefined.
 */
function fakeClients(options: FakeOptions = {}): { clients: Clients; recorded: Recorded } {
  const recorded: Recorded = { updates: [], projectReads: 0, countReads: 0, productTypeReads: 0 };
  let version = (options.project?.version ?? PROJECT.version) as number;
  let updateAttempts = 0;

  const results = (value: unknown[] | Error | undefined) => ({
    get: () => ({
      execute: async () => {
        if (value instanceof Error) throw value;
        return { body: { results: value ?? [] } };
      },
    }),
  });

  const total = (value: number | Error | undefined) => ({
    get: () => ({
      execute: async () => {
        recorded.countReads++;
        if (value instanceof Error) throw value;
        return { body: { total: value ?? 0 } };
      },
    }),
  });

  /**
   * ProductTypes are read twice for different reasons: `limit: 0` for the
   * count, and a paginated full read for the attribute types. One builder
   * serves both, because the real endpoint does.
   */
  const productTypes = () => ({
    get: (
      { queryArgs }: { queryArgs: { limit?: number; offset?: number } } = { queryArgs: {} },
    ) => ({
      execute: async () => {
        if ((queryArgs?.limit ?? 0) === 0) {
          recorded.countReads++;
          const c = options.counts?.productTypes;
          if (c instanceof Error) throw c;
          return { body: { total: c ?? 0, results: [] } };
        }
        recorded.productTypeReads++;
        const pts = options.existingProductTypes;
        if (pts instanceof Error) throw pts;
        const all = pts ?? [];
        // Slice like the real endpoint. Returning everything on page one would
        // make a pagination test pass without paginating.
        const offset = queryArgs?.offset ?? 0;
        const limit = queryArgs?.limit ?? all.length;
        return { body: { total: all.length, results: all.slice(offset, offset + limit) } };
      },
    }),
  });

  const platform = {
    get: () => ({
      execute: async () => {
        recorded.projectReads++;
        if (options.projectError) throw options.projectError;
        // A second read reflects a concurrent change, as a 409 retry expects.
        if (recorded.projectReads > 1) version += 2;
        return { body: { ...PROJECT, ...options.project, version } };
      },
    }),
    post: ({ body }: { body: ProjectUpdate }) => ({
      execute: async () => {
        recorded.updates.push(body);
        updateAttempts++;
        if (options.updateError && updateAttempts === 1) throw options.updateError;
        return { body: { ...PROJECT, ...options.project, version: version + 1 } };
      },
    }),
    productTypes,
    categories: () => total(options.counts?.categories),
    products: () => total(options.counts?.products),
    // Prerequisites the pipeline cannot create, so it can only verify them.
    channels: () => results(options.channels),
    customerGroups: () => results(options.customerGroups),
    productSelections: () => results(options.existingSelections),
    stores: () => results(options.existingStores),
  };

  const unavailable = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`fakeClients: importApi.${String(prop)} is not stubbed`);
      },
    },
  );

  return { clients: { platform, importApi: unavailable } as unknown as Clients, recorded };
}

function config() {
  return loadConfig(resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json')).config;
}

function plan() {
  return loadPlan(resolve(ROOT, 'fixtures', 'audit-violations', 'out'));
}

/** The stores fixture's plan: one selection, one store, both non-empty. */
function storePlan() {
  return loadPlan(resolve(ROOT, 'fixtures', 'stores', 'out'));
}

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

test('preflight: a matching project passes', async () => {
  const { clients } = fakeClients();
  const r = await preflight(clients, config(), undefined);
  // No errors. Every warning is a statement about the missing plan rather than
  // about the project: without one, none of the price countries, the channels
  // and customer groups the prices reference, or the attribute types can be
  // compared against it.
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(codes(r.diagnostics), [
    'prerequisites-unchecked',
    'price-countries-unchecked',
    'attribute-types-unchecked',
  ].sort());
  assert.equal(r.project?.key, 'demo');
});

test('preflight: run without a plan, it says price countries went unchecked', async () => {
  // The live run that found this said "Preflight passed" on a project whose
  // country list would go on to reject eight of fifteen prices. Price
  // countries exist only in the plan, so without one the check cannot run —
  // and a check that cannot run has to say so, not pass quietly.
  const { clients } = fakeClients();
  const r = await preflight(clients, config(), undefined);
  const d = r.diagnostics.find((x) => x.code === 'price-countries-unchecked');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /the config does not declare them/);

  // With a plan the warning is gone: it is about absent information, not
  // about the project. (The plan fixture carries a currency this fake project
  // does not accept, which is a different finding and not this test's.)
  const withPlan = await preflight(clients, config(), plan());
  assert.ok(!withPlan.diagnostics.some((x) => x.code === 'price-countries-unchecked'));
});

test('preflight: an unset catalog model means Classic, not a mismatch', async () => {
  const project = { ...PROJECT };
  delete project.productCatalogModel;
  assert.equal(effectiveCatalogModel(project), 'Classic');

  const { clients } = fakeClients({ project: { productCatalogModel: undefined } });
  const r = await preflight(clients, config(), undefined);
  assert.ok(
    !r.diagnostics.some((d) => d.code === 'catalog-model-mismatch'),
    'projects predating the setting must not be reported as mismatched',
  );
});

test('preflight: a Modular project against a Classic plan is a mismatch', async () => {
  // Preflight is the only stage that can find this out — the catalog model is a
  // project fact, and nothing offline can infer it. Both models are supported
  // now, so this is a genuine mismatch: the plan was built in one shape and
  // the project runs the other.
  const { clients } = fakeClients({ project: { productCatalogModel: 'Modular' } });
  const r = await preflight(clients, config(), undefined);
  const d = r.diagnostics.find((x) => x.code === 'catalog-model-mismatch');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  // Changing the config is necessary but not sufficient: the shape is decided
  // at map time, so the plan has to be rebuilt.
  assert.match(d.message, /re-run `plan`/);
  assert.match(d.message, /changing the config alone is not enough/);
  assert.doesNotMatch(d.message, /which this pipeline does not emit/);
});

test('preflight: a Modular project against a Modular plan passes', async () => {
  const { clients } = fakeClients({ project: { productCatalogModel: 'Modular' } });
  const { config: modular } = loadConfig(
    resolve(ROOT, 'fixtures', 'modular-standalone', 'migration.config.json'),
  );
  const r = await preflight(clients, modular, undefined);
  assert.ok(
    !r.diagnostics.some((x) => x.code === 'catalog-model-mismatch'),
    'the model the project runs is the model the plan targets',
  );
});

test('preflight: missing locales and currencies are errors with a pending fix', async () => {
  const { clients } = fakeClients({ project: { languages: ['en-GB'], currencies: ['GBP'] } });
  const r = await preflight(clients, config(), undefined);
  assert.deepEqual(
    codes(r.diagnostics).filter((c) => c.endsWith('not-accepted')),
    ['currencies-not-accepted', 'locales-not-accepted'],
  );
  assert.deepEqual(r.pending.languages, ['de-DE']);
  assert.deepEqual(r.pending.currencies, ['EUR']);
  assert.equal(r.applied, false, 'nothing is changed without --apply');
});

test('preflight: a default locale the project rejects is called out separately', async () => {
  const { clients } = fakeClients({ project: { languages: ['de-DE'] } });
  const r = await preflight(clients, config(), undefined);
  const d = r.diagnostics.find((x) => x.code === 'default-locale-not-accepted');
  assert.ok(d);
  assert.match(d.message, /derived labels and slugs/i);
});

test('preflight: locales used only by the plan are still required', async () => {
  const { clients } = fakeClients({
    project: { languages: ['de-DE'], currencies: ['GBP', 'EUR'] },
  });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'locales-not-accepted');
  assert.ok(d, 'the plan carries en-GB even if the config looked satisfied');
  assert.match(d.message, /en-GB/);
});

test('preflight: a country the project does not list blocks, but is not fixed', async () => {
  // Was a warning, phrased as though the cost were degraded price selection.
  // The live load proved otherwise: the API refuses the price outright, as
  // validationFailed, so eight of fifteen prices died while the products and
  // categories landed — a partly priced catalog from a green preflight.
  const { clients } = fakeClients({ project: { countries: [] } });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'countries-not-listed');
  assert.ok(d);
  assert.equal(d.severity, 'error', 'the API rejects these prices; this is not advisory');
  assert.match(d.message, /not an allowed country code/);
  // Still not auto-fixed: the country list drives shipping and tax too.
  assert.match(d.message, /--apply will not add them/);
  assert.match(d.message, /shipping and tax/);
});

test('preflight: a populated project is flagged before anything is written', async () => {
  const { clients } = fakeClients({ counts: { products: 4212 } });
  const r = await preflight(clients, config(), undefined);
  const d = r.diagnostics.find((x) => x.code === 'project-not-empty');
  assert.ok(d, 'loading into the wrong project is a real hazard');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /4212/);
  assert.match(d.message, /mig-/, 'it should say why the load is still additive');
});

test('preflight: unreadable counts degrade to a warning', async () => {
  const { clients } = fakeClients({
    counts: { products: httpError(403, 'insufficient_scope') },
  });
  const r = await preflight(clients, config(), undefined);
  const d = r.diagnostics.find((x) => x.code === 'counts-unavailable');
  assert.ok(d);
  assert.match(d.message, /manage_products/, 'the scope hint should survive');
  assert.ok(
    !r.diagnostics.some((x) => x.severity === 'error'),
    'a missing product scope must not block a project-settings preflight',
  );
});

test('preflight: an unreachable project reports once and stops', async () => {
  const { clients } = fakeClients({ projectError: httpError(404, 'not found') });
  const r = await preflight(clients, config(), undefined);
  assert.deepEqual(codes(r.diagnostics), ['project-unreachable']);
  assert.equal(r.project, undefined);
  assert.match(r.diagnostics[0].message, /project key and the region host/);
});

// ---------------------------------------------------------------------------
// Applying, which is where a mistake would be destructive
// ---------------------------------------------------------------------------

test('apply: the update sends the union, never only the missing values', async () => {
  const { clients, recorded } = fakeClients({
    project: { languages: ['en-GB'], currencies: ['GBP'] },
  });
  const r = await preflight(clients, config(), undefined, { apply: true });

  assert.equal(recorded.updates.length, 1);
  const update = recorded.updates[0];
  assert.equal(update.version, 7, 'the version must come from the read');

  const languages = update.actions.find((a) => a.action === 'changeLanguages');
  const currencies = update.actions.find((a) => a.action === 'changeCurrencies');
  assert.ok(languages && 'languages' in languages);
  assert.ok(currencies && 'currencies' in currencies);

  // changeLanguages REPLACES the array. Sending ['de-DE'] alone would delete
  // en-GB from the project.
  assert.deepEqual([...languages.languages].sort(), ['de-DE', 'en-GB']);
  assert.deepEqual([...currencies.currencies].sort(), ['EUR', 'GBP']);
  assert.equal(r.applied, true);
});

test('apply: findings the apply resolved are not still reported as errors', async () => {
  // Found on the first real --apply run: the checks had already run against
  // the project as it was found, so a successful apply left three errors
  // behind — each advising `--apply`, which had just happened — and the
  // command exited non-zero after doing exactly what was asked.
  const { clients } = fakeClients({ project: { languages: ['de-DE'], currencies: ['EUR'] } });

  const before = await preflight(clients, config(), undefined);
  assert.ok(
    before.diagnostics.some((d) => d.code === 'locales-not-accepted'),
    'without --apply the findings must still be reported',
  );

  const after = await preflight(clients, config(), undefined, { apply: true });
  assert.equal(after.applied, true);
  for (const code of [
    'locales-not-accepted',
    'currencies-not-accepted',
    'default-locale-not-accepted',
  ]) {
    assert.ok(
      !after.diagnostics.some((d) => d.code === code),
      `${code} survived an apply that fixed it`,
    );
  }
  assert.equal(
    after.diagnostics.filter((d) => d.severity === 'error').length,
    0,
    'a successful apply has to leave a passing preflight',
  );
  assert.ok(
    after.diagnostics.some((d) => d.code === 'project-updated'),
    'what changed still has to be reported',
  );
});

test('apply: a finding the apply does not address survives it', async () => {
  // The filter is a fixed list, not "clear everything": an apply adds
  // languages and currencies and nothing else.
  const { clients } = fakeClients({
    project: { languages: ['de-DE'], currencies: ['EUR'], productCatalogModel: 'Modular' },
  });
  const r = await preflight(clients, config(), undefined, { apply: true });
  assert.ok(
    r.diagnostics.some((d) => d.code === 'catalog-model-mismatch'),
    'the catalog model is not something --apply touches',
  );
});

test('apply: a 409 refetches and retries with the fresh version', async () => {
  const { clients, recorded } = fakeClients({
    project: { languages: ['en-GB'] },
    updateError: httpError(409, 'version mismatch'),
  });
  const r = await preflight(clients, config(), undefined, { apply: true });

  assert.equal(r.applied, true);
  assert.equal(recorded.updates.length, 2);
  assert.equal(recorded.updates[0].version, 7);
  assert.equal(
    recorded.updates[1].version,
    9,
    'the retry must use the freshly fetched version, never the one that failed',
  );
});

test('apply: a missing manage scope is reported, not swallowed', async () => {
  const { clients } = fakeClients({
    project: { languages: ['en-GB'] },
    updateError: httpError(403, 'insufficient_scope'),
  });
  const r = await preflight(clients, config(), undefined, { apply: true });
  const d = r.diagnostics.find((x) => x.code === 'project-update-failed');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /manage_project_settings/);
  assert.equal(r.applied, false);
});

test('apply: nothing is sent when there is nothing to add', async () => {
  const { clients, recorded } = fakeClients();
  const r = await preflight(clients, config(), undefined, { apply: true });
  assert.equal(recorded.updates.length, 0, 'a satisfied project must not be written to');
  assert.equal(r.applied, false);
});

// ---------------------------------------------------------------------------
// Building the clients
//
// These exist because `createClients` had no coverage at all: every other test
// in this suite hand-builds a fake `Clients`, which skips the factory
// entirely. The first real API call found a TypeError thrown before any
// request left the process — `withUserAgentMiddleware()` called bare, which
// the builder's types declare as optional and the middleware then
// dereferences. An injected httpClient exercises the whole construction with
// no network, so there is no excuse for that gap.
// ---------------------------------------------------------------------------

/** Records every request and answers the token call, so no network is needed. */
function recordingHttpClient() {
  const calls: { url: string; headers: Record<string, string>; method?: string }[] = [];
  const httpClient = async (url: string, options?: { headers?: Record<string, string>; method?: string }) => {
    calls.push({ url: String(url), headers: options?.headers ?? {}, method: options?.method });
    if (String(url).includes('/oauth/token')) {
      return { data: { access_token: 't', expires_in: 3600, scope: 's' }, status: 200 };
    }
    return { data: { key: 'p', name: 'Probe', version: 1 }, status: 200 };
  };
  return { calls, httpClient };
}

const TRIAL_CREDENTIALS = {
  projectKey: 'p',
  clientId: 'i',
  clientSecret: 's',
  authUrl: 'https://auth.test',
  apiUrl: 'https://api.test',
  importUrl: 'https://import.test',
};

test('clients: a request can actually be executed, middleware and all', async () => {
  const { calls, httpClient } = recordingHttpClient();
  const clients = createClients(TRIAL_CREDENTIALS, { httpClient });

  const res = await clients.platform.get().execute();
  assert.equal(res.body.name, 'Probe', 'the whole middleware stack has to survive a call');

  assert.ok(
    calls.some((c) => c.url.includes('/oauth/token')),
    'the client-credentials flow should fetch a token first',
  );
  assert.ok(calls.some((c) => c.url === 'https://api.test/p'), 'then call the project');
});

test('clients: every request carries a User-Agent naming this pipeline', async () => {
  // The bug was not a missing header — it was a TypeError on the first
  // request, thrown inside the middleware, nowhere near the factory. Asserting
  // the header is what pins the fix: passing `{}` would satisfy the types and
  // still produce 'undefined/...' here.
  const { calls, httpClient } = recordingHttpClient();
  await createClients(TRIAL_CREDENTIALS, { httpClient }).platform.get().execute();

  assert.ok(calls.length > 0);
  for (const call of calls) {
    const ua = call.headers['User-Agent'];
    assert.ok(ua, `no User-Agent on ${call.url}`);
    assert.match(ua, /^ct-catalog-migration-pipeline\//);
    assert.doesNotMatch(ua, /undefined/, 'an unnamed agent is how the TypeError got in');
  }
});

test('clients: the two roots are scoped to different hosts', async () => {
  // The platform root uses withProjectKey and the Import API root uses
  // withProjectKeyValue, and they are on different hosts. Getting either wrong
  // is invisible until a request is made.
  const { calls, httpClient } = recordingHttpClient();
  const clients = createClients(TRIAL_CREDENTIALS, { httpClient });

  await clients.platform.get().execute();
  await clients.importApi.importContainers().get().execute();

  assert.ok(calls.some((c) => c.url === 'https://api.test/p'));
  assert.ok(
    calls.some((c) => c.url.startsWith('https://import.test/p')),
    'the Import API must not be called on the HTTP API host',
  );
});

test('preflight: standalone prices are counted when gathering what the plan needs', async () => {
  // The defect the live load exposed. Standalone prices are not inside the
  // variants, so walking products alone found no countries at all — the
  // country check was correct and was handed an empty set, so preflight
  // passed and the load then rejected every GB-scoped price.
  const { clients } = fakeClients({ project: { countries: ['DE'], currencies: ['EUR'] } });

  const embedded = plan();
  const standalone = {
    ...embedded,
    // Prices moved out of the variants, exactly as priceMode 'standalone' does.
    products: embedded.products.map((p) => ({
      ...p,
      masterVariant: p.masterVariant ? { ...p.masterVariant, prices: [] } : undefined,
      variants: (p.variants ?? []).map((v) => ({ ...v, prices: [] })),
    })),
    standalonePrices: [
      {
        key: 'mig-X-GBP-GB',
        sku: 'X',
        value: { type: 'centPrecision' as const, currencyCode: 'GBP', centAmount: 100, fractionDigits: 2 },
        country: 'GB',
      },
    ],
  };

  const r = await preflight(clients, config(), standalone);
  const country = r.diagnostics.find((d) => d.code === 'countries-not-listed');
  assert.ok(country, 'a standalone price scoped to an unlisted country has to be caught');
  assert.match(country.message, /\[GB\]/);

  const currency = r.diagnostics.find((d) => d.code === 'currencies-not-accepted');
  assert.ok(currency, 'and its currency too — the same walk collects both');
  assert.match(currency.message, /GBP/);
});

test('preflight: a missing view_project_settings degrades, it does not stop', () => {
  // Found by a dogfood engagement whose API Client had every load and verify
  // scope but not this one: preflight reported `project-unreachable` and
  // checked nothing at all, and the operator had to introspect the token
  // against the auth endpoint to work out what the client could actually do.
  return (async () => {
    const { clients, recorded } = fakeClients({
      projectError: Object.assign(
        new Error('Insufficient scope. One of the following scopes is missing: view_project_settings.'),
        { statusCode: 403 },
      ),
      counts: { products: 17 },
    });

    const r = await preflight(clients, config(), plan());

    const d = r.diagnostics.find((x) => x.code === 'project-settings-unreadable');
    assert.ok(d, 'a scope problem is not an unreachable project');
    assert.equal(d.severity, 'error');
    assert.match(d.message, /scope problem, not an unreachable project/);
    assert.match(d.message, /going in blind/);
    assert.ok(
      !r.diagnostics.some((x) => x.code === 'project-unreachable'),
      'the misleading code must not also fire',
    );

    // The counts check needs only view_products, so it still runs — it is the
    // one that catches a load aimed at the wrong project.
    assert.equal(r.counts?.products, 17, 'what could still be checked, was');
    assert.ok(recorded.countReads > 0);
  })();
});

test('preflight: a genuinely unreachable project still reports as such', () => {
  return (async () => {
    const { clients } = fakeClients({
      projectError: Object.assign(new Error('socket hang up'), { statusCode: 503 }),
    });
    const r = await preflight(clients, config(), plan());
    assert.ok(r.diagnostics.some((x) => x.code === 'project-unreachable'));
    assert.ok(!r.diagnostics.some((x) => x.code === 'project-settings-unreadable'));
    assert.equal(r.counts, undefined, 'no point counting against a dead project');
  })();
});

// ---------------------------------------------------------------------------
// Prerequisites the pipeline cannot create
// ---------------------------------------------------------------------------

/** A plan whose prices reference one channel and one customer group. */
function planWithPrerequisites() {
  const base = plan();
  return {
    ...base,
    prerequisites: {
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }],
      customerGroups: [{ key: 'trade', name: 'Trade' }],
      stores: [],
    },
  };
}

test('prerequisites: a channel the project lacks is advance notice, not a block', () => {
  // It was an error until `load` could create them. Blocking here would refuse
  // a load that fixes the problem — so it is a warning that says what will
  // happen, and names the scope and the typo risk.
  return (async () => {
    const { clients } = fakeClients({ channels: [], customerGroups: [{ key: 'trade' }] });
    const r = await preflight(clients, config(), planWithPrerequisites());

    const d = r.diagnostics.find((x) => x.code === 'channel-will-be-created');
    assert.ok(d);
    assert.equal(d.severity, 'warning', 'load creates it; refusing here would be wrong');
    assert.match(d.message, /no channel with key 'retail-uk'/);
    assert.match(d.message, /roles \[ProductDistribution\]/);
    assert.match(d.message, /needs manage_products/);
    // The genuinely useful warning: a typo silently creates a second channel.
    assert.match(d.message, /typo here creates a second channel/);
    // Scoped to prerequisites: this fake project also rejects one of the
    // plan's currencies, which is a different finding and not this test's.
    assert.deepEqual(
      r.diagnostics
        .filter((x) => x.severity === 'error')
        .map((x) => x.code)
        .filter((c) => c.includes('channel') || c.includes('customer-group')),
      [],
      'nothing about a creatable prerequisite should block',
    );
  })();
});

test('prerequisites: a channel present but under-rolled is caught', () => {
  return (async () => {
    const { clients } = fakeClients({
      channels: [{ key: 'retail-uk', roles: ['InventorySupply'] }],
      customerGroups: [{ key: 'trade' }],
    });
    const r = await preflight(clients, config(), planWithPrerequisites());
    const d = r.diagnostics.find((x) => x.code === 'channel-roles-insufficient');
    assert.ok(d, 'existing is not the same as usable');
    assert.match(d.message, /missing \[ProductDistribution\]/);
  })();
});

test('prerequisites: a missing customer group is advance notice too', () => {
  return (async () => {
    const { clients } = fakeClients({
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution'] }],
      customerGroups: [],
    });
    const r = await preflight(clients, config(), planWithPrerequisites());
    const d = r.diagnostics.find((x) => x.code === 'customer-group-will-be-created');
    assert.ok(d);
    assert.equal(d.severity, 'warning');
    // A different scope from channels, and manage_products does not grant it.
    assert.match(d.message, /manage_customer_groups/);
  })();
});

test('prerequisites: everything present reports nothing', () => {
  return (async () => {
    const { clients } = fakeClients({
      channels: [{ key: 'retail-uk', roles: ['ProductDistribution', 'Primary'] }],
      customerGroups: [{ key: 'trade' }],
    });
    const r = await preflight(clients, config(), planWithPrerequisites());
    for (const code of [
      'channel-will-be-created',
      'channel-roles-insufficient',
      'customer-group-will-be-created',
      'prerequisites-unchecked',
    ]) {
      assert.ok(!r.diagnostics.some((x) => x.code === code), `${code} should not fire`);
    }
  })();
});

test('prerequisites: an unreadable channel list is an error, not silence', () => {
  // A missing view scope and an empty project are the same observation
  // otherwise, and this one decides whether prices survive.
  return (async () => {
    const { clients } = fakeClients({
      channels: Object.assign(new Error('Insufficient scope'), { statusCode: 403 }),
    });
    const r = await preflight(clients, config(), planWithPrerequisites());
    const d = r.diagnostics.find((x) => x.code === 'prerequisites-unreadable');
    assert.ok(d);
    assert.match(d.message, /could not be verified/);
    assert.ok(
      !r.diagnostics.some((x) => x.code === 'channel-will-be-created'),
      'unreadable must not be reported as absent — that would create a duplicate',
    );
  })();
});

// ---------------------------------------------------------------------------
// Attribute types, project-wide
//
// The live load that prompted these: the project's `apparel-basic` held
// `material` as ltext, the plan declared it text, and the ProductType came
// back AttributeDefinitionTypeConflict with the product then failing
// AttributeNameDoesNotExist. All of it knowable from a read preflight already
// had the scope for.
// ---------------------------------------------------------------------------

test('attribute types: a conflicting type on an unrelated ProductType is an error', async () => {
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'apparel-basic', name: 'Apparel (basic)', attributes: [
        { name: 'material', type: { name: 'ltext' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());

  const d = r.diagnostics.find((x) => x.code === 'attribute-type-conflict');
  assert.ok(d, 'the conflict must be caught before the load');
  assert.equal(d.severity, 'error');
  assert.match(d.message, /'material' is ltext on the project's ProductType 'apparel-basic'/);
  assert.match(d.message, /plan defines it as text on 'mig-pt-main'/);
  assert.match(d.message, /AttributeDefinitionTypeConflict/);
  // The remedy for an unrelated ProductType is to rename or match, not to
  // recreate anything.
  assert.match(d.message, /different attribute name/);
});

test('attribute types: agreeing types produce no finding', async () => {
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'other', name: 'Other', attributes: [
        { name: 'material', type: { name: 'text' }, isSearchable: true },
        { name: 'weight', type: { name: 'number' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'attribute-type-conflict'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'attribute-searchable-conflict'));
});

test('attribute types: an attribute the plan never defines is ignored', async () => {
  // The project is allowed to hold anything it likes under names the migration
  // does not touch. Reporting those would make the check unusable on a
  // populated project.
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'other', name: 'Other', attributes: [
        { name: 'somethingElse', type: { name: 'boolean' }, isSearchable: false },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'attribute-type-conflict'));
});

test('attribute types: enum values may differ, the type may not', async () => {
  // The documentation's own example gives `Color` a different value set on
  // Jeans than on T-Shirt, so values are not part of a type's identity.
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'other', name: 'Other', attributes: [
        { name: 'colour', type: { name: 'enum' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  assert.ok(
    !r.diagnostics.some((x) => x.code === 'attribute-type-conflict'),
    'a differing value set is not a type conflict',
  );
});

test('attribute types: a set of text differs from plain text', async () => {
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'other', name: 'Other', attributes: [
        { name: 'material', type: { name: 'set', elementType: { name: 'text' } }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'attribute-type-conflict');
  assert.ok(d, 'set<text> and text are different types');
  assert.match(d.message, /set<text>/);
});

test('attribute types: a conflict on a ProductType the plan itself loads says so', async () => {
  // Different remedy: there is no update action that changes an attribute's
  // type, so this one cannot be fixed by editing the plan.
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'mig-pt-main', name: 'Main', attributes: [
        { name: 'material', type: { name: 'ltext' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'attribute-type-conflict')!;
  assert.match(d.message, /same ProductType the plan loads/);
  assert.match(d.message, /deletes the values on every existing product/);
});

test('attribute types: a matching type with a differing isSearchable warns', async () => {
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'other', name: 'Other', attributes: [
        { name: 'material', type: { name: 'text' }, isSearchable: false },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'attribute-searchable-conflict');
  assert.ok(d, 'silently losing every facet on the name is worth a warning');
  assert.equal(d.severity, 'warning', 'the load still succeeds');
  assert.match(d.message, /unavailable for search, filters and facets/);
});

test('attribute types: an unreadable ProductType list degrades to a warning', async () => {
  const { clients } = fakeClients({
    existingProductTypes: httpError(403, 'Insufficient scope'),
  });
  const r = await preflight(clients, config(), plan());
  const d = r.diagnostics.find((x) => x.code === 'attribute-types-unreadable');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /view_products/);
  assert.ok(!r.diagnostics.some((x) => x.code === 'attribute-type-conflict'));
});

test('attribute types: they are checked even when project settings are unreadable', async () => {
  // Reading ProductTypes needs view_products, not view_project_settings — the
  // same argument that keeps the resource counts running on this path.
  const { clients, recorded } = fakeClients({
    projectError: httpError(403, 'Insufficient scope: view_project_settings'),
    existingProductTypes: [
      { key: 'apparel-basic', name: 'Apparel (basic)', attributes: [
        { name: 'material', type: { name: 'ltext' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());

  assert.ok(r.diagnostics.some((x) => x.code === 'project-settings-unreadable'));
  assert.ok(recorded.productTypeReads > 0, 'the read should still be attempted');
  assert.ok(
    r.diagnostics.some((x) => x.code === 'attribute-type-conflict'),
    'a degraded preflight should still catch what it can',
  );
});

test('attribute types: the full read is paginated, not truncated', async () => {
  const many = Array.from({ length: 501 }, (_, i) => ({
    key: `pt-${i}`,
    name: `PT ${i}`,
    attributes: i === 500
      ? [{ name: 'material', type: { name: 'ltext' }, isSearchable: true }]
      : [],
  }));
  const { clients, recorded } = fakeClients({ existingProductTypes: many });
  const r = await preflight(clients, config(), plan());
  assert.equal(recorded.productTypeReads, 2, 'a second page must actually be fetched');
  assert.ok(
    r.diagnostics.some((x) => x.code === 'attribute-type-conflict'),
    'a conflict past the first page must still be found',
  );
});

test('product-type keys: a pre-prefix load is flagged, with its real consequence', async () => {
  // ProductType keys used to be emitted verbatim, so a project loaded before
  // that fix holds `pt-main` where the plan now says `mig-pt-main`. The load
  // would create the new ProductType and then be unable to move the existing
  // products onto it.
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'pt-main', name: 'Main', attributes: [
        { name: 'material', type: { name: 'text' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());

  const d = r.diagnostics.find((x) => x.code === 'product-type-keys-unprefixed');
  assert.ok(d, 'silently creating a second ProductType is the worst outcome here');
  assert.equal(d.severity, 'warning', 'an empty or already-migrated project is the normal case');
  assert.match(d.message, /'pt-main' \(plan wants 'mig-pt-main'\)/);
  assert.match(d.message, /cannot be changed after creation/);
});

test('product-type keys: a project already holding the prefixed key says nothing', async () => {
  const { clients } = fakeClients({
    existingProductTypes: [
      { key: 'mig-pt-main', name: 'Main', attributes: [
        { name: 'material', type: { name: 'text' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'product-type-keys-unprefixed'));
});

test('product-type keys: an empty project says nothing', async () => {
  const { clients } = fakeClients({ existingProductTypes: [] });
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'product-type-keys-unprefixed'));
});

test('product-type keys: an unrelated ProductType is not mistaken for a stale one', async () => {
  // Only a key that is exactly the plan's key minus the prefix counts.
  const { clients } = fakeClients({
    existingProductTypes: [{ key: 'something-else', name: 'Else', attributes: [] }],
  });
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'product-type-keys-unprefixed'));
});

test('product-type keys: the ProductTypes are read once for both checks', async () => {
  // Two unrelated questions share one list; reading it twice would be a
  // wasted round trip on every preflight.
  const { clients, recorded } = fakeClients({
    existingProductTypes: [
      { key: 'pt-main', name: 'Main', attributes: [
        { name: 'material', type: { name: 'ltext' }, isSearchable: true },
      ] },
    ],
  });
  const r = await preflight(clients, config(), plan());
  assert.equal(recorded.productTypeReads, 1);
  // And both findings come out of it.
  assert.ok(r.diagnostics.some((x) => x.code === 'attribute-type-conflict'));
  assert.ok(r.diagnostics.some((x) => x.code === 'product-type-keys-unprefixed'));
});

// ---------------------------------------------------------------------------
// Stores and product selections
//
// A selection's mode is immutable — the update actions are setKey, changeName,
// add/exclude/remove product and the variant setters, and there is no
// changeMode — so a mode that already differs in the project cannot be fixed
// by importing over it. That makes this the same class of finding as
// attribute-type-conflict: knowable from a read, fatal if missed.
// ---------------------------------------------------------------------------

test('selections: an existing selection with the opposite mode is an error', () => {
  const { clients } = fakeClients({
    existingSelections: [{ key: 'mig-uk-assortment', mode: 'IndividualExclusion' }],
    existingStores: [],
  });
  return preflight(clients, config(), storePlan()).then((r) => {
    const d = r.diagnostics.find((x) => x.code === 'product-selection-mode-conflict');
    assert.ok(d, 'importing the opposite mode inverts the whole assortment');
    assert.equal(d.severity, 'error');
    assert.match(d.message, /no changeMode action/);
    assert.match(d.message, /invert the assortment/);
  });
});

test('selections: a matching mode is silent', async () => {
  const { clients } = fakeClients({
    existingSelections: [{ key: 'mig-uk-assortment', mode: 'Individual' }],
    existingStores: [{ key: 'northwind-uk', productSelections: [{}] }],
  });
  const r = await preflight(clients, config(), storePlan());
  assert.ok(!r.diagnostics.some((x) => x.code === 'product-selection-mode-conflict'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'store-wiring-differs'));
});

test('selections: an absent one warns that the permanent mode is about to be set', async () => {
  const { clients } = fakeClients({ existingSelections: [], existingStores: [] });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'product-selection-will-be-created');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /permanent/);
});

test('stores: an existing store whose wiring differs is an error before the load', async () => {
  // `load` will not modify an existing store, so without this the difference
  // only surfaces after the catalog has landed.
  const { clients } = fakeClients({
    existingSelections: [{ key: 'mig-uk-assortment', mode: 'Individual' }],
    existingStores: [{ key: 'northwind-uk', productSelections: [] }],
  });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'store-wiring-differs');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /replaces the whole array/);
});

test('stores: an absent store warns that it is created after the imports', async () => {
  const { clients } = fakeClients({ existingSelections: [], existingStores: [] });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'store-will-be-created');
  assert.ok(d);
  assert.match(d.message, /after the import stages/);
});

test('stores: a language the project does not accept is refused', async () => {
  // The store fixture declares en-GB; this project does not list it.
  const { clients } = fakeClients({
    project: { languages: ['de-DE'], countries: ['DE'] },
    existingSelections: [],
    existingStores: [],
  });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'store-locales-not-accepted');
  assert.ok(d);
  assert.match(d.message, /must be a subset/);
});

test('stores: a country the project does not list is refused, and --apply will not add it', async () => {
  const { clients } = fakeClients({
    project: { languages: ['en-GB', 'de-DE'], countries: ['DE'] },
    existingSelections: [],
    existingStores: [],
  });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'store-countries-not-accepted');
  assert.ok(d);
  assert.match(d.message, /drives shipping\s+and tax|drives shipping and tax/);
});

test('stores: an unreadable selection list degrades to a warning', async () => {
  const { clients } = fakeClients({
    existingSelections: httpError(403, 'Insufficient scope'),
    existingStores: [],
  });
  const r = await preflight(clients, config(), storePlan());
  const d = r.diagnostics.find((x) => x.code === 'product-selections-unreadable');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /view_product_selections/);
  assert.match(d.message, /cannot be changed afterwards/);
});

test('stores: a plan with neither stores nor selections reads nothing', async () => {
  // The two endpoints must not be called when the feed declares none, or every
  // preflight pays for a feature most engagements do not use.
  const { clients } = fakeClients();
  const r = await preflight(clients, config(), plan());
  assert.ok(!r.diagnostics.some((x) => x.code.startsWith('store')));
  assert.ok(!r.diagnostics.some((x) => x.code.startsWith('product-selection')));
});
