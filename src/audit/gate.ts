/**
 * The audit gate.
 *
 * Every invariant commercetools enforces at write time, checked against the
 * plan before anything is sent. The API names one offending record and stops;
 * the gate names all of them, and does it without credentials.
 *
 * This module deliberately reads only the emitted plan — never the feed, never
 * the mapper's internals. A verifier that shares logic with the writer confirms
 * the writer's bugs rather than finding them, so the checks here re-derive what
 * they need from the drafts as data. That is also why `audit` loads plan.json
 * from disk instead of taking the in-memory object: it checks what will
 * actually be sent.
 */

import type { PipelineConfig } from '../model/config.js';
import type {
  Asset,
  AttributeDefinition,
  CategoryImport,
  AttributeType,
  MigrationPlan,
  PriceDraftImport,
  ProductDraftImport,
  ProductTypeImport,
  ProductVariantDraftImport,
  StandalonePriceImport,
} from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import {
  MAX_VARIANTS_CLASSIC,
  MAX_VARIANTS_MODULAR,
  VARIANT_WARN_THRESHOLD,
} from '../model/limits.js';
import { isValidKey } from '../map/identity.js';
import {
  attributeDefinitionsOf,
  attributeName,
  attributesOf,
  categoriesOf,
  indexVariants,
  pricesOf,
  variantSku,
  variantsOf,
} from '../model/plan.js';

/** Embedded Prices per Variant. The variant caps are shared with `validate`. */
const MAX_EMBEDDED_PRICES = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface AuditResult {
  diagnostics: Diagnostic[];
  checked: {
    productTypes: number;
    categories: number;
    products: number;
    variants: number;
    /** Embedded prices, i.e. prices inside a variant draft. */
    prices: number;
    standalonePrices: number;
    attributeValues: number;
  };
}

export function auditPlan(plan: MigrationPlan, config: PipelineConfig): AuditResult {
  const diagnostics: Diagnostic[] = [];
  const checked = {
    productTypes: plan.productTypes.length,
    categories: plan.categories.length,
    products: plan.products.length,
    variants: 0,
    prices: 0,
    standalonePrices: plan.standalonePrices.length,
    attributeValues: 0,
  };

  const definitions = indexDefinitions(plan.productTypes);
  const pricedSkus = new Set(plan.standalonePrices.map((p) => p.sku));
  // Under Modular the variants are a separate collection, so every check that
  // walks "this product's variants" goes through the index rather than the
  // product. The checks themselves are identical in both models — the
  // invariants a variant has to satisfy do not depend on where it is stored.
  const variantsByProduct = indexVariants(plan);
  const variantsFor = (key: string) => variantsByProduct.get(key) ?? [];

  checkKeysAndSlugs(plan, diagnostics);
  checkReferences(plan, diagnostics);
  checkOrderHints(plan.categories, diagnostics);

  for (const product of plan.products) {
    const variants = variantsFor(product.key);
    checked.variants += variants.length;

    checkVariantCount(product, variants, config, diagnostics);

    const byName = definitions.get(product.productType.key);
    if (!byName) {
      // Already reported as a dangling reference; no point cascading.
      continue;
    }

    for (const variant of variants) {
      checked.prices += pricesOf(variant).length;
      checked.attributeValues += attributesOf(variant).length;

      checkAttributeValues(product, variant, byName, diagnostics);
      checkRequiredAttributes(product, variant, byName, diagnostics);
      checkPrices(product, variant, config, diagnostics);
    }

    checkSameForAll(product, variants, byName, diagnostics);
    checkCombinationUnique(product, variants, byName, diagnostics);
    checkAdvisory(product, variants, pricedSkus, diagnostics);
  }

  checkUnpopulatedAttributes(plan, definitions, diagnostics);
  checkCategoryUsage(plan, diagnostics);
  checkPriceModeConsistency(plan, config, diagnostics);
  checkStandalonePrices(plan, config, diagnostics);

  return { diagnostics, checked };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function indexDefinitions(
  productTypes: ProductTypeImport[],
): Map<string, Map<string, AttributeDefinition>> {
  const index = new Map<string, Map<string, AttributeDefinition>>();
  for (const pt of productTypes) {
    index.set(pt.key, new Map(attributeDefinitionsOf(pt).map((a) => [a.name, a])));
  }
  return index;
}

// ---------------------------------------------------------------------------
// Keys, slugs, order hints
// ---------------------------------------------------------------------------

/** First available localized value, used to tell same-key duplicates apart. */
function anyName(localized: Record<string, string> | undefined): string {
  const values = Object.values(localized ?? {});
  return values.length > 0 ? values[0] : '';
}

function checkKeysAndSlugs(plan: MigrationPlan, diagnostics: Diagnostic[]): void {
  const variantsByProduct = indexVariants(plan);
  const keys = new Map<string, string>();
  const seenCount = new Map<string, number>();

  const claimKey = (key: string, owner: string) => {
    if (!isValidKey(key)) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-key',
        message:
          `${owner} has key '${key}', which is not 2-256 characters of [A-Za-z0-9_-]. ` +
          'The API rejects it.',
      });
    }
    const occurrence = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, occurrence);

    const prior = keys.get(key);
    if (prior) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-resource-key',
        message:
          `Key '${key}' is claimed twice — first by ${prior}, then by ${owner} ` +
          `(occurrence ${occurrence}). The second import would overwrite the first, so ` +
          'part of the catalog would silently go missing.',
      });
    } else {
      keys.set(key, owner);
    }
  };

  // Slug uniqueness is per locale and project-wide within a resource type.
  const categorySlugs = new Map<string, Map<string, string>>();
  const productSlugs = new Map<string, Map<string, string>>();

  // SKU uniqueness is **project-wide**, not per product: "Unique across all
  // ProductVariants in a Project". This was scoped per product, which caught
  // the common case — the same SKU twice on one product — and missed the one
  // that matters more, because two products claiming a SKU is how a collapsed
  // hierarchy or a re-used source code silently merges two things inventory
  // and orders then cannot tell apart.
  const skus = new Map<string, string>();

  const claimSlug = (
    store: Map<string, Map<string, string>>,
    kind: string,
    owner: string,
    slug: Record<string, string>,
  ) => {
    for (const [locale, value] of Object.entries(slug)) {
      if (!isValidKey(value)) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid-slug',
          message:
            `${owner} has slug '${value}' in ${locale}, which does not match ` +
            '[A-Za-z0-9_-]{2,256}.',
        });
        continue;
      }
      let perLocale = store.get(locale);
      if (!perLocale) {
        perLocale = new Map();
        store.set(locale, perLocale);
      }
      const prior = perLocale.get(value);
      if (prior) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-slug',
          message:
            `${kind} slug '${value}' in ${locale} is used by both ${prior} and ${owner}. ` +
            'Slugs are unique across the Project per locale, so the second write fails.',
        });
      } else {
        perLocale.set(value, owner);
      }
    }
  };

  // Assets carry a required key that reaches the project, so it gets the same
  // scrutiny as any other: charset, and no two resources claiming one.
  const claimAssets = (owner: string, assets: Asset[] | undefined) => {
    // Asset keys are unique **per ProductVariant or Category**, not per
    // project: "It is unique per Category or ProductVariant." Claiming them in
    // the project-wide namespace made the natural mapping illegal — the same
    // source asset reused across the sizes of one colour is one key on several
    // variants, which the API permits. A dogfood run worked around this by
    // inventing per-SKU codes it did not need, so the check was not merely
    // noisy: it changed the shape of the data.
    const ownerKeys = new Set<string>();

    for (const asset of assets ?? []) {
      if (!isValidKey(asset.key)) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid-key',
          message:
            `Asset '${asset.key}' on ${owner} has a key that is not 2-256 characters ` +
            'of [A-Za-z0-9_-]. The API rejects it.',
        });
      }
      if (ownerKeys.has(asset.key)) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-asset-key',
          message:
            `${owner} has two assets keyed '${asset.key}'. Asset keys are unique per ` +
            'variant and per category, so the second would collide with the first on ' +
            'the same owner.',
        });
      }
      ownerKeys.add(asset.key);

      if (asset.sources.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'asset-without-source',
          message:
            `Asset '${asset.key}' on ${owner} has no sources. commercetools requires at ` +
            'least one — an asset with none is a name attached to nothing.',
        });
      }

      // Source keys distinguish renditions inside one asset, so a duplicate
      // silently collapses two of them.
      const sourceKeys = new Map<string, number>();
      for (const source of asset.sources) {
        if (source.key === undefined) continue;
        sourceKeys.set(source.key, (sourceKeys.get(source.key) ?? 0) + 1);
      }
      for (const [key, count] of sourceKeys) {
        if (count > 1) {
          diagnostics.push({
            severity: 'error',
            code: 'duplicate-asset-source-key',
            message:
              `Asset '${asset.key}' on ${owner} has ${count} sources keyed '${key}'. ` +
              'Source keys are what tell renditions apart, so a duplicate means two of ' +
              'them cannot be addressed separately.',
          });
        }
      }

      if (Object.keys(asset.name ?? {}).length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'asset-without-name',
          message:
            `Asset '${asset.key}' on ${owner} has no name in any locale. commercetools ` +
            'requires one.',
        });
      }
    }
  };

  for (const pt of plan.productTypes) claimKey(pt.key, `productType '${pt.key}'`);

  for (const c of plan.categories) {
    const label = `category '${c.key}'${anyName(c.name) ? ` (${anyName(c.name)})` : ''}`;
    claimKey(c.key, label);
    claimSlug(categorySlugs, 'Category', label, c.slug);
  }

  for (const p of plan.products) {
    const label = `product '${p.key}'${anyName(p.name) ? ` (${anyName(p.name)})` : ''}`;
    claimKey(p.key, label);
    claimSlug(productSlugs, 'Product', label, p.slug);

    const priceKeys = new Map<string, string>();
    for (const v of variantsByProduct.get(p.key) ?? []) {
      claimKey(v.key, `variant '${variantSku(v)}'`);
      claimAssets(`variant '${variantSku(v)}'`, v.assets);
      if (v.sku === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'variant-without-sku',
          message:
            `Variant '${v.key}' on product '${p.key}' has no SKU. The API allows it, but a ` +
            'migrated catalog needs one: the SKU is the permanent identifier inventory, ' +
            'orders and fulfilment join on.',
        });
      }
      const prior = skus.get(variantSku(v));
      if (prior !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-sku',
          message:
            `SKU '${variantSku(v)}' is claimed twice — by ${prior} and by variant ` +
            `'${v.key}' on product '${p.key}'. A SKU is unique across the whole Project, ` +
            'and it is what inventory, orders and fulfilment join on, so two variants ' +
            'sharing one is a merge nothing downstream can undo.',
        });
      } else {
        skus.set(variantSku(v), `variant '${v.key}' on product '${p.key}'`);
      }

      // A price key is required on import, and two prices sharing one collide.
      // The mapper derives keys from the price scope, so a duplicate here means
      // two prices really do occupy the same scope.
      for (const price of pricesOf(v)) {
        const prior = priceKeys.get(price.key);
        if (prior) {
          diagnostics.push({
            severity: 'error',
            code: 'duplicate-price-key',
            message:
              `Price key '${price.key}' is used twice on product '${p.key}' ` +
              `(variants '${prior}' and '${variantSku(v)}'). The second import would ` +
              'overwrite the first.',
          });
        } else {
          priceKeys.set(price.key, variantSku(v));
        }
      }
    }
  }

  for (const category of plan.categories) {
    claimAssets(`category '${category.key}'`, (category as { assets?: Asset[] }).assets);
  }

  // Standalone Price keys are project-wide, not per product, so they go through
  // the same map as every other resource rather than a per-product one.
  for (const price of plan.standalonePrices) {
    claimKey(price.key, `standalone price '${price.key}' (sku '${price.sku}')`);
  }
}

function checkOrderHints(categories: CategoryImport[], diagnostics: Diagnostic[]): void {
  for (const c of categories) {
    // Optional on CategoryImport: the API assigns one when omitted. The
    // pipeline always sets it, so an absent hint means something upstream
    // dropped it rather than that it was never wanted.
    if (c.orderHint === undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'order-hint-absent',
        message:
          `Category '${c.key}' has no orderHint, so commercetools will assign one and ` +
          'the source ordering is lost.',
      });
      continue;
    }
    const value = Number(c.orderHint);
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-order-hint',
        message:
          `Category '${c.key}' has orderHint '${c.orderHint}', which must be a decimal ` +
          'strictly between 0 and 1.',
      });
      continue;
    }
    if (c.orderHint.endsWith('0')) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-order-hint',
        message:
          `Category '${c.key}' has orderHint '${c.orderHint}', which ends in 0. ` +
          'commercetools rejects order hints ending in zero.',
      });
    }
  }
}

function checkReferences(plan: MigrationPlan, diagnostics: Diagnostic[]): void {
  const categoryKeys = new Set(plan.categories.map((c) => c.key));
  const productTypeKeys = new Set(plan.productTypes.map((p) => p.key));

  for (const c of plan.categories) {
    if (c.parent && !categoryKeys.has(c.parent.key)) {
      diagnostics.push({
        severity: 'error',
        code: 'dangling-category-parent',
        message:
          `Category '${c.key}' references parent '${c.parent.key}', which the plan does ` +
          'not create. The Import Operation would sit unresolved for 48 hours and then ' +
          'expire.',
      });
    }
  }

  for (const p of plan.products) {
    if (!productTypeKeys.has(p.productType.key)) {
      diagnostics.push({
        severity: 'error',
        code: 'dangling-product-type',
        message:
          `Product '${p.key}' references ProductType '${p.productType.key}', which the ` +
          'plan does not create.',
      });
    }
    for (const c of categoriesOf(p)) {
      if (!categoryKeys.has(c.key)) {
        diagnostics.push({
          severity: 'error',
          code: 'dangling-category-reference',
          message:
            `Product '${p.key}' references category '${c.key}', which the plan does not ` +
            'create.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function checkVariantCount(
  product: ProductDraftImport,
  variants: ProductVariantDraftImport[],
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const modular = config.target.catalogModel === 'Modular';
  const cap = modular ? MAX_VARIANTS_MODULAR : MAX_VARIANTS_CLASSIC;

  if (variants.length > cap) {
    diagnostics.push({
      severity: 'error',
      code: 'variant-limit-exceeded',
      message:
        `Product '${product.key}' has ${variants.length} variants, above the ` +
        `${config.target.catalogModel} limit of ${cap}.` +
        (modular
          ? ' Modular is already the higher ceiling, so this needs a limit increase ' +
            'arranged for the project — splitting the product would change the catalog ' +
            'model rather than migrate it.'
          : ' This is a catalog for the Modular catalog model, where the ceiling is ' +
            `${MAX_VARIANTS_MODULAR} — not a product that needs splitting. Set ` +
            "target.catalogModel to 'Modular' if the project can be switched; " +
            '`validate` reports this against the feed, before anything is planned.'),
    });
  } else if (!modular && variants.length > VARIANT_WARN_THRESHOLD) {
    diagnostics.push({
      severity: 'warning',
      code: 'approaching-variant-limit',
      message:
        `Product '${product.key}' has ${variants.length} variants, close to the Classic ` +
        `limit of ${MAX_VARIANTS_CLASSIC}. A catalog that grows will hit it.`,
    });
  }
}

/**
 * An attribute written but not declared on the ProductType rejects the *whole*
 * product, with a terse error naming one attribute. Catching it here names
 * every one of them.
 */
function checkAttributeValues(
  product: ProductDraftImport,
  variant: ProductVariantDraftImport,
  definitions: Map<string, AttributeDefinition>,
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();

  for (const attribute of attributesOf(variant)) {
    if (seen.has(attributeName(attribute))) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-attribute',
        message:
          `Variant '${variantSku(variant)}' sets '${attributeName(attribute)}' more than once. Only one of ` +
          'the values would survive.',
      });
    }
    seen.add(attributeName(attribute));

    const definition = definitions.get(attributeName(attribute));
    if (!definition) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-not-declared',
        message:
          `Variant '${variantSku(variant)}' sets '${attributeName(attribute)}', which ProductType ` +
          `'${product.productType.key}' does not declare. commercetools rejects the entire ` +
          'product, not just the attribute.',
      });
      continue;
    }

    const problem = describeTypeMismatch(attribute.value, definition.type);
    if (problem) {
      diagnostics.push({
        severity: 'error',
        code: problem.code,
        message: `Variant '${variantSku(variant)}', attribute '${attributeName(attribute)}': ${problem.message}`,
      });
    }
  }
}

function checkRequiredAttributes(
  product: ProductDraftImport,
  variant: ProductVariantDraftImport,
  definitions: Map<string, AttributeDefinition>,
  diagnostics: Diagnostic[],
): void {
  const present = new Set(attributesOf(variant).map((a) => attributeName(a)));
  for (const definition of definitions.values()) {
    if (!definition.isRequired) continue;
    if (present.has(definition.name)) continue;
    diagnostics.push({
      severity: 'error',
      code: 'required-attribute-missing',
      message:
        `Variant '${variantSku(variant)}' omits '${definition.name}', which ProductType ` +
        `'${product.productType.key}' marks required. The product is rejected.`,
    });
  }
}

interface TypeProblem {
  code: string;
  message: string;
}

function describeTypeMismatch(
  value: unknown,
  type: AttributeType,
): TypeProblem | undefined {
  const mismatch = (expected: string): TypeProblem => ({
    code: 'attribute-type-mismatch',
    message: `declared ${type.name}, but the value is ${describeValue(value)}. Expected ${expected}.`,
  });

  switch (type.name) {
    case 'text':
      return typeof value === 'string' ? undefined : mismatch('a string');

    case 'ltext':
      if (!isPlainObject(value)) return mismatch('a locale-keyed object');
      for (const [locale, text] of Object.entries(value)) {
        if (typeof text !== 'string') {
          return mismatch(`a string for every locale (${locale} is not)`);
        }
      }
      return undefined;

    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : mismatch('a finite number');

    case 'boolean':
      return typeof value === 'boolean' ? undefined : mismatch('a boolean');

    case 'date':
      if (typeof value !== 'string') return mismatch('an ISO date string');
      return ISO_DATE.test(value) ? undefined : mismatch('an ISO date (YYYY-MM-DD)');

    case 'datetime':
      if (typeof value !== 'string') return mismatch('an ISO timestamp string');
      return ISO_DATETIME.test(value) ? undefined : mismatch('an ISO timestamp');

    case 'time':
      if (typeof value !== 'string') return mismatch('an ISO time string');
      return ISO_TIME.test(value) ? undefined : mismatch('an ISO time (HH:MM:SS)');

    case 'money':
      if (!isPlainObject(value)) return mismatch('a money object');
      if (typeof value.currencyCode !== 'string' || typeof value.centAmount !== 'number') {
        return mismatch('an object with currencyCode and centAmount');
      }
      return undefined;

    case 'reference':
      if (!isPlainObject(value)) return mismatch('a reference object');
      if (typeof value.key !== 'string' && typeof value.id !== 'string') {
        return mismatch('a reference carrying a key or an id');
      }
      return undefined;

    case 'enum':
    case 'lenum': {
      if (typeof value !== 'string') {
        return mismatch('the key of a declared value, as a string');
      }
      const keys = type.values.map((v) => v.key);
      if (!keys.includes(value)) {
        return {
          code: 'enum-value-not-declared',
          message:
            `'${value}' is not one of the ${keys.length} declared ${type.name} value(s) ` +
            `(${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}). ` +
            'commercetools rejects an undeclared enum key.',
        };
      }
      return undefined;
    }

    case 'set': {
      if (!Array.isArray(value)) return mismatch('an array');
      for (const element of value) {
        const problem = describeTypeMismatch(element, type.elementType);
        if (problem) {
          return {
            code: problem.code,
            message: `set element rejected — ${problem.message}`,
          };
        }
      }
      return undefined;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return `an object (${Object.keys(value).join(', ')})`;
  if (typeof value === 'string') return `the string '${truncate(value)}'`;
  return `${typeof value} ${String(value)}`;
}

function truncate(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
}

/**
 * SameForAll means the API refuses a product whose variants disagree. The
 * mapper replicates product-level values onto every variant, so a violation
 * here means either the replication broke or the feed really did carry
 * per-variant values for an invariant attribute.
 */
function checkSameForAll(
  product: ProductDraftImport,
  variants: ProductVariantDraftImport[],
  definitions: Map<string, AttributeDefinition>,
  diagnostics: Diagnostic[],
): void {
  for (const definition of definitions.values()) {
    if (definition.attributeConstraint !== 'SameForAll') continue;

    const seen: { sku: string; value: unknown }[] = [];
    for (const variant of variants) {
      const attribute = attributesOf(variant).find((a) => attributeName(a) === definition.name);
      if (attribute) seen.push({ sku: variantSku(variant), value: attribute.value });
    }
    if (seen.length < 2) continue;

    const first = seen[0];
    const differing = seen.find((s) => !deepEqual(s.value, first.value));
    if (differing) {
      diagnostics.push({
        severity: 'error',
        code: 'same-for-all-violation',
        message:
          `Product '${product.key}': '${definition.name}' is SameForAll but '${first.sku}' ` +
          `and '${differing.sku}' carry different values. commercetools rejects the product.`,
      });
    }

    // A SameForAll attribute set on some variants but not others is also
    // refused, and is easy to produce by replicating incompletely.
    if (seen.length !== variants.length) {
      diagnostics.push({
        severity: 'error',
        code: 'same-for-all-violation',
        message:
          `Product '${product.key}': '${definition.name}' is SameForAll but only ` +
          `${seen.length} of ${variants.length} variants carry it. It has to be present on ` +
          'every variant or absent from all of them.',
      });
    }
  }
}

function checkCombinationUnique(
  product: ProductDraftImport,
  variants: ProductVariantDraftImport[],
  definitions: Map<string, AttributeDefinition>,
  diagnostics: Diagnostic[],
): void {
  const axes = [...definitions.values()]
    .filter((d) => d.attributeConstraint === 'CombinationUnique')
    .map((d) => d.name)
    .sort();
  if (axes.length === 0) return;

  const combinations = new Map<string, string>();
  for (const variant of variants) {
    const byName = new Map(attributesOf(variant).map((a) => [attributeName(a), a.value]));
    // A variant carrying none of the axes has no combination to clash on.
    if (!axes.some((axis) => byName.has(axis))) continue;

    const fingerprint = axes
      .map((axis) => `${axis}=${JSON.stringify(byName.get(axis) ?? null)}`)
      .join('|');

    const prior = combinations.get(fingerprint);
    if (prior) {
      diagnostics.push({
        severity: 'error',
        code: 'combination-unique-violation',
        message:
          `Product '${product.key}': variants '${prior}' and '${variantSku(variant)}' share the ` +
          `CombinationUnique values ${fingerprint}. commercetools rejects the product.`,
      });
    } else {
      combinations.set(fingerprint, variantSku(variant));
    }
  }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The money invariants, shared by embedded and standalone prices because the
 * project-level rules they check are the same for both.
 */
function checkMoney(
  owner: string,
  value: PriceDraftImport['value'],
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  if (!config.market.requiredCurrencies.includes(value.currencyCode)) {
    diagnostics.push({
      severity: 'error',
      code: 'currency-not-configured',
      message:
        `${owner} has a price in ${value.currencyCode}, which is not in ` +
        'market.requiredCurrencies. The project will reject money in a currency it does ' +
        'not accept.',
    });
  }
  const expected = config.market.currencyFractionDigits[value.currencyCode];
  if (expected !== undefined && (value.fractionDigits ?? expected) !== expected) {
    diagnostics.push({
      severity: 'error',
      code: 'fraction-digits-mismatch',
      message:
        `${owner}: a ${value.currencyCode} price declares fractionDigits ` +
        `${value.fractionDigits ?? '(unset)'} but the configuration says ${expected}. One of ` +
        'the two is wrong, and the difference is a factor of ' +
        `${10 ** Math.abs(expected - (value.fractionDigits ?? expected))}.`,
    });
  }
}

/** Scope identity: everything except the validity window. */
function priceScope(price: PriceDraftImport | StandalonePriceImport): string {
  return [
    price.value.currencyCode,
    price.country ?? '',
    price.customerGroup?.key ?? '',
    price.channel?.key ?? '',
  ].join('|');
}

function checkPrices(
  product: ProductDraftImport,
  variant: ProductVariantDraftImport,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const variantPrices = pricesOf(variant);
  if (config.target.priceMode === 'embedded' && variantPrices.length > MAX_EMBEDDED_PRICES) {
    diagnostics.push({
      severity: 'error',
      code: 'price-limit-exceeded',
      message:
        `Variant '${variantSku(variant)}' has ${variantPrices.length} embedded prices, above the ` +
        `limit of ${MAX_EMBEDDED_PRICES}. Use Standalone Prices, or lean on price-selection ` +
        'fallback so fewer explicit prices are needed.',
    });
  }

  for (const price of variantPrices) {
    checkMoney(`Variant '${variantSku(variant)}'`, price.value, config, diagnostics);
  }

  // Grouped by scope, because that is the granularity the uniqueness rule uses.
  const byScope = new Map<string, PriceDraftImport[]>();
  for (const price of variantPrices) {
    const scope = priceScope(price);
    const group = byScope.get(scope) ?? [];
    group.push(price);
    byScope.set(scope, group);
  }

  for (const [scope, prices] of byScope) {
    if (prices.length < 2) continue;

    // A price with no validity window does not conflict with one that has a
    // window, so the two kinds are checked separately.
    const windowless = prices.filter(
      (p) => p.validFrom === undefined && p.validUntil === undefined,
    );
    const windowed = prices.filter(
      (p) => p.validFrom !== undefined || p.validUntil !== undefined,
    );

    if (windowless.length > 1) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-price-scope',
        message:
          `Variant '${variantSku(variant)}' has ${windowless.length} prices with no validity ` +
          `window sharing the scope ${scope}. Only one price may exist per scope, and ` +
          'resolving inherited prices produces this shape easily.',
      });
    }

    for (let i = 0; i < windowed.length; i++) {
      for (let j = i + 1; j < windowed.length; j++) {
        const a = windowed[i];
        const b = windowed[j];
        if (sameWindow(a, b)) {
          diagnostics.push({
            severity: 'error',
            code: 'duplicate-price-scope',
            message:
              `Variant '${variantSku(variant)}' has two prices in scope ${scope} with an identical ` +
              `validity window (${a.validFrom ?? '-'}..${a.validUntil ?? '-'}).`,
          });
        } else if (windowsOverlap(a, b)) {
          diagnostics.push({
            severity: 'error',
            code: 'overlapping-price-validity',
            message:
              `Variant '${variantSku(variant)}': prices in scope ${scope} have overlapping ` +
              `validity periods (${a.validFrom ?? '-'}..${a.validUntil ?? '-'} and ` +
              `${b.validFrom ?? '-'}..${b.validUntil ?? '-'}). commercetools rejects ` +
              'overlapping windows within one scope.',
          });
        }
      }
    }
  }
}

/** Just the validity window, so both price kinds can use these. */
interface Validity {
  validFrom?: string;
  validUntil?: string;
}

function sameWindow(a: Validity, b: Validity): boolean {
  return a.validFrom === b.validFrom && a.validUntil === b.validUntil;
}

/**
 * Whether two **bounded** validity windows overlap.
 *
 * **Callers must partition windowless prices out first.** Absent bounds become
 * ±Infinity here, so a price with no window "overlaps" every other price — and
 * read in isolation this function says a base price collides with a dated
 * promotion, which is the opposite of the truth. Both callers below do the
 * partition; `pricing-and-money.md` states the rule twice.
 *
 * A dogfood run read this function on its own, concluded a windowless base
 * price conflicted with a clearance markdown, and built a three-window price
 * split to work around a collision that does not exist. It caught the mistake
 * by re-reading the reference. This comment is the cheaper path.
 */
function windowsOverlap(a: Validity, b: Validity): boolean {
  const start = (p: Validity) =>
    p.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(p.validFrom);
  const end = (p: Validity) =>
    p.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(p.validUntil);

  const aStart = start(a);
  const aEnd = end(a);
  const bStart = start(b);
  const bEnd = end(b);

  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false;
  // Half-open intervals: one ending exactly where the next begins is fine.
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Standalone prices
// ---------------------------------------------------------------------------

/**
 * `priceMode` and where the prices actually are must agree.
 *
 * This is the one price check whose failure is completely silent. A product
 * with `priceMode: 'Standalone'` whose variants carry embedded prices imports
 * with every operation reporting `imported`, and then shows no price anywhere,
 * because price selection reads only the kind of price the product declares.
 * A green load and a priceless catalog is the worst outcome the gate exists to
 * prevent, so every half of the disagreement is an error.
 */
function checkPriceModeConsistency(
  plan: MigrationPlan,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const standalone = config.target.priceMode === 'standalone';

  // Modular variants cannot carry embedded prices at all, so this is always
  // empty there — which is the point: the check still has to run, because a
  // Classic plan audited against a standalone config must still be caught.
  const embedded = plan.products.flatMap((p) =>
    variantsOf(p).flatMap((v) => pricesOf(v).map(() => variantSku(v))),
  );

  if (standalone && embedded.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'embedded-prices-in-standalone-mode',
      message:
        `target.priceMode is 'standalone', but ${embedded.length} price(s) are embedded in ` +
        `variant drafts (first: '${embedded[0]}'). They would import successfully and then ` +
        'never be read, because price selection follows the product\'s priceMode.',
    });
  }

  if (!standalone && plan.standalonePrices.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'standalone-prices-in-embedded-mode',
      message:
        `target.priceMode is 'embedded', but the plan carries ${plan.standalonePrices.length} ` +
        'Standalone Price(s). They would be created as orphans that no product reads.',
    });
  }

  if (standalone && plan.standalonePrices.length === 0 && embedded.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'no-prices-planned',
      message:
        "target.priceMode is 'standalone' but the plan holds no prices of either kind. " +
        'If the feed carried prices, something dropped them; if it did not, the catalog ' +
        'will load unpriced.',
    });
  }

  const expected = standalone ? 'Standalone' : 'Embedded';
  for (const product of plan.products) {
    // Absent means Embedded, per the API default — so it is a real mismatch
    // under standalone pricing rather than a missing-field nit.
    const declared = product.priceMode ?? 'Embedded';
    if (declared !== expected) {
      diagnostics.push({
        severity: 'error',
        code: 'product-price-mode-mismatch',
        message:
          `Product '${product.key}' declares priceMode '${declared}'` +
          `${product.priceMode === undefined ? ' (unset, which means Embedded)' : ''} but ` +
          `target.priceMode is '${config.target.priceMode}'. Price selection would look for ` +
          'the wrong kind of price and find none.',
      });
    }
  }
}

/**
 * The Standalone Price invariants.
 *
 * Uniqueness is the combination of SKU, currency, country, customerGroup,
 * channel, validFrom and validUntil — project-wide per SKU, not per variant as
 * with embedded prices. `DuplicateStandalonePriceScopeError` names an exact
 * collision; overlapping windows within a scope are accepted by the API but
 * make price selection ambiguous, so those are a warning rather than an error.
 *
 * There is no per-variant ceiling worth checking here: the limit is 50,000
 * Standalone Prices per variant, against 100 embedded.
 */
function checkStandalonePrices(
  plan: MigrationPlan,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  if (plan.standalonePrices.length === 0) return;

  const skus = new Set<string>();
  for (const variants of indexVariants(plan).values()) {
    for (const variant of variants) {
      if (variant.sku !== undefined) skus.add(variant.sku);
    }
  }

  const bySku = new Map<string, StandalonePriceImport[]>();

  for (const price of plan.standalonePrices) {
    checkMoney(`Standalone price '${price.key}'`, price.value, config, diagnostics);

    // The Import API explicitly does not validate that the SKU exists, so this
    // is the only place a typo gets caught. The price would be created, priced
    // nothing, and report `imported`.
    if (!skus.has(price.sku)) {
      diagnostics.push({
        severity: 'error',
        code: 'standalone-price-orphan',
        message:
          `Standalone price '${price.key}' is for SKU '${price.sku}', which no variant in ` +
          'this plan has. The Import API does not validate the SKU, so it would be created ' +
          'as a price for a product that does not exist.',
      });
    }

    const group = bySku.get(price.sku) ?? [];
    group.push(price);
    bySku.set(price.sku, group);
  }

  for (const [sku, prices] of bySku) {
    const byScope = new Map<string, StandalonePriceImport[]>();
    for (const price of prices) {
      const scope = priceScope(price);
      const group = byScope.get(scope) ?? [];
      group.push(price);
      byScope.set(scope, group);
    }

    for (const [scope, group] of byScope) {
      if (group.length < 2) continue;

      // An open-ended price and a dated one are not in conflict — that pair is
      // a base price plus a promotion, which is the single most common shape a
      // catalog has. Comparing them as intervals would make every one of them
      // overlap, so the two kinds are checked separately, exactly as the
      // embedded check does.
      const windowless = group.filter(
        (p) => p.validFrom === undefined && p.validUntil === undefined,
      );
      const windowed = group.filter(
        (p) => p.validFrom !== undefined || p.validUntil !== undefined,
      );

      if (windowless.length > 1) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-standalone-price-scope',
          message:
            `SKU '${sku}' has ${windowless.length} Standalone Prices with no validity window ` +
            `sharing the scope ${scope} (e.g. '${windowless[0].key}', ` +
            `'${windowless[1].key}'). The combination of SKU, currency, country, ` +
            'customerGroup, channel, validFrom and validUntil must be unique.',
        });
      }

      for (let i = 0; i < windowed.length; i++) {
        for (let j = i + 1; j < windowed.length; j++) {
          const a = windowed[i];
          const b = windowed[j];
          if (sameWindow(a, b)) {
            diagnostics.push({
              severity: 'error',
              code: 'duplicate-standalone-price-scope',
              message:
                `SKU '${sku}' has two Standalone Prices in scope ${scope} with the same ` +
                `validity window (${a.validFrom ?? '-'}..${a.validUntil ?? '-'}): ` +
                `'${a.key}' and '${b.key}'. The combination of SKU, currency, country, ` +
                'customerGroup, channel, validFrom and validUntil must be unique.',
            });
          } else if (windowsOverlap(a, b)) {
            diagnostics.push({
              severity: 'warning',
              code: 'overlapping-standalone-price-validity',
              message:
                `SKU '${sku}' has Standalone Prices in scope ${scope} with overlapping ` +
                `validity periods ('${a.key}' ${a.validFrom ?? '-'}..${a.validUntil ?? '-'}, ` +
                `'${b.key}' ${b.validFrom ?? '-'}..${b.validUntil ?? '-'}). The API accepts ` +
                'this, unlike embedded prices, but which one wins is then not something the ' +
                'migration decides.',
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Advisory
// ---------------------------------------------------------------------------

function checkAdvisory(
  product: ProductDraftImport,
  variants: ProductVariantDraftImport[],
  /** SKUs with at least one Standalone Price in the plan. */
  pricedSkus: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (categoriesOf(product).length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'product-without-category',
      message:
        `Product '${product.key}' is in no category, so it cannot be reached by browsing.`,
    });
  }

  // Under standalone pricing the variant draft carries no prices at all, so
  // "has no embedded price" would fire on every variant in the catalog. What
  // matters is whether a price exists *somewhere* for the SKU.
  const unpriced = variants.filter(
    (v) => pricesOf(v).length === 0 && !(v.sku !== undefined && pricedSkus.has(v.sku)),
  );
  if (unpriced.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'variant-without-price',
      message:
        `Product '${product.key}' has ${unpriced.length} variant(s) with no price ` +
        `(e.g. '${unpriced[0].sku}'). Price selection returns nothing, so a storefront ` +
        'shows no price and adding to a cart fails with MatchingPriceNotFound.',
    });
  }

  if (!product.name || Object.keys(product.name).length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-name',
      message: `Product '${product.key}' has no name in any locale.`,
    });
  }
}

function checkUnpopulatedAttributes(
  plan: MigrationPlan,
  definitions: Map<string, Map<string, AttributeDefinition>>,
  diagnostics: Diagnostic[],
): void {
  const variantsByProduct = indexVariants(plan);
  const used = new Map<string, Set<string>>();
  for (const product of plan.products) {
    const set = used.get(product.productType.key) ?? new Set<string>();
    for (const variant of variantsByProduct.get(product.key) ?? []) {
      for (const attribute of attributesOf(variant)) set.add(attributeName(attribute));
    }
    used.set(product.productType.key, set);
  }

  for (const [productTypeKey, byName] of definitions) {
    const seen = used.get(productTypeKey) ?? new Set<string>();
    const unpopulated = [...byName.keys()].filter((name) => !seen.has(name));
    if (unpopulated.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'attribute-never-populated',
        message:
          `ProductType '${productTypeKey}' declares ${unpopulated.length} attribute(s) no ` +
          `variant sets: ${unpopulated.join(', ')}. Usually a source field the adapter ` +
          'dropped.',
      });
    }
  }
}

function checkCategoryUsage(plan: MigrationPlan, diagnostics: Diagnostic[]): void {
  const assigned = new Set<string>();
  for (const product of plan.products) {
    for (const category of categoriesOf(product)) assigned.add(category.key);
  }
  // A parent with children is a navigation node, not an empty leaf.
  const parents = new Set(
    plan.categories.filter((c) => c.parent).map((c) => c.parent!.key),
  );
  const empty = plan.categories.filter(
    (c) => !assigned.has(c.key) && !parents.has(c.key),
  );
  if (empty.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'category-without-products',
      message:
        `${empty.length} leaf category(ies) have no products and no children ` +
        `(e.g. '${empty[0].key}'). They render as empty pages.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i]) &&
      ka.every((k) => deepEqual(a[k], b[k]))
    );
  }
  return false;
}
