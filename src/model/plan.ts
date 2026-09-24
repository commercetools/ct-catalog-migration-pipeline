/**
 * The plan, expressed in the official Import API types.
 *
 * Everything here that describes a commercetools resource is imported from
 * `@commercetools/importapi-sdk` rather than hand-written. Those types are
 * generated from the same specification the API is built from, so a field that
 * moves becomes a compile error instead of a rejected operation discovered
 * hours into a load.
 *
 * Transcribing them by hand hid three real defects, all of which the generated
 * types make impossible:
 *
 *   - `PriceDraftImport.key` is required. The hand-written price draft had no
 *     key at all.
 *   - An Import API `Attribute` is a discriminated union carrying `type`
 *     (`{type: 'text', name, value}`). The hand-written one was `{name, value}`.
 *   - A set attribute's discriminator is `'text-set'`, not `'set'`.
 *
 * Only the four types below are genuinely ours: they describe the migration,
 * not commercetools.
 */

import type {
  Asset,
  Attribute,
  AttributeConstraintEnum,
  AttributeDefinition,
  AttributeLevel,
  AttributeLocalizedEnumValue,
  AttributePlainEnumValue,
  AttributeType,
  CategoryImport,
  CategoryKeyReference,
  Image,
  LocalizedString,
  Money,
  PriceDraftImport,
  ProductDraftImport,
  ProductPriceModeEnum,
  ProductTypeImport,
  ProductTypeKeyReference,
  ProductVariantDraftImport,
  ProductKeyReference,
  ProductSelectionAssignment,
  ProductSelectionImport,
  ProductSelectionMode,
  StandalonePriceImport,
  TextInputHint,
  VariantImport,
  VariantSelection,
} from '@commercetools/importapi-sdk';

export type {
  Asset,
  Attribute,
  AttributeConstraintEnum,
  AttributeDefinition,
  AttributeLevel,
  AttributeLocalizedEnumValue,
  AttributePlainEnumValue,
  AttributeType,
  CategoryImport,
  CategoryKeyReference,
  Image,
  LocalizedString,
  Money,
  PriceDraftImport,
  ProductDraftImport,
  ProductPriceModeEnum,
  ProductTypeImport,
  ProductTypeKeyReference,
  ProductVariantDraftImport,
  ProductKeyReference,
  ProductSelectionAssignment,
  ProductSelectionImport,
  ProductSelectionMode,
  StandalonePriceImport,
  TextInputHint,
  VariantImport,
  VariantSelection,
};

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

/**
 * One recorded mapping choice.
 *
 * The rationale is not a comment — it is the deliverable. A migration's output
 * is a reviewed set of decisions, and a mapping added without a rationale is an
 * incomplete change, because the next reader cannot tell whether the choice was
 * considered or accidental.
 */
export interface MappingDecision {
  /** Where it applies, e.g. "apparel-basic.colour". */
  subject: string;
  /** The verdict, e.g. "lenum, CombinationUnique". */
  outcome: string;
  /** Why, in a sentence. Shown verbatim to whoever signs this off. */
  rationale: string;
  /** Set when information does not survive the mapping. */
  lossy?: boolean;
  /**
   * Set when the choice cannot be undone by a later update action. Attribute
   * constraints are the main case: changeAttributeConstraint accepts only
   * 'None', so a constraint can be relaxed but never tightened or switched.
   */
  irreversible?: boolean;
  /**
   * Set when the value was guessed rather than derived from a declaration.
   * Everything flagged here lands in MODEL-REVIEW.md for sign-off.
   */
  review?: boolean;
}

export function lossyDecisions(decisions: MappingDecision[]): MappingDecision[] {
  return decisions.filter((d) => d.lossy);
}

export function reviewDecisions(decisions: MappingDecision[]): MappingDecision[] {
  return decisions.filter((d) => d.review);
}

// ---------------------------------------------------------------------------
// Derived model
// ---------------------------------------------------------------------------

export interface DerivedModel {
  productTypes: Map<string, ProductTypeImport>;
  /** product code → ProductType key. */
  assignment: Map<string, string>;
  decisions: MappingDecision[];
  /** True when definitions were inferred rather than declared. */
  inferred: boolean;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Load stages in dependency order. Teardown runs them in reverse.
 *
 * `product-draft`, not `product`: the Import API has both, and they are
 * different resources. `ProductDraftImport` creates or fully replaces a product
 * including its variants, which is what a migration wants. `ProductImport`
 * updates an existing one.
 *
 * `channel` and `customer-group` come first and are **not Import API stages** —
 * the Import API cannot create either, so they go through the platform HTTP
 * API. They lead because prices reference them, and a price whose channel does
 * not exist yet becomes an operation that expires unresolved after 48 hours.
 *
 * `variant` is the Modular stage and is empty under Classic, where variants
 * travel inside the ProductDraftImport instead. It comes after `product-draft`
 * because a VariantImport references its product by key.
 *
 * `standalone-price` comes last and is empty unless `target.priceMode` is
 * 'standalone'. A StandalonePrice references its variant by SKU, and the Import
 * API explicitly does not validate that the SKU exists — so the ordering is not
 * a correctness requirement the way the others are. It is still last, because a
 * price that lands before its variant is an orphan nobody notices, while the
 * reverse resolves itself.
 */
export const LOAD_ORDER = [
  'channel',
  'customer-group',
  'product-type',
  'category',
  'product-draft',
  'variant',
  'standalone-price',
  'product-selection',
  // Last, and after the Import stages rather than with the other platform
  // prerequisites. A store's `productSelections` reference selections by key,
  // and a store cannot be created pointing at one that does not exist yet —
  // but selections are imported *asynchronously*, so the store stage has to
  // wait for those operations to resolve. `load` refuses to create a
  // selection-referencing store without `--wait` rather than wiring a store to
  // a dangling list.
  'store',
] as const;

export type LoadStage = (typeof LOAD_ORDER)[number];

/**
 * The Import API resource behind each stage — and the two stages that have
 * none.
 *
 * `channel` and `customer-group` are **created through the platform HTTP API**,
 * because the Import API has no resource for either. They are still load
 * stages, and first in order, because prices reference them and an unresolved
 * reference expires after 48 hours. But none of the Import API machinery
 * applies to them: no containers, no 20-per-request batching, no Import
 * Operation states. A `undefined` here is what tells the loader which
 * mechanism a stage uses.
 */
export const IMPORT_RESOURCE_TYPE: Record<LoadStage, string | undefined> = {
  channel: undefined,
  'customer-group': undefined,
  'product-type': 'product-type',
  category: 'category',
  'product-draft': 'product-draft',
  variant: 'variant',
  'standalone-price': 'standalone-price',
  'product-selection': 'product-selection',
  store: undefined,
};

/** Stages the Import API loads, in order. */
export function importStages(order: readonly LoadStage[]): LoadStage[] {
  return order.filter((stage) => IMPORT_RESOURCE_TYPE[stage] !== undefined);
}

/**
 * When each platform stage runs relative to the Import API stages.
 *
 * Not all of them can go first. Channels and customer groups **must**, because
 * prices reference them and an unresolved price expires. A store **cannot**,
 * because it references product selections that the Import API creates — so it
 * runs after, once those operations have resolved.
 */
export const PLATFORM_PHASE: Partial<Record<LoadStage, 'before' | 'after'>> = {
  channel: 'before',
  'customer-group': 'before',
  store: 'after',
};

/**
 * Stages created through the platform API, in the requested phase.
 *
 * The phase argument is required rather than defaulted: a caller that forgets
 * it would silently create stores before the selections they point at exist.
 */
export function platformStages(
  order: readonly LoadStage[],
  phase: 'before' | 'after',
): LoadStage[] {
  return order.filter(
    (stage) => IMPORT_RESOURCE_TYPE[stage] === undefined && PLATFORM_PHASE[stage] === phase,
  );
}

export interface MigrationPlan {
  productTypes: ProductTypeImport[];
  categories: CategoryImport[];
  /**
   * Under Classic these carry their variants. Under Modular they must not —
   * the API refuses `masterVariant`/`variants` on a Modular product — so they
   * are containers for the shared data only, and the variants live below.
   */
  products: ProductDraftImport[];
  /**
   * Modular only, and empty under Classic.
   *
   * A Modular Variant is a resource in its own right, referencing its product
   * by key. Keeping them here rather than nested is what makes `plan.json`
   * match what the load actually sends, which is the property the audit gate
   * depends on: it reads the written plan, not the mapper's intentions.
   */
  variants: VariantImport[];
  /**
   * Empty under `priceMode: 'embedded'`, where prices live inside the variant
   * drafts instead. Never both: mixing price types on one product is legal but
   * degrades price selection, so the config makes it a single choice.
   *
   * Always populated under Modular, which has no embedded prices at all.
   */
  standalonePrices: StandalonePriceImport[];
  /**
   * Resources the project must already hold, which this pipeline **cannot
   * create**: the Import API has no channel or customer-group resource.
   *
   * Deliberately not a load stage. `loadOrder` lists what gets imported, and
   * putting an unimportable resource there would make it lie. These exist so
   * `preflight` can verify the prerequisite before anything is written —
   * without them, a price referencing a missing channel becomes an operation
   * that expires unresolved after 48 hours and reports nothing.
   */
  prerequisites: {
    channels: { key: string; roles: string[]; name?: LocalizedString }[];
    customerGroups: { key: string; name: string }[];
    /**
     * Created through the platform API like the two above, but **after** the
     * import stages, because a store references product selections that the
     * Import API creates asynchronously.
     */
    stores: {
      key: string;
      name?: LocalizedString;
      languages?: string[];
      countries?: string[];
      distributionChannels: string[];
      supplyChannels: string[];
      productSelections: { key: string; active: boolean }[];
    }[];
  };
  /**
   * Assortments, as `ProductSelectionImport` resources.
   *
   * Each carries its **complete** assignment list. That is not a style choice:
   * the Import API removes omitted fields on update, so a selection's
   * assignments cannot be split across resources — the last resource for a key
   * would silently drop every assignment the others carried.
   */
  productSelections: ProductSelectionImport[];
  decisions: MappingDecision[];
  /**
   * What this plan was built from.
   *
   * `audit` reads the plan off disk, so the plan and the feed can drift apart
   * — most sharply when `plan` fails and leaves the previous run's file in
   * place. The digest is what lets the gate tell a fresh plan from a stale
   * one instead of passing against the wrong data.
   *
   * Optional because a plan written before this field existed, or by hand,
   * has none. Absent means *unknown*, which is reported as such rather than
   * treated as fresh.
   */
  provenance?: {
    /** `sha256:…` over the feed's *.ndjson files. See contract/digest.ts. */
    feedDigest: string;
    generatedAt: string;
  };
  /**
   * Source identifier → commercetools key, for every resource. Persisted so a
   * delta run and a rollback can both find what this migration created without
   * re-deriving it.
   */
  keyMap: {
    categories: Record<string, string>;
    products: Record<string, string>;
    variants: Record<string, string>;
  };
  loadOrder: readonly LoadStage[];
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Builds a typed Import API attribute from a declared type and a raw value.
 *
 * The discriminator is not optional and not guessable from the value: a string
 * could be `text`, `enum`, `lenum`, `date`, `datetime` or `time`, and only the
 * ProductType's declaration says which. A set wraps its element type's
 * discriminator with a `-set` suffix.
 */
export function typedAttribute(
  name: string,
  declared: AttributeType,
  value: unknown,
): Attribute | undefined {
  if (declared.name === 'set') {
    const element = declared.elementType;
    // Nested sets are not a shape the feed contract can produce.
    if (element.name === 'set' || element.name === 'nested') return undefined;
    return {
      type: `${element.name}-set`,
      name,
      value: Array.isArray(value) ? value : [value],
    } as Attribute;
  }
  if (declared.name === 'nested') return undefined;
  return { type: declared.name, name, value } as Attribute;
}

/** Human-readable description of an attribute type, for reports. */
export function describeAttributeType(type: AttributeType): string {
  switch (type.name) {
    case 'set':
      return `set of ${describeAttributeType(type.elementType)}`;
    case 'enum':
      return `enum (${type.values.length})`;
    case 'lenum':
      return `lenum (${type.values.length})`;
    case 'reference':
      return `reference → ${type.referenceTypeId}`;
    default:
      return type.name;
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * The generated types mark `attributes`, `variants`, `categories` and `prices`
 * optional, because the API genuinely accepts a resource without them. These
 * accessors normalise the absent case once, instead of every caller either
 * asserting non-null or quietly skipping.
 */

export function attributeDefinitionsOf(
  productType: ProductTypeImport,
): AttributeDefinition[] {
  return productType.attributes ?? [];
}

/**
 * Master variant first, then the rest.
 *
 * Classic only: a Modular product carries no variants at all. Use
 * `indexVariants` for anything that must work in either model.
 */
export function variantsOf(product: ProductDraftImport): ProductVariantDraftImport[] {
  return [
    ...(product.masterVariant ? [product.masterVariant] : []),
    ...(product.variants ?? []),
  ];
}

/**
 * What a check needs from a variant, in either catalog model.
 *
 * The two representations differ in where they live and in one field:
 * `ProductVariantDraftImport` can carry embedded prices, `VariantImport`
 * cannot — Modular pricing is exclusively Standalone. Everything the audit
 * gate actually checks about a variant (key, SKU, attribute values,
 * SameForAll, CombinationUnique) is identical across both, which is why the
 * checks stay single-path rather than forking per model.
 */
export interface PlannedVariant {
  key: string;
  sku?: string;
  attributes?: Attribute[];
  images?: Image[];
  assets?: Asset[];
  /** Embedded prices. Never present under Modular, which has no such field. */
  prices?: PriceDraftImport[];
}

/**
 * Product key → its variants, wherever the plan keeps them.
 *
 * Built once and passed down rather than resolved per product: under Modular
 * the variants are a flat list, and searching it per product would be
 * quadratic on a catalog whose whole reason for being Modular is having a lot
 * of variants.
 */
export function indexVariants(plan: MigrationPlan): Map<string, PlannedVariant[]> {
  const index = new Map<string, PlannedVariant[]>();

  for (const product of plan.products) {
    index.set(product.key, variantsOf(product) as PlannedVariant[]);
  }

  for (const variant of plan.variants ?? []) {
    const productKey = variant.product.key;
    const group = index.get(productKey) ?? [];
    group.push(variant as PlannedVariant);
    index.set(productKey, group);
  }

  return index;
}

export function attributesOf(variant: ProductVariantDraftImport): Attribute[] {
  return variant.attributes ?? [];
}

export function pricesOf(variant: ProductVariantDraftImport): PriceDraftImport[] {
  return variant.prices ?? [];
}

export function categoriesOf(product: ProductDraftImport): CategoryKeyReference[] {
  return product.categories ?? [];
}

/**
 * `Attribute.name` is optional because ProductVariantPatch forbids it. Every
 * attribute this pipeline emits has one, so a missing name is a defect worth
 * surfacing rather than crashing on.
 */
export function attributeName(attribute: Attribute): string {
  return attribute.name ?? '(unnamed)';
}

/**
 * `sku` is optional on ProductVariantDraftImport — only `key` is required. For
 * a catalog migration a SKU is not optional in practice: it is the permanent
 * identifier inventory, orders and fulfilment join on. The audit gate reports a
 * variant without one; this falls back to the key so diagnostics stay readable.
 */
export function variantSku(variant: ProductVariantDraftImport): string {
  return variant.sku ?? variant.key;
}
