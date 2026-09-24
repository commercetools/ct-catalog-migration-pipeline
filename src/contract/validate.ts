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
  type CatalogFeed,
  type FeedAttributeDefinition,
  type FeedCategory,
  type FeedChannel,
  type FeedCustomerGroup,
  type FeedProduct,
  type FeedProductSelection,
  type FeedRecord,
  type FeedStore,
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

function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
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
          message: describeErrors(validate),
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
          `Attribute '${def.name}' is declared but no product or variant sets it. It will ` +
          'be created on the ProductType and stay empty — usually a source field the ' +
          'adapter dropped.',
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
  checkPrefixNotDoubled(config, diagnostics);

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

  for (const [code] of feed.channels) {
    if (!channelUses.has(code) && supplyReferenced.has(code)) continue;
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
          `Channel '${code}' is declared but no price is scoped to it. Nothing will break, ` +
          'but it is a prerequisite the project does not actually need for this load.',
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

    // Carried for fidelity, but this pipeline imports no inventory. Saying so
    // is the difference between a correctly configured store and a store that
    // looks like its stock was migrated.
    if ((store.supplyChannels ?? []).length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'store-inventory-not-migrated',
        message:
          `Store '${store.code}' declares ${store.supplyChannels!.length} supply ` +
          'channel(s). They will be created and wired to the store, but this pipeline ' +
          'imports no inventory, so every one of them will hold zero stock until ' +
          'something else populates it.\n' +
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
