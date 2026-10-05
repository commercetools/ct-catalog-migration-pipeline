/**
 * Feed validation: schema conformance, then catalog-wide integrity.
 *
 * This runs before anything is mapped and needs no credentials. Everything it
 * reports is a defect in the feed — that is, in the adapter — not in the target
 * project. Target-invariant checks (price scopes, variant caps, slug
 * uniqueness) belong to the audit gate, which runs after mapping.
 *
 * Diagnostics name a file and line wherever possible: an adapter author fixing
 * a feed needs to find the record, and "record 41293 is invalid" does not help.
 */

import type { ValidateFunction } from 'ajv';
// The 2020 entry point, not the default one: the feed schema declares
// draft 2020-12, and ajv's default export only knows draft-07.
import ajvModule from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * ajv and ajv-formats are CommonJS. Consumed from an ESM entry point their
 * default export may or may not arrive wrapped in `.default` depending on the
 * resolver, so unwrap defensively instead of committing to one shape.
 */
function unwrap<T>(mod: unknown): T {
  const m = mod as { default?: unknown };
  return (m.default ?? mod) as T;
}

type AjvConstructor = new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => {
  compile(schema: unknown): ValidateFunction;
  addSchema(schema: unknown): unknown;
  getSchema(ref: string): ValidateFunction | undefined;
};

const Ajv = unwrap<AjvConstructor>(ajvModule);
const addFormats = unwrap<(ajv: unknown) => unknown>(ajvFormatsModule);

import {
  emptyFeed,
  FEED_TYPES,
  inventoryIdentity,
  subRateSumMismatch,
  taxRateScope,
  type CatalogFeed,
  type FeedAttributeDefinition,
  type FeedCategory,
  type FeedChannel,
  type FeedCustomerGroup,
  type FeedInventoryEntry,
  type FeedProduct,
  type FeedProductSelection,
  type FeedRecord,
  type FeedStore,
  type FeedTaxCategory,
  type FeedVariant,
} from '../model/feed.js';
import type { PipelineConfig } from '../model/config.js';
import {
  MAX_VARIANTS_CLASSIC,
  MAX_VARIANTS_MODULAR,
  VARIANT_WARN_THRESHOLD,
  requiredCatalogModel,
} from '../model/limits.js';

export interface Diagnostic {
  severity: 'error' | 'warning';
  /** Stable machine-readable code, so callers can filter without string matching. */
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationResult {
  feed: CatalogFeed;
  diagnostics: Diagnostic[];
  /** Records that passed schema validation. */
  accepted: number;
  /** Records rejected by schema validation, and therefore absent from `feed`. */
  rejected: number;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One compiled validator per record type, rather than one for the root schema.
 *
 * The root schema's `oneOf` is correct as a published contract and is what CI
 * and editors should check against, but it is useless for diagnostics: ajv
 * resolves the `$ref`s away, so every error arrives with a schemaPath like
 * `#/required` and a record with one bad field reports failures against all
 * four branches at once. Dispatching on `_type` first and validating against
 * that branch alone gives an error that names the actual problem.
 */
function compileBranches(schemaPath: string): Map<string, ValidateFunction> {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    $id?: string;
    $defs: Record<string, unknown>;
  };
  // allErrors so one bad record reports every problem, not just the first.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);

  const base = schema.$id ?? '';
  const branches = new Map<string, ValidateFunction>();
  for (const type of FEED_TYPES) {
    const fn = ajv.getSchema(`${base}#/$defs/${type}`);
    if (!fn) {
      throw new Error(
        `Feed schema at ${schemaPath} has no $defs/${type}. The schema and ` +
          'src/model/feed.ts have drifted apart.',
      );
    }
    branches.set(type, fn);
  }
  return branches;
}

function describeErrors(validate: ValidateFunction, recordType: string): string {
  return (validate.errors ?? [])
    .map((e) => {
      const message = `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim();
      if (e.keyword !== 'additionalProperties') return message;
      // ajv's own message does not say which property it objects to.
      const name = String((e.params as { additionalProperty?: unknown }).additionalProperty);
      const hint =
        name === 'key' && recordType === 'variant'
          ? ". A variant's key is not a feed field: it is always <keys.prefix>-<sku>, " +
            'because the SKU is the variant\'s identity. Remove the field.'
          : '';
      return `${message}: '${name}'${hint}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function feedFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(
      `Cannot read feed directory ${dir}.\n` +
        'The feed is a directory of *.ndjson files, one record per line, each tagged\n' +
        'with a _type. See references/catalog-feed-contract.md.',
    );
  }
  const files = entries
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();

  if (files.length === 0) {
    throw new Error(`No *.ndjson files in ${dir}. The feed is empty.`);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateFeed(
  feedDir: string,
  schemaPath: string,
  config: PipelineConfig,
): ValidationResult {
  const branches = compileBranches(schemaPath);
  const feed = emptyFeed();
  const diagnostics: Diagnostic[] = [];
  let accepted = 0;
  let rejected = 0;

  for (const file of feedFiles(feedDir)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      // Blank lines are tolerated; NDJSON writers often leave a trailing one.
      if (raw === '') continue;

      const line = i + 1;

      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch (err) {
        rejected++;
        diagnostics.push({
          severity: 'error',
          code: 'malformed-json',
          message: `Not valid JSON: ${(err as Error).message}`,
          file,
          line,
        });
        continue;
      }

      const type = (record as { _type?: unknown })._type;
      const validate = typeof type === 'string' ? branches.get(type) : undefined;

      if (!validate) {
        rejected++;
        diagnostics.push({
          severity: 'error',
          code: 'unknown-record-type',
          message:
            `_type is ${JSON.stringify(type)}; expected one of ${FEED_TYPES.join(', ')}.`,
          file,
          line,
        });
        continue;
      }

      if (!validate(record)) {
        rejected++;
        diagnostics.push({
          severity: 'error',
          code: 'schema-violation',
          message: describeErrors(validate, String(type)),
          file,
          line,
        });
        continue;
      }

      accepted++;
      index(feed, record as FeedRecord, file, line, diagnostics);
    }
  }

  // Catalog-wide integrity runs only once every record parses and conforms.
  // A rejected record removes a product or variant from the index, which makes
  // the integrity pass report orphans and childless products that are really
  // just consequences of the earlier failure — chasing those wastes the
  // adapter author's time.
  if (rejected === 0) {
    checkIntegrity(feed, diagnostics);
    checkAgainstConfig(feed, config, diagnostics);
  }

  return { feed, diagnostics, accepted, rejected };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function index(
  feed: CatalogFeed,
  record: FeedRecord,
  file: string,
  line: number,
  diagnostics: Diagnostic[],
): void {
  const duplicate = (kind: string, id: string) => {
    const first = feed.origin.get(`${kind}:${id}`);
    diagnostics.push({
      severity: 'error',
      code: 'duplicate-record',
      message:
        `Duplicate ${kind} '${id}'` +
        (first ? `; first declared at ${basename(first.file)}:${first.line}` : '') +
        '. A later record silently overwriting an earlier one is how half a catalog ' +
        'goes missing without an error.',
      file,
      line,
    });
  };

  switch (record._type) {
    case 'channel': {
      const r = record as FeedChannel;
      if (feed.channels.has(r.code)) return duplicate('channel', r.code);
      feed.channels.set(r.code, r);
      feed.origin.set(`channel:${r.code}`, { file, line });
      return;
    }
    case 'customerGroup': {
      const r = record as FeedCustomerGroup;
      if (feed.customerGroups.has(r.code)) return duplicate('customerGroup', r.code);
      feed.customerGroups.set(r.code, r);
      feed.origin.set(`customerGroup:${r.code}`, { file, line });
      return;
    }
    case 'taxCategory': {
      const r = record as FeedTaxCategory;
      if (feed.taxCategories.has(r.code)) return duplicate('taxCategory', r.code);
      feed.taxCategories.set(r.code, r);
      feed.origin.set(`taxCategory:${r.code}`, { file, line });
      return;
    }
    case 'productSelection': {
      const r = record as FeedProductSelection;
      if (feed.productSelections.has(r.code)) return duplicate('productSelection', r.code);
      feed.productSelections.set(r.code, r);
      feed.origin.set(`productSelection:${r.code}`, { file, line });
      return;
    }
    case 'store': {
      const r = record as FeedStore;
      if (feed.stores.has(r.code)) return duplicate('store', r.code);
      feed.stores.set(r.code, r);
      feed.origin.set(`store:${r.code}`, { file, line });
      return;
    }
    case 'category': {
      const r = record as FeedCategory;
      if (feed.categories.has(r.code)) return duplicate('category', r.code);
      feed.categories.set(r.code, r);
      feed.origin.set(`category:${r.code}`, { file, line });
      return;
    }
    case 'attributeDefinition': {
      const r = record as FeedAttributeDefinition;
      if (feed.attributeDefinitions.has(r.name)) {
        return duplicate('attributeDefinition', r.name);
      }
      feed.attributeDefinitions.set(r.name, r);
      feed.origin.set(`attributeDefinition:${r.name}`, { file, line });
      return;
    }
    case 'product': {
      const r = record as FeedProduct;
      if (feed.products.has(r.code)) return duplicate('product', r.code);
      feed.products.set(r.code, r);
      feed.origin.set(`product:${r.code}`, { file, line });
      return;
    }
    case 'variant': {
      const r = record as FeedVariant;
      if (feed.variants.has(r.sku)) return duplicate('variant', r.sku);
      feed.variants.set(r.sku, r);
      feed.origin.set(`variant:${r.sku}`, { file, line });
      const siblings = feed.variantsByProduct.get(r.product) ?? [];
      siblings.push(r.sku);
      feed.variantsByProduct.set(r.product, siblings);
      return;
    }
    case 'inventoryEntry': {
      const r = record as FeedInventoryEntry;
      // Identity is the pair, not the SKU: the same SKU legitimately has one
      // entry per supply channel, and a project-wide entry alongside them.
      const id = inventoryIdentity(r.sku, r.supplyChannel);
      if (feed.inventoryEntries.has(id)) return duplicate('inventoryEntry', id);
      feed.inventoryEntries.set(id, r);
      feed.origin.set(`inventoryEntry:${id}`, { file, line });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Catalog-wide integrity
// ---------------------------------------------------------------------------

function checkIntegrity(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  const at = (kind: string, id: string) => feed.origin.get(`${kind}:${id}`) ?? {};

  // --- category tree ------------------------------------------------------
  for (const cat of feed.categories.values()) {
    if (cat.parent !== undefined && !feed.categories.has(cat.parent)) {
      diagnostics.push({
        severity: 'error',
        code: 'missing-parent',
        message: `Category '${cat.code}' names parent '${cat.parent}', which is not in the feed.`,
        ...at('category', cat.code),
      });
    }
  }
  reportCycles(feed, diagnostics);

  // --- orphan variants and childless products -----------------------------
  for (const variant of feed.variants.values()) {
    if (!feed.products.has(variant.product)) {
      diagnostics.push({
        severity: 'error',
        code: 'orphan-variant',
        message: `Variant '${variant.sku}' names product '${variant.product}', which is not in the feed.`,
        ...at('variant', variant.sku),
      });
    }
  }
  for (const product of feed.products.values()) {
    const skus = feed.variantsByProduct.get(product.code) ?? [];
    if (skus.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'product-without-variants',
        message:
          `Product '${product.code}' has no variants. commercetools requires at least ` +
          'one variant per product, since the master variant is what makes it sellable.',
        ...at('product', product.code),
      });
    }
  }

  // --- category references on products ------------------------------------
  for (const product of feed.products.values()) {
    for (const code of product.categories ?? []) {
      if (!feed.categories.has(code)) {
        diagnostics.push({
          severity: 'error',
          code: 'missing-category',
          message: `Product '${product.code}' references category '${code}', which is not in the feed.`,
          ...at('product', product.code),
        });
      }
    }
  }

  checkAxes(feed, diagnostics);
  checkDeclarations(feed, diagnostics);
  checkMasterVariants(feed, diagnostics);
  checkUnmappedExternalId(feed, diagnostics);
}

function reportCycles(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  const state = new Map<string, 'visiting' | 'done'>();

  const walk = (code: string, trail: string[]): void => {
    const seen = state.get(code);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const from = trail.indexOf(code);
      const cycle = [...trail.slice(from), code].join(' → ');
      diagnostics.push({
        severity: 'error',
        code: 'category-cycle',
        message: `Category parent chain forms a cycle: ${cycle}`,
        ...(feed.origin.get(`category:${code}`) ?? {}),
      });
      return;
    }
    state.set(code, 'visiting');
    const parent = feed.categories.get(code)?.parent;
    if (parent !== undefined && feed.categories.has(parent)) {
      walk(parent, [...trail, code]);
    }
    state.set(code, 'done');
  };

  for (const code of feed.categories.keys()) walk(code, []);
}

/**
 * Axis coverage and uniqueness.
 *
 * Two variants sharing an axis-value combination is fatal at the API once the
 * axes carry the CombinationUnique constraint, and it is the single most common
 * consequence of collapsing a multi-level source hierarchy wrongly. Catching it
 * here names every offender; the API names one.
 */
function checkAxes(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  for (const product of feed.products.values()) {
    const axes = product.axes ?? [];
    const skus = feed.variantsByProduct.get(product.code) ?? [];
    const origin = feed.origin.get(`product:${product.code}`) ?? {};

    if (axes.length === 0) {
      if (skus.length > 1) {
        diagnostics.push({
          severity: 'error',
          code: 'axes-missing',
          message:
            `Product '${product.code}' declares no axes but has ${skus.length} variants. ` +
            'Without an axis there is nothing to tell the variants apart, and a storefront ' +
            'cannot build a variant selector. Declare the axes, or split the product.',
          ...origin,
        });
      }
      continue;
    }

    const combinations = new Map<string, string>();
    for (const sku of skus) {
      const variant = feed.variants.get(sku);
      if (!variant) continue;
      const values = variant.axisValues ?? {};

      const missing = axes.filter((a) => values[a] === undefined || values[a] === '');
      if (missing.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'axis-value-missing',
          message:
            `Variant '${sku}' is missing a value for axis ${missing.map((m) => `'${m}'`).join(', ')}. ` +
            'Every variant must supply every axis, or variant identity is undefined.',
          ...(feed.origin.get(`variant:${sku}`) ?? {}),
        });
        continue;
      }

      const extra = Object.keys(values).filter((k) => !axes.includes(k));
      if (extra.length > 0) {
        diagnostics.push({
          severity: 'warning',
          code: 'axis-value-undeclared',
          message:
            `Variant '${sku}' supplies axis value(s) ${extra.map((e) => `'${e}'`).join(', ')} ` +
            `that product '${product.code}' does not declare in axes. They will be mapped as ` +
            'ordinary variant attributes, not as identity.',
          ...(feed.origin.get(`variant:${sku}`) ?? {}),
        });
      }

      const fingerprint = axes.map((a) => `${a}=${values[a]}`).join('|');
      const clash = combinations.get(fingerprint);
      if (clash !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'axis-combination-duplicate',
          message:
            `Variants '${clash}' and '${sku}' share the axis combination ${fingerprint}. ` +
            'Axes become CombinationUnique, so commercetools will reject the product. Either ' +
            'the hierarchy was collapsed wrongly, or an axis is missing from the declaration.',
          ...(feed.origin.get(`variant:${sku}`) ?? {}),
        });
      } else {
        combinations.set(fingerprint, sku);
      }
    }
  }
}

/**
 * Attributes written but not declared.
 *
 * Only meaningful when the feed carries declarations at all — an inferring run
 * derives definitions from exactly these values, so there is nothing to check.
 */
function checkDeclarations(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  if (feed.attributeDefinitions.size === 0) return;

  const declared = feed.attributeDefinitions;

  const check = (
    names: string[],
    level: 'product' | 'variant',
    owner: string,
    origin: Partial<Diagnostic>,
  ) => {
    for (const name of names) {
      const def = declared.get(name);
      if (!def) {
        diagnostics.push({
          severity: 'error',
          code: 'attribute-undeclared',
          message:
            `${owner} sets attribute '${name}', which no attributeDefinition declares. ` +
            'commercetools rejects the whole product when a variant carries an attribute ' +
            'the ProductType does not define.',
          ...origin,
        });
        continue;
      }
      if (def.level !== level) {
        diagnostics.push({
          severity: 'error',
          code: 'attribute-level-mismatch',
          message:
            `${owner} sets '${name}' at ${level} level, but it is declared as ` +
            `${def.level}-level. A product-level attribute becomes SameForAll and cannot ` +
            'differ between variants.',
          ...origin,
        });
      }
    }
  };

  for (const product of feed.products.values()) {
    check(
      Object.keys(product.attributes ?? {}),
      'product',
      `Product '${product.code}'`,
      feed.origin.get(`product:${product.code}`) ?? {},
    );

    // Axes must be declared as variant-level axis attributes, or the
    // CombinationUnique constraint never gets applied and nothing enforces
    // variant identity.
    for (const axis of product.axes ?? []) {
      const def = declared.get(axis);
      if (!def) {
        diagnostics.push({
          severity: 'error',
          code: 'axis-undeclared',
          message: `Product '${product.code}' declares axis '${axis}' with no matching attributeDefinition.`,
          ...(feed.origin.get(`product:${product.code}`) ?? {}),
        });
        continue;
      }
      if (def.axis !== true) {
        diagnostics.push({
          severity: 'warning',
          code: 'axis-not-flagged',
          message:
            `'${axis}' is used as an axis by product '${product.code}' but its definition ` +
            'does not set axis:true. It will still be mapped CombinationUnique; flag it in ' +
            'the definition so the intent is explicit.',
          ...(feed.origin.get(`attributeDefinition:${axis}`) ?? {}),
        });
      }
      if (def.type === 'ltext') {
        diagnostics.push({
          severity: 'error',
          code: 'axis-localized',
          message:
            `Axis '${axis}' is declared as ltext. A localized value must never be variant ` +
            'identity: the same SKU would key differently per language and break the moment ' +
            'a second locale is added. Use enum or lenum with a language-independent key, ' +
            'and put display text in axisLabels.',
          ...(feed.origin.get(`attributeDefinition:${axis}`) ?? {}),
        });
      }
    }
  }

  for (const variant of feed.variants.values()) {
    check(
      Object.keys(variant.attributes ?? {}),
      'variant',
      `Variant '${variant.sku}'`,
      feed.origin.get(`variant:${variant.sku}`) ?? {},
    );
  }

  // Declared but never populated: a source field silently dropped by the
  // adapter. Not fatal, but it is usually a mapping bug.
  const used = new Set<string>();
  for (const p of feed.products.values()) {
    Object.keys(p.attributes ?? {}).forEach((n) => used.add(n));
    (p.axes ?? []).forEach((n) => used.add(n));
  }
  for (const v of feed.variants.values()) {
    Object.keys(v.attributes ?? {}).forEach((n) => used.add(n));
  }
  for (const def of declared.values()) {
    // A product-level axis is a contradiction: 'product' level means invariant
    // across variants (SameForAll), an axis means it is what distinguishes
    // them (CombinationUnique). The schema documents the rule but cannot
    // express it, and derive resolves the pair silently in favour of the axis —
    // so without this the declaration says one thing and the ProductType says
    // another, with nothing reported.
    if (def.axis === true && def.level === 'product') {
      diagnostics.push({
        severity: 'error',
        code: 'axis-at-product-level',
        message:
          `Attribute '${def.name}' sets axis:true at level 'product'. An axis is what ` +
          "distinguishes a product's variants, so it has to be variant level; product " +
          'level means the value is invariant across them. Pick one: level "variant" to ' +
          'keep it as an axis, or drop axis:true to keep it invariant.',
        ...(feed.origin.get(`attributeDefinition:${def.name}`) ?? {}),
      });
    }

    if (!used.has(def.name)) {
      diagnostics.push({
        severity: 'warning',
        code: 'attribute-never-populated',
        message:
          `Attribute '${def.name}' is declared but no product or variant sets it. derive ` +
          'leaves it off every ProductType rather than create an attribute no product ' +
          'fills — usually a source field the adapter dropped.',
        ...(feed.origin.get(`attributeDefinition:${def.name}`) ?? {}),
      });
    }
  }
}

/**
 * The feed against the config it will be mapped with.
 *
 * Not a contract check — the feed is perfectly valid — but `validate` is the
 * earliest stage that holds both, and the pipeline's rule is that a defect is
 * reported by the earliest stage that can see it. Without this, a currency the
 * config does not describe survives validate and derive, then fails in `plan`
 * once per affected variant: the same defect, two stages later, multiplied by
 * the size of the catalog.
 *
 * Reported once per currency, with the first price that uses it, because the
 * fix is one config edit however many variants are involved.
 */
function checkAgainstConfig(
  feed: CatalogFeed,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  // Only one condition is needed: `loadConfig` already refuses a currency in
  // requiredCurrencies with no currencyFractionDigits entry, so anything
  // declared is guaranteed to have a digit count by the time the feed is read.
  // What it cannot know is which currencies the feed actually uses.
  const declared = new Set(config.market.requiredCurrencies);

  /** currency → first variant using it, for the file and line. */
  const firstUse = new Map<string, string>();
  const uses = new Map<string, number>();

  for (const variant of feed.variants.values()) {
    for (const price of variant.prices ?? []) {
      uses.set(price.currency, (uses.get(price.currency) ?? 0) + 1);
      if (!firstUse.has(price.currency)) firstUse.set(price.currency, variant.sku);
    }
  }

  checkCatalogModelFits(feed, config, diagnostics);
  checkMediaResolvable(feed, config, diagnostics);
  checkPriceReferences(feed, config, diagnostics);
  checkStoresAndSelections(feed, diagnostics);
  checkInventory(feed, diagnostics);
  checkTaxCategories(feed, config, diagnostics);
  checkPrefixNotDoubled(config, diagnostics);
  if (config.feed.subset === true) rollUpUnreferencedOnSubset(diagnostics);

  for (const [currency, sku] of firstUse) {
    if (declared.has(currency)) continue;

    diagnostics.push({
      severity: 'error',
      code: 'currency-not-configured',
      message:
        `Currency ${currency} appears on ${uses.get(currency)} price(s) — first on variant ` +
        `'${sku}' — but is not in market.requiredCurrencies. Two things follow: a project ` +
        'rejects money in a currency it does not accept, and the minor-unit digit count ' +
        'is unknown — assuming 2 does not error, it multiplies a 0-digit currency like ' +
        'JPY by 100. Add the currency and its fractionDigits to the config, or drop those ' +
        'prices in the adapter.',
      ...(feed.origin.get(`variant:${sku}`) ?? {}),
    });
  }
}

/** Declared prerequisites a subset feed is expected to leave unreferenced. */
const UNREFERENCED_ON_A_SUBSET = new Set(['tax-category-never-referenced', 'channel-never-referenced']);

/**
 * On a subset feed, replace the per-prerequisite "never referenced" warnings
 * with one line.
 *
 * The slice is the small first run the skill recommends before the full
 * catalog, and the products that use a tax category or channel are often
 * outside it, so each of these warnings is true of the slice and false of the
 * catalog. Dropping them silently would let the flag outlive the first run and
 * quietly hide the same finding on the full load, so the replacement names what
 * was held back and says when to turn the flag off.
 */
function rollUpUnreferencedOnSubset(diagnostics: Diagnostic[]): void {
  const held = diagnostics.filter((d) => UNREFERENCED_ON_A_SUBSET.has(d.code));
  if (held.length === 0) return;

  for (let i = diagnostics.length - 1; i >= 0; i--) {
    if (UNREFERENCED_ON_A_SUBSET.has(diagnostics[i].code)) diagnostics.splice(i, 1);
  }

  diagnostics.push({
    severity: 'warning',
    code: 'subset-unreferenced-declarations',
    message:
      `feed.subset is true, so ${held.length} declared prerequisite(s) nothing in this ` +
      'feed references are reported here rather than one by one: ' +
      held
        .map((d) => `${d.code === 'channel-never-referenced' ? 'channel' : 'tax category'} ${d.message.match(/'([^']+)'/)?.[1] ?? '?'}`)
        .join(', ') +
      '. Expected on a slice, because the products that use them may sit outside it. ' +
      'Remove feed.subset for the full load, where an unreferenced prerequisite is a real finding.',
  });
}

/**
 * Relative image URLs against `media.baseUrl`.
 *
 * A source that stores `/medias/sys_master/...` keeps the host somewhere the
 * export does not reach — a CDN setting, a storefront config, an operations
 * runbook. The host therefore cannot be derived, only supplied, and supplying
 * the wrong one loads a catalog whose every image 404s with nothing in the
 * pipeline able to notice.
 *
 * So this is an **error the user has to resolve, not a warning to note**. The
 * previous design was worse than silent: `image.url` was `format: uri`, which
 * made a relative path a schema violation, so the only way to get a feed to
 * validate was to invent a hostname — which is exactly what an engagement did.
 * Refusing with the decision named is what stops that.
 */
function checkMediaResolvable(
  feed: CatalogFeed,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  // Images and asset sources together. Assets are media too, and a second
  // media path with its own rules is how one of them ends up unresolved.
  const relative: { owner: string; kind: string; url: string }[] = [];
  let absolute = 0;

  const note = (owner: string, kind: string, url: string) => {
    if (isAbsoluteUrl(url)) absolute++;
    else relative.push({ owner, kind, url });
  };

  for (const variant of feed.variants.values()) {
    for (const image of variant.images ?? []) note(`variant:${variant.sku}`, 'image', image.url);
    for (const asset of variant.assets ?? []) {
      for (const source of asset.sources) {
        note(`variant:${variant.sku}`, `asset '${asset.code}' source`, source.uri);
      }
    }
  }
  for (const category of feed.categories.values()) {
    for (const asset of category.assets ?? []) {
      for (const source of asset.sources) {
        note(`category:${category.code}`, `asset '${asset.code}' source`, source.uri);
      }
    }
  }

  if (relative.length === 0) return;

  const base = config.media?.baseUrl;
  if (base === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'media-base-url-required',
      message:
        `${relative.length} media URL(s) are relative — first is the ` +
        `${relative[0].kind} on ${relative[0].owner}: '${relative[0].url}'` +
        (absolute > 0 ? ` (${absolute} other media URL(s) are already absolute)` : '') +
        '.\n' +
        '      commercetools stores image URLs verbatim and serves them as given, so a ' +
        'relative one resolves against whatever page renders it and breaks everywhere ' +
        'else. The host is not in the export and must not be guessed: a wrong one loads ' +
        'a catalog whose every image 404s, and nothing downstream can detect that.\n' +
        '      **This is a decision for whoever owns the storefront or CDN.** Once they ' +
        'confirm it, set it in the config and re-run:\n' +
        '        "media": { "baseUrl": "https://cdn.example.com/" }\n' +
        '      Relative URLs are then resolved against it at map time and the resolution ' +
        'is recorded as a decision. If the source truly has no host, the alternative is ' +
        'to drop the media in the adapter and report it as not migrated — an absent ' +
        'image is recoverable, a wrong URL on every product is not.',
      ...(feed.origin.get(relative[0].owner) ?? {}),
    });
  }
}

/**
 * Price scope references against what the feed declares.
 *
 * `price.channel` and `price.customerGroup` become KeyReferences, and **the
 * Import API can create neither resource** — there is no channel or
 * customer-group import. So a reference to something the project does not hold
 * becomes an Import Operation that sits `unresolved` for 48 hours and then
 * expires, taking the price with it and reporting nothing. That is the worst
 * failure shape this pipeline has: a green load and a partly priced catalog,
 * discovered weeks later.
 *
 * Requiring a declaration is what makes it checkable. It is stricter than the
 * API — a channel that exists in the project loads fine undeclared — but the
 * declaration is one line and it is what lets `preflight` verify the
 * prerequisite before anything is written.
 */
function checkPriceReferences(
  feed: CatalogFeed,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const channelUses = new Map<string, string>();
  const groupUses = new Map<string, string>();

  for (const variant of feed.variants.values()) {
    for (const price of variant.prices ?? []) {
      if (price.channel && !channelUses.has(price.channel)) {
        channelUses.set(price.channel, variant.sku);
      }
      if (price.customerGroup && !groupUses.has(price.customerGroup)) {
        groupUses.set(price.customerGroup, variant.sku);
      }
    }
  }

  for (const [code, sku] of channelUses) {
    if (!feed.channels.has(code)) {
      diagnostics.push({
        severity: 'error',
        code: 'undeclared-channel',
        message:
          `A price on variant '${sku}' is scoped to channel '${code}', which no channel ` +
          'record declares. The Import API cannot create a channel, so an undeclared one ' +
          'cannot be verified — and a price referencing a channel the project does not ' +
          'hold becomes an operation that sits unresolved for 48 hours and then expires, ' +
          'silently.\n' +
          `      Declare it: {"_type":"channel","code":"${code}",` +
          '"roles":["ProductDistribution"]}. The code is the channel\'s key in the ' +
          'project, verbatim — it is not prefixed, because the channel already exists ' +
          'there. `preflight` then checks it does.',
        ...(feed.origin.get(`variant:${sku}`) ?? {}),
      });
    }
  }

  for (const [code, sku] of groupUses) {
    if (!feed.customerGroups.has(code)) {
      diagnostics.push({
        severity: 'error',
        code: 'undeclared-customer-group',
        message:
          `A price on variant '${sku}' is scoped to customer group '${code}', which no ` +
          'customerGroup record declares. Same reason as an undeclared channel: the ' +
          'Import API cannot create one, so the reference expires unresolved after 48 ' +
          `hours. Declare it: {"_type":"customerGroup","code":"${code}"}.`,
        ...(feed.origin.get(`variant:${sku}`) ?? {}),
      });
    }
  }

  // A price-scoped channel without ProductDistribution: the API rejects a
  // StandalonePrice referencing one outright (MissingRoleOnChannelError), and
  // under embedded pricing it simply cannot act as a distribution channel.
  const standalone = config.target.priceMode === 'standalone';
  for (const [code, sku] of channelUses) {
    const channel = feed.channels.get(code);
    if (!channel || channel.roles.includes('ProductDistribution')) continue;
    diagnostics.push({
      severity: standalone ? 'error' : 'warning',
      code: 'channel-missing-product-distribution',
      message:
        `Channel '${code}' is scoped to a price (first on variant '${sku}') but declares ` +
        `roles [${channel.roles.join(', ')}] without ProductDistribution. ` +
        (standalone
          ? 'The API refuses a StandalonePrice referencing such a channel outright — ' +
            'MissingRoleOnChannelError, "does not have the required role".'
          : 'The price will import, but the channel cannot act as a distribution channel, ' +
            'so channel-scoped price selection will not find it.'),
      ...(feed.origin.get(`channel:${code}`) ?? {}),
    });
  }

  // Declared and never used: usually a channel mapped from the source that no
  // price actually references, which is worth knowing before it is created.
  // Distribution and supply are tracked apart on purpose. A *supply* channel
  // having no prices is not a finding — inventory is all it is for — and
  // lumping the two together reported every warehouse as a pricing mistake.
  const distributionReferenced = new Set<string>();
  const supplyReferenced = new Set<string>();
  for (const store of feed.stores.values()) {
    for (const c of store.distributionChannels ?? []) distributionReferenced.add(c);
    for (const c of store.supplyChannels ?? []) supplyReferenced.add(c);
  }
  // Stock is a use in its own right: `load` has to create the channel before
  // the entries can resolve, whether or not any store lists it. Counting only
  // prices and stores told a stock-only feed that its warehouses were
  // prerequisites "the project does not actually need".
  const stockedChannels = new Set<string>();
  for (const entry of feed.inventoryEntries.values()) {
    if (entry.supplyChannel) stockedChannels.add(entry.supplyChannel);
  }

  for (const [code] of feed.channels) {
    if (!channelUses.has(code) && (supplyReferenced.has(code) || stockedChannels.has(code))) {
      continue;
    }
    if (!channelUses.has(code) && distributionReferenced.has(code)) {
      // A store trades through it, so the project needs it — but nothing is
      // priced into it, so shoppers in that store see only channel-less
      // prices. Legal, and almost never intended.
      diagnostics.push({
        severity: 'warning',
        code: 'distribution-channel-without-prices',
        message:
          `Channel '${code}' is listed by a store but no price is scoped to it. Price ` +
          'selection in that store will fall through to prices with no channel, so the ' +
          'channel has no effect on what a shopper pays.',
        ...(feed.origin.get(`channel:${code}`) ?? {}),
      });
      continue;
    }
    if (!channelUses.has(code)) {
      diagnostics.push({
        severity: 'warning',
        code: 'channel-never-referenced',
        message:
          `Channel '${code}' is declared but no price, stock entry or store references it. ` +
          'Nothing will break, but it is a prerequisite the project does not actually need ' +
          'for this load.',
        ...(feed.origin.get(`channel:${code}`) ?? {}),
      });
    }
  }
}

/**
 * Stores and product selections, and the references between them.
 *
 * These two are the only records whose whole purpose is to point at other
 * records, so almost every failure here is a dangling reference or an
 * activation rule that reads backwards. None of it is visible at load time:
 * a store with a mis-wired selection imports cleanly and sells nothing.
 */
function checkStoresAndSelections(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  const selectionUses = new Map<string, string>();

  for (const product of feed.products.values()) {
    const skus = new Set(feed.variantsByProduct.get(product.code) ?? []);
    const seen = new Set<string>();

    for (const m of product.selections ?? []) {
      if (!feed.productSelections.has(m.code)) {
        diagnostics.push({
          severity: 'error',
          code: 'selection-not-declared',
          message:
            `Product '${product.code}' is assigned to product selection '${m.code}', which ` +
            'no productSelection record declares. The assignment is part of the selection ' +
            'resource, so an undeclared selection means the assignment is simply dropped — ' +
            'no operation fails and no product is missing, the assortment is just wrong.\n' +
            `      Declare it: {"_type":"productSelection","code":"${m.code}","name":{...}}.`,
          ...(feed.origin.get(`product:${product.code}`) ?? {}),
        });
        continue;
      }
      if (seen.has(m.code)) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-selection-membership',
          message:
            `Product '${product.code}' is assigned to selection '${m.code}' twice. One ` +
            'product has at most one assignment per selection, so the second would ' +
            'overwrite the first and the SKU list that survives is decided by feed order.',
          ...(feed.origin.get(`product:${product.code}`) ?? {}),
        });
      }
      seen.add(m.code);
      if (!selectionUses.has(m.code)) selectionUses.set(m.code, product.code);

      // SKU lists have to name variants of *this* product: the assignment is
      // (selection, product), and a SKU from elsewhere silently selects nothing.
      for (const [field, list] of [
        ['includeSkus', m.includeSkus],
        ['excludeSkus', m.excludeSkus],
      ] as const) {
        for (const sku of list ?? []) {
          if (skus.has(sku)) continue;
          diagnostics.push({
            severity: 'error',
            code: 'selection-sku-not-on-product',
            message:
              `Product '${product.code}' assigns SKU '${sku}' via ${field} on selection ` +
              `'${m.code}', but that SKU is not one of its ${skus.size} variant(s). An ` +
              'assignment scopes variants of the product it is on, so this SKU selects ' +
              'nothing — and the platform prunes unknown SKUs from the list silently.',
            ...(feed.origin.get(`product:${product.code}`) ?? {}),
          });
        }
      }
    }
  }

  // A selection nothing is assigned to. Harmless under IndividualExclusion —
  // an empty denylist excludes nothing — and fatal under Individual, where an
  // empty allowlist exposes no products at all.
  for (const [code, selection] of feed.productSelections) {
    if (selectionUses.has(code)) continue;
    const exclusion = selection.mode === 'IndividualExclusion';
    diagnostics.push({
      severity: exclusion ? 'warning' : 'error',
      code: 'selection-empty',
      message: exclusion
        ? `Product selection '${code}' is declared with mode IndividualExclusion and no ` +
          'product is assigned to it. An empty denylist excludes nothing, so any store ' +
          'using it offers the full catalog — which may be what you want, or may mean the ' +
          'exclusions were never mapped.'
        : `Product selection '${code}' has mode Individual and no product assigned to it. ` +
          'An empty allowlist offers **nothing**, so every store using it would sell an ' +
          'empty catalog.\n' +
          '      Assign products with `selections` on the product records, or drop the ' +
          'selection.',
      ...(feed.origin.get(`productSelection:${code}`) ?? {}),
    });
  }

  for (const store of feed.stores.values()) {
    const at = feed.origin.get(`store:${store.code}`) ?? {};

    const channelRole = (code: string, role: string, field: string) => {
      const channel = feed.channels.get(code);
      if (!channel) {
        diagnostics.push({
          severity: 'error',
          code: 'store-channel-not-declared',
          message:
            `Store '${store.code}' lists channel '${code}' in ${field}, which no channel ` +
            'record declares. A store cannot be created referencing a channel that does ' +
            `not exist.\n      Declare it: {"_type":"channel","code":"${code}","roles":["${role}"]}.`,
          ...at,
        });
        return;
      }
      if (!channel.roles.includes(role as never)) {
        diagnostics.push({
          severity: 'error',
          code: 'store-channel-role-insufficient',
          message:
            `Store '${store.code}' lists channel '${code}' in ${field}, but that channel's ` +
            `roles are [${channel.roles.join(', ')}] and ${field} requires ${role}. The API ` +
            'refuses the store.',
          ...at,
        });
      }
    };

    for (const code of store.distributionChannels ?? []) {
      channelRole(code, 'ProductDistribution', 'distributionChannels');
    }
    for (const code of store.supplyChannels ?? []) {
      channelRole(code, 'InventorySupply', 'supplyChannels');
    }

    // A supply channel is wiring; the stock is the inventoryEntry records that
    // name it. Wiring with nothing behind it is a store that looks like its
    // stock was migrated and holds none — so the warning is now about the
    // *empty* channels rather than about the pipeline's own limitations.
    const unstocked = (store.supplyChannels ?? []).filter(
      (code) => ![...feed.inventoryEntries.values()].some((e) => e.supplyChannel === code),
    );
    if (unstocked.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'store-supply-channel-unstocked',
        message:
          `Store '${store.code}' lists supply channel(s) [${unstocked.join(', ')}] that no ` +
          'inventory entry references. They will be created and wired to the store, and ' +
          'will hold zero stock until something else populates them.\n' +
          '      Correct as configuration, misleading as a migration result — record it.',
        ...at,
      });
    }

    const settings = store.productSelections ?? [];
    for (const setting of settings) {
      if (!feed.productSelections.has(setting.code)) {
        diagnostics.push({
          severity: 'error',
          code: 'store-selection-not-declared',
          message:
            `Store '${store.code}' references product selection '${setting.code}', which no ` +
            'productSelection record declares.',
          ...at,
        });
      }
    }

    // The activation rule that reads backwards. Straight from the API docs:
    // if every setting is inactive and at least one is Individual, the store
    // offers no products. An empty list, by contrast, offers all of them.
    if (settings.length > 0 && settings.every((x) => x.active === false)) {
      const anyIndividual = settings.some(
        (x) => (feed.productSelections.get(x.code)?.mode ?? 'Individual') === 'Individual',
      );
      if (anyIndividual) {
        diagnostics.push({
          severity: 'error',
          code: 'store-exposes-no-products',
          message:
            `Store '${store.code}' has ${settings.length} product selection(s) and every one ` +
            'is inactive, at least one of them with mode Individual. That combination ' +
            'offers **no products at all** — not the full catalog.\n' +
            '      A store with an *empty* selection list offers everything; a store whose ' +
            'only active-able selections are switched off offers nothing. Set at least one ' +
            'active, or remove the list entirely.',
          ...at,
        });
      }
    }
  }

  // A selection no store uses is inert: it is created, and changes nothing.
  for (const [code] of feed.productSelections) {
    const used = [...feed.stores.values()].some((st) =>
      (st.productSelections ?? []).some((x) => x.code === code),
    );
    if (used) continue;
    diagnostics.push({
      severity: 'warning',
      code: 'selection-not-used-by-any-store',
      message:
        `Product selection '${code}' is not referenced by any store. A selection has no ` +
        'effect until a store uses it, so this one will be created and change nothing.',
      ...(feed.origin.get(`productSelection:${code}`) ?? {}),
    });
  }
}

/**
 * Stock references: the SKU, and the supply channel.
 *
 * Both are things the Import API will not check for you, and they fail in
 * opposite ways. An entry for an unknown SKU imports **successfully** and
 * becomes stock against nothing — no error anywhere, at any stage, ever. An
 * entry naming a channel that does not exist imports into `unresolved`, waits
 * 48 hours and expires. The first is silent forever, the second is silent
 * until long after anyone is watching, so both are errors here.
 */
function checkInventory(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  for (const [id, entry] of feed.inventoryEntries) {
    const at = feed.origin.get(`inventoryEntry:${id}`) ?? {};

    if (!feed.variants.has(entry.sku)) {
      diagnostics.push({
        severity: 'error',
        code: 'inventory-sku-unknown',
        message:
          `Inventory entry for SKU '${entry.sku}' matches no variant in the feed. The ` +
          'Import API does not check this: the entry would import cleanly and hold stock ' +
          'against a SKU nothing sells.',
        ...at,
      });
    }

    const code = entry.supplyChannel;
    if (code === undefined) continue;

    const channel = feed.channels.get(code);
    if (!channel) {
      diagnostics.push({
        severity: 'error',
        code: 'inventory-channel-not-declared',
        message:
          `Inventory entry for SKU '${entry.sku}' is supplied by channel '${code}', which ` +
          'no channel record declares. An entry referencing a channel that does not exist ' +
          'stays unresolved for 48 hours and then expires, taking the stock with it.\n' +
          `      Declare it: {"_type":"channel","code":"${code}","roles":["InventorySupply"]}.`,
        ...at,
      });
      continue;
    }

    if (!channel.roles.includes('InventorySupply')) {
      diagnostics.push({
        severity: 'error',
        code: 'inventory-channel-role-insufficient',
        message:
          `Inventory entry for SKU '${entry.sku}' is supplied by channel '${code}', whose ` +
          `roles are [${channel.roles.join(', ')}]. Stock needs InventorySupply, and a ` +
          'store cannot list the channel as a supply channel without it.',
        ...at,
      });
    }
  }

  // The reverse of store-supply-channel-unstocked: stock in a channel no store
  // lists. Per the Product Projections docs, a store with `supplyChannels` set
  // projects only entries on those channels (plus channel-less ones); a store
  // without them filters nothing. So the stock is hidden only when some store
  // filters and none lists the channel — with no filtering store, every read
  // sees it and there is nothing to say. A warning, not an error: stores may
  // be created after cutover, and stock read by channel is legitimate.
  const listed = new Set<string>();
  const filtering: string[] = [];
  for (const store of feed.stores.values()) {
    const codes = store.supplyChannels ?? [];
    if (codes.length > 0) filtering.push(store.code);
    for (const code of codes) listed.add(code);
  }
  if (filtering.length === 0) return;
  const unreachable = new Map<string, string[]>();
  for (const entry of feed.inventoryEntries.values()) {
    const code = entry.supplyChannel;
    if (code === undefined || listed.has(code)) continue;
    // An undeclared channel or a wrong role is already an error above.
    if (!feed.channels.get(code)?.roles.includes('InventorySupply')) continue;
    const skus = unreachable.get(code) ?? [];
    skus.push(entry.sku);
    unreachable.set(code, skus);
  }
  for (const [code, skus] of unreachable) {
    const sample = skus.slice(0, 3).join(', ') + (skus.length > 3 ? ', …' : '');
    diagnostics.push({
      severity: 'warning',
      code: 'inventory-supply-channel-not-in-store',
      message:
        `Supply channel '${code}' holds ${skus.length} inventory entr${skus.length === 1 ? 'y' : 'ies'} ` +
        `(${sample}) and no store lists it. The stock will import, and reads through ` +
        `store(s) [${filtering.join(', ')}] will not see it: a store with supply channels ` +
        'projects stock only from those channels.\n' +
        '      Add the channel to the supplyChannels of the store(s) that sell from it — or, ' +
        'if stores come later or stock is read by channel, record that decision.',
      ...(feed.origin.get(`channel:${code}`) ?? {}),
    });
  }
}

/**
 * Tax categories: the references to them, their rates, and the products that
 * have none.
 *
 * The reference is an error for a sharper reason than a price's channel. A
 * product draft whose `taxCategory` does not resolve is held up **whole** —
 * variants, prices and all — and expires after 48 hours. One typo in a code
 * shared by a thousand products is a thousand products that never arrive.
 *
 * Everything else is a warning, because the feed cannot know the cart tax
 * mode. Under `External` or `ExternalAmount` an outside service supplies the
 * rate and a category needs none; under `Platform`, the default, a product
 * with no category or a category with no rate for the shipping country cannot
 * be taxed at checkout. None of that shows at load time, so it is said here.
 */
function checkTaxCategories(
  feed: CatalogFeed,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  /** category code → first product using it. */
  const uses = new Map<string, string>();
  const untaxed: string[] = [];

  for (const product of feed.products.values()) {
    const code = product.taxCategory;
    if (code === undefined) {
      untaxed.push(product.code);
      continue;
    }
    if (!uses.has(code)) uses.set(code, product.code);
    if (feed.taxCategories.has(code)) continue;
    diagnostics.push({
      severity: 'error',
      code: 'undeclared-tax-category',
      message:
        `Product '${product.code}' references tax category '${code}', which no ` +
        'taxCategory record declares. The Import API cannot create a tax category, and ' +
        'a product whose reference does not resolve is held up whole — variants and ' +
        'prices with it — then expires after 48 hours.\n' +
        `      Declare it: {"_type":"taxCategory","code":"${code}","rates":[...]}. The ` +
        "code is the category's key in the project, verbatim. `load` creates it if it " +
        'is missing and leaves it alone if it exists.',
      ...(feed.origin.get(`product:${product.code}`) ?? {}),
    });
  }

  // An outside service supplies the rate under these modes, so a product with
  // no category is correct, not a gap. The config records the interview's answer;
  // without it the warning stays, because Platform is the default.
  const taxFromProduct =
    config.target.taxMode !== 'External' && config.target.taxMode !== 'ExternalAmount';

  if (taxFromProduct && untaxed.length > 0 && feed.products.size > 0) {
    const none = feed.taxCategories.size === 0;
    diagnostics.push({
      severity: 'warning',
      code: 'products-without-tax-category',
      message:
        (none
          ? `No tax category is declared, so none of the ${feed.products.size} product(s) ` +
            'will have one.'
          : `${untaxed.length} of ${feed.products.size} product(s) have no tax category — ` +
            `first '${untaxed[0]}'.`) +
        ' Under the default Platform tax mode a cart takes its rate from the product\'s ' +
        'tax category, so these cannot be taxed at checkout; the load and verify both ' +
        'pass regardless.\n' +
        '      Correct if carts use External or ExternalAmount tax mode, where an outside ' +
        'service supplies the rate: record that as target.taxMode in the config and this ' +
        'stops. Otherwise declare a taxCategory and set it on the products — which tax ' +
        'mode the project uses is a question for whoever owns tax.',
      ...(feed.origin.get(`product:${untaxed[0]}`) ?? {}),
    });
  }

  // Countries something is sold into: where a price is scoped, and where a
  // store trades. A rate is only selected by exact country match, so a gap
  // here is a cart that cannot be taxed for that destination.
  const storeCountries = new Set<string>();
  for (const store of feed.stores.values()) {
    for (const c of store.countries ?? []) storeCountries.add(c);
  }

  for (const [code, category] of feed.taxCategories) {
    const at = feed.origin.get(`taxCategory:${code}`) ?? {};
    const rates = category.rates ?? [];

    const scopes = new Map<string, number>();
    rates.forEach((rate, i) => {
      const scope = taxRateScope(rate);
      const subSum = subRateSumMismatch(rate.amount, rate.subRates);
      if (subSum !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'tax-subrates-sum-mismatch',
          message:
            `Tax category '${code}', rate for ${scope}: the sub-rates sum to ${subSum} but ` +
            `amount is ${rate.amount}. The API refuses a rate whose total and portions ` +
            'differ, and refuses the whole category with it, which then holds up every ' +
            'product that references it. Make amount the sum of the sub-rates.',
          ...at,
        });
      }
      if (rate.taxRoundingTarget !== undefined && !rate.includedInPrice) {
        diagnostics.push({
          severity: 'warning',
          code: 'tax-rounding-target-ignored',
          message:
            `Tax category '${code}', rate for ${scope}: taxRoundingTarget is ` +
            `'${rate.taxRoundingTarget}' but includedInPrice is false. The target only ` +
            'decides which derived amount is rounded when tax is carved out of a gross ' +
            'price, so here it has no effect. The API accepts and stores it anyway; drop ' +
            'it unless includedInPrice is meant to be true.',
          ...at,
        });
      }
      const prior = scopes.get(scope);
      if (prior !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-tax-rate-scope',
          message:
            `Tax category '${code}' has two rates for ${scope} (rates[${prior}] and ` +
            `rates[${i}]). The API allows one rate per country and state and refuses the ` +
            'category, which then holds up every product that references it.',
          ...at,
        });
        return;
      }
      scopes.set(scope, i);
    });

    if (!uses.has(code)) {
      diagnostics.push({
        severity: 'warning',
        code: 'tax-category-never-referenced',
        message:
          `Tax category '${code}' is declared but no product references it. It will still ` +
          'be created if the project lacks it — a write outside the catalog that nothing ' +
          'in this load needs.',
        ...at,
      });
      continue;
    }

    // Both checks below are about the rate a cart will find. Under External or
    // ExternalAmount an outside service supplies it, so a category with no
    // rates, or none for a country, is the intended shape rather than a gap.
    if (!taxFromProduct) continue;

    if (rates.length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'tax-category-without-rates',
        message:
          `Tax category '${code}' declares no rates. Correct if carts use External or ` +
          'ExternalAmount tax mode: set target.taxMode and this stops. Under Platform, ' +
          'every cart containing one of its products fails to calculate tax — and if the ' +
          "category already exists in the project, the project's own rates are the ones " +
          'that apply.',
        ...at,
      });
      continue;
    }

    const sold = new Set(storeCountries);
    for (const product of feed.products.values()) {
      if (product.taxCategory !== code) continue;
      for (const sku of feed.variantsByProduct.get(product.code) ?? []) {
        for (const price of feed.variants.get(sku)?.prices ?? []) {
          if (price.country) sold.add(price.country);
        }
      }
    }
    const rated = new Set(rates.map((r) => r.country));
    const uncovered = [...sold].filter((c) => !rated.has(c)).sort();
    if (uncovered.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'tax-rate-country-missing',
        message:
          `Tax category '${code}' has no rate for [${uncovered.join(', ')}], where its ` +
          'products are priced or a store trades. A rate is selected by exact country ' +
          'match on the shipping address, so under Platform tax mode a cart shipping ' +
          'there cannot be taxed. Under External or ExternalAmount an outside service ' +
          'supplies the rate: set target.taxMode and this stops.',
        ...at,
      });
    }
  }
}

/**
 * A `defaultKey` that already carries the prefix.
 *
 * ProductType keys are prefixed like every other resource, so a `defaultKey`
 * of `acme-apparel` under `keys.prefix: "acme"` becomes
 * `acme-acme-apparel`. Legal, permanent, and nobody's intent — I produced one
 * myself writing a test config, which is reasonable evidence it is easy to hit.
 *
 * A warning rather than an error: a prefix that genuinely repeats is
 * conceivable, and refusing would be the tool overruling a deliberate choice.
 */
function checkPrefixNotDoubled(config: PipelineConfig, diagnostics: Diagnostic[]): void {
  const prefix = `${config.keys.prefix}-`;
  const key = config.productTypes.defaultKey;
  if (!key.startsWith(prefix)) return;
  diagnostics.push({
    severity: 'warning',
    code: 'product-type-key-doubles-prefix',
    message:
      `productTypes.defaultKey is '${key}' and keys.prefix is ` +
      `'${config.keys.prefix}', so the ProductType will be keyed ` +
      `'${prefix}${key}' — the prefix twice.\n` +
      `      Every resource key is prefixed, so drop it from defaultKey: ` +
      `'${key.slice(prefix.length)}' produces '${key}'. A key cannot be changed once ` +
      'products reference the ProductType.',
  });
}

/** Absolute means it has a scheme; anything else resolves against a base. */
function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//');
}

/**
 * Which catalog model this catalog actually needs, answered from the feed.
 *
 * The variant ceiling is the one project-level decision the data can settle on
 * its own, and `validate` can do it with no credentials and no plan. That is
 * worth saying plainly rather than leaving the config to guess: a greenfield
 * project switches between models with a single `setProductCatalogModel`
 * action, so a catalog whose largest product has 480 variants should be told it
 * needs Modular — not told to split its products, which would be changing the
 * catalog to fit the tool.
 *
 * Silent when the catalog fits. A recommendation nobody needs is noise.
 */
function checkCatalogModelFits(
  feed: CatalogFeed,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  let largest = { code: '', variants: 0 };
  const overflowing: string[] = [];

  for (const [code, skus] of feed.variantsByProduct) {
    if (skus.length > largest.variants) largest = { code, variants: skus.length };
    if (skus.length > MAX_VARIANTS_CLASSIC) overflowing.push(code);
  }

  if (largest.variants === 0) return;

  const needed = requiredCatalogModel(largest.variants);

  if (needed === 'Modular' && config.target.catalogModel === 'Classic') {
    diagnostics.push({
      severity: 'error',
      code: 'catalog-model-insufficient',
      message:
        `This catalog needs the Modular catalog model. ${overflowing.length} product(s) ` +
        `exceed the Classic limit of ${MAX_VARIANTS_CLASSIC} variants — the largest, ` +
        `'${largest.code}', has ${largest.variants}. Modular raises the ceiling to ` +
        `${MAX_VARIANTS_MODULAR}.\n` +
        "      Set target.catalogModel to 'Modular' and re-run `plan`: the import shape " +
        'is decided at map time, so changing the config alone is not enough. Modular ' +
        "also forces target.priceMode to 'standalone', since it has no embedded prices. " +
        'The project itself must be switched too — one setProductCatalogModel action, ' +
        'which `preflight` verifies but will not perform.\n' +
        '      Splitting products to fit Classic is not the answer: that changes the ' +
        'catalog model rather than migrating it.',
      ...(feed.origin.get(`product:${largest.code}`) ?? {}),
    });
    return;
  }

  if (largest.variants > VARIANT_WARN_THRESHOLD && needed === 'Classic') {
    diagnostics.push({
      severity: 'warning',
      code: 'approaching-variant-limit',
      message:
        `Product '${largest.code}' has ${largest.variants} variants, close to the Classic ` +
        `limit of ${MAX_VARIANTS_CLASSIC}. Classic fits this catalog today, but a range ` +
        'that grows will not. Worth deciding now, while the project is greenfield and ' +
        'the catalog model is still a free choice.',
      ...(feed.origin.get(`product:${largest.code}`) ?? {}),
    });
  }
}

/**
 * `externalId` set where commercetools has nowhere to put it.
 *
 * The contract accepts it on categories, products and variants. Only
 * `CategoryImport` has the field — `ProductDraftImport` and `VariantImport` do
 * not — so a product or variant `externalId` is accepted by the schema,
 * carried through the feed, and then silently dropped at map time.
 *
 * Reported rather than documented-and-forgotten. An adapter author who set it
 * has an ERP or PIM join key they intend to keep, and the whole point of this
 * pipeline is that a field which does not survive says so instead of going
 * quiet. Found by an engagement that set it on 90 variants and had to read the
 * mapper to discover it went nowhere.
 */
function checkUnmappedExternalId(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  const report = (kind: 'product' | 'variant', ids: string[]) => {
    if (ids.length === 0) return;
    diagnostics.push({
      severity: 'warning',
      code: 'external-id-not-mapped',
      message:
        `${ids.length} ${kind}(s) set externalId (e.g. '${ids[0]}'), which commercetools ` +
        `has no field for on a ${kind}: only Category has externalId. The value would be ` +
        'dropped at map time.\n' +
        '      If it is a join key a downstream system needs — an ERP article number, a ' +
        'PIM id — declare it as an attribute and emit it as one. If it is only feed ' +
        'provenance, this warning is the expected outcome.',
      ...(feed.origin.get(`${kind}:${ids[0]}`) ?? {}),
    });
  };

  report(
    'product',
    [...feed.products.values()].filter((p) => p.externalId !== undefined).map((p) => p.code),
  );
  report(
    'variant',
    [...feed.variants.values()].filter((v) => v.externalId !== undefined).map((v) => v.sku),
  );
}

function checkMasterVariants(feed: CatalogFeed, diagnostics: Diagnostic[]): void {
  for (const [code, skus] of feed.variantsByProduct) {
    const claimed = skus.filter((sku) => feed.variants.get(sku)?.isMaster === true);
    if (claimed.length > 1) {
      diagnostics.push({
        severity: 'error',
        code: 'multiple-master-variants',
        message:
          `Product '${code}' has ${claimed.length} variants claiming isMaster ` +
          `(${claimed.join(', ')}). Exactly one variant can be the master.`,
        ...(feed.origin.get(`product:${code}`) ?? {}),
      });
    }
  }
}
