/**
 * Contract regression tests.
 *
 * Each fixture asserts the exact set of diagnostic codes the validator should
 * produce. Asserting the set rather than a count means a check that silently
 * stops firing fails the suite, which is the failure mode that matters: a
 * validator that quietly passes everything looks identical to a clean feed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed, hasErrors } from '../src/contract/validate.js';
import { loadConfig, outDirFor, type PipelineConfig } from '../src/model/config.js';
import { requiredCatalogModel } from '../src/model/limits.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { importStages, platformStages, type PriceDraftImport } from '../src/model/plan.js';


/**
 * Walk up to the package root rather than assuming a fixed depth: this file is
 * compiled into dist-test/test/, so a relative '..' would land in the build
 * output and every fixture path would silently miss.
 */
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

function run(fixture: string) {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
  );
  return { config, ...validateFeed(feedDir, SCHEMA, config) };
}

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

test('declared-types: a well-formed feed produces no diagnostics at all', () => {
  const r = run('declared-types');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.rejected, 0);
  assert.equal(hasErrors(r.diagnostics), false);
  assert.equal(r.feed.categories.size, 4);
  assert.equal(r.feed.products.size, 3);
  assert.equal(r.feed.variants.size, 7);
  assert.equal(r.feed.attributeDefinitions.size, 5);
});

test('declared-types: the single-variant product needs no axes', () => {
  const r = run('declared-types');
  const cap = r.feed.products.get('CAP-LOGO');
  assert.ok(cap, 'CAP-LOGO should be indexed');
  assert.equal(cap.axes, undefined);
  assert.deepEqual(r.feed.variantsByProduct.get('CAP-LOGO'), ['CAP-LOGO-OS']);
});

test('inferred-types: a feed with no declarations is still valid', () => {
  const r = run('inferred-types');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.feed.attributeDefinitions.size, 0);
  // Undeclared-attribute checks must not fire when there is nothing declared:
  // inference derives the definitions from exactly these values.
  assert.equal(hasErrors(r.diagnostics), false);
});

test('broken-schema: parse and schema defects are caught, integrity is deferred', () => {
  const r = run('broken-schema');
  assert.deepEqual(codes(r.diagnostics), [
    'duplicate-record',
    'malformed-json',
    'schema-violation',
  ]);
  assert.equal(r.rejected, 3);
  assert.equal(hasErrors(r.diagnostics), true);

  // The readable-message fix: a bad locale tag must not report failures against
  // every branch of the schema's oneOf.
  const localeError = r.diagnostics.find(
    (d) => d.code === 'schema-violation' && d.message.includes('property name must be valid'),
  );
  assert.ok(localeError, 'underscore locale tag should be rejected');
  assert.ok(
    !localeError.message.includes("required property 'sku'"),
    'error should be narrowed to the product branch, not report variant-branch failures',
  );

  const floatError = r.diagnostics.find((d) => d.message.includes('/prices/0/amount'));
  assert.ok(floatError, 'a float amount should be rejected');
  assert.match(floatError.message, /must be string/);
});

test('broken-integrity: every catalog-wide check fires', () => {
  const r = run('broken-integrity');
  assert.equal(r.rejected, 0, 'fixture must be schema-clean so integrity runs');
  assert.deepEqual(codes(r.diagnostics), [
    'attribute-level-mismatch',
    'attribute-never-populated',
    'attribute-undeclared',
    'axes-missing',
    'axis-at-product-level',
    'axis-combination-duplicate',
    'axis-localized',
    'axis-value-missing',
    'category-cycle',
    'duplicate-record',
    'missing-category',
    'missing-parent',
    'multiple-master-variants',
    'orphan-variant',
    'product-without-variants',
  ]);
});

test('broken-integrity: an axis declared at product level is a contradiction', () => {
  // 'product' level means invariant across variants; an axis is what makes them
  // differ. The schema documents the rule but cannot express it, and derive
  // silently resolves the pair in favour of the axis — so unreported, the
  // declaration and the resulting ProductType would disagree.
  const r = run('broken-integrity');
  const d = r.diagnostics.find((x) => x.code === 'axis-at-product-level');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /brandLine/);
});

test('broken-integrity: the localized-axis check names the offending axis', () => {
  const r = run('broken-integrity');
  const d = r.diagnostics.find((x) => x.code === 'axis-localized');
  assert.ok(d);
  assert.match(d.message, /colourName/);
  assert.equal(d.severity, 'error');
});

test('broken-integrity: a duplicated axis combination is an error, not a warning', () => {
  const r = run('broken-integrity');
  const d = r.diagnostics.find((x) => x.code === 'axis-combination-duplicate');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /COLLAPSED-M-1/);
  assert.match(d.message, /COLLAPSED-M-2/);
});

test('every diagnostic carries a file and line', () => {
  for (const fixture of ['broken-schema', 'broken-integrity']) {
    const r = run(fixture);
    for (const d of r.diagnostics) {
      assert.ok(d.file, `${fixture}: ${d.code} has no file`);
      assert.ok(
        typeof d.line === 'number' && d.line > 0,
        `${fixture}: ${d.code} has no usable line`,
      );
    }
  }
});

test('config: Modular with embedded prices is refused', () => {
  // Modular has no embedded prices at all — the project's price mode is fixed
  // to Standalone and a VariantImport has no price field — so this pair cannot
  // be honoured whatever the pipeline does.
  assert.throws(
    () => loadConfig(resolve(ROOT, 'fixtures', 'invalid-config', 'modular-embedded.json')),
    /does not support Embedded Prices at all/,
  );
});

test('config: Modular with standalone prices is accepted', () => {
  const { config } = loadConfig(
    resolve(ROOT, 'fixtures', 'modular-standalone', 'migration.config.json'),
  );
  assert.equal(config.target.catalogModel, 'Modular');
  assert.equal(config.target.priceMode, 'standalone');
});

test('config: standalone prices on a Classic project are accepted', () => {
  // Standalone pricing is a Classic-compatible choice, and refusing Modular
  // must not take it away: it is the whole reason a Classic project would ask
  // for StandalonePrice resources.
  const { config } = loadConfig(
    resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json'),
  );
  assert.equal(config.target.catalogModel, 'Classic');
  assert.equal(config.target.priceMode, 'standalone');
});

test('config: a currency with no fractionDigits entry is refused', () => {
  assert.throws(
    () => loadConfig(resolve(ROOT, 'fixtures', 'invalid-config', 'missing-fraction-digits.json')),
    /currencyFractionDigits has no entry for 'JPY'/,
  );
});

test('config: a batch size above the Import API limit is refused', () => {
  assert.throws(
    () => loadConfig(resolve(ROOT, 'fixtures', 'invalid-config', 'oversized-batch.json')),
    /at most 20 resources per request/,
  );
});

// ---------------------------------------------------------------------------
// The shipped template, and the decisions it holds
//
// These drive the real template file rather than a fixture copy, so it cannot
// drift out of sync with the loader that validates it.
// ---------------------------------------------------------------------------

const TEMPLATE = resolve(ROOT, 'migration.config.json');

/** The template with `mutate` applied, written somewhere loadConfig can read. */
function fromTemplate(mutate: (c: PipelineConfig) => void) {
  const config = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as PipelineConfig;
  mutate(config);
  const dir = mkdtempSync(join(tmpdir(), 'ct-config-'));
  const path = join(dir, 'migration.config.json');
  writeFileSync(path, JSON.stringify(config));
  return () => loadConfig(path);
}

test('template: the shipped file refuses to run unedited', () => {
  // A template that ran as-is would write REPLACE-ME-* keys into a real
  // project, and keys.prefix is exactly what bounds a teardown to its own work.
  assert.throws(() => loadConfig(TEMPLATE), /keys.prefix is still 'REPLACE-ME'/);
});

test('template: editing only the prefix is enough to make it valid', () => {
  // The other defaults have to be usable, or the refusal above just teaches
  // people to copy a fixture instead.
  const { config } = fromTemplate((c) => {
    c.keys.prefix = 'acme';
  })();
  assert.equal(config.target.catalogModel, 'Classic');
  assert.equal(config.target.priceMode, 'embedded');
  assert.equal(config.productTypes.productLevelStrategy, 'sameForAll');
});

test('template: a prefix with illegal characters is refused', () => {
  assert.throws(
    fromTemplate((c) => {
      c.keys.prefix = 'acme migration';
    }),
    /contains illegal characters/,
  );
});

test('decisions: an absent priceMode is refused, not defaulted', () => {
  // The silent one. Absent, the mapper writes standalone prices while the gate
  // expects embedded — caught, but by coincidence rather than design.
  assert.throws(
    fromTemplate((c) => {
      delete (c.target as Partial<PipelineConfig['target']>).priceMode;
    }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /target\.priceMode is undefined/);
      // The message has to carry the consequence, not just name the field:
      // this is the one wrong value that produces a green load.
      assert.match(message, /shows no\nprice at all/);
      return true;
    },
  );
});

test('decisions: a misspelled priceMode is refused', () => {
  assert.throws(
    fromTemplate((c) => {
      (c.target as { priceMode: string }).priceMode = 'Standalone';
    }),
    /target.priceMode is "Standalone"/,
  );
});

test('decisions: an absent productLevelStrategy is refused', () => {
  assert.throws(
    fromTemplate((c) => {
      delete (c.productTypes as Partial<PipelineConfig['productTypes']>)
        .productLevelStrategy;
    }),
    /productTypes.productLevelStrategy is undefined/,
  );
});

test('decisions: an absent onMissingDefinitions is refused', () => {
  assert.throws(
    fromTemplate((c) => {
      delete (c.productTypes as Partial<PipelineConfig['productTypes']>)
        .onMissingDefinitions;
    }),
    /cannot be changed afterwards/,
  );
});

test('decisions: a non-boolean searchableByDefault is refused', () => {
  // 'false' the string is truthy, so a JSON typo would silently flip the value.
  assert.throws(
    fromTemplate((c) => {
      (c.productTypes as { searchableByDefault: unknown }).searchableByDefault = 'false';
    }),
    /searchableByDefault is "false"/,
  );
});

test('decisions: an empty currency list is refused rather than crashing later', () => {
  assert.throws(
    fromTemplate((c) => {
      c.market.requiredCurrencies = [];
    }),
    /market.requiredCurrencies is missing or empty/,
  );
});

test('decisions: every fixture config satisfies the same checks', () => {
  // The fixtures are what people copy in practice, so they must not be a way
  // around the decisions the template enforces.
  for (const fixture of ['declared-types', 'classic-standalone', 'broken-integrity']) {
    const { config } = loadConfig(
      resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
    );
    assert.notEqual(config.keys.prefix, 'REPLACE-ME', fixture);
  }
});

// ---------------------------------------------------------------------------
// The feed against the config
//
// Not contract defects — the feed is valid — but validate is the earliest
// stage holding both, and the pipeline's rule is that a defect is reported by
// the earliest stage that can see it.
// ---------------------------------------------------------------------------

/** The declared-types feed, validated against a config the test controls. */
function validateWith(mutate: (c: PipelineConfig) => void) {
  const source = resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json');
  const config = JSON.parse(readFileSync(source, 'utf8')) as PipelineConfig;
  mutate(config);
  const dir = mkdtempSync(join(tmpdir(), 'ct-market-'));
  const path = join(dir, 'migration.config.json');
  config.feed.dir = resolve(ROOT, 'fixtures', 'declared-types', 'feed');
  writeFileSync(path, JSON.stringify(config));
  const loaded = loadConfig(path);
  return validateFeed(loaded.feedDir, SCHEMA, loaded.config);
}

test('market: a currency the config never describes fails at validate, not at plan', () => {
  // This used to survive validate and derive, then fail in `plan` once per
  // affected variant — the same defect two stages later, multiplied by the
  // size of the catalog.
  const r = validateWith((c) => {
    c.market.requiredCurrencies = ['GBP'];
    c.market.currencyFractionDigits = { GBP: 2 };
  });
  const found = r.diagnostics.filter((d) => d.code === 'currency-not-configured');
  assert.equal(found.length, 1, 'once per currency, not once per price');
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /Currency EUR appears on 7 price\(s\)/);
  assert.match(found[0].message, /is not in market.requiredCurrencies/);
  assert.match(found[0].message, /multiplies a 0-digit currency like JPY by 100/);
  assert.ok(found[0].file, 'a diagnostic without a line cannot be acted on');
  assert.ok((found[0].line ?? 0) > 0);
});

test('market: a declared currency with no digit count never reaches validate', () => {
  // The config loader owns that half, and catching it there is strictly better:
  // it needs no feed at all. So the feed check has only one condition, and this
  // records why — if the loader ever stops refusing it, the gap lands here.
  assert.throws(
    () =>
      validateWith((c) => {
        c.market.requiredCurrencies = ['GBP', 'EUR'];
        c.market.currencyFractionDigits = { GBP: 2 };
      }),
    /market.currencyFractionDigits has no entry for 'EUR'/,
  );
});

test('market: a fully described feed reports nothing', () => {
  const r = validateWith(() => {});
  assert.deepEqual(codes(r.diagnostics), [], 'the check must not fire on a clean feed');
});

test('market: an unconfigured currency is not reported twice over', () => {
  // The schema pass gates the integrity and config passes, so a feed that does
  // not parse must not also be told its currencies are wrong.
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'broken-schema', 'migration.config.json'),
  );
  const r = validateFeed(feedDir, SCHEMA, config);
  assert.ok(r.rejected > 0, 'the fixture has schema defects');
  assert.ok(!codes(r.diagnostics).includes('currency-not-configured'));
});

// ---------------------------------------------------------------------------
// Which catalog model the catalog needs
//
// Variant counts are the one project-level decision the feed can settle on its
// own, so validate answers it — with no credentials and before anything is
// derived or planned.
// ---------------------------------------------------------------------------

/**
 * A synthetic feed with one product of `variantCount` variants.
 *
 * Generated rather than committed: a 101-variant fixture is 100 lines of noise
 * to read and the only interesting thing about it is the count.
 */
function feedWithVariants(variantCount: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-variants-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);

  const lines = [
    {
      _type: 'attributeDefinition',
      name: 'code',
      type: 'text',
      level: 'variant',
      axis: true,
      label: { 'en-GB': 'Code' },
    },
    { _type: 'product', code: 'BIG', name: { 'en-GB': 'Wide range' }, axes: ['code'] },
    ...Array.from({ length: variantCount }, (_, i) => ({
      _type: 'variant',
      sku: `BIG-${i}`,
      product: 'BIG',
      axisValues: { code: `V${i}` },
    })),
  ];
  writeFileSync(join(feedDir, 'catalog.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n'));

  const source = resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json');
  const config = JSON.parse(readFileSync(source, 'utf8')) as PipelineConfig;
  config.feed.dir = feedDir;
  const configPath = join(dir, 'migration.config.json');
  writeFileSync(configPath, JSON.stringify(config));

  const loaded = loadConfig(configPath);
  return validateFeed(loaded.feedDir, SCHEMA, loaded.config);
}

test('model: a catalog past the Classic ceiling is told which model it needs', () => {
  const r = feedWithVariants(101);
  const d = r.diagnostics.find((x) => x.code === 'catalog-model-insufficient');
  assert.ok(d, 'the feed alone is enough to know this');
  assert.equal(d.severity, 'error');
  assert.match(d.message, /needs the Modular catalog model/);
  assert.match(d.message, /'BIG', has 101/);
  assert.match(d.message, /setProductCatalogModel action/);
  // Actionable now that the Modular path exists: the remedy is a config change
  // plus a re-plan, not a dead end. This assertion used to require the message
  // to say the pipeline could not load such a catalog at all — true when
  // written, false the moment Modular shipped. A message that outlives its own
  // code is worse than no message.
  assert.match(d.message, /Set target.catalogModel to 'Modular'/);
  assert.match(d.message, /changing the config alone is not enough/);
  assert.match(d.message, /forces target.priceMode to 'standalone'/);
  // And it still must not suggest reshaping the catalog to suit the tool.
  assert.match(d.message, /Splitting products to fit Classic is not the answer/);
  assert.ok(d.file, 'it has to point at the offending product');
});

test('model: exactly at the ceiling is still Classic', () => {
  const r = feedWithVariants(100);
  assert.ok(!codes(r.diagnostics).includes('catalog-model-insufficient'));
  assert.equal(requiredCatalogModel(100), 'Classic');
  assert.equal(requiredCatalogModel(101), 'Modular');
});

test('model: a range approaching the ceiling warns while the choice is still free', () => {
  const r = feedWithVariants(85);
  const d = r.diagnostics.find((x) => x.code === 'approaching-variant-limit');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /while the project is greenfield/);
  assert.ok(
    !codes(r.diagnostics).includes('catalog-model-insufficient'),
    'a catalog that fits must not be told to change model',
  );
});

test('model: a catalog well inside the limit is told nothing', () => {
  const r = feedWithVariants(4);
  assert.deepEqual(
    codes(r.diagnostics).filter((c) => c.includes('variant-limit') || c.includes('catalog-model')),
    [],
    'a recommendation nobody needs is noise',
  );
});

test('model: the real fixtures produce no model diagnostics', () => {
  for (const fixture of ['declared-types', 'classic-standalone', 'plan-edges']) {
    const r = run(fixture);
    assert.ok(!codes(r.diagnostics).includes('catalog-model-insufficient'), fixture);
    assert.ok(!codes(r.diagnostics).includes('approaching-variant-limit'), fixture);
  }
});

test('market: externalId on a product or variant warns, because it is dropped', () => {
  // Found by a dogfood engagement that set it on 90 variants as an ERP join
  // key and had to read `map/plan.ts` to discover it went nowhere. The
  // contract accepts it on categories, products and variants; only
  // `CategoryImport` has the field. Two of this repo's own fixtures set it,
  // which is to say the author believed it worked too.
  const dir = mkdtempSync(join(tmpdir(), 'ct-extid-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(
    join(feedDir, 'catalog.ndjson'),
    [
      { _type: 'product', code: 'P1', name: { 'en-GB': 'One' }, externalId: 'ERP-1' },
      { _type: 'variant', sku: 'P1-A', product: 'P1', externalId: 'ERP-1-A' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );

  const source = resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json');
  const config = JSON.parse(readFileSync(source, 'utf8')) as PipelineConfig;
  config.feed.dir = feedDir;
  config.productTypes.onMissingDefinitions = 'infer';
  const configPath = join(dir, 'migration.config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const loaded = loadConfig(configPath);

  const r = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  const found = r.diagnostics.filter((d) => d.code === 'external-id-not-mapped');
  assert.equal(found.length, 2, 'one per kind, not one per record');
  assert.equal(found[0].severity, 'warning');
  assert.ok(
    found.some((d) => /product\(s\) set externalId/.test(d.message)),
    'products reported',
  );
  assert.ok(
    found.some((d) => /variant\(s\) set externalId/.test(d.message)),
    'variants reported',
  );
  // The remedy matters more than the warning: an ERP join key has to become an
  // attribute if it is to survive at all.
  assert.match(found[0].message, /declare it as an attribute/);
});

test('market: a category externalId is not warned about, because it does map', () => {
  const r = run('declared-types');
  assert.ok(!codes(r.diagnostics).includes('external-id-not-mapped'));
  assert.equal(r.feed.categories.get('tops')?.externalId ?? 'tops', 'tops');
});

// ---------------------------------------------------------------------------
// Artefact location
// ---------------------------------------------------------------------------

test('--out follows the config, not the current directory', () => {
  // `feed.dir` has always resolved relative to the config file; `--out` used
  // to resolve relative to cwd. With the config beside the engagement and the
  // commands run from `pipeline/`, that wrote artefacts into the tool's own
  // directory — a dogfood run lost its first `derive` output that way.
  const engagement = resolve('/tmp/acme/migration.config.json');

  assert.equal(
    outDirFor({ out: 'out', config: engagement }),
    resolve('/tmp/acme/out'),
    'a relative --out belongs beside the config',
  );
  assert.equal(
    outDirFor({ out: 'artefacts/run-1', config: engagement }),
    resolve('/tmp/acme/artefacts/run-1'),
  );

  // An absolute path is honoured untouched — scripts and CI pass those.
  assert.equal(
    outDirFor({ out: '/var/tmp/elsewhere', config: engagement }),
    '/var/tmp/elsewhere',
  );

  // The standalone case, config inside `pipeline/`, resolves exactly as it did
  // before the change — which is what makes this safe.
  const standalone = resolve(ROOT, 'migration.config.json');
  assert.equal(outDirFor({ out: 'out', config: standalone }), resolve(ROOT, 'out'));
});

// ---------------------------------------------------------------------------
// Channels and customer groups
//
// Prices already referenced both, and the Import API can create neither. So a
// reference to something the project does not hold became an Import Operation
// that sat unresolved for 48 hours and then expired, taking the price with it
// and reporting nothing.
// ---------------------------------------------------------------------------

/** The channels fixture with `mutate` applied to its feed records. */
function channelFeed(mutate: (rows: Record<string, unknown>[]) => void) {
  const source = resolve(ROOT, 'fixtures', 'channels', 'feed', 'catalog.ndjson');
  const rows = readFileSync(source, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  mutate(rows);

  const dir = mkdtempSync(join(tmpdir(), 'ct-channels-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(join(feedDir, 'catalog.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n'));

  const config = JSON.parse(
    readFileSync(resolve(ROOT, 'fixtures', 'channels', 'migration.config.json'), 'utf8'),
  ) as PipelineConfig;
  config.feed.dir = feedDir;
  const configPath = join(dir, 'migration.config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return loadConfig(configPath);
}

test('channels: a declared channel and customer group validate clean', () => {
  const r = run('channels');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.feed.channels.get('retail-uk')?.roles[0], 'ProductDistribution');
  assert.equal(r.feed.customerGroups.get('trade')?.name, 'Trade');
});

test('channels: a price scoped to an undeclared channel is refused', () => {
  // The whole reason to declare them: an undeclared channel cannot be
  // verified, and the failure is a silent 48-hour expiry.
  const loaded = channelFeed((rows) => {
    const i = rows.findIndex((r) => r._type === 'channel');
    rows.splice(i, 1);
  });
  const r = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  const d = r.diagnostics.find((x) => x.code === 'undeclared-channel');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /sits unresolved for 48 hours and then expires/);
  // The remedy is stated as a record you can paste, with the roles.
  assert.match(d.message, /"_type":"channel","code":"retail-uk"/);
  assert.match(d.message, /it is not prefixed/);
  assert.ok(d.file, 'it points at the offending variant');
});

test('channels: an undeclared customer group is refused the same way', () => {
  const loaded = channelFeed((rows) => {
    const i = rows.findIndex((r) => r._type === 'customerGroup');
    rows.splice(i, 1);
  });
  const found = codes(validateFeed(loaded.feedDir, SCHEMA, loaded.config).diagnostics);
  assert.ok(found.includes('undeclared-customer-group'));
});

test('channels: a price channel without ProductDistribution is caught', () => {
  // The API refuses a StandalonePrice referencing such a channel outright —
  // MissingRoleOnChannelError — so the severity follows the price mode.
  const loaded = channelFeed((rows) => {
    const channel = rows.find((r) => r._type === 'channel')!;
    channel.roles = ['InventorySupply'];
  });

  const embedded = validateFeed(loaded.feedDir, SCHEMA, loaded.config);
  const w = embedded.diagnostics.find((x) => x.code === 'channel-missing-product-distribution');
  assert.ok(w);
  assert.equal(w.severity, 'warning', 'embedded prices import, but selection cannot find it');
  assert.match(w.message, /cannot act as a distribution channel/);

  const standalone = validateFeed(loaded.feedDir, SCHEMA, {
    ...loaded.config,
    target: { catalogModel: 'Classic', priceMode: 'standalone' },
  });
  const e = standalone.diagnostics.find(
    (x) => x.code === 'channel-missing-product-distribution',
  );
  assert.ok(e);
  assert.equal(e.severity, 'error', 'the API rejects it outright for standalone prices');
  assert.match(e.message, /MissingRoleOnChannelError/);
});

test('channels: a declared channel nothing references is a warning', () => {
  const loaded = channelFeed((rows) => {
    rows.push({ _type: 'channel', code: 'unused-dc', roles: ['InventorySupply'] });
  });
  const d = validateFeed(loaded.feedDir, SCHEMA, loaded.config).diagnostics.find(
    (x) => x.code === 'channel-never-referenced',
  );
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /unused-dc/);
});

test('channels: the key is used verbatim, never prefixed', () => {
  // A price references the project's own channel key. Prefixing would point
  // every price at a channel that does not exist.
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'channels', 'migration.config.json'),
  );
  assert.equal(config.keys.prefix, 'mig', 'the fixture does prefix everything else');

  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const model = deriveProductTypes(feed, config);
  const { plan } = buildPlan(feed, model, config);

  assert.deepEqual(plan.prerequisites.channels, [
    { key: 'retail-uk', roles: ['ProductDistribution'], name: { 'en-GB': 'Retail UK' } },
  ]);
  assert.deepEqual(plan.prerequisites.customerGroups, [{ key: 'trade', name: 'Trade' }]);

  // And the price points at the same unprefixed key.
  const priced = plan.products[0].masterVariant!.prices!.find(
    (x: PriceDraftImport) => x.channel,
  );
  assert.equal(priced?.channel?.key, 'retail-uk');

  // A load stage, but not an *import* stage: the Import API has no channel
  // resource, so the platform API creates it. Both facts have to hold.
  assert.ok(plan.loadOrder.includes('channel'), 'it is loaded, and first');
  assert.equal(plan.loadOrder[0], 'channel');
  assert.equal(plan.loadOrder[1], 'customer-group');
  assert.ok(!importStages(plan.loadOrder).includes('channel'), 'nothing to import');
  assert.ok(platformStages(plan.loadOrder, 'before').includes('channel'));
});

// ---------------------------------------------------------------------------
// Stores and product selections
//
// Both records exist to point at other records, so nearly every failure is a
// dangling reference or an activation rule that reads backwards — and none of
// it shows up at load time. A store wired to the wrong selection imports
// cleanly and sells the wrong catalog.
// ---------------------------------------------------------------------------

/** Validates an inline feed against the `stores` fixture's config. */
function validateStoreFeed(lines: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-stores-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(
    join(feedDir, 'catalog.ndjson'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  const { config } = loadConfig(resolve(ROOT, 'fixtures', 'stores', 'migration.config.json'));
  return validateFeed(feedDir, SCHEMA, config);
}

const AXIS_DEF = {
  _type: 'attributeDefinition', name: 'sz', type: 'text', level: 'variant', axis: true,
};
const ONE_VARIANT = {
  _type: 'variant', sku: 'TEE-S', product: 'TEE', axisValues: { sz: 'S' },
  prices: [{ currency: 'GBP', amount: '10.00' }],
};

test('selections: a product assigned to an undeclared selection is an error', () => {
  // The assignment lives on the selection resource, so an undeclared selection
  // means the assignment is simply dropped — nothing fails, the assortment is
  // just wrong.
  const r = validateStoreFeed([
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'], selections: [{ code: 'ghost' }] },
    ONE_VARIANT,
  ]);
  const d = r.diagnostics.find((x) => x.code === 'selection-not-declared');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /simply dropped/);
});

test('selections: an empty Individual selection is an error, an empty exclusion a warning', () => {
  // Opposite ends of the same mechanism: an empty allowlist offers nothing, an
  // empty denylist excludes nothing.
  const r = validateStoreFeed([
    { _type: 'productSelection', code: 'allow', name: { 'en-GB': 'A' }, mode: 'Individual' },
    { _type: 'productSelection', code: 'deny', name: { 'en-GB': 'D' }, mode: 'IndividualExclusion' },
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'] },
    ONE_VARIANT,
  ]);
  const found = r.diagnostics.filter((x) => x.code === 'selection-empty');
  assert.equal(found.length, 2);
  assert.equal(found.find((d) => d.message.includes("'allow'"))!.severity, 'error');
  assert.equal(found.find((d) => d.message.includes("'deny'"))!.severity, 'warning');
});

test('selections: a SKU from another product selects nothing, so it is an error', () => {
  const r = validateStoreFeed([
    { _type: 'productSelection', code: 'uk', name: { 'en-GB': 'UK' } },
    AXIS_DEF,
    {
      _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'],
      selections: [{ code: 'uk', includeSkus: ['SOMEONE-ELSE'] }],
    },
    ONE_VARIANT,
  ]);
  const d = r.diagnostics.find((x) => x.code === 'selection-sku-not-on-product');
  assert.ok(d);
  assert.match(d.message, /prunes unknown SKUs/);
});

test('stores: every selection inactive with one Individual exposes nothing', () => {
  // The rule that reads backwards: an *empty* list offers the whole catalog,
  // but a list whose entries are all switched off offers none of it.
  const r = validateStoreFeed([
    { _type: 'productSelection', code: 'uk', name: { 'en-GB': 'UK' }, mode: 'Individual' },
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'], selections: [{ code: 'uk' }] },
    ONE_VARIANT,
    { _type: 'store', code: 's1', productSelections: [{ code: 'uk', active: false }] },
  ]);
  const d = r.diagnostics.find((x) => x.code === 'store-exposes-no-products');
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.message, /no products at all/);
});

test('stores: a distribution channel lacking ProductDistribution is refused', () => {
  const r = validateStoreFeed([
    { _type: 'channel', code: 'warehouse', roles: ['InventorySupply'] },
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'] },
    ONE_VARIANT,
    { _type: 'store', code: 's1', distributionChannels: ['warehouse'] },
  ]);
  const d = r.diagnostics.find((x) => x.code === 'store-channel-role-insufficient');
  assert.ok(d);
  assert.match(d.message, /requires ProductDistribution/);
});

test('stores: a supply channel with no prices is not reported as a pricing mistake', () => {
  // Inventory is all a supply channel is for. An earlier version lumped the
  // two lists together and flagged every warehouse.
  const r = validateStoreFeed([
    { _type: 'channel', code: 'warehouse', roles: ['InventorySupply'] },
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'] },
    ONE_VARIANT,
    { _type: 'store', code: 's1', supplyChannels: ['warehouse'] },
  ]);
  assert.ok(!r.diagnostics.some((x) => x.code === 'distribution-channel-without-prices'));
  // But the honest warning still fires: no inventory is ever imported.
  assert.ok(r.diagnostics.some((x) => x.code === 'store-inventory-not-migrated'));
});

test('stores: a distribution channel nothing is priced into is reported', () => {
  const r = validateStoreFeed([
    { _type: 'channel', code: 'retail', roles: ['ProductDistribution'] },
    AXIS_DEF,
    { _type: 'product', code: 'TEE', name: { 'en-GB': 'Tee' }, axes: ['sz'] },
    ONE_VARIANT,
    { _type: 'store', code: 's1', distributionChannels: ['retail'] },
  ]);
  const d = r.diagnostics.find((x) => x.code === 'distribution-channel-without-prices');
  assert.ok(d);
  assert.match(d.message, /fall through to prices with no channel/);
});

test('config: a defaultKey that already carries the prefix is flagged', () => {
  // Produced while writing a live-test config: prefix `storetest` plus
  // defaultKey `storetest-apparel` gave the ProductType
  // `storetest-storetest-apparel`. Legal, permanent, nobody's intent.
  const dir = mkdtempSync(join(tmpdir(), 'ct-prefix-'));
  const feedDir = join(dir, 'feed');
  mkdirSync(feedDir);
  writeFileSync(
    join(feedDir, 'catalog.ndjson'),
    [
      JSON.stringify({ _type: 'attributeDefinition', name: 'm', type: 'text', level: 'product' }),
      JSON.stringify({ _type: 'product', code: 'P', name: { 'en-GB': 'P' }, attributes: { m: 'x' } }),
      JSON.stringify({ _type: 'variant', sku: 'P-1', product: 'P', prices: [{ currency: 'GBP', amount: '1.00' }] }),
    ].join('\n') + '\n',
  );

  const base = loadConfig(resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json')).config;
  const doubled = {
    ...base,
    keys: { ...base.keys, prefix: 'acme' },
    productTypes: { ...base.productTypes, defaultKey: 'acme-apparel' },
  };
  const r = validateFeed(feedDir, SCHEMA, doubled);
  const d = r.diagnostics.find((x) => x.code === 'product-type-key-doubles-prefix');
  assert.ok(d);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /acme-acme-apparel/);
  assert.match(d.message, /'apparel' produces 'acme-apparel'/);

  // And silent when the key does not repeat the prefix.
  const fine = { ...doubled, productTypes: { ...doubled.productTypes, defaultKey: 'apparel' } };
  assert.ok(
    !validateFeed(feedDir, SCHEMA, fine).diagnostics.some(
      (x) => x.code === 'product-type-key-doubles-prefix',
    ),
  );
});
