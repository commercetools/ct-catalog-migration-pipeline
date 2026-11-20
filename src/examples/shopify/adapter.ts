/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 * Maps a Shopify catalog, as read by `extract.ts` through the Admin GraphQL
 * API, to the feed contract. It shows the shape of an adapter, where Shopify
 * data needs a decision, and how to stop rather than guess. It is not a
 * supported or complete Shopify adapter: it was written against one test
 * shop, and every shop has its own apps, metafields, markets and data quirks.
 * Profile the export first, and change this code to match what the profile
 * shows, before trusting a single line of its output.
 *
 * Every place where the adapter decides rather than translates is counted in
 * the report (`decisions`), and everything it does not carry is counted too
 * (`losses`). Anything it cannot decide safely stops the run with an
 * `AdapterStop` that says what to look at.
 */

import { gidType, type Obj, type ShopifyExport } from './export.js';

export const EXAMPLE_NOTICE =
  'This feed was written by the EXAMPLE Shopify adapter of ct-catalog-migration-pipeline. ' +
  'The example is not a supported adapter and was not written for this shop: profile the ' +
  'export and adapt the code before relying on any of its output.';

export class AdapterStop extends Error {}

export interface AdapterOptions {
  /** The locale the shop's texts are written in. Checked against the shop's primary locale. */
  locale: string;
  /** Fraction digits of the shop currency (the currency itself comes from shop.json). */
  fractionDigits: number;
  /** Which Shopify quantity becomes `quantityOnStock`: the business decides. */
  stockQuantity: 'available' | 'on_hand';
  /** A variant without a SKU: stop (default), or derive one from the handle and option values. */
  skus?: 'require' | 'derive';
  /** Product statuses to load. Default: ACTIVE only; others are skipped and counted. */
  statuses?: string[];
  /** Where categories come from. Default: collections. */
  categories?: { from: 'collections' | 'productType' | 'none'; exclude?: string[] };
  /** The compare-at ("was") price: drop it (default, counted) or carry it as a money attribute. */
  compareAtPrice?: 'drop' | 'attribute';
  /** Tax category codes for taxable and non-taxable products. */
  taxCategories?: { taxable?: string; notTaxable?: string };
  /** Location name or id → supply channel code. Required when stock sits in more than one location. */
  locations?: Record<string, string>;
  /** Product metafield `namespace.key` → attribute name. Unlisted metafields are counted as losses. */
  metafields?: Record<string, string>;
  /** Product handle → the SKU that fronts it. Default: the first variant in Shopify's order. */
  masterVariants?: Record<string, string>;
}

export interface ReportEntry {
  count: number;
  examples: string[];
}

export interface AdapterReport {
  notice: string;
  source: Record<string, string | number | boolean | undefined>;
  counts: Record<string, number>;
  decisions: Record<string, ReportEntry>;
  losses: Record<string, ReportEntry>;
}

export interface AdapterResult {
  records: Record<string, unknown>[];
  report: AdapterReport;
}

/** Attribute names this adapter writes itself; an option or metafield mapped to one would collide. */
const OWN_ATTRIBUTES = new Set(['vendor', 'compareAtPrice']);

/** Metafield types the example maps, and the attribute type each becomes. */
const METAFIELD_TYPES: Record<string, 'text' | 'number' | 'boolean' | 'date'> = {
  single_line_text_field: 'text',
  multi_line_text_field: 'text',
  number_integer: 'number',
  number_decimal: 'number',
  boolean: 'boolean',
  date: 'date',
};

/** The commercetools Classic catalog holds at most 100 variants per product; Shopify allows many more. */
const CLASSIC_VARIANT_LIMIT = 100;

export function convert(source: ShopifyExport, options: AdapterOptions): AdapterResult {
  return new ShopifyAdapter(source, options).run();
}

interface Axis {
  name: string;
  label: string;
  values: Map<string, string>; // key → label
  products: Set<string>;
}

class ShopifyAdapter {
  private readonly report: AdapterReport;
  private readonly records: Record<string, unknown>[] = [];
  private readonly currency: string;
  private readonly locale: string;

  private readonly axes = new Map<string, Axis>();
  private readonly usedTaxCategories = new Set<string>();
  private readonly usedAttributes = new Map<string, 'text' | 'number' | 'boolean' | 'date' | 'money'>();
  private readonly categoryCodes = new Map<string, string>(); // collection id or product type → code
  private readonly skus = new Map<string, string>(); // sku → handle

  constructor(
    private readonly source: ShopifyExport,
    private readonly options: AdapterOptions,
  ) {
    if (!options.locale) throw new AdapterStop('options.locale is required: the language the shop writes its texts in.');
    if (!Number.isInteger(options.fractionDigits)) throw new AdapterStop('options.fractionDigits is required: the fraction digits of the shop currency.');
    if (options.stockQuantity !== 'available' && options.stockQuantity !== 'on_hand') {
      throw new AdapterStop(
        'options.stockQuantity must be "available" or "on_hand". On hand counts units committed to unfulfilled orders too; ' +
          'which one the new shop starts from is a question for the business.',
      );
    }
    const currency = source.shop?.shop?.currencyCode;
    if (!currency) throw new AdapterStop('shop.json has no shop.currencyCode, so the currency of the prices is unknown.');
    this.currency = currency;
    this.locale = options.locale;
    this.report = {
      notice: EXAMPLE_NOTICE,
      source: {
        shop: source.shop.shop.name,
        apiVersion: source.shop.apiVersion,
        extractedAt: source.shop.extractedAt,
        currency,
        taxesIncluded: source.shop.shop.taxesIncluded,
        products: source.products.length,
      },
      counts: {},
      decisions: {},
      losses: {},
    };
  }

  run(): AdapterResult {
    this.checkLocale();
    this.checkMetafieldOptions();
    const carried = this.products();
    this.inventory(carried);
    this.definitions();
    this.taxCategories();

    const order = ['channel', 'taxCategory', 'category', 'attributeDefinition', 'product', 'variant', 'inventoryEntry'];
    const sorted = [...this.records].sort((a, b) => order.indexOf(String(a._type)) - order.indexOf(String(b._type)));
    for (const r of sorted) this.report.counts[String(r._type)] = (this.report.counts[String(r._type)] ?? 0) + 1;
    return { records: sorted, report: this.report };
  }

  // ------------------------------------------------------------ helpers

  private note(bucket: 'decisions' | 'losses', key: string, example?: string): void {
    const entry = (this.report[bucket][key] ??= { count: 0, examples: [] });
    entry.count++;
    if (example !== undefined && entry.examples.length < 5) entry.examples.push(example);
  }

  private text(value: string): Record<string, string> {
    return { [this.locale]: value };
  }

  // ------------------------------------------------------------ checks

  /**
   * Shopify writes product texts in the shop's primary language; translations
   * are separate resources the extractor does not read. Filing them under
   * another locale would mislabel every name and description, so a locale
   * whose language differs from the primary one stops the run.
   */
  private checkLocale(): void {
    const locales = this.source.shop.shopLocales;
    if (!locales || locales.length === 0) {
      this.note('decisions', 'locale-not-checked (shop.json has no shopLocales)', this.locale);
      return;
    }
    const primary = locales.find((l) => l.primary)?.locale;
    const language = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];
    if (primary && language(primary) !== language(this.locale)) {
      throw new AdapterStop(
        `options.locale is ${this.locale}, but the shop's primary locale is ${primary}, the language its texts are written in. ` +
          'Set options.locale to a tag of that language (and add it to the project), or translate before loading: never file the texts under another language.',
      );
    }
    const others = locales.filter((l) => !l.primary && l.published).map((l) => l.locale);
    if (others.length > 0) this.note('losses', 'translations-not-read (published locales besides the primary one)', others.join(', '));
  }

  private checkMetafieldOptions(): void {
    for (const [field, attribute] of Object.entries(this.options.metafields ?? {})) {
      if (OWN_ATTRIBUTES.has(attribute)) throw new AdapterStop(`options.metafields maps ${field} to "${attribute}", which this adapter already writes.`);
      if (!/^[A-Za-z0-9_-]{2,256}$/.test(attribute)) throw new AdapterStop(`options.metafields maps ${field} to "${attribute}", which is not a valid attribute name.`);
    }
  }

  // ------------------------------------------------------------ products

  /** Returns the carried variants by Shopify variant id: id → { sku, policy }. */
  private products(): Map<string, { sku: string; policy: unknown }> {
    const statuses = new Set(this.options.statuses ?? ['ACTIVE']);
    const carried = new Map<string, { sku: string; policy: unknown }>();
    const codes = new Map<string, string>();
    const vendors = new Map<string, Set<string>>();

    for (const p of this.source.products) {
      const handle = String(p.handle ?? '');
      if (!handle) throw new AdapterStop(`${String(p.id)} has no handle to derive a product code from.`);
      if (p.isGiftCard === true) {
        // A gift card sells a balance, not goods, and commercetools has no
        // gift card product: loading it would sell something that issues nothing.
        this.note('losses', 'gift-card-product-not-carried', handle);
        continue;
      }
      if (!statuses.has(String(p.status))) {
        this.note('decisions', `product-skipped-by-status (${String(p.status)})`, handle);
        continue;
      }

      const children = this.source.childrenOf.get(String(p.id)) ?? [];
      const variants = children.filter((c) => gidType(c.id) === 'ProductVariant').sort((a, b) => Number(a.position) - Number(b.position));
      if (variants.length === 0) throw new AdapterStop(`${handle} has no variant lines in products.jsonl; was the export cut short?`);
      if (variants.length > CLASSIC_VARIANT_LIMIT) {
        this.note('decisions', `product-over-${CLASSIC_VARIANT_LIMIT}-variants (above the Classic limit; split it or use Modular)`, `${handle}: ${variants.length}`);
      }

      const code = handle.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!code) throw new AdapterStop(`The handle "${handle}" leaves no characters for a product code.`);
      if (codes.has(code)) throw new AdapterStop(`The handles "${codes.get(code)}" and "${handle}" both become the product code "${code}".`);
      codes.set(code, handle);
      if (code !== handle) this.note('decisions', 'product-code-sanitised-from-handle', `${handle} → ${code}`);

      const record: Record<string, unknown> = { _type: 'product', code, name: this.text(String(p.title ?? handle)), slug: this.text(handle) };
      if (typeof p.descriptionHtml === 'string' && p.descriptionHtml.trim() !== '') record.description = this.text(p.descriptionHtml);
      if (typeof p.productType === 'string' && p.productType.trim() !== '') {
        record.productType = keyFromLabel(p.productType);
      } else {
        this.note('decisions', 'product-without-product-type (the pipeline default applies)', handle);
      }

      const axes = this.productAxes(p, handle);
      if (axes.length > 0) record.axes = axes.map((a) => a.name);
      const categories = this.productCategories(p, children, handle);
      if (categories.length > 0) record.categories = categories;
      const attributes = this.productAttributes(p, children, handle, vendors);
      if (Object.keys(attributes).length > 0) record.attributes = attributes;
      record.taxCategory = this.taxCategory(variants, handle);
      this.reportProductLosses(p, children, handle);
      this.records.push(record);

      const images = this.productImages(children, handle);
      const master = this.options.masterVariants?.[handle];
      const skus = variants.map((v) => this.sku(v, handle, axes));
      if (master && !skus.includes(master)) throw new AdapterStop(`options.masterVariants names ${master} for ${handle}, which is not one of its SKUs.`);
      if (!master && variants.length > 1) this.note('decisions', 'master-variant-is-first-in-shopify-order', `${handle}: ${skus[0]}`);
      variants.forEach((v, i) => {
        const sku = skus[i];
        const isMaster = master ? sku === master : i === 0;
        this.variant(v, sku, code, axes, images, isMaster, handle);
        carried.set(String(v.id), { sku, policy: v.inventoryPolicy });
      });
    }

    for (const [, spellings] of vendors) {
      if (spellings.size > 1) this.note('decisions', 'vendor-spellings-differ-only-in-case-or-punctuation (passed through as is)', [...spellings].join(' | '));
    }
    return carried;
  }

  /**
   * Shopify options become axes. A product with only the default variant has
   * one option, "Title", with the value "Default Title": that is no axis. An
   * option name shared by several products becomes one attribute, so "Size"
   * on shoes and "Size" on perfume share their values list: check that the
   * business means the same thing by both.
   */
  private productAxes(p: Obj, handle: string): Axis[] {
    const options = Array.isArray(p.options) ? (p.options as Obj[]) : [];
    const onlyDefault =
      p.hasOnlyDefaultVariant === true ||
      (options.length === 1 && options[0].name === 'Title' && Array.isArray(options[0].values) && (options[0].values as unknown[]).every((v) => v === 'Default Title'));
    if (onlyDefault) return [];
    return [...options]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((o) => {
        const label = String(o.name ?? '');
        const name = keyFromLabel(label);
        if (name.length < 2) throw new AdapterStop(`${handle}: the option "${label}" yields no attribute name. Name the attribute in the adapter.`);
        if (OWN_ATTRIBUTES.has(name) || Object.values(this.options.metafields ?? {}).includes(name)) {
          throw new AdapterStop(`${handle}: the option "${label}" becomes the attribute "${name}", which another field already uses. Rename one in the adapter.`);
        }
        const axis = this.axes.get(name) ?? { name, label, values: new Map<string, string>(), products: new Set<string>() };
        if (axis.label !== label) this.note('decisions', 'option-names-differing-in-case-share-one-attribute', `${axis.label} | ${label}`);
        axis.products.add(handle);
        this.axes.set(name, axis);
        return axis;
      });
  }

  /** Option values become enum keys; two values with one key stop, because merging them would merge variants. */
  private axisValue(axis: Axis, value: string, handle: string): string {
    const key = keyFromLabel(value) || `value-${[...value].map((c) => c.codePointAt(0)?.toString(16)).join('')}`;
    const existing = axis.values.get(key);
    if (existing !== undefined && existing !== value) {
      throw new AdapterStop(
        `${handle}: the ${axis.label} values "${existing}" and "${value}" both become the key "${key}". ` +
          'Ask the business whether they are one value or two (the same size written two ways, or two sizes), then map them in the adapter.',
      );
    }
    axis.values.set(key, value);
    return key;
  }

  /**
   * Collections are flat, and a product sits in any number of them. A
   * collection built from conditions is rule-based: its membership is read as
   * it stood at the export, and the rules are not carried, so a product added
   * later joins no category. Sub-collections are a membership reference, not
   * a tree, so they load flat too.
   */
  private productCategories(p: Obj, children: Obj[], handle: string): string[] {
    const mode = this.options.categories?.from ?? 'collections';
    if (mode === 'none') return [];
    if (mode === 'productType') {
      const type = typeof p.productType === 'string' ? p.productType.trim() : '';
      if (!type) return [];
      return [this.category(`type:${type}`, keyFromLabel(type), type)];
    }
    const exclude = new Set(this.options.categories?.exclude ?? []);
    const out: string[] = [];
    for (const c of children.filter((c) => gidType(c.id) === 'Collection')) {
      const handleOfCollection = String(c.handle);
      if (exclude.has(handleOfCollection)) {
        this.note('decisions', 'collection-excluded-by-options', `${handle} @ ${handleOfCollection}`);
        continue;
      }
      const full = this.source.collections.get(String(c.id)) ?? c;
      const code = this.category(String(c.id), keyFromLabel(handleOfCollection), String(full.title ?? handleOfCollection), full);
      out.push(code);
    }
    return out.sort();
  }

  private category(id: string, code: string, title: string, collection?: Obj): string {
    const existing = this.categoryCodes.get(id);
    if (existing) return existing;
    if (!code) throw new AdapterStop(`The category "${title}" yields no code.`);
    if ([...this.categoryCodes.values()].includes(code)) throw new AdapterStop(`Two categories both become the code "${code}".`);
    this.categoryCodes.set(id, code);
    const record: Record<string, unknown> = { _type: 'category', code, name: this.text(title), sourceOrder: this.categoryCodes.size };
    if (collection) {
      record.slug = this.text(String(collection.handle));
      record.externalId = String(collection.id);
      if (typeof collection.descriptionHtml === 'string' && collection.descriptionHtml.trim() !== '') record.description = this.text(collection.descriptionHtml);
      // Since 2026-07 a collection lists its sources. A conditions source holds rules
      // and hand-picked products alike: it is rule-based only when it has conditions.
      // A hand-picked collection is a conditions source with none. Older exports carry ruleSet.
      const sources = Array.isArray(collection.sources) ? (collection.sources as Obj[]) : [];
      const conditions = (part: unknown) => (Array.isArray((part as Obj | null | undefined)?.conditions) ? ((part as Obj).conditions as unknown[]).length : 0);
      const ruleBased = collection.ruleSet != null || sources.some((x) => conditions(x.inclusion) + conditions(x.exclusion) > 0);
      if (ruleBased) {
        this.note('decisions', 'rule-based-collection-loaded-as-static-category (its rules are not carried)', code);
      }
      if (sources.some((x) => x.__typename === 'CollectionSubCollectionsSource')) {
        this.note('decisions', 'collection-with-sub-collections-loaded-flat (membership as exported, no nesting)', code);
      }
      if (collection.sortOrder && collection.sortOrder !== 'MANUAL') {
        this.note('losses', 'collection-sort-order (the feed has no product order within a category)', `${code}: ${String(collection.sortOrder)}`);
      } else if (collection.sortOrder === 'MANUAL') {
        this.note('losses', 'manual-product-order-within-collection (not in the feed contract)', code);
      }
    }
    this.records.push(record);
    return code;
  }

  private productAttributes(p: Obj, children: Obj[], handle: string, vendors: Map<string, Set<string>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof p.vendor === 'string' && p.vendor.trim() !== '') {
      // Carried as written. Two spellings of one vendor are reported, never merged.
      out.vendor = p.vendor;
      this.usedAttributes.set('vendor', 'text');
      const norm = p.vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
      vendors.set(norm, (vendors.get(norm) ?? new Set<string>()).add(p.vendor));
    }
    const mapped = this.options.metafields ?? {};
    for (const m of children.filter((c) => gidType(c.id) === 'Metafield' || (c.namespace !== undefined && c.key !== undefined))) {
      const field = `${String(m.namespace)}.${String(m.key)}`;
      const attribute = mapped[field];
      if (!attribute) {
        this.note('losses', `metafield-not-carried (${field})`, handle);
        continue;
      }
      const type = METAFIELD_TYPES[String(m.type)];
      if (!type) {
        throw new AdapterStop(
          `${handle}: the metafield ${field} has the type "${String(m.type)}", which this example does not map. Map it, or leave it out of options.metafields and report it as not migrated.`,
        );
      }
      const raw = String(m.value ?? '');
      let value: unknown = raw;
      if (type === 'number') {
        if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new AdapterStop(`${handle}: ${field} is "${raw}", not a number.`);
        value = Number(raw);
      } else if (type === 'boolean') value = raw === 'true';
      else if (type === 'date') value = raw.slice(0, 10);
      const known = this.usedAttributes.get(attribute);
      if (known && known !== type) throw new AdapterStop(`The attribute ${attribute} receives both ${known} and ${type} values.`);
      this.usedAttributes.set(attribute, type);
      out[attribute] = value;
    }
    return out;
  }

  /**
   * Shopify keeps a taxable flag per variant; commercetools holds one tax
   * category per product. Variants that disagree stop the run, because
   * either choice would tax some of them wrongly. The tax categories come
   * without rates: Shopify computes tax from the destination, and the rates
   * and the tax mode are decided with the business.
   */
  private taxCategory(variants: Obj[], handle: string): string {
    const flags = new Set(variants.map((v) => v.taxable !== false));
    if (flags.size > 1) {
      const exempt = variants.filter((v) => v.taxable === false).map((v) => String(v.sku || v.id));
      throw new AdapterStop(
        `${handle}: some variants are taxable and some are not (${exempt.join(', ')} not), and commercetools holds one tax category per product. ` +
          'Ask whoever owns tax whether to split the product, or which category applies to all of it.',
      );
    }
    const taxable = flags.has(true);
    const code = taxable ? (this.options.taxCategories?.taxable ?? 'taxable') : (this.options.taxCategories?.notTaxable ?? 'not-taxable');
    this.usedTaxCategories.add(code);
    if (!taxable) this.note('decisions', 'product-not-taxable', handle);
    return code;
  }

  private reportProductLosses(p: Obj, children: Obj[], handle: string): void {
    if (Array.isArray(p.tags) && p.tags.length > 0) this.note('losses', 'tags', `${handle}: ${(p.tags as string[]).join(', ')}`);
    const seo = p.seo as Obj | undefined;
    if (seo && (seo.title || seo.description)) this.note('losses', 'seo-title-and-description (the feed has no meta fields)', handle);
    const category = p.category as Obj | undefined;
    if (category?.fullName) this.note('losses', 'shopify-product-taxonomy-category', `${handle}: ${String(category.fullName)}`);
    for (const m of children.filter((c) => ['Video', 'ExternalVideo', 'Model3d'].includes(String(gidType(c.id))))) {
      this.note('losses', `media-${String(gidType(m.id))}`, handle);
    }
  }

  /**
   * Shopify attaches media to the product, and a variant can name some of
   * them as its own; commercetools attaches images to variants only. So each variant
   * gets its own image first, then the product's, which repeats a URL but
   * leaves no variant without a picture. The URLs point at Shopify's CDN.
   */
  private productImages(children: Obj[], handle: string): { url: string; width?: number; height?: number; label?: string }[] {
    const images = children
      .filter((c) => gidType(c.id) === 'MediaImage')
      .flatMap((m) => {
        const img = m.image as Obj | null | undefined;
        if (!img?.url) {
          this.note('decisions', 'media-image-without-url-skipped (still processing, or failed)', handle);
          return [];
        }
        return [this.image(img, m.alt)];
      });
    if (images.some((i) => /(^|\.)cdn\.shopify\.com$/.test(hostOf(i.url)))) this.note('decisions', 'image-urls-point-at-shopify-cdn (re-host before the store closes)', handle);
    return images;
  }

  private image(img: Obj, alt: unknown): { url: string; width?: number; height?: number; label?: string } {
    const out: { url: string; width?: number; height?: number; label?: string } = { url: String(img.url) };
    if (Number.isInteger(img.width)) out.width = img.width as number;
    if (Number.isInteger(img.height)) out.height = img.height as number;
    const label = (typeof alt === 'string' && alt) || (typeof img.altText === 'string' && img.altText) || undefined;
    if (label) out.label = label;
    return out;
  }

  // ------------------------------------------------------------ variants

  /**
   * SKUs become variant keys in commercetools. Shopify allows a variant with
   * no SKU, so an empty one stops the run unless the business has agreed to
   * derive them. A derived SKU is built from the handle and the option
   * values, which a merchant can rename: it holds for a one-shot load, and a
   * second load after a rename creates a second variant.
   */
  private sku(v: Obj, handle: string, axes: Axis[]): string {
    let sku = typeof v.sku === 'string' ? v.sku.trim() : '';
    if (!sku) {
      if (this.options.skus !== 'derive') {
        throw new AdapterStop(
          `${handle}: a variant (${String(v.id)}) has no SKU, and SKUs become variant keys. Ask the business for real SKUs, ` +
            'or agree to derive them (options.skus = "derive", valid for a one-shot load only, because a renamed handle or option value derives a new one).',
        );
      }
      const parts = axes.length === 0 ? [] : this.selected(v, axes, handle).map(([, value]) => keyFromLabel(value));
      sku = [handle, ...parts].join('-').toUpperCase();
      this.note('decisions', 'sku-derived-from-handle-and-option-values (one-shot load only)', `${String(v.id)} → ${sku}`);
    } else if (sku !== v.sku) {
      this.note('decisions', 'sku-whitespace-trimmed', sku);
    }
    const other = this.skus.get(sku);
    if (other !== undefined) {
      throw new AdapterStop(`The SKU "${sku}" is on a variant of ${other} and of ${handle}; a SKU is one variant in commercetools. Ask which one keeps it.`);
    }
    this.skus.set(sku, handle);
    return sku;
  }

  private selected(v: Obj, axes: Axis[], handle: string): [Axis, string][] {
    const chosen = Array.isArray(v.selectedOptions) ? (v.selectedOptions as Obj[]) : [];
    return axes.map((axis) => {
      const option = chosen.find((o) => String(o.name) === axis.label || keyFromLabel(String(o.name)) === axis.name);
      if (!option) throw new AdapterStop(`${handle}: a variant (${String(v.id)}) has no value for the option ${axis.label}.`);
      return [axis, String(option.value)];
    });
  }

  private variant(
    v: Obj,
    sku: string,
    product: string,
    axes: Axis[],
    productImages: { url: string; width?: number; height?: number; label?: string }[],
    isMaster: boolean,
    handle: string,
  ): void {
    const price = this.money(v.price, `${sku} price`);
    const record: Record<string, unknown> = { _type: 'variant', sku, product, prices: [{ currency: this.currency, amount: price }] };
    if (axes.length > 0) {
      const axisValues: Record<string, string> = {};
      const axisLabels: Record<string, Record<string, string>> = {};
      for (const [axis, value] of this.selected(v, axes, handle)) {
        axisValues[axis.name] = this.axisValue(axis, value, handle);
        axisLabels[axis.name] = this.text(value);
      }
      record.axisValues = axisValues;
      record.axisLabels = axisLabels;
    }

    if (v.compareAtPrice !== null && v.compareAtPrice !== undefined && v.compareAtPrice !== '') {
      const compareAt = this.money(v.compareAtPrice, `${sku} compareAtPrice`);
      if (Number(compareAt) <= Number(price)) {
        this.note('decisions', 'compare-at-price-not-above-price-dropped', `${sku}: ${compareAt} vs ${price}`);
      } else if (this.options.compareAtPrice === 'attribute') {
        // commercetools has no "was" price field. Stored as an attribute, nothing
        // in the platform reads it as a strikethrough price: the storefront must.
        record.attributes = { compareAtPrice: { currency: this.currency, amount: compareAt } };
        this.usedAttributes.set('compareAtPrice', 'money');
        this.note('decisions', 'compare-at-price-carried-as-attribute', sku);
      } else {
        this.note('losses', 'compare-at-price (no commercetools field; options.compareAtPrice = "attribute" carries it)', `${sku}: ${compareAt}`);
      }
    }

    const own = (this.source.variants.get(String(v.id))?.media ?? [])
      .filter((m) => gidType(m.id) === 'MediaImage' && (m.image as Obj | null | undefined)?.url)
      .map((m) => this.image(m.image as Obj, m.alt));
    const images = [...own];
    for (const i of productImages) if (!images.some((x) => x.url === i.url)) images.push(i);
    if (images.length > 0) record.images = images;
    if (own.length === 0 && productImages.length > 0 && axes.length > 0) this.note('decisions', 'product-images-repeated-on-variant', sku);
    if (isMaster) record.isMaster = true;

    const weight = ((v.inventoryItem as Obj | undefined)?.measurement as Obj | undefined)?.weight as Obj | undefined;
    if (weight && Number(weight.value) > 0) this.note('losses', 'weight', `${sku}: ${String(weight.value)} ${String(weight.unit)}`);
    this.records.push(record);
  }

  /** Money from the digit string, never through a float; more digits than the currency has stop the run. */
  private money(raw: unknown, where: string): string {
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(String(raw ?? '').trim());
    if (!m) throw new AdapterStop(`${where}: "${String(raw)}" is not a plain decimal.`);
    const fraction = (m[2] ?? '').replace(/0+$/, '');
    if (fraction.length > this.options.fractionDigits) {
      throw new AdapterStop(`${where}: "${String(raw)}" has more decimal places than ${this.currency} allows; decide how to round it.`);
    }
    return this.options.fractionDigits === 0 ? m[1] : `${m[1]}.${fraction.padEnd(this.options.fractionDigits, '0')}`;
  }

  // ------------------------------------------------------------ stock

  /**
   * A variant whose inventory is not tracked has no stock to carry: it gets
   * no entry, not a zero, which would make it unsellable. With one location
   * the stock is project-wide; with several, each location becomes a supply
   * channel the business names.
   */
  private inventory(carried: Map<string, { sku: string; policy: unknown }>): void {
    const quantityName = this.options.stockQuantity;
    const locationsWithStock = new Map<string, string>(); // id → name
    const rows: { sku: string; location: Obj; quantity: number }[] = [];

    for (const [id, { sku, policy }] of carried) {
      const entry = this.source.variants.get(id);
      if (!entry) {
        this.note('decisions', 'variant-without-inventory-line-no-entry', sku);
        continue;
      }
      if ((entry.variant.inventoryItem as Obj | undefined)?.tracked !== true) {
        this.note('decisions', 'untracked-variant-no-stock-entry', sku);
        continue;
      }
      if (policy === 'CONTINUE') this.note('losses', 'continue-selling-when-out-of-stock (no equivalent on an inventory entry)', sku);
      for (const level of entry.levels) {
        const location = level.location as Obj;
        const q = (Array.isArray(level.quantities) ? (level.quantities as Obj[]) : []).find((x) => x.name === quantityName);
        if (q === undefined) throw new AdapterStop(`${sku}: the inventory level at ${String(location?.name)} has no "${quantityName}" quantity. Re-run the extractor with that name requested.`);
        const n = Number(q.quantity);
        if (!Number.isInteger(n)) throw new AdapterStop(`${sku}: the ${quantityName} quantity "${String(q.quantity)}" is not a whole number.`);
        if (n < 0) {
          throw new AdapterStop(
            `${sku}: ${quantityName} is ${n} at ${String(location?.name)}, oversold (the variant keeps selling when out of stock). Decide what it should load as.`,
          );
        }
        locationsWithStock.set(String(location.id), String(location.name));
        rows.push({ sku, location, quantity: n });
      }
    }

    if (locationsWithStock.size <= 1) {
      if (locationsWithStock.size === 1) this.note('decisions', 'single-location-loaded-as-project-wide-stock', [...locationsWithStock.values()][0]);
      for (const r of rows) this.records.push({ _type: 'inventoryEntry', sku: r.sku, quantityOnStock: r.quantity });
      return;
    }
    const map = this.options.locations ?? {};
    const channelOf = (id: string, name: string): string | undefined => map[id] ?? map[name];
    const unmapped = [...locationsWithStock].filter(([id, name]) => !channelOf(id, name)).map(([, name]) => name);
    if (unmapped.length > 0) {
      throw new AdapterStop(
        `Stock sits in ${locationsWithStock.size} locations (${[...locationsWithStock.values()].join(', ')}); ${unmapped.join(', ')} not in options.locations. ` +
          'Decide with the business whether stock is per location (a supply channel each) or one total.',
      );
    }
    const channels = new Set<string>();
    for (const r of rows) {
      const channel = channelOf(String(r.location.id), String(r.location.name)) as string;
      channels.add(channel);
      this.records.push({ _type: 'inventoryEntry', sku: r.sku, quantityOnStock: r.quantity, supplyChannel: channel });
    }
    for (const c of channels) this.records.push({ _type: 'channel', code: c, roles: ['InventorySupply'] });
  }

  // ------------------------------------------------------------ definitions

  private definitions(): void {
    for (const axis of this.axes.values()) {
      if (axis.products.size > 1) this.note('decisions', 'option-shared-by-several-products-is-one-attribute', `${axis.label}: ${axis.products.size} products`);
      this.records.push({
        _type: 'attributeDefinition',
        name: axis.name,
        label: this.text(axis.label),
        type: 'lenum',
        level: 'variant',
        axis: true,
        values: [...axis.values].map(([key, label]) => ({ key, label: this.text(label) })),
      });
    }
    for (const [name, type] of this.usedAttributes) {
      const label = name === 'compareAtPrice' ? 'Compare-at price' : name === 'vendor' ? 'Vendor' : name;
      this.records.push({ _type: 'attributeDefinition', name, label: this.text(label), type, level: name === 'compareAtPrice' ? 'variant' : 'product' });
    }
  }

  private taxCategories(): void {
    for (const code of this.usedTaxCategories) {
      this.records.push({ _type: 'taxCategory', code, name: code });
      this.note('decisions', 'tax-category-without-rates (rates and the tax mode are decided in step 0)', code);
    }
    if (this.source.shop.shop.taxesIncluded === true) this.note('decisions', 'shop-prices-include-tax (taxesIncluded is true)', this.currency);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A key for the feed ([A-Za-z0-9_-]) from a label: "100 ml" → "100-ml". */
export function keyFromLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
