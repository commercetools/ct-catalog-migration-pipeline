/**
 * The canonical catalog feed — the pipeline's source boundary.
 *
 * Nothing in this file names a source system, and nothing in it imports the
 * commercetools SDK. Adapters write these shapes; the pipeline reads only these
 * shapes. That is the whole contract.
 *
 * Kept in lockstep with schema/catalog-feed.schema.json, which is the published
 * artefact and the one CI validates against. These types are for the pipeline's
 * own convenience; the schema is the authority.
 */

export type LocalizedString = Record<string, string>;

/** A monetary amount as a decimal string — never a float. See DecimalAmount in the schema. */
export type DecimalAmount = string;

export type AttributeType =
  | 'text'
  | 'ltext'
  | 'enum'
  | 'lenum'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'money'
  | 'reference';

export type AttributeValue =
  | string
  | number
  | boolean
  | LocalizedString
  | (string | number | boolean)[];

export interface FeedPrice {
  currency: string;
  amount: DecimalAmount;
  country?: string;
  customerGroup?: string;
  channel?: string;
  validFrom?: string;
  validTo?: string;
}

export interface FeedImage {
  url: string;
  label?: string;
  width?: number;
  height?: number;
}

export interface FeedCategory {
  _type: 'category';
  code: string;
  name: LocalizedString;
  description?: LocalizedString;
  parent?: string;
  slug?: LocalizedString;
  /** Pre-encoded (0,1) string. Prefer sourceOrder and let the pipeline encode. */
  orderHint?: string;
  sourceOrder?: number;
  externalId?: string;
  assets?: FeedAsset[];
}

/**
 * One renderable file behind an asset.
 *
 * An asset holds *several* of these, which is the whole reason to prefer it
 * over `images` when a source has multiple renditions of the same shot: an
 * image carries exactly one URL, so a thumbnail/product/zoom set has to
 * discard two. A hybris MediaContainer, or any format table, maps to one
 * asset with one source per format.
 */
export interface FeedAssetSource {
  /** Relative or absolute, resolved exactly as an image URL is. */
  uri: string;
  /** Distinguishes renditions within one asset, e.g. `zoom`. */
  key?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

/**
 * A media asset on a variant or a category.
 *
 * commercetools requires a `key` and at least one source, so the feed requires
 * a stable `code` — the same convention every other record follows, prefixed
 * into a key by the pipeline.
 */
export interface FeedAsset {
  /** Stable source identifier; becomes `<prefix>-<code>`. */
  code: string;
  /** Optional in the feed; derived from `code` when absent, and recorded. */
  name?: LocalizedString;
  description?: LocalizedString;
  /** At least one. */
  sources: FeedAssetSource[];
  tags?: string[];
}

export interface FeedEnumValue {
  key: string;
  label?: string | LocalizedString;
}

export interface FeedAttributeDefinition {
  _type: 'attributeDefinition';
  name: string;
  label?: LocalizedString;
  type: AttributeType;
  level: 'product' | 'variant';
  /** Part of variant identity → CombinationUnique. Only valid at variant level. */
  axis?: boolean;
  /**
   * Per-attribute searchability, when the source declares it. Absent falls
   * back to `productTypes.searchableByDefault`. An axis is always searchable
   * regardless.
   *
   * Sources commonly declare this (hybris `items.xml` has `search="true"`),
   * and without a field for it the declaration was silently replaced by the
   * project-wide default.
   */
  searchable?: boolean;
  set?: boolean;
  required?: boolean;
  values?: FeedEnumValue[];
  unit?: string;
}

export interface FeedProduct {
  _type: 'product';
  code: string;
  name: LocalizedString;
  description?: LocalizedString;
  slug?: LocalizedString;
  productType?: string;
  categories?: string[];
  /** Ordered axis attribute names. Absent or empty ⇒ single-variant product. */
  axes?: string[];
  attributes?: Record<string, AttributeValue>;
  externalId?: string;
  /**
   * Product-selection membership, i.e. which assortments carry this product.
   *
   * Authored **here, on the product**, rather than as a list of assignments on
   * the selection — even though that is the shape the Import API takes. Two
   * reasons: one record per line is this contract's defining property, and a
   * selection covering twenty thousand products would be a single
   * twenty-thousand-element line; and an adapter walks products anyway.
   *
   * `plan` inverts this into `ProductSelectionImport.assignments`. It has to
   * assemble each selection's list in full regardless of how the feed is
   * authored, because the Import API replaces omitted fields — so a
   * selection's assignments cannot be sent across more than one resource.
   */
  selections?: FeedSelectionMembership[];
}

/**
 * One product's membership of one selection.
 *
 * With neither `includeSkus` nor `excludeSkus`, every variant is in (or out,
 * under `IndividualExclusion`). The two are mutually exclusive — the API
 * accepts a `variantSelection` **or** a `variantExclusion`, never both.
 */
export interface FeedSelectionMembership {
  /** Code of a declared `productSelection`. */
  code: string;
  /** Only these SKUs. Maps to `variantSelection: includeOnly`. */
  includeSkus?: string[];
  /** All SKUs except these. Maps to `variantSelection: includeAllExcept`, or to
   * `variantExclusion` when the selection's mode is `IndividualExclusion`. */
  excludeSkus?: string[];
}

export interface FeedVariant {
  _type: 'variant';
  sku: string;
  product: string;
  key?: string;
  /** Language-independent codes only. */
  axisValues?: Record<string, string>;
  /** Display text only — never identity. */
  axisLabels?: Record<string, LocalizedString>;
  attributes?: Record<string, AttributeValue>;
  prices?: FeedPrice[];
  images?: FeedImage[];
  assets?: FeedAsset[];
  isMaster?: boolean;
  externalId?: string;
}

/**
 * Channel roles. `ProductDistribution` is the one a price-scoped channel must
 * carry: the API rejects a StandalonePrice referencing a channel without it
 * (`MissingRoleOnChannelError`), and without it the channel cannot act as a
 * distribution channel for price selection.
 */
export type ChannelRole =
  | 'InventorySupply'
  | 'OrderExport'
  | 'OrderImport'
  | 'Primary'
  | 'ProductDistribution';

/**
 * A channel a price is scoped to.
 *
 * **This declares a prerequisite, not a resource the migration creates.** The
 * Import API has no channel resource — it cannot be imported at all — so the
 * channel must already exist in the target project, and `preflight` checks
 * that it does. Declaring it here is what makes that check possible: without
 * a declaration, a price referencing a missing channel becomes an Import
 * Operation that sits `unresolved` for 48 hours and then expires, taking the
 * price with it and reporting nothing.
 *
 * Consequently `code` is the channel's **actual key, used verbatim** — not
 * prefixed with `keys.prefix` like every other record. A price references the
 * project's own channel key, and channels are normally created by store setup
 * long before a catalog migration runs. For the same reason a teardown scoped
 * to the prefix will not remove them, which is correct: the migration did not
 * create them.
 */
export interface FeedChannel {
  _type: 'channel';
  /** The channel's key in the project, verbatim. */
  code: string;
  /** At least one. `ProductDistribution` for a price channel. */
  roles: ChannelRole[];
  name?: LocalizedString;
  description?: LocalizedString;
}

/**
 * A customer group a price is scoped to.
 *
 * The same prerequisite shape as `channel`, and for the same reason: the
 * Import API cannot create a customer group either, so an unverified
 * reference expires silently.
 */
export interface FeedCustomerGroup {
  _type: 'customerGroup';
  /** The customer group's key in the project, verbatim. */
  code: string;
  /** `CustomerGroup.name` is required by the API; derived from the code when absent. */
  name?: string;
}

/**
 * A named subset of the catalog — an assortment.
 *
 * **Unlike `channel` and `store`, this one IS importable.** The Import API has
 * a `product-selection` resource, so a selection is a resource the migration
 * creates, its key is prefixed like every other one, and a prefix-scoped
 * teardown removes it.
 *
 * A selection is inert on its own: it has no effect until a `store` references
 * it. A store with no selections exposes **every** product in the project.
 *
 * `mode` is **fixed at creation** and cannot be changed afterwards, which puts
 * it in the same class as `attributeConstraint` — an irreversible decision the
 * pipeline records rather than makes quietly.
 */
export interface FeedProductSelection {
  _type: 'productSelection';
  code: string;
  name: LocalizedString;
  /**
   * `Individual` is an allowlist, `IndividualExclusion` a denylist. Pick by
   * which list is shorter to maintain, because the choice is permanent.
   * Defaults to `Individual`.
   */
  mode?: 'Individual' | 'IndividualExclusion';
}

/**
 * A shopping context: which channels trade, and which products are on offer.
 *
 * A prerequisite like `channel` and `customerGroup` — the Import API has no
 * store resource — so `code` is the project's **actual key, verbatim**, and a
 * prefix-scoped teardown will not remove it.
 *
 * A store is where `channel` and `productSelection` become visible to a
 * shopper, and it is the reason both exist in this contract:
 *
 * - **`distributionChannels` decide which prices apply.** A price carries a
 *   channel; a store lists the channels it trades through. In store context
 *   the candidate prices are those whose channel the store lists, plus every
 *   price with no channel at all. There is no `store` field on a price.
 * - **`productSelections` decide which products exist.** Empty means all of
 *   them.
 *
 * `supplyChannels` is carried for fidelity, and is the one field here this
 * pipeline cannot follow through on: it imports no inventory, so the channels
 * are created and wired but no `InventoryEntry` ever arrives. `validate` says
 * so rather than letting a correct-looking store imply migrated stock.
 *
 * Deliberately absent: `storefront` URLs, `custom`. Neither is catalog data,
 * and neither can be validated or verified here.
 */
export interface FeedStore {
  _type: 'store';
  /** The store's key in the project, verbatim. */
  code: string;
  name?: LocalizedString;
  /** Must be a subset of the project's languages. */
  languages?: string[];
  /** Must be a subset of the project's countries. */
  countries?: string[];
  /** Codes of declared channels. Each needs the `ProductDistribution` role. */
  distributionChannels?: string[];
  /** Codes of declared channels. Each needs the `InventorySupply` role. */
  supplyChannels?: string[];
  /**
   * Codes of declared product selections, at most 100.
   *
   * `active` defaults to true. The activation rules are unintuitive enough to
   * be worth stating: if every entry is inactive and at least one is
   * `Individual`, the store exposes **no products at all**.
   */
  productSelections?: { code: string; active?: boolean }[];
}

export type FeedRecord =
  | FeedCategory
  | FeedAttributeDefinition
  | FeedProduct
  | FeedVariant
  | FeedChannel
  | FeedCustomerGroup
  | FeedProductSelection
  | FeedStore;

export const FEED_TYPES = [
  'channel',
  'customerGroup',
  'productSelection',
  'store',
  'category',
  'attributeDefinition',
  'product',
  'variant',
] as const;

/**
 * A feed after loading and integrity checking.
 *
 * Assembled in memory because the catalog-wide checks — slug collisions, axis
 * coverage, orphan variants, project-wide SKU uniqueness — are not expressible
 * per record.
 *
 * **What actually limits scale is not this, and it is not memory.** The
 * binding constraint is `JSON.stringify` on the *plan*: it builds the whole
 * document as one string and V8 caps strings at ~537 MB, whatever the heap
 * size. Measured:
 *
 * | Catalog | plan.json per variant | Ceiling |
 * | :--- | ---: | ---: |
 * | 2 product-level attributes | 0.9 KB | ~575,000 variants |
 * | 25 product-level attributes | 4.2 KB | ~125,000 variants |
 *
 * The difference is `productLevelStrategy: sameForAll`, which states a product
 * attribute once here and writes it onto every variant in the plan — a 15×
 * feed-to-plan amplification, measured at 2.8 MB → 42.6 MB.
 *
 * This comment previously claimed "streaming becomes necessary above roughly a
 * million variants", which was never measured and is optimistic by about 8× for
 * an attribute-heavy catalog. The feed held in memory costs ~14 KB per variant
 * of RSS, so a 125,000-variant run peaks near 1.8 GB against a 4.3 GB default
 * heap — comfortable. `stringifyArtefact` explains the real ceiling when it is
 * reached; writing the artefacts incrementally is what would remove it.
 */
export interface CatalogFeed {
  /** Prerequisites the project must already hold — see FeedChannel. */
  channels: Map<string, FeedChannel>;
  customerGroups: Map<string, FeedCustomerGroup>;
  /** Importable, unlike the prerequisites above — see FeedProductSelection. */
  productSelections: Map<string, FeedProductSelection>;
  /** A prerequisite, and the thing that makes channels and selections visible. */
  stores: Map<string, FeedStore>;
  categories: Map<string, FeedCategory>;
  attributeDefinitions: Map<string, FeedAttributeDefinition>;
  products: Map<string, FeedProduct>;
  /** Keyed by SKU. */
  variants: Map<string, FeedVariant>;
  /** product code → SKUs, in feed order. */
  variantsByProduct: Map<string, string[]>;
  /** Where each record came from, for diagnostics that name a file and line. */
  origin: Map<string, { file: string; line: number }>;
}

export function emptyFeed(): CatalogFeed {
  return {
    channels: new Map(),
    customerGroups: new Map(),
    productSelections: new Map(),
    stores: new Map(),
    categories: new Map(),
    attributeDefinitions: new Map(),
    products: new Map(),
    variants: new Map(),
    variantsByProduct: new Map(),
    origin: new Map(),
  };
}
