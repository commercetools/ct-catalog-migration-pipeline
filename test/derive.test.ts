/**
 * Derivation regression tests.
 *
 * The declared and inferred paths are asserted against each other on the same
 * catalog: the inferred-types fixture is the declared-types fixture with its
 * attributeDefinition records stripped, so the two should agree on everything
 * except what a declaration is the only possible source of.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { attributeDefinitionsOf, type AttributeDefinition } from '../src/model/plan.js';

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

function derive(fixture: string) {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', fixture, 'migration.config.json'),
  );
  const { feed } = validateFeed(feedDir, SCHEMA, config);
  return deriveProductTypes(feed, config);
}

/**
 * ProductType keys are prefixed like every other resource, so a test that
 * knows a feed's ProductType code has to ask for the resource key. Every
 * fixture here uses `keys.prefix: "mig"`.
 */
const PREFIX = 'mig';
function ptKey(sourceKey: string): string {
  return `${PREFIX}-${sourceKey}`;
}

/**
 * Derives from an inline feed, for shapes no fixture should have to carry.
 * Borrows `declared-types`' config, so the default locale is `en-GB`.
 */
function deriveFeed(lines: string[], configFixture = 'declared-types') {
  const dir = mkdtempSync(join(tmpdir(), 'ct-derive-'));
  writeFileSync(join(dir, 'catalog.ndjson'), lines.join('\n') + '\n');
  const { config } = loadConfig(resolve(ROOT, 'fixtures', configFixture, 'migration.config.json'));
  const { feed } = validateFeed(dir, SCHEMA, config);
  return deriveProductTypes(feed, config);
}

function codes(diagnostics: { code: string }[]): string[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}

function attr(
  result: ReturnType<typeof derive>,
  productType: string,
  name: string,
): AttributeDefinition {
  const pt = result.productTypes.get(ptKey(productType));
  assert.ok(pt, `ProductType '${productType}' should exist`);
  const found = attributeDefinitionsOf(pt).find((a) => a.name === name);
  assert.ok(found, `attribute '${name}' should exist on '${productType}'`);
  return found;
}

// ---------------------------------------------------------------------------
// Declared path
// ---------------------------------------------------------------------------

test('declared: one shared ProductType, no diagnostics', () => {
  const r = derive('declared-types');
  assert.deepEqual(codes(r.diagnostics), []);
  assert.equal(r.inferred, false);
  assert.deepEqual([...r.productTypes.keys()], [ptKey('apparel-basic')]);
  assert.equal(attributeDefinitionsOf(r.productTypes.get(ptKey('apparel-basic'))!).length, 5);
});

test('declared: axes become CombinationUnique at Variant level', () => {
  const r = derive('declared-types');
  for (const name of ['colour', 'size']) {
    const a = attr(r, 'apparel-basic', name);
    assert.equal(a.attributeConstraint, 'CombinationUnique');
    assert.equal(a.level, 'Variant');
    assert.equal(a.isSearchable, true, 'axes are always searchable');
  }
});

test('declared: product-level attributes become SameForAll at Variant level', () => {
  const r = derive('declared-types');
  for (const name of ['material', 'organicCertified']) {
    const a = attr(r, 'apparel-basic', name);
    assert.equal(a.attributeConstraint, 'SameForAll');
    assert.equal(
      a.level,
      'Variant',
      "the sameForAll strategy keeps them at Variant level so Product Projection Search still works",
    );
  }
});

test('declared: a freely-varying attribute gets no constraint', () => {
  const a = attr(derive('declared-types'), 'apparel-basic', 'weightGrams');
  assert.equal(a.attributeConstraint, 'None');
});

test('declared: lenum keeps the code as key and the localized label for display', () => {
  const a = attr(derive('declared-types'), 'apparel-basic', 'colour');
  assert.equal(a.type.name, 'lenum');
  assert.ok(a.type.name === 'lenum');
  assert.deepEqual(
    a.type.values.map((v: { key: string }) => v.key),
    ['BLK', 'NVY', 'OAT'],
  );
  assert.equal(a.type.values[0]!.label['de-DE'], 'Schwarz');
});

test('declared: enum labels are plain strings, not localized', () => {
  const a = attr(derive('declared-types'), 'apparel-basic', 'size');
  assert.ok(a.type.name === 'enum');
  assert.equal(typeof a.type.values[0]!.label, 'string');
});

test('declared: a unit is carried into the label and recorded as lossy', () => {
  const r = derive('declared-types');
  const a = attr(r, 'apparel-basic', 'weightGrams');
  assert.equal(a.label['en-GB'], 'Weight (g)');
  assert.equal(a.label['de-DE'], 'Gewicht (g)');

  const d = r.decisions.find(
    (x) => x.subject === `${ptKey('apparel-basic')}.weightGrams` && x.lossy === true,
  );
  assert.ok(d, 'appending a unit to the label loses machine-readability');
  assert.match(d.rationale, /no unit/);
});

test('declared: every non-None constraint is recorded as irreversible', () => {
  const r = derive('declared-types');
  const constrained = attributeDefinitionsOf(
    r.productTypes.get(ptKey('apparel-basic'))!,
  ).filter((a) => a.attributeConstraint !== 'None');
  const irreversible = r.decisions.filter((d) => d.irreversible);

  assert.equal(constrained.length, 4);
  assert.equal(irreversible.length, 4);
  for (const d of irreversible) {
    assert.match(
      d.rationale,
      /changeAttributeConstraint accepts only None/,
      'the rationale has to state why the choice cannot be undone',
    );
  }
});

test('every decision carries a non-empty rationale', () => {
  for (const fixture of ['declared-types', 'inferred-types', 'derive-inference']) {
    for (const d of derive(fixture).decisions) {
      assert.ok(
        d.rationale && d.rationale.trim().length > 20,
        `${fixture}: ${d.subject} has no usable rationale`,
      );
      assert.ok(d.subject && d.outcome, `${fixture}: decision is missing subject or outcome`);
    }
  }
});

// ---------------------------------------------------------------------------
// Inferred path
// ---------------------------------------------------------------------------

test('inferred: reproduces the declared model except where a declaration is the only source', () => {
  const declared = derive('declared-types');
  const inferred = derive('inferred-types');

  assert.equal(inferred.inferred, true);
  assert.deepEqual(codes(inferred.diagnostics), []);
  assert.deepEqual([...inferred.productTypes.keys()], [...declared.productTypes.keys()]);

  for (const d of attributeDefinitionsOf(declared.productTypes.get(ptKey('apparel-basic'))!)) {
    const i = attr(inferred, 'apparel-basic', d.name);
    assert.equal(i.attributeConstraint, d.attributeConstraint, `${d.name} constraint`);
    assert.equal(i.level, d.level, `${d.name} level`);
    // colour degrades lenum → enum because labels only existed in the
    // declaration; everything else should match exactly.
    if (d.name !== 'colour') {
      assert.equal(i.type.name, d.type.name, `${d.name} type`);
    }
  }
});

test('inferred: an axis with no labels degrades to enum and says so', () => {
  const r = derive('inferred-types');
  const a = attr(r, 'apparel-basic', 'colour');
  assert.ok(a.type.name === 'enum');
  assert.deepEqual(
    a.type.values.map((v: { key: string }) => v.key),
    ['BLK', 'NVY', 'OAT'],
    'axis codes come straight from axisValues',
  );
  assert.equal(a.type.values[0]!.label, 'BLK', 'the code doubles as the label');

  const d = r.decisions.find(
    (x) => x.subject === `${ptKey('apparel-basic')}.colour` && x.review,
  );
  assert.ok(d);
  assert.match(d.rationale, /axisLabels/);
});

test('inferred: every inferred type is flagged for review', () => {
  const r = derive('inferred-types');
  for (const name of ['material', 'organicCertified', 'size', 'weightGrams', 'colour']) {
    const d = r.decisions.find(
      (x) => x.subject === `${ptKey('apparel-basic')}.${name}` && x.review,
    );
    assert.ok(d, `${name} was guessed and must be flagged for review`);
  }
});

test('inferred: labels are humanized into the default locale only', () => {
  const a = attr(derive('inferred-types'), 'apparel-basic', 'organicCertified');
  assert.deepEqual(a.label, { 'en-GB': 'Organic Certified' });
});

test('inferred: nothing is ever marked required when guessing', () => {
  const r = derive('inferred-types');
  for (const a of attributeDefinitionsOf(r.productTypes.get(ptKey('apparel-basic'))!)) {
    assert.equal(a.isRequired, false, `${a.name} must not be inferred as required`);
  }
});

test('inferred: ISO dates, timestamps, sets and long prose are recognised', () => {
  const r = derive('derive-inference');
  assert.deepEqual(codes(r.diagnostics), []);

  assert.equal(attr(r, 'dated', 'releasedOn').type.name, 'date');
  assert.equal(attr(r, 'dated', 'launchAt').type.name, 'datetime');

  const tags = attr(r, 'dated', 'tags');
  assert.ok(tags.type.name === 'set');
  assert.equal(tags.type.elementType.name, 'text');

  const care = attr(r, 'dated', 'careInstructions');
  assert.equal(care.type.name, 'text');
  assert.equal(care.inputHint, 'MultiLine', 'long prose is easier to edit multi-line');
});

test('inferred: a date guess explains how to override it', () => {
  const r = derive('derive-inference');
  const d = r.decisions.find(
    (x) => x.subject === `${ptKey('dated')}.releasedOn` && x.outcome === 'date',
  );
  assert.ok(d);
  assert.match(d.rationale, /declare/);
  assert.equal(d.review, true);
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

test('conflicts: axis, level and mixed-type clashes are all reported', () => {
  const r = derive('derive-conflicts');
  assert.deepEqual(codes(r.diagnostics), [
    'axis-inconsistent-in-product-type',
    'level-inconsistent-in-product-type',
    'mixed-value-types',
  ]);
  assert.ok(r.diagnostics.every((d) => d.severity === 'error'));
});

test('conflicts: an axis in one product and a plain attribute in another cannot share a ProductType', () => {
  const d = derive('derive-conflicts').diagnostics.find(
    (x) => x.code === 'axis-inconsistent-in-product-type',
  );
  assert.ok(d);
  assert.match(d.message, /finish/);
  assert.match(d.message, /constraints belong to the ProductType/);
});

test('conflicts: mixed value kinds refuse to be inferred rather than guessing', () => {
  const d = derive('derive-conflicts').diagnostics.find(
    (x) => x.code === 'mixed-value-types',
  );
  assert.ok(d);
  assert.match(d.message, /capacity/);
  assert.match(d.message, /string, number/);
});

test('conflicts: a mismatched isSearchable across ProductTypes is an error', () => {
  const r = derive('derive-searchable');
  const d = r.diagnostics.find(
    (x) => x.code === 'searchable-mismatch-across-product-types',
  );
  assert.ok(d, 'differing isSearchable silently disables search for the whole name');
  assert.equal(d.severity, 'error');
  assert.match(d.message, /tone/);
  assert.match(d.message, /nothing errors at import time/);
});

test('keys: a ProductType key is prefixed, its name is not', () => {
  // ProductType keys were the one resource that escaped `keys.prefix`. That
  // broke two promises at once: a teardown scoped to the prefix could not find
  // them, and two engagements loading into one project collided on a shared
  // code like `apparel-basic`. The container was already prefixed
  // (`mig-product-type`), which hid the asymmetry.
  const r = derive('declared-types');
  const [key] = [...r.productTypes.keys()];
  assert.equal(key, 'mig-apparel-basic');

  // The name must come from the *source* key: humanising the resource key
  // would read "Mig Apparel Basic" in the Merchant Center, and the configured
  // defaultName would never match.
  assert.equal(r.productTypes.get(key)!.name, 'Apparel (basic)');
});

test('keys: a non-default ProductType code is humanized from the source, not the key', () => {
  const r = derive('derive-searchable');
  const keys = [...r.productTypes.keys()].sort();
  assert.deepEqual(keys, ['mig-pt-axis', 'mig-pt-plain']);
  for (const k of keys) {
    const name = r.productTypes.get(k)!.name;
    assert.ok(!/^Mig /.test(name), `'${name}' should not carry the key prefix`);
  }
});

test('conflicts: one attribute name with two types is an error, not a warning', () => {
  // This was a warning reading "Legal, but a storefront filtering on the name
  // has to handle both shapes." A live load disproved it: the API returns
  // AttributeDefinitionTypeConflict and rejects the ProductType outright, then
  // the products fail with AttributeNameDoesNotExist.
  const r = derive('derive-type-conflict');
  const d = r.diagnostics.find((x) => x.code === 'type-mismatch-across-product-types');
  assert.ok(d, 'the API refuses this, so the pipeline has to as well');
  assert.equal(d.severity, 'error');
  assert.match(
    d.message,
    /'grade' is text on ProductType 'mig-pt-words' and number on 'mig-pt-numbers'/,
    'diagnostics name the resource key, which is what the project will hold',
  );
  assert.match(d.message, /AttributeDefinitionTypeConflict/);
  assert.match(d.message, /AttributeNameDoesNotExist/);
  // Enum values are explicitly not part of the constraint — the docs' own
  // example gives one attribute name different value sets per ProductType.
  assert.match(d.message, /Enum \*values\* may differ freely/);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("the 'native' product-level strategy uses Product level with no constraint", () => {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'declared-types', 'migration.config.json'),
  );
  config.productTypes.productLevelStrategy = 'native';

  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const r = deriveProductTypes(feed, config);

  const a = attr(r, 'apparel-basic', 'material');
  assert.equal(a.level, 'Product');
  assert.equal(a.attributeConstraint, 'None');

  // Axes are variant identity and must stay at Variant level regardless.
  assert.equal(attr(r, 'apparel-basic', 'colour').level, 'Variant');
});

test("onMissingDefinitions 'require' refuses to guess", () => {
  const { config, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'inferred-types', 'migration.config.json'),
  );
  config.productTypes.onMissingDefinitions = 'require';

  const { feed } = validateFeed(feedDir, SCHEMA, config);
  const r = deriveProductTypes(feed, config);

  assert.deepEqual(codes(r.diagnostics), ['definitions-required']);
  assert.equal(r.productTypes.size, 0);
});

test('a declared searchable flag beats the configured default', () => {
  // The source declares searchability per attribute — hybris `items.xml` has
  // `search="true|false"` — and the contract had no field for it, so every
  // declaration was silently replaced by productTypes.searchableByDefault. A
  // dogfood engagement lost the flag on 5 attributes that way.
  const { config: cfg, feedDir } = loadConfig(
    resolve(ROOT, 'fixtures', 'declared-searchable', 'migration.config.json'),
  );
  assert.equal(cfg.productTypes.searchableByDefault, true, 'default is the opposite');

  const { feed } = validateFeed(feedDir, SCHEMA, cfg);
  const model = deriveProductTypes(feed, cfg);
  assert.deepEqual(
    model.diagnostics.filter((d) => d.severity === 'error'),
    [],
  );

  const defs = new Map(
    attributeDefinitionsOf([...model.productTypes.values()][0]).map((d) => [d.name, d]),
  );

  assert.equal(defs.get('internalNote')?.isSearchable, false, 'declared false is honoured');
  assert.equal(defs.get('material')?.isSearchable, true, 'declared true is honoured');
  assert.equal(
    defs.get('fabricWeight')?.isSearchable,
    true,
    'undeclared falls back to searchableByDefault',
  );
  // An axis is always searchable: it is variant identity, and faceting on it is
  // the usual reason to have one.
  assert.equal(defs.get('colour')?.isSearchable, true, 'an axis stays searchable');

  // The override is a reviewable decision, not a silent change.
  const d = model.decisions.find(
    (x) => x.subject.endsWith('.internalNote') && /declared, overriding/.test(x.outcome),
  );
  assert.ok(d, 'honouring a declaration against the default has to be recorded');
  assert.equal(d.review, true);
});

// ---------------------------------------------------------------------------
// Enum value labels
//
// Four separate under-specified-label paths used to behave four different
// ways, three of them putting the text somewhere unreachable. A dogfood run
// hit the worst: a declared `lenum` value with no label became `label: {}` —
// blank in every locale, reported nowhere.
// ---------------------------------------------------------------------------

const ONE_PRODUCT = [
  '{"_type": "product", "code": "P1", "name": {"en-GB": "One"}, "attributes": {"tone": "COOL"}}',
  '{"_type": "variant", "sku": "P1-1", "product": "P1", "prices": [{"currency": "GBP", "amount": "10.00"}]}',
];

test('enum labels: a declared lenum value with no label falls back to the key', () => {
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "lenum", "level": "product", "values": [{"key": "WARM", "label": {"en-GB": "Warm"}}, {"key": "COOL"}]}',
    ...ONE_PRODUCT,
  ]);
  const t = attr(r, 'apparel-basic', 'tone').type as { values: { key: string; label: Record<string, string> }[] };
  const cool = t.values.find((v) => v.key === 'COOL')!;
  assert.deepEqual(cool.label, { 'en-GB': 'COOL' }, 'never an empty label object');
  assert.deepEqual(t.values.find((v) => v.key === 'WARM')!.label, { 'en-GB': 'Warm' });
});

test('enum labels: a derived value label is recorded as lossy, needing review', () => {
  // Small loss, but loss: merchandisers see the raw code. Absorbing it
  // silently is what this pipeline exists not to do.
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "lenum", "level": "product", "values": [{"key": "WARM", "label": {"en-GB": "Warm"}}, {"key": "COOL"}]}',
    ...ONE_PRODUCT,
  ]);
  const d = r.decisions.find((x) => /value label\(s\) derived from the key/.test(x.outcome));
  assert.ok(d, 'a derived label has to be reported');
  assert.equal(d.lossy, true);
  assert.equal(d.review, true);
  assert.match(d.rationale, /COOL/);
});

test('enum labels: a plain-string label on a lenum lands in the default locale, not `und`', () => {
  // `und` is the ISO undetermined tag and is never among a project's
  // configured languages, so a label keyed by it is unreachable.
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "lenum", "level": "product", "values": [{"key": "COOL", "label": "Cool"}]}',
    ...ONE_PRODUCT,
  ]);
  const t = attr(r, 'apparel-basic', 'tone').type as { values: { key: string; label: Record<string, string> }[] };
  assert.deepEqual(t.values[0].label, { 'en-GB': 'Cool' });
  assert.ok(!('und' in t.values[0].label));
});

test('enum labels: a localized label on a plain enum prefers the default locale', () => {
  // It has to collapse to one string. Picking by JSON key order would make the
  // output depend on how the adapter happened to serialise its objects.
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "enum", "level": "product", "values": [{"key": "COOL", "label": {"de-DE": "Kuehl", "en-GB": "Cool"}}]}',
    ...ONE_PRODUCT,
  ]);
  const t = attr(r, 'apparel-basic', 'tone').type as { values: { key: string; label: string }[] };
  assert.equal(t.values[0].label, 'Cool', 'en-GB wins even though de-DE is written first');
});

test('enum labels: collapsing to a non-default locale is reported', () => {
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "enum", "level": "product", "values": [{"key": "COOL", "label": {"de-DE": "Kuehl"}}]}',
    ...ONE_PRODUCT,
  ]);
  const t = attr(r, 'apparel-basic', 'tone').type as { values: { key: string; label: string }[] };
  assert.equal(t.values[0].label, 'Kuehl');
  const d = r.decisions.find((x) => /non-default locale/.test(x.outcome));
  assert.ok(d, 'silently dropping every other locale is worth a decision');
  assert.equal(d.lossy, true);
  assert.match(d.rationale, /declare the attribute as lenum/i);
});

test('enum labels: a fully labelled enum produces no label decision', () => {
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "tone", "type": "enum", "level": "product", "values": [{"key": "COOL", "label": "Cool"}]}',
    ...ONE_PRODUCT,
  ]);
  assert.ok(!r.decisions.some((x) => /value label/.test(x.outcome)));
});

test('axis labels: one key with two labels across products is reported, not silently picked', () => {
  // A real export carried a shared size key with different display text on
  // different styles. `axisKeys` keeps the first and drops the rest — fine as
  // a rule, but it was silent, and "first" is feed line order, so the winner
  // moved when the adapter reordered its output.
  const r = deriveFeed(
    [
      '{"_type": "product", "code": "P1", "name": {"en-GB": "One"}, "axes": ["sz"]}',
      '{"_type": "variant", "sku": "P1-M", "product": "P1", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"en-GB": "Medium"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
      '{"_type": "product", "code": "P2", "name": {"en-GB": "Two"}, "axes": ["sz"]}',
      '{"_type": "variant", "sku": "P2-M", "product": "P2", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"en-GB": "Mid"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
    ],
    'derive-searchable',
  );

  const d = r.decisions.find((x) => /more than one label/.test(x.outcome));
  assert.ok(d, 'dropping a display label has to be reported');
  assert.equal(d.lossy, true);
  assert.equal(d.review, true);
  assert.match(d.rationale, /Medium/);
  assert.match(d.rationale, /Mid/, 'both renderings have to appear, or the reader cannot judge');

  // The first is still what lands.
  const t = attr(r, 'apparel-basic', 'sz').type as { values: { key: string; label: Record<string, string> }[] };
  assert.deepEqual(t.values.find((v) => v.key === 'M')!.label, { 'en-GB': 'Medium' });
});

test('axis labels: the same label written twice is not a conflict', () => {
  // Equal labels whose JSON key order differs must not look like a clash.
  const r = deriveFeed(
    [
      '{"_type": "product", "code": "P1", "name": {"en-GB": "One"}, "axes": ["sz"]}',
      '{"_type": "variant", "sku": "P1-M", "product": "P1", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"en-GB": "Medium", "de-DE": "Mittel"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
      '{"_type": "product", "code": "P2", "name": {"en-GB": "Two"}, "axes": ["sz"]}',
      '{"_type": "variant", "sku": "P2-M", "product": "P2", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"de-DE": "Mittel", "en-GB": "Medium"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
    ],
    'derive-searchable',
  );
  assert.ok(!r.decisions.some((x) => /more than one label/.test(x.outcome)));
});

test('axis labels: labels supplied for a declared text axis are reported as dropped', () => {
  // enum and lenum carry a key and display text separately; text does not, so
  // the axis value *is* the display text and every supplied label is
  // discarded. That was silent.
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "sz", "type": "text", "level": "variant", "axis": true}',
    '{"_type": "product", "code": "P1", "name": {"en-GB": "One"}, "axes": ["sz"]}',
    '{"_type": "variant", "sku": "P1-M", "product": "P1", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"en-GB": "Medium"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
  ]);
  const d = r.diagnostics.find((x) => x.code === 'axis-labels-ignored');
  assert.ok(d, 'silently dropping every label is worth saying out loud');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /declare it as enum or lenum/i);
});

test('axis labels: an enum axis keeps them, with no warning', () => {
  const r = deriveFeed([
    '{"_type": "attributeDefinition", "name": "sz", "type": "lenum", "level": "variant", "axis": true, "values": [{"key": "M", "label": {"en-GB": "Medium"}}]}',
    '{"_type": "product", "code": "P1", "name": {"en-GB": "One"}, "axes": ["sz"]}',
    '{"_type": "variant", "sku": "P1-M", "product": "P1", "axisValues": {"sz": "M"}, "axisLabels": {"sz": {"en-GB": "Medium"}}, "prices": [{"currency": "GBP", "amount": "10.00"}]}',
  ]);
  assert.ok(!r.diagnostics.some((x) => x.code === 'axis-labels-ignored'));
});
