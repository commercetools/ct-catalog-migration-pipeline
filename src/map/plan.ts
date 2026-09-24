/**
 * Feed + derived model → commercetools drafts.
 *
 * This stage constructs; it does not verify. Anything that has to be *resolved*
 * happens here — slugs, order hints, master variants, minor units — and the
 * audit gate then checks the result against the invariants the API enforces at
 * write time. Keeping the two apart means the audit can be trusted: it reads
 * the plan, not the intentions behind it.
 */

import type { PipelineConfig } from '../model/config.js';
import { fractionDigitsFor } from '../model/config.js';
import type {
  AttributeValue,
  CatalogFeed,
  FeedAsset,
  FeedPrice,
  FeedVariant,
} from '../model/feed.js';
import {
  attributeDefinitionsOf,
  LOAD_ORDER,
  typedAttribute,
  variantsOf,
  type Asset,
  type Attribute,
  type AttributeDefinition,
  type CategoryImport,
  type CategoryKeyReference,
  type DerivedModel,
  type Image,
  type MappingDecision,
  type MigrationPlan,
  type PriceDraftImport,
  type ProductDraftImport,
  type ProductVariantDraftImport,
  type ProductKeyReference,
  type ProductSelectionAssignment,
  type ProductSelectionImport,
  type ProductSelectionMode,
  type StandalonePriceImport,
  type VariantImport,
} from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import { allocateSlug, chooseMasterSku, orderHint, resourceKey } from './identity.js';
import { toTypedMoney } from './money.js';

/** Soft project limit on Categories. */
const MAX_CATEGORIES = 10000;

export interface PlanResult {
  plan: MigrationPlan;
  diagnostics: Diagnostic[];
}

export function buildPlan(
  feed: CatalogFeed,
  model: DerivedModel,
  config: PipelineConfig,
): PlanResult {
  const diagnostics: Diagnostic[] = [];
  const decisions: MappingDecision[] = [];

  // The 'native' strategy puts invariant attributes at Product level, which is
  // a different write shape than replicating them across variants. Refusing is
  // honest; silently writing them to the wrong place is not.
  if (config.productTypes.productLevelStrategy === 'native') {
    diagnostics.push({
      severity: 'error',
      code: 'native-product-level-not-mapped',
      message:
        "productTypes.productLevelStrategy is 'native', which derive supports but plan " +
        'does not yet: writing values to native Product-level attributes is a different ' +
        "shape from replicating them across variants. Use 'sameForAll' for now.",
    });
  }

  const categories = mapCategories(feed, config, decisions, diagnostics);
  const { products, variants, standalonePrices } = mapProducts(
    feed,
    model,
    config,
    decisions,
    diagnostics,
  );

  // Recorded once with a count rather than per image: the decision is the host,
  // and it is the kind of thing that is only visibly wrong on a storefront.
  if (config.media?.baseUrl !== undefined) {
    const resolved = [...feed.variants.values()].reduce(
      (n, v) => n + (v.images ?? []).filter((i) => !isAbsoluteUrl(i.url)).length,
      0,
    );
    if (resolved > 0) {
      decisions.push({
        subject: 'media',
        outcome: `${resolved} relative image URL(s) resolved against ${config.media.baseUrl}`,
        rationale:
          'The source stored image paths relative to its own site and kept the host ' +
          'elsewhere, so the host came from the configuration rather than the export. ' +
          'commercetools serves these URLs verbatim: if this base is wrong, every one of ' +
          'those images 404s and nothing in the pipeline or the project can detect it. ' +
          'Whoever owns the storefront or CDN should confirm the value, and one loaded ' +
          'image should be opened before the catalog is published.',
        review: true,
      });
    }
  }

  // The master-variant choice is recorded per product by `mapProducts`, but
  // under Modular it cannot be *expressed*: a Modular Product has
  // `defaultVariant` instead of a master variant, and `defaultVariant` appears
  // nowhere in the Import API. So the choice is made, logged, and then not
  // written — which is information loss, and has to be declared as such rather
  // than left for someone to notice a storefront defaulting arbitrarily.
  if (config.target.catalogModel === 'Modular' && variants.length > 0) {
    decisions.push({
      subject: 'defaultVariant',
      outcome: `not set on ${products.length} product(s)`,
      rationale:
        'Modular replaces the master variant with Product.defaultVariant, and the Import ' +
        'API has no field for it — so the deterministic choice this pipeline makes cannot ' +
        'be imported. Products load with no default variant, and a storefront picking one ' +
        'arbitrarily is the visible symptom. Setting them needs a pass over the HTTP API ' +
        'after the load, which this pipeline does not do.',
      lossy: true,
      review: true,
    });
  }

  // Recorded once rather than per price: the consequence is a scope, and it is
  // the kind of thing that surfaces as a 403 an hour into a load otherwise.
  if (config.target.priceMode === 'standalone') {
    decisions.push({
      subject: 'pricing',
      outcome: `${standalonePrices.length} Standalone Price(s); product priceMode 'Standalone'`,
      rationale:
        'target.priceMode is standalone, so prices are written as StandalonePrice resources ' +
        'keyed by SKU rather than inside the variants. The load needs the ' +
        'manage_standalone_prices scope, which manage_products does not grant. Price ' +
        'selection reads Standalone Prices only for products whose priceMode says so, ' +
        'which is why it is set explicitly on every product draft.',
      review: true,
    });
  }

  if (categories.length > MAX_CATEGORIES) {
    diagnostics.push({
      severity: 'warning',
      code: 'category-limit',
      message:
        `${categories.length} categories exceed the soft project limit of ${MAX_CATEGORIES}. ` +
        'Arrange a limit increase before the load.',
    });
  }

  const keyMap = {
    categories: Object.fromEntries(categories.map((c) => [stripPrefix(c.key, config), c.key])),
    products: Object.fromEntries(products.map((p) => [stripPrefix(p.key, config), p.key])),
    // Both shapes: under Modular the variants are not inside the products, and
    // a key map missing them would leave a teardown unable to find what this
    // migration created.
    variants: Object.fromEntries([
      ...products.flatMap((p) => variantsOf(p).map((v) => [v.sku ?? v.key, v.key] as const)),
      ...variants.map((v) => [v.sku, v.key] as const),
    ]),
  };

  // Keys verbatim, not prefixed: a price references the project's own channel
  // key, and the channel was created by whoever set up the stores — long
  // before this migration ran. Prefixing would point every price at a channel
  // that does not exist.
  const prerequisites = {
    channels: [...feed.channels.values()].map((c) => ({
      key: c.code,
      roles: [...c.roles],
      ...(c.name ? { name: c.name } : {}),
    })),
    customerGroups: [...feed.customerGroups.values()].map((g) => ({
      key: g.code,
      name: g.name ?? g.code,
    })),
    // Verbatim for the same reason as channels: a store's key belongs to the
    // project, not to this migration. Its *selections*, by contrast, are
    // resources the migration creates, so those references are prefixed.
    stores: [...feed.stores.values()].map((st) => ({
      key: st.code,
      ...(st.name ? { name: st.name } : {}),
      ...(st.languages ? { languages: [...st.languages] } : {}),
      ...(st.countries ? { countries: [...st.countries] } : {}),
      distributionChannels: [...(st.distributionChannels ?? [])],
      supplyChannels: [...(st.supplyChannels ?? [])],
      productSelections: (st.productSelections ?? []).map((x) => ({
        key: resourceKey(config.keys.prefix, x.code),
        active: x.active ?? true,
      })),
    })),
  };

  const productSelections = buildProductSelections(feed, config, decisions);

  for (const group of feed.customerGroups.values()) {
    if (group.name === undefined) {
      decisions.push({
        subject: `customerGroup:${group.code}`,
        outcome: 'name taken from the code',
        rationale:
          'CustomerGroup.name is required by the API and the feed supplied none, so the ' +
          'code stands in. Only visible if this pipeline ever creates the group — today ' +
          'it only verifies that the project already holds it.',
        lossy: true,
      });
    }
  }

  return {
    plan: {
      productTypes: [...model.productTypes.values()],
      categories,
      products,
      variants,
      standalonePrices,
      productSelections,
      prerequisites,
      decisions: [...model.decisions, ...decisions],
      keyMap,
      loadOrder: LOAD_ORDER,
    },
    diagnostics,
  };
}

/**
 * Inverts product-side membership into `ProductSelectionImport` resources.
 *
 * The feed authors membership on the product (`selections: [...]`) because one
 * record per line is the contract's defining property. The Import API wants
 * the opposite: assignments are a field *on the selection*.
 *
 * The inversion is not merely convenience. The Import API removes omitted
 * fields on update, so a selection's assignments cannot be split across
 * resources — the last resource for a key would silently drop everything the
 * others carried. Each selection therefore emits exactly **one** resource with
 * its complete list, however long that is.
 */
function buildProductSelections(
  feed: CatalogFeed,
  config: PipelineConfig,
  decisions: MappingDecision[],
): ProductSelectionImport[] {
  if (feed.productSelections.size === 0) return [];

  const assignments = new Map<string, ProductSelectionAssignment[]>();

  // Feed order, so a re-run produces a byte-identical resource. An assignment
  // list whose order drifts would make every plan diff noise.
  for (const product of feed.products.values()) {
    for (const m of product.selections ?? []) {
      if (!feed.productSelections.has(m.code)) continue; // already an error in validate
      const list = assignments.get(m.code) ?? [];
      const productRef = {
        typeId: 'product' as const,
        key: resourceKey(config.keys.prefix, product.code),
      };
      const mode = feed.productSelections.get(m.code)!.mode ?? 'Individual';

      // `variantSelection` and `variantExclusion` are mutually exclusive, and
      // which one an `excludeSkus` list becomes depends on the selection's
      // mode: under Individual it means "all this product's variants except
      // these", under IndividualExclusion it means "exclude these".
      if (m.includeSkus && m.includeSkus.length > 0) {
        list.push({
          product: productRef,
          variantSelection: { type: 'includeOnly', skus: [...m.includeSkus] },
        });
      } else if (m.excludeSkus && m.excludeSkus.length > 0) {
        list.push(
          mode === 'IndividualExclusion'
            ? { product: productRef, variantExclusion: { skus: [...m.excludeSkus] } }
            : {
                product: productRef,
                variantSelection: { type: 'includeAllExcept', skus: [...m.excludeSkus] },
              },
        );
      } else {
        list.push({ product: productRef });
      }
      assignments.set(m.code, list);
    }
  }

  const out: ProductSelectionImport[] = [];
  for (const selection of feed.productSelections.values()) {
    const list = assignments.get(selection.code) ?? [];
    const mode = (selection.mode ?? 'Individual') as ProductSelectionMode;

    decisions.push({
      subject: `productSelection:${selection.code}`,
      outcome: `mode ${mode}, ${list.length} assignment(s)`,
      rationale:
        `A selection's mode is fixed when it is created — there is no update action that ` +
        `changes it — so ${mode} is permanent for this key. ` +
        (mode === 'Individual'
          ? 'As an allowlist, only the assigned products are offered in any store using it.'
          : 'As a denylist, every product *except* the assigned ones is offered.'),
      irreversible: true,
      review: true,
    });

    // Worth saying out loud rather than discovering at load time: the whole
    // list travels in one resource, so a large assortment is one large
    // request. The 20-resources-per-request cap does not help here.
    if (list.length > LARGE_SELECTION) {
      decisions.push({
        subject: `productSelection:${selection.code}`,
        outcome: `${list.length} assignments in a single import resource`,
        rationale:
          'A selection carries its assignments as one field, and the Import API replaces ' +
          'omitted fields, so they cannot be split across resources. This one request ' +
          'will be large — measure it before relying on it.',
        review: true,
      });
    }

    out.push({
      key: resourceKey(config.keys.prefix, selection.code),
      name: selection.name,
      mode,
      ...(list.length > 0 ? { assignments: list } : {}),
    });
  }
  return out;
}

/** Above this, a selection's single-resource assignment list is worth flagging. */
const LARGE_SELECTION = 1000;

function stripPrefix(key: string, config: PipelineConfig): string {
  const prefix = `${config.keys.prefix}-`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function mapCategories(
  feed: CatalogFeed,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
): CategoryImport[] {
  const locales = config.market.requiredLocales;
  const takenSlugs = new Map<string, Set<string>>();

  // Siblings are ordered together, so group by parent first. Sorting by code
  // within a group keeps the result stable when the source gives no ordering.
  const byParent = new Map<string, string[]>();
  for (const cat of feed.categories.values()) {
    const parent = cat.parent ?? '';
    const siblings = byParent.get(parent) ?? [];
    siblings.push(cat.code);
    byParent.set(parent, siblings);
  }

  const hints = new Map<string, string>();
  for (const [, siblings] of byParent) {
    const ordered = [...siblings].sort((a, b) => {
      const oa = feed.categories.get(a)?.sourceOrder;
      const ob = feed.categories.get(b)?.sourceOrder;
      if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
      if (oa !== undefined && ob === undefined) return -1;
      if (oa === undefined && ob !== undefined) return 1;
      return a.localeCompare(b);
    });
    ordered.forEach((code, i) => hints.set(code, orderHint(i + 1, ordered.length)));
  }

  // Deterministic emission order, parents before children, so the import can be
  // streamed in this order even though KeyReferences would resolve either way.
  const drafts: CategoryImport[] = [];
  const emitted = new Set<string>();

  const emit = (code: string): void => {
    if (emitted.has(code)) return;
    const cat = feed.categories.get(code);
    if (!cat) return;
    if (cat.parent && !emitted.has(cat.parent)) emit(cat.parent);
    emitted.add(code);

    const { slug, derived, disambiguated } = allocateSlug(
      cat.code,
      cat.name,
      cat.slug,
      locales,
      takenSlugs,
    );

    if (derived.length > 0) {
      decisions.push({
        subject: `category:${cat.code}`,
        outcome: `slug derived from name for ${derived.join(', ')}`,
        rationale:
          'The feed supplied no slug for those locales, so one was generated from the ' +
          'category name. Slugs are part of the storefront URL, so whoever owns SEO ' +
          'should see these before go-live.',
        review: true,
      });
    }

    for (const d of disambiguated) {
      decisions.push({
        subject: `category:${cat.code}`,
        outcome: `slug disambiguated to '${d.slug}' in ${d.locale}`,
        rationale:
          'Category slugs are unique across the whole Project per locale, and another ' +
          'category already claimed the natural slug. The source code was appended so ' +
          'the result stays traceable. This changes the URL the migration produces.',
        lossy: true,
        review: true,
      });
    }

    const explicitHint = cat.orderHint;
    if (explicitHint === undefined && cat.sourceOrder === undefined) {
      decisions.push({
        subject: `category:${cat.code}`,
        outcome: `orderHint '${hints.get(cat.code)}' assigned by code order`,
        rationale:
          'The feed gave neither an orderHint nor a sourceOrder, so siblings were ordered ' +
          'by their source code. Navigation order is a merchandising decision, not a ' +
          'migration one — confirm it or supply sourceOrder in the adapter.',
        review: true,
      });
    }

    drafts.push({
      key: resourceKey(config.keys.prefix, cat.code),
      name: cat.name,
      slug,
      ...(cat.description ? { description: cat.description } : {}),
      ...(cat.parent
        ? {
            parent: {
              typeId: 'category',
              key: resourceKey(config.keys.prefix, cat.parent),
            } satisfies CategoryKeyReference,
          }
        : {}),
      orderHint: explicitHint ?? hints.get(cat.code)!,
      // Preserved separately from the key so downstream systems — ERP, feeds,
      // analytics — can still join on the original identifier.
      externalId: cat.externalId ?? cat.code,
      ...(() => {
        const assets = mapAssets(
          cat.assets,
          `category:${cat.code}`,
          config,
          decisions,
          diagnostics,
        );
        return assets.length > 0 ? { assets } : {};
      })(),
    });
  };

  for (const code of [...feed.categories.keys()].sort()) emit(code);
  return drafts;
}

// ---------------------------------------------------------------------------
// Products and variants
// ---------------------------------------------------------------------------

interface MappedProducts {
  products: ProductDraftImport[];
  /** Modular only, and empty under Classic. */
  variants: VariantImport[];
  /** Empty unless priceMode is 'standalone'. */
  standalonePrices: StandalonePriceImport[];
}

function mapProducts(
  feed: CatalogFeed,
  model: DerivedModel,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
): MappedProducts {
  const locales = config.market.requiredLocales;
  const takenSlugs = new Map<string, Set<string>>();
  const drafts: ProductDraftImport[] = [];
  const variants: VariantImport[] = [];
  const standalonePrices: StandalonePriceImport[] = [];
  const embedded = config.target.priceMode === 'embedded';
  const modular = config.target.catalogModel === 'Modular';

  for (const code of [...feed.products.keys()].sort()) {
    const product = feed.products.get(code)!;
    const productTypeKey = model.assignment.get(code);
    if (!productTypeKey) {
      diagnostics.push({
        severity: 'error',
        code: 'no-product-type',
        message: `Product '${code}' was not assigned a ProductType by derive.`,
      });
      continue;
    }

    const { slug, derived, disambiguated } = allocateSlug(
      code,
      product.name,
      product.slug,
      locales,
      takenSlugs,
    );

    if (derived.length > 0) {
      decisions.push({
        subject: `product:${code}`,
        outcome: `slug derived from name for ${derived.join(', ')}`,
        rationale:
          'No slug was supplied for those locales, so one was generated from the product ' +
          'name. This is the product URL.',
        review: true,
      });
    }
    for (const d of disambiguated) {
      decisions.push({
        subject: `product:${code}`,
        outcome: `slug disambiguated to '${d.slug}' in ${d.locale}`,
        rationale:
          'Product slugs are unique across the Project per locale and the natural slug was ' +
          'already taken. The source code was appended to keep it traceable, which changes ' +
          'the URL this product will have.',
        lossy: true,
        review: true,
      });
    }

    const skus = feed.variantsByProduct.get(code) ?? [];
    const claimed = skus.find((sku) => feed.variants.get(sku)?.isMaster === true);
    const { sku: masterSku, byFallback } = chooseMasterSku(skus, claimed);

    if (byFallback && skus.length > 1) {
      decisions.push({
        subject: `product:${code}`,
        outcome: `masterVariant is '${masterSku}' (lowest SKU)`,
        rationale:
          'No variant claimed isMaster, so the lowest SKU was chosen. The choice has to be ' +
          'deterministic: the master variant is what a storefront shows by default, and a ' +
          'feed-order-dependent choice would silently change it between runs.',
        review: true,
      });
    }

    // The attribute discriminator ('text', 'lenum', 'number-set', …) comes from
    // the ProductType, not from the value: a string could legitimately be text,
    // enum, lenum, date, datetime or time.
    const productType = model.productTypes.get(productTypeKey);
    const definitions = new Map<string, AttributeDefinition>(
      productType ? attributeDefinitionsOf(productType).map((d) => [d.name, d]) : [],
    );

    const variantDrafts = new Map<string, ProductVariantDraftImport>();
    for (const sku of [...skus].sort()) {
      const variant = feed.variants.get(sku);
      if (!variant) continue;
      const mapped = mapVariant(
        variant,
        product.attributes,
        definitions,
        config,
        decisions,
        diagnostics,
      );

      // The same price drafts go one of two places, never both.
      variantDrafts.set(
        sku,
        embedded ? { ...mapped.draft, prices: mapped.prices } : mapped.draft,
      );
      if (!embedded) {
        for (const price of mapped.prices) {
          standalonePrices.push(toStandalonePrice(sku, price));
        }
      }
    }

    const master = variantDrafts.get(masterSku);
    if (!master) continue;

    drafts.push({
      key: resourceKey(config.keys.prefix, code),
      productType: { typeId: 'product-type', key: productTypeKey },
      name: product.name,
      slug,
      ...(product.description ? { description: product.description } : {}),
      categories: (product.categories ?? [])
        .slice()
        .sort()
        .map(
          (c) =>
            ({
              typeId: 'category',
              key: resourceKey(config.keys.prefix, c),
            }) satisfies CategoryKeyReference,
        ),
      // Modular products must carry NO variant data: the API refuses
      // `masterVariant` and `variants` on a Modular product, because a Variant
      // is a resource in its own right there. The product becomes a container
      // for the shared fields and the variants are emitted separately below.
      ...(modular
        ? {}
        : {
            masterVariant: master,
            variants: [...variantDrafts.entries()]
              .filter(([sku]) => sku !== masterSku)
              .map(([, v]) => v),
          }),
      // Stated rather than defaulted: priceMode decides whether price selection
      // reads Embedded or Standalone prices, and an unset value is assumed to
      // mean Embedded.
      priceMode: config.target.priceMode === 'embedded' ? 'Embedded' : 'Standalone',
      // Import staged and publish deliberately, so the model can be reviewed in
      // the Merchant Center before anything reaches a storefront.
      publish: false,
    });

    if (modular) {
      const productKeyRef: ProductKeyReference = {
        typeId: 'product',
        key: resourceKey(config.keys.prefix, code),
      };
      for (const [sku, draft] of variantDrafts) {
        variants.push(toVariantImport(sku, draft, productKeyRef));
      }
    }
  }

  return { products: drafts, variants, standalonePrices };
}

/**
 * A variant draft as a Modular Variant resource.
 *
 * Everything carries over except `prices`, which `VariantImport` does not
 * have: Modular pricing is exclusively Standalone, so the prices have already
 * been emitted as StandalonePrice resources by the caller. The key is
 * unchanged, so a re-run updates the same Variant rather than adding a second.
 *
 * `publish: false` for the same reason the product is staged — and note the
 * ordering the API imposes at publish time, which is not this pipeline's
 * concern but is the next person's: a Variant can only be published once its
 * parent Product already is.
 */
function toVariantImport(
  sku: string,
  draft: ProductVariantDraftImport,
  product: ProductKeyReference,
): VariantImport {
  return {
    key: draft.key,
    sku,
    product,
    ...(draft.attributes ? { attributes: draft.attributes } : {}),
    ...(draft.images ? { images: draft.images } : {}),
    ...(draft.assets ? { assets: draft.assets } : {}),
    publish: false,
  };
}

/**
 * A variant draft plus its prices, kept apart.
 *
 * `priceMode` decides where the prices go, and that decision belongs to the
 * product, not the variant — so `mapVariant` converts them and lets the caller
 * place them.
 */
interface MappedVariant {
  draft: ProductVariantDraftImport;
  prices: PriceDraftImport[];
}

function mapVariant(
  variant: FeedVariant,
  productAttributes: Record<string, AttributeValue> | undefined,
  definitions: Map<string, AttributeDefinition>,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
): MappedVariant {
  const attributes: Attribute[] = [];

  const add = (name: string, value: AttributeValue | string): void => {
    const definition = definitions.get(name);
    if (!definition) {
      // The audit gate reports undeclared attributes against the plan; emitting
      // an untyped one here would produce a payload the API cannot parse at all,
      // so it is dropped and the gate names it.
      diagnostics.push({
        severity: 'error',
        code: 'attribute-not-declared',
        message:
          `Variant '${variant.sku}' sets '${name}', which its ProductType does not ` +
          'declare. An Import API attribute needs a type from the declaration, so it ' +
          'cannot be written at all.',
      });
      return;
    }
    const attribute = typedAttribute(name, definition.type, value);
    if (!attribute) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-type-unmappable',
        message:
          `Variant '${variant.sku}', attribute '${name}': the declared type ` +
          `'${definition.type.name}' has no representation the feed contract can carry ` +
          '(nested and set-of-nested attributes are out of scope).',
      });
      return;
    }
    attributes.push(attribute);
  };

  // Product-level attributes carry the SameForAll constraint, which means the
  // value has to be present on every variant — the constraint enforces that
  // they agree, it does not distribute them.
  for (const [name, value] of Object.entries(productAttributes ?? {})) {
    add(name, value);
  }

  // Axis codes are ordinary attribute values on the variant. For enum and lenum
  // attributes the value written is the key, which is exactly what axisValues
  // holds — axisLabels never reach the variant.
  for (const [axis, key] of Object.entries(variant.axisValues ?? {})) {
    add(axis, key);
  }

  for (const [name, value] of Object.entries(variant.attributes ?? {})) {
    add(name, value);
  }

  attributes.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const prices: PriceDraftImport[] = [];
  for (const price of variant.prices ?? []) {
    const digits = config.market.currencyFractionDigits[price.currency];
    if (digits === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'unknown-currency',
        message:
          `Variant '${variant.sku}' has a price in ${price.currency}, which has no ` +
          'market.currencyFractionDigits entry. Defaulting to 2 would multiply a ' +
          '0-digit currency like JPY by 100, so this is refused.',
      });
      continue;
    }

    const converted = toTypedMoney(price.amount, price.currency, digits);
    if (!converted.ok) {
      diagnostics.push({
        severity: 'error',
        code: 'money-precision',
        message: `Variant '${variant.sku}': ${converted.reason}`,
      });
      continue;
    }

    prices.push({
      // Required by PriceDraftImport, and deterministic so a re-run updates the
      // same price rather than adding a second one in the same scope.
      key: priceKey(config.keys.prefix, variant.sku, price),
      value: converted.money,
      ...(price.country ? { country: price.country } : {}),
      ...(price.customerGroup
        ? {
            customerGroup: {
              typeId: 'customer-group' as const,
              key: price.customerGroup,
            },
          }
        : {}),
      ...(price.channel
        ? { channel: { typeId: 'channel' as const, key: price.channel } }
        : {}),
      ...(price.validFrom ? { validFrom: price.validFrom } : {}),
      // The feed calls it validTo; the API field is validUntil.
      ...(price.validTo ? { validUntil: price.validTo } : {}),
    });
  }

  const images: Image[] = (variant.images ?? []).map((image) => {
    if (image.width === undefined || image.height === undefined) {
      decisions.push({
        subject: `variant:${variant.sku}`,
        outcome: `image dimensions defaulted to 0x0 for ${image.url}`,
        rationale:
          'commercetools requires dimensions on an image and the feed supplied none. ' +
          'Zero is accepted but a storefront that reserves layout space from the declared ' +
          'size will not be able to. Emit real dimensions from the adapter if the source ' +
          'has them.',
        lossy: true,
      });
    }
    return {
      url: resolveMediaUrl(image.url, config, variant.sku, diagnostics),
      dimensions: { w: image.width ?? 0, h: image.height ?? 0 },
      ...(image.label ? { label: image.label } : {}),
    };
  });

  const assets = mapAssets(
    variant.assets,
    `variant:${variant.sku}`,
    config,
    decisions,
    diagnostics,
  );

  return {
    draft: {
      key: resourceKey(config.keys.prefix, slugSafeSku(variant.sku)),
      sku: variant.sku,
      attributes,
      images,
      ...(assets.length > 0 ? { assets } : {}),
    },
    prices,
  };
}

/**
 * The same price, as a project-level resource instead of part of a variant.
 *
 * Every field carries over unchanged, including the key: it is already derived
 * from the SKU and the scope, which is exactly the tuple a StandalonePrice has
 * to be unique on (SKU, currency, country, customerGroup, channel, validFrom,
 * validUntil). A second run therefore updates the same price rather than
 * colliding with it.
 *
 * `sku` is a plain string here, not a reference, and the Import API does not
 * validate that a variant with that SKU exists — a typo produces an orphan
 * price that no storefront will ever read and nothing will report. The audit
 * gate checks it against the plan's own variants instead.
 */
function toStandalonePrice(sku: string, price: PriceDraftImport): StandalonePriceImport {
  return {
    key: price.key,
    sku,
    value: price.value,
    ...(price.country ? { country: price.country } : {}),
    ...(price.customerGroup ? { customerGroup: price.customerGroup } : {}),
    ...(price.channel ? { channel: price.channel } : {}),
    ...(price.validFrom ? { validFrom: price.validFrom } : {}),
    ...(price.validUntil ? { validUntil: price.validUntil } : {}),
  };
}

/**
 * Feed assets as commercetools Assets.
 *
 * Three things are resolved here rather than left to the adapter:
 *
 *   - **The key**, prefixed like every other resource so a teardown scoped to
 *     `keys.prefix` finds it. `Asset.key` is required by the API.
 *   - **Source URIs**, through the same resolution images get — assets are
 *     media, and a second media path with different rules is how one of them
 *     ends up wrong.
 *   - **The name**, required by the API. Derived from the code when the feed
 *     supplies none, and recorded: a Merchant Center showing `hero-shot-01`
 *     where a merchandiser expected "Hero shot" is a small loss, but it is a
 *     loss and nobody reviews what they were not told about.
 */
function mapAssets(
  assets: FeedAsset[] | undefined,
  owner: string,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
): Asset[] {
  return (assets ?? []).map((asset) => {
    let name = asset.name;
    if (name === undefined) {
      name = { [config.market.defaultLocale]: asset.code };
      decisions.push({
        subject: owner,
        outcome: `asset '${asset.code}' named from its code`,
        rationale:
          'commercetools requires a name on an asset and the feed supplied none, so the ' +
          'code stands in. It is what the Merchant Center will show. Emit a name from the ' +
          'adapter if the source has one.',
        lossy: true,
        review: true,
      });
    }

    return {
      key: resourceKey(config.keys.prefix, asset.code),
      name,
      ...(asset.description ? { description: asset.description } : {}),
      ...(asset.tags ? { tags: asset.tags } : {}),
      sources: asset.sources.map((source) => ({
        uri: resolveMediaUrl(source.uri, config, owner, diagnostics),
        ...(source.key ? { key: source.key } : {}),
        ...(source.contentType ? { contentType: source.contentType } : {}),
        ...(source.width !== undefined && source.height !== undefined
          ? { dimensions: { w: source.width, h: source.height } }
          : {}),
      })),
    };
  });
}

/** Absolute means it has a scheme; anything else resolves against a base. */
function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//');
}

/**
 * A relative image URL resolved against `media.baseUrl`.
 *
 * Absolute URLs are returned untouched — a feed may legitimately mix, with
 * some assets already on a CDN and some still site-relative.
 *
 * Resolution goes through `new URL`, which implements RFC 3986 rather than
 * string concatenation: a root-relative `/medias/x.jpg` correctly ignores any
 * path on the base, and a path-relative `medias/x.jpg` correctly resolves
 * against it. The base is given a trailing slash first, because without one
 * RFC 3986 discards its last segment — `medias/x` against
 * `https://cdn.example.com/assets` yields `/medias/x`, not `/assets/medias/x`,
 * which is technically right and almost never what was meant.
 *
 * `validate` has already refused a feed with relative URLs and no base, so
 * reaching here without one means a hand-edited config or a replayed plan. It
 * is an error rather than a silent pass-through: leaving the URL relative
 * would load a catalog whose images resolve against whatever page renders
 * them.
 */
function resolveMediaUrl(
  url: string,
  config: PipelineConfig,
  sku: string,
  diagnostics: Diagnostic[],
): string {
  if (isAbsoluteUrl(url)) return url;

  const base = config.media?.baseUrl;
  if (base === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'media-base-url-required',
      message:
        `Variant '${sku}' has the relative image URL '${url}' and no media.baseUrl is ` +
        'configured to resolve it against. `validate` refuses this, so the config has ' +
        'changed since the feed was validated.',
    });
    return url;
  }

  try {
    return new URL(url, base.endsWith('/') ? base : `${base}/`).toString();
  } catch {
    diagnostics.push({
      severity: 'error',
      code: 'media-url-unresolvable',
      message:
        `Variant '${sku}': image URL '${url}' could not be resolved against ` +
        `media.baseUrl '${base}'.`,
    });
    return url;
  }
}

/**
 * A resource key is restricted to [A-Za-z0-9_-] while a SKU is not, so a key
 * derived from a SKU has to be sanitised. The SKU itself is written unchanged:
 * it is the permanent identifier that inventory, orders and fulfilment join on.
 */
function slugSafeSku(sku: string): string {
  return sku.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A deterministic key for a price, built from its SKU and scope.
 *
 * `PriceDraftImport` requires a key, and it has to be a function of the scope
 * rather than a counter: on a second run the same price must resolve to the
 * same key, or the import adds a duplicate in a scope that already has one —
 * which the API then rejects. Timestamps are compacted because a key may only
 * contain [A-Za-z0-9_-].
 *
 * Including the SKU is what lets the same key serve a Standalone Price, whose
 * uniqueness is project-wide rather than per variant.
 */
function priceKey(prefix: string, sku: string, price: FeedPrice): string {
  const parts = [
    slugSafeSku(sku),
    price.currency,
    price.country ?? '',
    price.customerGroup ?? '',
    price.channel ?? '',
    compactTimestamp(price.validFrom),
    compactTimestamp(price.validTo),
  ].filter((part) => part !== '');
  return resourceKey(prefix, parts.join('-')).slice(0, 256);
}

function compactTimestamp(value: string | undefined): string {
  return value === undefined ? '' : value.replace(/[^0-9]/g, '').slice(0, 8);
}
