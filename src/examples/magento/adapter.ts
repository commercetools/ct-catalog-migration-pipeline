/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 * Maps the catalog tables of a Magento Open Source 2.4 snapshot to the feed
 * contract. It shows the shape of an adapter, where Magento data needs a
 * decision, and how to stop rather than guess. It is not a supported or
 * complete Magento adapter: it was written against one shop's tables, and
 * every shop has its own extensions, attributes, scopes and data quirks.
 * Profile the snapshot first, and change this code to match what the profile
 * shows, before trusting a single line of its output.
 *
 * Every place where the adapter decides rather than translates is counted in
 * the report (`decisions`), and everything it does not carry is counted too
 * (`losses`). Anything it cannot decide safely stops the run with an
 * `AdapterStop` that says what to look at.
 */

import type { Row, Tables } from './tables.js';

export const EXAMPLE_NOTICE =
  'This feed was written by the EXAMPLE Magento adapter of ct-catalog-migration-pipeline. ' +
  'The example is not a supported adapter and was not written for this shop: profile the ' +
  'snapshot and adapt the code before relying on any of its output.';

export class AdapterStop extends Error {}

export interface AdapterOptions {
  /** Store view code to locale. Must include `admin`, whose values are the fallback for every locale. */
  locales: Record<string, string>;
  /** The one currency the prices are in, and its fraction digits. */
  currency: string;
  fractionDigits: number;
  /** Which shop-defined product attributes to carry. Default: every user-defined attribute with a value. */
  attributes?: { include?: string[]; exclude?: string[] };
  /** Configurable product SKU to the child SKU that fronts it. Default: the pipeline picks the lowest SKU. */
  masterVariants?: Record<string, string>;
  /** Magento tax class name to tax category code. Default: the code derived from the class name. */
  taxCategories?: Record<string, string>;
  /** Load products whose status is disabled. Default false: they are skipped and counted. */
  includeDisabled?: boolean;
  /** Multi-source inventory: source code to the supply channel code it becomes. */
  stockSources?: Record<string, string>;
}

export interface ReportEntry {
  count: number;
  examples: string[];
}

export interface AdapterReport {
  notice: string;
  counts: Record<string, number>;
  decisions: Record<string, ReportEntry>;
  losses: Record<string, ReportEntry>;
}

export interface AdapterResult {
  records: Record<string, unknown>[];
  report: AdapterReport;
}

export const REQUIRED_TABLES = [
  'store',
  'eav_entity_type',
  'eav_attribute',
  'eav_attribute_set',
  'eav_attribute_label',
  'eav_attribute_option',
  'eav_attribute_option_value',
  'catalog_product_entity',
  'catalog_product_entity_varchar',
  'catalog_product_entity_int',
  'catalog_product_entity_decimal',
  'catalog_product_entity_text',
  'catalog_product_entity_datetime',
  'catalog_product_super_attribute',
  'catalog_product_super_link',
  'catalog_product_entity_media_gallery',
  'catalog_product_entity_media_gallery_value',
  'catalog_category_entity',
  'catalog_category_entity_varchar',
  'catalog_category_entity_int',
  'catalog_category_entity_text',
  'catalog_category_product',
  'cataloginventory_stock_item',
  'tax_class',
] as const;

/** Read when present, to check or report; the adapter runs without them. */
export const OPTIONAL_TABLES = [
  'catalog_eav_attribute',
  'core_config_data',
  'inventory_source_item',
  'catalog_product_entity_tier_price',
  'catalogrule',
  'catalog_product_option',
  'catalog_product_link',
] as const;

const BACKEND_TYPES = ['varchar', 'int', 'decimal', 'text', 'datetime'] as const;

/** Product attributes the adapter maps to product or price fields rather than to attributes. */
const FIELD_ATTRIBUTES = new Set([
  'name',
  'description',
  'url_key',
  'status',
  'visibility',
  'price',
  'special_price',
  'special_from_date',
  'special_to_date',
  'tax_class_id',
]);

/** Fields whose text differs per locale, so a store-view value is a translation, not an override. */
const LOCALIZED_FIELDS = new Set(['name', 'description', 'url_key']);

/** Read for reporting only: carried nowhere, so a value is a counted loss. */
const REPORTED_FIELD_LOSSES = ['short_description', 'meta_title', 'meta_keyword', 'meta_description', 'weight', 'msrp'];

/**
 * Named HTML entities Magento is known to store in plain-text fields. An
 * entity not listed here stops the run: add it once you have seen it.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  reg: '®', trade: '™', copy: '©', deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
};

export function convert(tables: Tables, options: AdapterOptions): AdapterResult {
  return new MagentoAdapter(tables, options).run();
}

class MagentoAdapter {
  private readonly report: AdapterReport = { notice: EXAMPLE_NOTICE, counts: {}, decisions: {}, losses: {} };
  private readonly records: Record<string, unknown>[] = [];

  private readonly defaultLocale: string;
  private readonly locales: string[];
  /** store_id to locale, for the store views the options map; admin (0) included. */
  private readonly localeOfStore = new Map<string, string>();
  private readonly storeCode = new Map<string, string>();

  private readonly attrById = new Map<string, Row>();
  private readonly productAttrByCode = new Map<string, Row>();
  private readonly categoryAttrById = new Map<string, Row>();

  /** entity_id → attribute_code → store_id → raw value */
  private readonly productValues = new Map<string, Map<string, Map<string, string | null>>>();
  private readonly categoryValues = new Map<string, Map<string, Map<string, string | null>>>();

  private readonly optionLabels = new Map<string, Map<string, string>>(); // option_id → store_id → label
  private readonly optionsOfAttr = new Map<string, Row[]>();
  private readonly optionUse = new Map<string, number>();
  private readonly enumKey = new Map<string, Map<string, string>>(); // attribute_code → option_id → key

  // Computed once: several callers ask, and a recomputation would count its report notes twice.
  private carriedCache?: Set<string>;
  private readonly labelCache = new Map<string, Record<string, string>>();
  private readonly imageCache = new Map<string, { url: string; label?: string }[]>();
  private galleryCache?: Map<string, Row>;
  private readonly decodeCache = new Map<string, string>();

  constructor(
    private readonly tables: Tables,
    private readonly options: AdapterOptions,
  ) {
    const admin = options.locales?.admin;
    if (!admin) throw new AdapterStop('options.locales must map the "admin" store to the default locale.');
    this.defaultLocale = admin;
    this.locales = [...new Set(Object.values(options.locales))];
    if (!options.currency || !Number.isInteger(options.fractionDigits)) {
      throw new AdapterStop('options.currency and options.fractionDigits are required: the snapshot does not say which currency the prices are in.');
    }
  }

  run(): AdapterResult {
    this.checkTables();
    this.readStores();
    this.checkConfig();
    this.readAttributes();
    this.readValues();
    this.checkStoreOverrides();

    const taxCategoryOf = this.taxCategories();
    const categoryCodeOf = this.categories();
    const { variantIds } = this.products(taxCategoryOf, categoryCodeOf);
    this.inventory(variantIds);
    this.reportUnmapped();

    const order = ['channel', 'taxCategory', 'category', 'attributeDefinition', 'product', 'variant', 'inventoryEntry'];
    this.records.sort((a, b) => order.indexOf(String(a._type)) - order.indexOf(String(b._type)));
    for (const r of this.records) this.report.counts[String(r._type)] = (this.report.counts[String(r._type)] ?? 0) + 1;
    return { records: this.records, report: this.report };
  }

  // ------------------------------------------------------------ helpers

  private rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  private note(bucket: 'decisions' | 'losses', key: string, example?: string): void {
    const entry = (this.report[bucket][key] ??= { count: 0, examples: [] });
    entry.count++;
    if (example !== undefined && entry.examples.length < 5) entry.examples.push(example);
  }

  private decode(text: string, where: string): string {
    const cacheKey = `${where}\u0000${text}`;
    const cached = this.decodeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const decoded = text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, name: string) => {
      let decoded: string | undefined;
      if (name.startsWith('#x')) decoded = String.fromCodePoint(parseInt(name.slice(2), 16));
      else if (name.startsWith('#')) decoded = String.fromCodePoint(parseInt(name.slice(1), 10));
      else decoded = ENTITIES[name];
      if (decoded === undefined) {
        throw new AdapterStop(`${where}: unknown HTML entity ${entity} in "${text}". Look at how the shop renders it, then add it to ENTITIES.`);
      }
      this.note('decisions', 'html-entity-decoded-in-plain-text', `${where}: ${entity}`);
      return decoded;
    });
    this.decodeCache.set(cacheKey, decoded);
    return decoded;
  }

  // ------------------------------------------------------------ checks

  private checkTables(): void {
    const missing = REQUIRED_TABLES.filter((t) => !this.tables.has(t));
    if (missing.length > 0) {
      throw new AdapterStop(
        `The snapshot lacks ${missing.length} table(s) this adapter reads: ${missing.join(', ')}. ` +
          'Ask for a dump that includes them (mysqldump --single-transaction --hex-blob <db> <tables...>).',
      );
    }
    // Adobe Commerce content staging versions every catalog entity: several
    // rows per product, value tables keyed by row_id. Open Source SQL run
    // against it returns wrong or duplicate rows, so stop rather than guess.
    for (const table of ['catalog_product_entity', 'catalog_category_entity']) {
      const first = this.rows(table)[0];
      if (first && ('row_id' in first || 'created_in' in first)) {
        throw new AdapterStop(
          `${table} has row_id/created_in columns: this is Adobe Commerce with content staging. ` +
            'This example reads Open Source tables only. Rows must be filtered to the current version and ' +
            'joined on row_id; write that, and test it against the staging data, before mapping anything.',
        );
      }
    }
  }

  private readStores(): void {
    const known = new Set<string>();
    for (const s of this.rows('store')) {
      this.storeCode.set(String(s.store_id), String(s.code));
      known.add(String(s.code));
      const locale = this.options.locales[String(s.code)];
      if (locale) this.localeOfStore.set(String(s.store_id), locale);
    }
    for (const code of Object.keys(this.options.locales)) {
      if (!known.has(code)) throw new AdapterStop(`options.locales names the store view "${code}", which the snapshot does not have.`);
    }
    for (const [id, code] of this.storeCode) {
      if (id !== '0' && !this.localeOfStore.has(id)) this.note('decisions', 'store-view-without-locale (its values are checked, not read)', code);
    }
  }

  private checkConfig(): void {
    for (const c of this.rows('core_config_data')) {
      if (c.scope !== 'default') continue;
      if (c.path === 'currency/options/base' && c.value && c.value !== this.options.currency) {
        throw new AdapterStop(`The shop's base currency is ${c.value}, options.currency is ${this.options.currency}.`);
      }
      if (c.path === 'catalog/price/scope' && c.value === '1') {
        this.note('decisions', 'price-scope-is-website (per-website price values stop the run below)', 'catalog/price/scope = 1');
      }
    }
  }

  private readAttributes(): void {
    const typeId = new Map(this.rows('eav_entity_type').map((t) => [String(t.entity_type_code), String(t.entity_type_id)]));
    const product = typeId.get('catalog_product');
    const category = typeId.get('catalog_category');
    for (const a of this.rows('eav_attribute')) {
      this.attrById.set(String(a.attribute_id), a);
      if (a.entity_type_id === product) this.productAttrByCode.set(String(a.attribute_code), a);
      if (a.entity_type_id === category) this.categoryAttrById.set(String(a.attribute_id), a);
    }
    for (const o of this.rows('eav_attribute_option')) {
      const list = this.optionsOfAttr.get(String(o.attribute_id)) ?? [];
      list.push(o);
      this.optionsOfAttr.set(String(o.attribute_id), list);
    }
    for (const v of this.rows('eav_attribute_option_value')) {
      const byStore = this.optionLabels.get(String(v.option_id)) ?? new Map<string, string>();
      byStore.set(String(v.store_id), String(v.value ?? ''));
      this.optionLabels.set(String(v.option_id), byStore);
    }
  }

  private readValues(): void {
    const productIds = new Set(this.rows('catalog_product_entity').map((p) => String(p.entity_id)));
    for (const bt of BACKEND_TYPES) {
      for (const r of this.rows(`catalog_product_entity_${bt}`)) {
        const attr = this.attrById.get(String(r.attribute_id));
        if (!attr || !productIds.has(String(r.entity_id))) continue;
        put(this.productValues, String(r.entity_id), String(attr.attribute_code), String(r.store_id), r.value);
        const input = attr.frontend_input;
        if ((input === 'select' || input === 'multiselect') && r.value) {
          for (const id of r.value.split(',')) this.optionUse.set(id, (this.optionUse.get(id) ?? 0) + 1);
        }
      }
    }
    for (const bt of ['varchar', 'int', 'text'] as const) {
      for (const r of this.rows(`catalog_category_entity_${bt}`)) {
        const attr = this.categoryAttrById.get(String(r.attribute_id));
        if (attr) put(this.categoryValues, String(r.entity_id), String(attr.attribute_code), String(r.store_id), r.value);
      }
    }
  }

  /** The attributes this adapter reads: product fields plus the selected shop attributes and the axes. */
  private carried(): Set<string> {
    if (this.carriedCache) return this.carriedCache;
    const { include, exclude = [] } = this.options.attributes ?? {};
    const axes = new Set(this.rows('catalog_product_super_attribute').map((s) => String(this.attrById.get(String(s.attribute_id))?.attribute_code)));
    const out = new Set<string>(FIELD_ATTRIBUTES);
    for (const [code, a] of this.productAttrByCode) {
      if (axes.has(code)) out.add(code);
      else if (include ? include.includes(code) : a.is_user_defined === '1' && !exclude.includes(code)) out.add(code);
    }
    this.carriedCache = out;
    return out;
  }

  /**
   * A store-view value that differs from admin scope is either a translation
   * (a localized field, on a store view the options map to a locale) or data
   * the feed cannot hold. An adapter reading admin scope would ignore the
   * second kind silently, so on a carried attribute it stops the run; on any
   * other attribute it is counted as a loss.
   */
  private checkStoreOverrides(): void {
    const carried = this.carried();
    const sku = new Map(this.rows('catalog_product_entity').map((p) => [String(p.entity_id), String(p.sku)]));
    for (const [id, byCode] of this.productValues) {
      for (const [code, byStore] of byCode) {
        const admin = byStore.get('0') ?? null;
        for (const [store, value] of byStore) {
          if (store === '0' || value === admin) continue;
          const where = `${sku.get(id)}: ${code} in store view "${this.storeCode.get(store)}" is "${value}", admin "${admin}"`;
          if (!carried.has(code)) {
            this.note('losses', `store-view-value-of-an-attribute-not-carried (${code})`, where);
            continue;
          }
          const translatable = LOCALIZED_FIELDS.has(code) || this.isLocalizedAttribute(code);
          if (translatable && this.localeOfStore.has(store)) continue;
          throw new AdapterStop(
            `${where}. ` +
              (translatable
                ? 'Map that store view to a locale in options.locales, or confirm the value can be dropped and exclude it.'
                : 'The feed holds one value per product for this attribute. Decide with the business which value is right, or carry it per store in your adapter.'),
          );
        }
      }
    }
  }

  private isLocalizedAttribute(code: string): boolean {
    const input = this.productAttrByCode.get(code)?.frontend_input;
    return this.locales.length > 1 && (input === 'text' || input === 'textarea');
  }

  /** One value per locale: the store view's when it has one, else admin's. */
  private localized(values: Map<string, string | null> | undefined, where: string, plain: boolean): Record<string, string> | undefined {
    const admin = values?.get('0');
    const out: Record<string, string> = {};
    for (const locale of this.locales) {
      let value: string | null | undefined;
      for (const [store, v] of values ?? []) {
        if (store === '0' || this.localeOfStore.get(store) !== locale || v === null) continue;
        if (value != null && value !== v) throw new AdapterStop(`${where}: two store views mapped to ${locale} hold different values ("${value}", "${v}").`);
        value = v;
      }
      if (value == null && admin != null && admin !== '' && locale !== this.defaultLocale) {
        // No store view mapped to this locale has its own text, so the admin
        // text stands in: probably untranslated, and the business should know.
        this.note('decisions', `admin-text-used-for-${locale} (no translation in the snapshot)`, where);
      }
      value ??= admin;
      if (value == null || value === '') continue;
      out[locale] = plain ? this.decode(value, where) : value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // ------------------------------------------------------------ tax

  private taxCategories(): Map<string, string> {
    const codeOf = new Map<string, string>();
    for (const c of this.rows('tax_class')) {
      if (c.class_type !== 'PRODUCT') continue;
      const name = String(c.class_name);
      codeOf.set(String(c.class_id), this.options.taxCategories?.[name] ?? keyFromLabel(name));
    }
    return codeOf;
  }

  // ------------------------------------------------------------ categories

  private categories(): Map<string, string> {
    const cats = this.rows('catalog_category_entity');
    const codeOf = new Map<string, string>();
    const byUrlKey = new Map<string, string[]>();
    for (const c of cats) {
      if (Number(c.level) < 2) continue; // the tree root and the store roots are containers, not categories
      const key = this.categoryValues.get(String(c.entity_id))?.get('url_key')?.get('0');
      if (!key) throw new AdapterStop(`Category ${c.entity_id} has no admin url_key to derive its code from.`);
      byUrlKey.set(key, [...(byUrlKey.get(key) ?? []), String(c.entity_id)]);
    }
    for (const [key, ids] of byUrlKey) {
      for (const id of ids) {
        // url_key is unique among siblings only; a code must be unique feed-wide.
        const code = ids.length === 1 ? key : `${key}-${id}`;
        if (ids.length > 1) this.note('decisions', 'category-code-suffixed-with-entity-id (url_key shared)', `${id}: ${code}`);
        codeOf.set(id, code);
      }
    }
    const roots = new Set(cats.filter((c) => Number(c.level) === 2).map((c) => String(c.parent_id)));
    if (roots.size > 1) this.note('decisions', 'categories-of-several-store-roots-loaded-as-one-tree', `${roots.size} roots`);

    for (const c of cats) {
      const id = String(c.entity_id);
      const code = codeOf.get(id);
      if (!code) continue;
      const values = this.categoryValues.get(id);
      const name = this.localized(values?.get('name'), `category ${code} name`, true);
      if (!name) throw new AdapterStop(`Category ${code} has no name.`);
      const record: Record<string, unknown> = { _type: 'category', code, name, sourceOrder: Number(c.position), externalId: id };
      const parent = codeOf.get(String(c.parent_id));
      if (parent) record.parent = parent;
      const description = this.localized(values?.get('description'), `category ${code} description`, false);
      if (description) record.description = description;
      // A slug shared by two categories would be refused; let the pipeline derive those.
      if ((byUrlKey.get(String(values?.get('url_key')?.get('0'))) ?? []).length === 1) {
        record.slug = this.localized(values?.get('url_key'), `category ${code} url_key`, false);
      }
      if (values?.get('is_active')?.get('0') === '0') this.note('losses', 'category-inactive-flag (loaded anyway)', code);
      if (values?.get('include_in_menu')?.get('0') === '0') this.note('losses', 'category-include-in-menu-flag', code);
      this.records.push(record);
    }
    return codeOf;
  }

  // ------------------------------------------------------------ products

  private products(taxCategoryOf: Map<string, string>, categoryCodeOf: Map<string, string>): { variantIds: Map<string, string> } {
    const products = this.rows('catalog_product_entity');
    const byId = new Map(products.map((p) => [String(p.entity_id), p]));
    const setName = new Map(this.rows('eav_attribute_set').map((s) => [String(s.attribute_set_id), String(s.attribute_set_name)]));
    const carried = this.carried();

    const axesOf = new Map<string, string[]>();
    for (const s of [...this.rows('catalog_product_super_attribute')].sort((a, b) => Number(a.position) - Number(b.position))) {
      const code = String(this.attrById.get(String(s.attribute_id))?.attribute_code);
      axesOf.set(String(s.product_id), [...(axesOf.get(String(s.product_id)) ?? []), code]);
    }
    const axisCodes = new Set([...axesOf.values()].flat());
    const childrenOf = new Map<string, string[]>();
    const parentOf = new Map<string, string>();
    for (const l of this.rows('catalog_product_super_link')) {
      const child = String(l.product_id);
      if (parentOf.has(child) && parentOf.get(child) !== String(l.parent_id)) {
        throw new AdapterStop(`${byId.get(child)?.sku} is a child of two configurable products; a SKU can be one variant only.`);
      }
      parentOf.set(child, String(l.parent_id));
      childrenOf.set(String(l.parent_id), [...(childrenOf.get(String(l.parent_id)) ?? []), child]);
    }

    const assigned = new Map<string, Set<string>>();
    let positions = 0;
    for (const r of this.rows('catalog_category_product')) {
      const code = categoryCodeOf.get(String(r.category_id));
      if (!code) continue;
      const set = assigned.get(String(r.product_id)) ?? new Set<string>();
      set.add(code);
      assigned.set(String(r.product_id), set);
      if (r.position !== '0' && r.position !== null) positions++;
    }
    if (positions > 0) {
      // The feed has no product order within a category (categoryOrderHints).
      this.report.losses['product-position-within-category (not in the feed contract)'] = {
        count: positions,
        examples: ['catalog_category_product.position: product order inside each category is not carried'],
      };
    }

    const value = (id: string, code: string): string | null => this.productValues.get(id)?.get(code)?.get('0') ?? null;
    const codeOfSku = new Map<string, string>();
    const productCode = (sku: string): string => {
      const code = sku.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!code) throw new AdapterStop(`SKU "${sku}" leaves no characters for a product code.`);
      const other = codeOfSku.get(code);
      if (other && other !== sku) throw new AdapterStop(`SKUs "${other}" and "${sku}" both become the product code "${code}".`);
      codeOfSku.set(code, sku);
      if (code !== sku) this.note('decisions', 'product-code-sanitised-from-sku', `${sku} → ${code}`);
      return code;
    };

    const usedAttributes = new Map<string, Set<string>>(); // code → option ids used, for definitions
    const variantIds = new Map<string, string>(); // entity_id → sku
    const usedTaxClasses = new Set<string>();
    const enabled = (id: string): boolean => value(id, 'status') !== '2' || this.options.includeDisabled === true;

    const productAttributes = (id: string): Record<string, unknown> | undefined => {
      const out: Record<string, unknown> = {};
      for (const [code, byStore] of this.productValues.get(id) ?? []) {
        if (!carried.has(code) || FIELD_ATTRIBUTES.has(code) || axisCodes.has(code)) continue;
        const raw = byStore.get('0');
        if (raw == null || raw === '') continue;
        const converted = this.attributeValue(code, raw, byStore, id);
        if (converted === undefined) continue;
        out[code] = converted;
        const used = usedAttributes.get(code) ?? new Set<string>();
        if (['select', 'multiselect'].includes(String(this.productAttrByCode.get(code)?.frontend_input))) raw.split(',').forEach((o) => used.add(o));
        usedAttributes.set(code, used);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };

    const emitProduct = (p: Row, categories: Set<string>, axes: string[], taxClass: string | null): string => {
      const id = String(p.entity_id);
      const code = productCode(String(p.sku));
      const values = this.productValues.get(id);
      const name = this.localized(values?.get('name'), `${p.sku} name`, true);
      if (!name) throw new AdapterStop(`${p.sku} has no name.`);
      const record: Record<string, unknown> = { _type: 'product', code, name };
      const slug = this.localized(values?.get('url_key'), `${p.sku} url_key`, false);
      if (slug) record.slug = slug;
      const description = this.localized(values?.get('description'), `${p.sku} description`, false);
      if (description) record.description = description;
      const set = setName.get(String(p.attribute_set_id));
      if (set) record.productType = keyFromLabel(set);
      if (categories.size > 0) record.categories = [...categories].sort();
      if (axes.length > 0) record.axes = axes;
      const attributes = productAttributes(id);
      if (attributes) record.attributes = attributes;
      const taxCategory = taxClass ? taxCategoryOf.get(taxClass) : undefined;
      if (taxCategory) {
        record.taxCategory = taxCategory;
        usedTaxClasses.add(String(taxClass));
      } else this.note('decisions', 'product-without-tax-class', String(p.sku));
      for (const field of REPORTED_FIELD_LOSSES) if (value(id, field)) this.note('losses', field, String(p.sku));
      this.records.push(record);
      return code;
    };

    const emitVariant = (child: Row, product: string, axes: string[], isMaster: boolean): void => {
      const id = String(child.entity_id);
      const record: Record<string, unknown> = { _type: 'variant', sku: String(child.sku), product, prices: this.prices(id, String(child.sku)) };
      if (axes.length > 0) {
        const axisValues: Record<string, string> = {};
        const axisLabels: Record<string, Record<string, string>> = {};
        for (const axis of axes) {
          const raw = value(id, axis);
          if (raw == null) throw new AdapterStop(`${child.sku} has no value for the axis ${axis}.`);
          axisValues[axis] = this.optionKey(axis, raw);
          axisLabels[axis] = this.optionLabel(raw, `${axis} option ${raw}`);
          usedAttributes.set(axis, (usedAttributes.get(axis) ?? new Set<string>()).add(raw));
        }
        record.axisValues = axisValues;
        record.axisLabels = axisLabels;
      }
      const images = this.images(id);
      if (images.length > 0) record.images = images;
      if (isMaster) record.isMaster = true;
      this.records.push(record);
      variantIds.set(id, String(child.sku));
    };

    for (const p of [...products].sort((a, b) => String(a.sku).localeCompare(String(b.sku)))) {
      const id = String(p.entity_id);
      const type = String(p.type_id);
      if (parentOf.has(id)) continue; // emitted with its configurable product
      if (type === 'bundle' || type === 'grouped') {
        this.note('losses', `${type}-product-not-carried (its components load as products of their own)`, String(p.sku));
        continue;
      }
      if (!enabled(id)) {
        this.note('decisions', 'disabled-product-skipped', String(p.sku));
        continue;
      }
      if (type === 'configurable') {
        const axes = axesOf.get(id) ?? [];
        const children = (childrenOf.get(id) ?? []).map((c) => byId.get(c)).filter((c): c is Row => c !== undefined);
        const live = children.filter((c) => {
          if (enabled(String(c.entity_id))) return true;
          this.note('decisions', 'disabled-variant-skipped', String(c.sku));
          return false;
        });
        if (live.length === 0) {
          this.note('decisions', 'configurable-product-without-enabled-children-skipped', String(p.sku));
          continue;
        }
        const categories = new Set(assigned.get(id) ?? []);
        for (const c of live) {
          for (const cat of assigned.get(String(c.entity_id)) ?? []) {
            if (!categories.has(cat)) this.note('decisions', 'variant-category-merged-into-product', `${c.sku} @ ${cat}`);
            categories.add(cat);
          }
        }
        const childImages = new Set(live.flatMap((c) => this.images(String(c.entity_id)).map((i) => i.url)));
        for (const img of this.images(id)) if (!childImages.has(img.url)) this.note('losses', 'configurable-product-image-on-no-variant', `${p.sku}: ${img.url}`);
        if (value(id, 'price')) this.note('losses', 'configurable-product-price (variants carry their own)', String(p.sku));
        const master = this.options.masterVariants?.[String(p.sku)];
        if (master && !live.some((c) => c.sku === master)) throw new AdapterStop(`options.masterVariants names ${master} for ${p.sku}, which is not one of its enabled children.`);
        if (!master) this.note('decisions', 'no-master-variant-chosen (the pipeline takes the lowest SKU)', String(p.sku));
        const code = emitProduct(p, categories, axes, this.configurableTaxClass(p, live, value));
        for (const c of [...live].sort((a, b) => String(a.sku).localeCompare(String(b.sku)))) emitVariant(c, code, axes, c.sku === master);
        continue;
      }
      if (type === 'downloadable') this.note('losses', 'downloadable-links-and-samples (product loaded without them)', String(p.sku));
      else if (type === 'virtual') this.note('decisions', 'virtual-product-loaded-as-simple', String(p.sku));
      else if (type !== 'simple') {
        throw new AdapterStop(`${p.sku} has the product type "${type}", which this example does not map. Decide how it should load, then add it.`);
      }
      if (value(id, 'visibility') === '1') this.note('decisions', 'not-visible-individually-product-loaded', String(p.sku));
      const code = emitProduct(p, assigned.get(id) ?? new Set(), [], value(id, 'tax_class_id'));
      emitVariant(p, code, [], true);
    }

    for (const [code, used] of usedAttributes) this.records.push(this.definition(code, used, axisCodes.has(code)));
    for (const c of this.rows('tax_class')) {
      if (!usedTaxClasses.has(String(c.class_id))) continue;
      this.records.push({ _type: 'taxCategory', code: taxCategoryOf.get(String(c.class_id)), name: String(c.class_name) });
      this.note('decisions', 'tax-category-without-rates (rates and the tax mode are decided in step 0)', String(c.class_name));
    }

    const variantSkus = new Set(variantIds.values());
    const tiers = this.rows('catalog_product_entity_tier_price').filter((t) => variantSkus.has(String(byId.get(String(t.entity_id))?.sku)));
    if (tiers.length > 0) this.report.losses['tier-prices (not carried by this example)'] = { count: tiers.length, examples: [] };
    const productIds = new Set(this.records.filter((r) => r._type === 'variant').map((r) => String(r.sku)));
    const emitted = (productId: string | null): boolean => productIds.has(String(byId.get(String(productId))?.sku)) || childrenOf.has(String(productId));
    const customOptions = this.rows('catalog_product_option').filter((o) => emitted(o.product_id));
    if (customOptions.length > 0) this.report.losses['custom-options (not carried by this example)'] = { count: customOptions.length, examples: [] };
    const links = this.rows('catalog_product_link').filter((l) => emitted(l.product_id));
    if (links.length > 0) this.report.losses['product-links: related, up-sell, cross-sell (not carried by this example)'] = { count: links.length, examples: [] };
    const rules = this.rows('catalogrule').filter((r) => r.is_active === '1');
    if (rules.length > 0) {
      this.report.losses['active-catalog-price-rules (discounts the shop applies, not carried)'] = { count: rules.length, examples: rules.slice(0, 5).map((r) => String(r.name)) };
    }
    return { variantIds };
  }

  /**
   * Magento taxes a configurable product's children, not the product itself,
   * while commercetools holds the tax category on the product. So the class
   * comes from the children: one class among them is the product's, and
   * children that disagree stop the run, because taking the parent's or the
   * first child's class would charge the wrong rate on the others.
   */
  private configurableTaxClass(parent: Row, children: Row[], value: (id: string, code: string) => string | null): string | null {
    const classes = new Map<string, string[]>();
    for (const c of children) {
      const cls = value(String(c.entity_id), 'tax_class_id');
      if (cls && cls !== '0') classes.set(cls, [...(classes.get(cls) ?? []), String(c.sku)]);
    }
    if (classes.size > 1) {
      throw new AdapterStop(
        `${parent.sku}: its variants carry different tax classes (${[...classes].map(([cls, skus]) => `${cls}: ${skus.join(', ')}`).join('; ')}), ` +
          'and commercetools holds one tax category per product. Ask whoever owns tax whether to split the product by class, hold the odd SKUs back, or take one class and record the rest as a loss.',
      );
    }
    const own = value(String(parent.entity_id), 'tax_class_id');
    const fromChildren = [...classes.keys()][0];
    if (fromChildren === undefined) {
      if (own) this.note('decisions', 'configurable-tax-class-from-product (variants have none)', String(parent.sku));
      return own;
    }
    if (own && own !== '0' && own !== fromChildren) this.note('decisions', 'configurable-product-tax-class-differs-from-variants (variants used)', `${parent.sku}: ${own} vs ${fromChildren}`);
    return fromChildren;
  }

  private attributeValue(code: string, raw: string, byStore: Map<string, string | null>, id: string): unknown {
    const input = this.productAttrByCode.get(code)?.frontend_input;
    switch (input) {
      case 'select':
        return this.optionKey(code, raw);
      case 'multiselect':
        return raw.split(',').filter(Boolean).map((o) => this.optionKey(code, o));
      case 'boolean':
        return raw === '1';
      case 'text':
      case 'textarea': {
        if (this.locales.length > 1) return this.localized(byStore, `${code} of ${id}`, input === 'text');
        return input === 'text' ? this.decode(raw, `${code} of ${id}`) : raw;
      }
      case 'date':
        return raw.slice(0, 10);
      case 'weight':
        return Number(raw);
      case 'price':
        return { currency: this.options.currency, amount: this.money(raw, `${code} of ${id}`) };
      default:
        throw new AdapterStop(
          `The attribute ${code} has the input type "${input}", which this example does not map. ` +
            'Map it, or leave it out with options.attributes.exclude and report it as not migrated.',
        );
    }
  }

  private definition(code: string, used: Set<string>, axis: boolean): Record<string, unknown> {
    const attr = this.productAttrByCode.get(code);
    if (!attr) throw new AdapterStop(`No attribute definition for ${code}.`);
    const input = String(attr.frontend_input);
    const localized = this.locales.length > 1;
    const record: Record<string, unknown> = { _type: 'attributeDefinition', name: code, level: axis ? 'variant' : 'product' };
    const label: Record<string, string> = {};
    const adminLabel = attr.frontend_label ? this.decode(attr.frontend_label, `${code} label`) : code;
    for (const locale of this.locales) label[locale] = adminLabel;
    for (const l of this.rows('eav_attribute_label')) {
      const locale = this.localeOfStore.get(String(l.store_id));
      if (l.attribute_id === attr.attribute_id && locale && l.value) label[locale] = this.decode(l.value, `${code} label`);
    }
    record.label = label;
    if (axis) record.axis = true;
    const searchable = this.rows('catalog_eav_attribute').find((c) => c.attribute_id === attr.attribute_id)?.is_searchable;
    if (searchable !== undefined && searchable !== null) record.searchable = searchable === '1';

    if (input === 'select' || input === 'multiselect') {
      record.type = localized ? 'lenum' : 'enum';
      if (input === 'multiselect') record.set = true;
      const keys = this.enumKey.get(code) ?? new Map<string, string>();
      const seen = new Set<string>();
      record.values = (this.optionsOfAttr.get(String(attr.attribute_id)) ?? [])
        .filter((o) => keys.has(String(o.option_id)))
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.option_id) - Number(b.option_id))
        .map((o) => {
          const key = String(keys.get(String(o.option_id)));
          if (seen.has(key)) return undefined;
          seen.add(key);
          const lbl = this.optionLabel(String(o.option_id), `${code} option ${o.option_id}`);
          return { key, label: localized ? lbl : lbl[this.defaultLocale] };
        })
        .filter((v) => v !== undefined);
      if (used.size === 0) this.note('decisions', 'attribute-without-values', code);
    } else if (input === 'boolean') record.type = 'boolean';
    else if (input === 'text' || input === 'textarea') record.type = localized ? 'ltext' : 'text';
    else if (input === 'date') record.type = 'date';
    else if (input === 'weight') record.type = 'number';
    else if (input === 'price') record.type = 'money';
    return record;
  }

  /**
   * Enum keys come from the admin label, so two options with the same label
   * collide on one key. Where only one of them is in use, the unused twin is
   * dropped and counted; two used options with one label stop the run,
   * because merging them would merge products the shop keeps apart.
   */
  private optionKey(code: string, optionId: string): string {
    let keys = this.enumKey.get(code);
    if (!keys) {
      keys = new Map<string, string>();
      const attr = this.productAttrByCode.get(code);
      const byKey = new Map<string, Row[]>();
      for (const o of this.optionsOfAttr.get(String(attr?.attribute_id)) ?? []) {
        const label = this.optionLabel(String(o.option_id), `${code} option ${o.option_id}`)[this.defaultLocale];
        let key = keyFromLabel(label ?? '');
        if (!key) {
          key = `option-${o.option_id}`;
          this.note('decisions', 'enum-key-from-option-id (label yields no key)', `${code}: "${label}" → ${key}`);
        }
        byKey.set(key, [...(byKey.get(key) ?? []), o]);
      }
      for (const [key, group] of byKey) {
        const used = group.filter((o) => this.optionUse.has(String(o.option_id)));
        if (used.length > 1) {
          throw new AdapterStop(
            `${code}: options ${used.map((o) => o.option_id).join(', ')} share the label behind the key "${key}" and are all in use. ` +
              'Ask the business whether they are one value or two, then merge or relabel them in the adapter.',
          );
        }
        const keep = used[0] ?? group[0];
        for (const o of group) {
          if (o === keep) keys.set(String(o.option_id), key);
          else this.note('decisions', 'unused-duplicate-option-dropped', `${code}: option ${o.option_id} duplicates "${key}", kept ${keep.option_id}`);
        }
      }
      this.enumKey.set(code, keys);
    }
    const key = keys.get(optionId);
    if (!key) throw new AdapterStop(`${code}: option id ${optionId} is used but has no option row.`);
    return key;
  }

  private optionLabel(optionId: string, where: string): Record<string, string> {
    const cached = this.labelCache.get(optionId);
    if (cached) return cached;
    const byStore = this.optionLabels.get(optionId);
    if (!byStore?.get('0')) throw new AdapterStop(`${where} has no admin label.`);
    const out = this.localized(byStore, where, true);
    if (!out) throw new AdapterStop(`${where} has no label.`);
    this.labelCache.set(optionId, out);
    return out;
  }

  // ------------------------------------------------------------ prices, images

  /** Money from the digit string, never through a float; more digits than the currency has stop the run. */
  private money(raw: string, where: string): string {
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(raw.trim());
    if (!m) throw new AdapterStop(`${where}: "${raw}" is not a plain decimal.`);
    const fraction = (m[2] ?? '').replace(/0+$/, '');
    if (fraction.length > this.options.fractionDigits) {
      throw new AdapterStop(`${where}: "${raw}" has more decimal places than ${this.options.currency} allows; decide how to round it.`);
    }
    return this.options.fractionDigits === 0 ? m[1] : `${m[1]}.${fraction.padEnd(this.options.fractionDigits, '0')}`;
  }

  private prices(id: string, sku: string): Record<string, unknown>[] {
    const v = (code: string): string | null => this.productValues.get(id)?.get(code)?.get('0') ?? null;
    const price = v('price');
    if (price == null) throw new AdapterStop(`${sku} has no price.`);
    const base = this.money(price, `${sku} price`);
    const prices: Record<string, unknown>[] = [{ currency: this.options.currency, amount: base }];
    const special = v('special_price');
    if (special != null) {
      const amount = this.money(special, `${sku} special_price`);
      if (Number(amount) >= Number(base)) {
        this.note('decisions', 'special-price-not-below-price-dropped', sku);
      } else {
        // The dates are calendar days in the shop's time zone, which the
        // tables do not hold; they are written as UTC days and counted.
        const from = v('special_from_date');
        const to = v('special_to_date');
        const dated: Record<string, unknown> = { currency: this.options.currency, amount };
        if (from) dated.validFrom = `${from.slice(0, 10)}T00:00:00.000Z`;
        if (to) dated.validTo = nextDay(to.slice(0, 10));
        prices.push(dated);
        this.note('decisions', 'special-price-as-dated-price (days read as UTC)', `${sku}: ${amount}`);
      }
    }
    return prices;
  }

  /**
   * Magento stores gallery paths relative to pub/media/catalog/product but
   * with a leading slash. Resolved per RFC 3986, a root-relative path ignores
   * the path of media.baseUrl, so every URL would lose /media/catalog/product.
   * The slash is removed here; media.baseUrl is then that folder's URL.
   */
  private images(id: string): { url: string; label?: string }[] {
    const cached = this.imageCache.get(id);
    if (cached) return cached;
    this.galleryCache ??= new Map(this.rows('catalog_product_entity_media_gallery').map((g) => [String(g.value_id), g]));
    const gallery = this.galleryCache;
    const images = this.rows('catalog_product_entity_media_gallery_value')
      .filter((r) => String(r.entity_id) === id && r.store_id === '0' && r.disabled !== '1')
      .sort((a, b) => Number(a.position) - Number(b.position))
      .flatMap((r) => {
        const g = gallery.get(String(r.value_id));
        if (!g || g.disabled === '1' || !g.value) return [];
        if (g.media_type && g.media_type !== 'image') {
          this.note('losses', `gallery-${g.media_type}`, String(g.value));
          return [];
        }
        const url = g.value.replace(/^\/+/, '');
        if (url !== g.value) this.note('decisions', 'image-path-made-relative-to-media-catalog-product', g.value);
        return [r.label ? { url, label: r.label } : { url }];
      });
    this.imageCache.set(id, images);
    return images;
  }

  // ------------------------------------------------------------ stock

  private inventory(variantIds: Map<string, string>): void {
    const msi = this.rows('inventory_source_item');
    const sources = new Set(msi.map((s) => String(s.source_code)));
    if (sources.size > 0 && !(sources.size === 1 && sources.has('default'))) {
      const map = this.options.stockSources ?? {};
      const unmapped = [...sources].filter((s) => !map[s]);
      if (unmapped.length > 0) {
        throw new AdapterStop(
          `Multi-source inventory with the sources ${[...sources].join(', ')}; ${unmapped.join(', ')} not in options.stockSources. ` +
            'Decide with the business whether stock is per source (a supply channel each) or one total.',
        );
      }
      for (const channel of new Set(Object.values(map))) this.records.push({ _type: 'channel', code: channel, roles: ['InventorySupply'] });
      const skus = new Set(variantIds.values());
      for (const s of msi) {
        if (!skus.has(String(s.sku))) continue;
        this.records.push({ _type: 'inventoryEntry', sku: s.sku, quantityOnStock: this.quantity(String(s.quantity), String(s.sku)), supplyChannel: map[String(s.source_code)] });
      }
      return;
    }
    if (sources.size === 1) this.note('decisions', 'inventory-source-item-has-only-the-default-source (legacy stock read)', 'default');

    for (const s of this.rows('cataloginventory_stock_item')) {
      const sku = variantIds.get(String(s.product_id));
      if (!sku) {
        if (s.qty !== null || s.is_in_stock === '1') this.note('decisions', 'stock-row-of-a-product-that-is-no-variant-skipped', `product ${s.product_id} (qty ${s.qty}, in stock ${s.is_in_stock})`);
        continue;
      }
      if (s.use_config_manage_stock === '0' && s.manage_stock === '0') {
        this.note('decisions', 'stock-not-managed-no-entry', sku);
        continue;
      }
      if (s.qty === null) {
        this.note('decisions', 'stock-qty-null-no-entry', sku);
        continue;
      }
      this.records.push({ _type: 'inventoryEntry', sku, quantityOnStock: this.quantity(s.qty, sku) });
    }
  }

  private quantity(raw: string, sku: string): number {
    const m = /^(-?\d+)(?:\.0+)?$/.exec(raw);
    if (!m) throw new AdapterStop(`${sku}: stock quantity "${raw}" is not a whole number; decide how fractional stock should load.`);
    const n = Number(m[1]);
    if (n < 0) throw new AdapterStop(`${sku}: stock quantity ${n} is negative (backorders?); decide what it should load as.`);
    return n;
  }

  private reportUnmapped(): void {
    const carried = this.carried();
    for (const [code, a] of this.productAttrByCode) {
      if (carried.has(code) || a.is_user_defined !== '1') continue;
      const holders = [...this.productValues.values()].filter((byCode) => byCode.get(code)?.get('0') != null).length;
      if (holders > 0) this.report.losses[`attribute-not-carried (${code})`] = { count: holders, examples: [] };
    }
  }
}

function put(
  target: Map<string, Map<string, Map<string, string | null>>>,
  id: string,
  code: string,
  store: string,
  value: string | null,
): void {
  const byCode = target.get(id) ?? new Map<string, Map<string, string | null>>();
  const byStore = byCode.get(code) ?? new Map<string, string | null>();
  byStore.set(store, value);
  byCode.set(code, byStore);
  target.set(id, byCode);
}

/** A key for the feed ([A-Za-z0-9_-]) from a label: "Wool ½" → "wool-1-2". */
export function keyFromLabel(label: string): string {
  return label
    .replace(/½/g, ' 1-2 ')
    .replace(/¼/g, ' 1-4 ')
    .replace(/¾/g, ' 3-4 ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
