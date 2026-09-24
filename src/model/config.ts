/**
 * Pipeline configuration.
 *
 * The dividing line: if a different source or target project would need a
 * different value, it is config. If it follows from how commercetools works, it
 * is code. Nothing source-system-specific belongs here either — that lives in
 * the adapter, upstream of the feed.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Which product catalog model the target project runs.
 *
 * Classic: variants embedded in the Product, 1-100 per Product, Embedded Prices
 * available. Modular: variants are standalone resources, up to 10000 per
 * Product, and Embedded Prices are NOT supported — pricing is exclusively
 * Standalone. This is a project-level setting (`productCatalogModel`) and it
 * changes which Import API requests are even legal, so it is not inferable.
 *
 * Both are supported as targets. Classic emits a ProductDraftImport carrying
 * its variants; Modular emits a container product plus VariantImport
 * resources, and forces `priceMode: 'standalone'` because Embedded Prices do
 * not exist there.
 */
export type CatalogModel = 'Classic' | 'Modular';

export interface PipelineConfig {
  feed: {
    /** Directory of *.ndjson feed files, relative to this config file. */
    dir: string;
  };

  target: {
    /**
     * Must match the project's actual `productCatalogModel`. Preflight reads
     * the project and refuses to load on mismatch, because the failure mode
     * otherwise is a wall of rejected operations.
     */
    catalogModel: CatalogModel;
    /**
     * Both modes are supported on Classic; Modular allows only 'standalone'.
     * 'embedded' writes prices inside the variant; 'standalone' writes
     * StandalonePrice resources keyed by SKU and sets the product's priceMode
     * to 'Standalone'.
     *
     * Mixing both types on one product is possible but degrades performance,
     * so this is deliberately a single choice.
     *
     * Note the scope difference: 'standalone' needs `manage_standalone_prices`,
     * which `manage_products` does NOT grant.
     */
    priceMode: 'embedded' | 'standalone';
  };

  market: {
    /** IETF tags (en-GB), not underscore form (en_GB). */
    defaultLocale: string;
    /** Locales the project must accept before any write. */
    requiredLocales: string[];
    requiredCurrencies: string[];
    /**
     * Minor-unit digits per currency. commercetools money is expressed in minor
     * units and the count is NOT 2 everywhere — JPY and KRW are 0, BHD, KWD,
     * OMR and TND are 3. A missing entry is a hard error rather than a default,
     * because defaulting to 2 does not fail: it multiplies the price by 100.
     */
    currencyFractionDigits: Record<string, number>;
  };

  /** Every created key is `<prefix>-<sourceCode>`, which is what bounds teardown. */
  keys: { prefix: string };

  /**
   * Media resolution. Only needed when the feed carries relative image URLs.
   *
   * Sources very often store a site-relative path and keep the host
   * elsewhere — a CDN setting, a storefront config, nothing in the export at
   * all. `baseUrl` is what a relative URL is resolved against, and it cannot
   * be guessed: a wrong host loads a catalog whose every image 404s, and
   * nothing downstream can tell. So `validate` refuses a feed with relative
   * URLs and no `baseUrl` rather than letting the adapter invent one.
   */
  media?: {
    /** Absolute http(s) origin or prefix. A trailing slash is added if absent. */
    baseUrl?: string;
  };

  productTypes: {
    /**
     * What to do when the feed carries no attributeDefinition records.
     * 'infer' derives definitions from observed values and writes them to a
     * review file; 'require' refuses to proceed. Inference is a fallback.
     */
    onMissingDefinitions: 'infer' | 'require';
    /**
     * Key of the ProductType assigned to products that declare none. A single
     * shared type is usually right; one ProductType per product is a modelling
     * mistake worth refusing to generate.
     */
    defaultKey: string;
    defaultName: string;
    /**
     * How to model an attribute that is invariant across a product's variants.
     *
     * 'sameForAll' puts it at Variant level with the SameForAll constraint, so
     * it is readable from both Product Search and Product Projection Search.
     * 'native' uses the Product-level attribute, which is cleaner but is NOT
     * supported by Product Projection Search.
     *
     * Default to 'sameForAll' unless the storefront is known to use Product
     * Search exclusively.
     */
    productLevelStrategy: 'sameForAll' | 'native';
    /**
     * isSearchable for attributes that are not variant axes (axes are always
     * searchable). An attribute name shared across ProductTypes must agree on
     * this value or it becomes unavailable for search, filters and facets
     * everywhere — `derive` checks that.
     */
    searchableByDefault: boolean;
  };

  load: {
    /** Import API hard limit is 20 resources per request. */
    batchSize: number;
    /**
     * Stay under 200000 Import Operations per container for performance, and
     * under 1000 containers per project. Containers are organised by resource
     * type rather than by temporal batch, per the Import API best practices.
     */
    maxOperationsPerContainer: number;
  };
}

export interface LoadedConfig {
  config: PipelineConfig;
  /** Absolute path to the feed directory. */
  feedDir: string;
  configPath: string;
}

const REQUIRED_SECTIONS = [
  'feed',
  'target',
  'market',
  'keys',
  'productTypes',
  'load',
] as const;

/** The value the shipped template carries, so an unedited copy cannot run. */
const PREFIX_PLACEHOLDER = 'REPLACE-ME';

/** A key prefix has to produce legal keys: `<prefix>-<sourceCode>`. */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The fields with no safe default.
 *
 * Absent or misspelled, each of these either crashes a later stage with a
 * message about the wrong thing, or — worse — falls through to a value nobody
 * chose. `priceMode` is the reason this function exists: leave it out and the
 * mapper writes standalone prices while the gate expects embedded ones, which
 * happens to be caught, but by coincidence rather than design.
 *
 * Every message states the decision and what it costs to get wrong, because
 * this is the first thing a new engagement reads and the only place these
 * consequences are enforced rather than documented.
 */
function checkDecisions(config: PipelineConfig, configPath: string): void {
  const fail = (field: string, detail: string): never => {
    throw new Error(`${configPath}: ${field}\n${detail}`);
  };

  if (config.target.catalogModel === undefined) {
    fail(
      'target.catalogModel is missing.',
      "Set it to 'Classic' or 'Modular'. It must match the target project's\n" +
        'productCatalogModel, which preflight reads and checks — it is a project fact,\n' +
        'not a preference, and nothing offline can infer it. Modular also forces\n' +
        "target.priceMode to 'standalone'.",
    );
  }

  if (config.target.priceMode !== 'embedded' && config.target.priceMode !== 'standalone') {
    fail(
      `target.priceMode is ${JSON.stringify(config.target.priceMode)}.`,
      "It must be 'embedded' or 'standalone', and there is no safe default: the mode\n" +
        'decides whether prices are written inside the variants or as StandalonePrice\n' +
        'resources. A product whose priceMode disagrees with where its prices actually\n' +
        'are imports cleanly, reports every operation as imported, and then shows no\n' +
        'price at all. Match how the target implementation prices.',
    );
  }

  if (
    config.productTypes.productLevelStrategy !== 'sameForAll' &&
    config.productTypes.productLevelStrategy !== 'native'
  ) {
    fail(
      `productTypes.productLevelStrategy is ${JSON.stringify(
        config.productTypes.productLevelStrategy,
      )}.`,
      "It must be 'sameForAll' or 'native'. 'sameForAll' puts invariant attributes at\n" +
        'variant level with the SameForAll constraint, readable from both Product Search\n' +
        "and Product Projection Search. 'native' uses real Product-level attributes,\n" +
        'which Product Projection Search does not support at all. Choose sameForAll\n' +
        'unless the storefront is known to use Product Search exclusively.',
    );
  }

  if (
    config.productTypes.onMissingDefinitions !== 'infer' &&
    config.productTypes.onMissingDefinitions !== 'require'
  ) {
    fail(
      `productTypes.onMissingDefinitions is ${JSON.stringify(
        config.productTypes.onMissingDefinitions,
      )}.`,
      "It must be 'infer' or 'require'. 'require' refuses a feed that declares no\n" +
        "attribute definitions; 'infer' guesses each type from observed values and writes\n" +
        'the guesses to a review file. Inference is a fallback for a source that cannot\n' +
        'describe its own type system, not a default — the guesses become attribute\n' +
        'constraints, and those cannot be changed afterwards.',
    );
  }

  if (typeof config.productTypes.searchableByDefault !== 'boolean') {
    fail(
      `productTypes.searchableByDefault is ${JSON.stringify(
        config.productTypes.searchableByDefault,
      )}.`,
      'It must be true or false. The value has to agree across every ProductType that\n' +
        'shares an attribute name: where they disagree the attribute becomes unavailable\n' +
        'for search, filters and facets everywhere, and the import still succeeds — so\n' +
        'the facet just silently goes missing.',
    );
  }

  for (const [field, value] of [
    ['market.defaultLocale', config.market.defaultLocale],
    ['keys.prefix', config.keys.prefix],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      fail(`${field} is missing.`, 'It has no default and every stage depends on it.');
    }
  }

  for (const [field, value] of [
    ['market.requiredLocales', config.market.requiredLocales],
    ['market.requiredCurrencies', config.market.requiredCurrencies],
  ] as const) {
    if (!Array.isArray(value) || value.length === 0) {
      fail(
        `${field} is missing or empty.`,
        'Preflight checks the project accepts every locale and currency the plan needs,\n' +
          'so it needs to know what they are.',
      );
    }
  }

  if (config.keys.prefix === PREFIX_PLACEHOLDER) {
    fail(
      `keys.prefix is still '${PREFIX_PLACEHOLDER}'.`,
      'This is the shipped template, unedited. The prefix is written into every key\n' +
        'this migration creates and is what bounds a teardown to its own work, so it\n' +
        'has to name this engagement — there is no defensible default.\n' +
        'Before running, settle the five values that are decisions rather than\n' +
        'settings: see "Configuration, and the decisions it holds" in the README.',
    );
  }

  if (!PREFIX_PATTERN.test(config.keys.prefix)) {
    fail(
      `keys.prefix is '${config.keys.prefix}', which contains illegal characters.`,
      'Every key becomes `<prefix>-<sourceCode>`, and a key may hold only\n' +
        '[A-Za-z0-9_-]. A prefix outside that produces a plan the API rejects record\n' +
        'by record.',
    );
  }
}

export function loadConfig(configPath: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read pipeline config at ${configPath}.\n` +
        'A template ships at pipeline/migration.config.json — copy it, edit the copy to\n' +
        'describe your target project, then pass --config <path>. The five values that\n' +
        'are decisions rather than settings are listed under "Configuration, and the\n' +
        'decisions it holds" in the README.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const config = parsed as PipelineConfig;
  const missing = REQUIRED_SECTIONS.filter((s) => !config[s]);
  if (missing.length > 0) {
    throw new Error(
      `${configPath} is missing required section(s): ${missing.join(', ')}`,
    );
  }

  checkDecisions(config, configPath);

  // Modular fixes the project's price mode to Standalone — Embedded Prices do
  // not exist there at all — so this combination cannot be honoured, and the
  // failure would otherwise be a wall of rejected operations.
  if (config.target.catalogModel === 'Modular' && config.target.priceMode === 'embedded') {
    throw new Error(
      `${configPath}: target.catalogModel is 'Modular' but target.priceMode is\n` +
        "'embedded'. Modular does not support Embedded Prices at all — the project's\n" +
        'price mode is fixed to Standalone, and a VariantImport has no price field to\n' +
        "put them in.\n\nSet target.priceMode to 'standalone'.",
    );
  }

  // A missing fraction-digit entry produces prices that are wrong by a factor
  // of 100 rather than an error, so refuse up front.
  for (const currency of config.market.requiredCurrencies) {
    if (config.market.currencyFractionDigits[currency] === undefined) {
      throw new Error(
        `${configPath}: market.currencyFractionDigits has no entry for '${currency}'.\n` +
          'commercetools money is in minor units and the digit count is not 2 for every\n' +
          'currency (JPY/KRW are 0; BHD/KWD/OMR/TND are 3). Set it explicitly.',
      );
    }
  }

  if (config.media?.baseUrl !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(config.media.baseUrl);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error(
        `${configPath}: media.baseUrl is ${JSON.stringify(config.media.baseUrl)}, which is\n` +
          'not an absolute http(s) URL. It is the host relative image paths resolve\n' +
          "against, so a relative value would leave them relative. Example:\n" +
          "  \"media\": { \"baseUrl\": \"https://cdn.example.com/\" }",
      );
    }
  }

  if (config.load.batchSize > 20) {
    throw new Error(
      `${configPath}: load.batchSize is ${config.load.batchSize}, but the Import API\n` +
        'accepts at most 20 resources per request.',
    );
  }

  if (!config.market.requiredLocales.includes(config.market.defaultLocale)) {
    throw new Error(
      `${configPath}: market.defaultLocale '${config.market.defaultLocale}' is not in\n` +
        'market.requiredLocales. The default locale must be one the project accepts.',
    );
  }

  const base = dirname(configPath);
  const feedDir = isAbsolute(config.feed.dir)
    ? config.feed.dir
    : join(base, config.feed.dir);

  return { config, feedDir, configPath };
}

/** Minor-unit digits for a currency, e.g. 2 for GBP, 0 for JPY. */
export function fractionDigitsFor(config: PipelineConfig, currency: string): number {
  const digits = config.market.currencyFractionDigits[currency];
  if (digits === undefined) {
    throw new Error(
      `No market.currencyFractionDigits entry for '${currency}', which appeared on a ` +
        'price in the feed. Add it to the config.',
    );
  }
  return digits;
}

/**
 * Where artefacts go, resolved the same way the feed directory is.
 *
 * `feed.dir` is resolved relative to the **config file**; `--out` used to be
 * resolved relative to the **current directory**. With the config beside the
 * engagement and the commands run from `pipeline/`, that silently wrote
 * `out/` into the tool's own directory instead of the engagement's — which is
 * how a dogfood run lost its first `derive` output.
 *
 * An absolute `--out` is honoured unchanged. A relative one now follows the
 * config, so `--config ../migration/migration.config.json` puts artefacts in
 * `../migration/out` wherever it is run from. For the standalone case, where
 * the config sits in `pipeline/`, this resolves to exactly what it did before.
 */
export function outDirFor(opts: { out: string; config: string }): string {
  if (isAbsolute(opts.out)) return opts.out;
  return resolve(dirname(resolve(opts.config)), opts.out);
}
