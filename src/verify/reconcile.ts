/**
 * Reconciling the plan against what the project actually holds.
 *
 * The load reports what the API *accepted*. That is not the same question as
 * what the project now contains, and today's live runs showed the gap plainly:
 * every Import Request came back accepted while eight of fifteen prices were
 * rejected asynchronously, and the container summary kept counting those
 * failures for 48 hours after a later run fixed them. Operation states cannot
 * answer "is the catalog right"; only reading the catalog can.
 *
 * So this module compares the written plan against a snapshot of the project,
 * resource by resource, and reports three things:
 *
 *   - **missing** — planned and not there. The load did not land, whatever it
 *     reported.
 *   - **mismatched** — there, but not what the plan says. A partially applied
 *     update, a hand edit, or a field the mapper thinks it set and does not.
 *   - **unexpected** — a variant or attribute present that the plan never
 *     mentioned, which is how a stale earlier run makes itself visible.
 *
 * Deliberately pure and offline: fetching lives in `snapshot.ts`. That split
 * is the lesson of the first live run, where the one module with no coverage
 * was the one that touched the network — comparison logic this fiddly has to
 * be testable without a project.
 *
 * Read-only by construction. Nothing here or in `snapshot.ts` writes.
 */

import type {
  Attribute as ReadAttribute,
  AttributeDefinition as ReadAttributeDefinition,
  Category,
  Product,
  ProductSelection,
  ProductType,
  ProductVariant,
  StandalonePrice,
  Store,
  TypedMoney,
  Variant,
} from '@commercetools/platform-sdk';

import type { PipelineConfig } from '../model/config.js';
import type {
  Asset,
  Attribute,
  MigrationPlan,
  PlannedVariant,
  PriceDraftImport,
  ProductDraftImport,
  ProductSelectionImport,
  ProductVariantDraftImport,
  StandalonePriceImport,
} from '../model/plan.js';
import { attributeDefinitionsOf, indexVariants, pricesOf } from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';

/**
 * The project as it is, indexed by key.
 *
 * References come back from the API as ids, never keys, so the id→key maps are
 * part of the snapshot rather than something the comparison can derive.
 */
export interface ProjectSnapshot {
  productTypes: Map<string, ProductType>;
  categories: Map<string, Category>;
  products: Map<string, Product>;
  /** Modular variants, by key. Empty under Classic, where they live on the product. */
  variants: Map<string, Variant>;
  standalonePrices: Map<string, StandalonePrice>;
  productSelections: Map<string, ProductSelection>;
  /** Keyed verbatim, not prefixed — a store's key belongs to the project. */
  stores: Map<string, Store>;
  /** Category id → key, for resolving a product's category references. */
  categoryKeyById: Map<string, string>;
  /** ProductType id → key, for resolving a product's productType reference. */
  productTypeKeyById: Map<string, string>;
  /** ProductSelection id → key, for resolving a store's selection references. */
  productSelectionKeyById: Map<string, string>;
}

export interface VerifyResult {
  diagnostics: Diagnostic[];
  checked: {
    productTypes: number;
    categories: number;
    products: number;
    variants: number;
    prices: number;
    productSelections: number;
    stores: number;
  };
  /** Planned resources found in the project, per kind. */
  found: {
    productTypes: number;
    categories: number;
    products: number;
    prices: number;
    productSelections: number;
    stores: number;
  };
}

export function reconcile(
  plan: MigrationPlan,
  snapshot: ProjectSnapshot,
  config: PipelineConfig,
): VerifyResult {
  const diagnostics: Diagnostic[] = [];
  const found = {
    productTypes: 0,
    categories: 0,
    products: 0,
    prices: 0,
    productSelections: 0,
    stores: 0,
  };
  // Under Modular the planned variants are a separate collection, so the
  // comparison reads them through the index rather than off the product.
  const variantsByProduct = indexVariants(plan);
  const checked = {
    productTypes: plan.productTypes.length,
    categories: plan.categories.length,
    products: plan.products.length,
    variants: 0,
    prices: 0,
    productSelections: (plan.productSelections ?? []).length,
    stores: (plan.prerequisites?.stores ?? []).length,
  };

  for (const planned of plan.productTypes) {
    const actual = snapshot.productTypes.get(planned.key);
    if (!actual) {
      diagnostics.push(missing('productType', planned.key));
      continue;
    }
    found.productTypes++;
    compareProductType(planned, actual, diagnostics);
  }

  for (const planned of plan.categories) {
    const actual = snapshot.categories.get(planned.key);
    if (!actual) {
      diagnostics.push(missing('category', planned.key));
      continue;
    }
    found.categories++;
    compareCategory(planned, actual, snapshot, diagnostics);
  }

  for (const planned of plan.products) {
    const actual = snapshot.products.get(planned.key);
    if (!actual) {
      diagnostics.push(missing('product', planned.key));
      continue;
    }
    found.products++;
    const variants = variantsByProduct.get(planned.key) ?? [];
    checked.variants += variants.length;
    checked.prices += variants.reduce((n, v) => n + pricesOf(v).length, 0);
    compareProduct(planned, actual, variants, snapshot, config, diagnostics);
  }

  checked.prices += plan.standalonePrices.length;
  for (const planned of plan.standalonePrices) {
    const actual = snapshot.standalonePrices.get(planned.key);
    if (!actual) {
      // The exact shape of today's live failure: the product landed, the price
      // did not, and the load called the request accepted.
      diagnostics.push({
        severity: 'error',
        code: 'standalone-price-missing',
        message:
          `Standalone price '${planned.key}' for SKU '${planned.sku}' is not in the ` +
          'project. The product it prices may well be there — an Import Request is ' +
          'accepted before its operations are validated, so a rejected price leaves an ' +
          'unpriced variant behind a successful-looking load.',
      });
      continue;
    }
    found.prices++;
    compareStandalonePrice(planned, actual, diagnostics);
  }

  for (const planned of plan.productSelections ?? []) {
    const actual = snapshot.productSelections.get(planned.key);
    if (!actual) {
      diagnostics.push(missing('productSelection', planned.key));
      continue;
    }
    found.productSelections++;
    compareProductSelection(planned, actual, diagnostics);
  }

  for (const planned of plan.prerequisites?.stores ?? []) {
    const actual = snapshot.stores.get(planned.key);
    if (!actual) {
      diagnostics.push(missing('store', planned.key));
      continue;
    }
    found.stores++;
    compareStore(planned, actual, snapshot, diagnostics);
  }

  return { diagnostics, checked, found };
}

function missing(kind: string, key: string): Diagnostic {
  return {
    severity: 'error',
    // Kebab-cased generically rather than special-casing one kind. Every other
    // diagnostic code in this pipeline is kebab, and `productType` was handled
    // by name — so `productSelection` came out camelCase and inconsistent.
    code: `${kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-missing`,
    message:
      `Planned ${kind} '${key}' is not in the project. The load reported what the API ` +
      'accepted, which is not the same as what it imported.',
  };
}

// ---------------------------------------------------------------------------
// Product types
// ---------------------------------------------------------------------------

/**
 * Attribute definitions are the part of a ProductType worth checking closely:
 * `attributeConstraint` cannot be changed afterwards except to `None`, so a
 * constraint that did not land as planned is not a difference to fix later.
 */
function compareProductType(
  planned: { key: string; name?: string },
  actual: ProductType,
  diagnostics: Diagnostic[],
): void {
  const plannedDefs = attributeDefinitionsOf(planned as never);
  const actualByName = new Map<string, ReadAttributeDefinition>(
    (actual.attributes ?? []).map((a) => [a.name, a]),
  );

  for (const def of plannedDefs) {
    const got = actualByName.get(def.name);
    if (!got) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-definition-missing',
        message:
          `ProductType '${planned.key}' has no attribute '${def.name}' in the project, ` +
          'though the plan declares one. Every variant value for it is unreadable.',
      });
      continue;
    }

    if (got.type.name !== def.type.name) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-type-differs',
        message:
          `ProductType '${planned.key}', attribute '${def.name}': the project has type ` +
          `'${got.type.name}' but the plan declares '${def.type.name}'. An attribute type ` +
          'cannot be changed — this one has to be recreated.',
      });
    }

    if (def.attributeConstraint && got.attributeConstraint !== def.attributeConstraint) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-constraint-differs',
        message:
          `ProductType '${planned.key}', attribute '${def.name}': the project has ` +
          `constraint '${got.attributeConstraint}' but the plan declares ` +
          `'${def.attributeConstraint}'. changeAttributeConstraint accepts only 'None', so ` +
          'this cannot be corrected in place — the attribute has to be recreated and its ' +
          'data rewritten.',
      });
    }

    if (def.isSearchable !== undefined && got.isSearchable !== def.isSearchable) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-searchable-differs',
        message:
          `ProductType '${planned.key}', attribute '${def.name}': isSearchable is ` +
          `${got.isSearchable} in the project and ${def.isSearchable} in the plan. Where ` +
          'ProductTypes sharing an attribute name disagree, the attribute becomes ' +
          'unavailable for search, filters and facets everywhere.',
      });
    }

    if (def.level !== undefined && got.level !== def.level) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-level-differs',
        message:
          `ProductType '${planned.key}', attribute '${def.name}': level is '${got.level}' ` +
          `in the project and '${def.level}' in the plan.`,
      });
    }
  }

  const plannedNames = new Set(plannedDefs.map((d) => d.name));
  for (const name of actualByName.keys()) {
    if (!plannedNames.has(name)) {
      diagnostics.push({
        severity: 'warning',
        code: 'attribute-definition-unexpected',
        message:
          `ProductType '${planned.key}' has attribute '${name}' in the project that the ` +
          'plan does not declare. Usually an earlier run of a different plan, or a ' +
          'pre-existing ProductType this migration adopted rather than created.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function compareCategory(
  planned: { key: string; slug: Record<string, string>; name: Record<string, string>; parent?: { key?: string }; orderHint?: string },
  actual: Category,
  snapshot: ProjectSnapshot,
  diagnostics: Diagnostic[],
): void {
  compareLocalized('category', planned.key, 'slug', planned.slug, actual.slug, diagnostics);
  compareLocalized('category', planned.key, 'name', planned.name, actual.name, diagnostics);

  const plannedParent = planned.parent?.key;
  const actualParent = actual.parent
    ? snapshot.categoryKeyById.get(actual.parent.id)
    : undefined;

  if (plannedParent !== actualParent) {
    diagnostics.push({
      severity: 'error',
      code: 'category-parent-differs',
      message:
        `Category '${planned.key}': the project's parent is ` +
        `${actualParent ? `'${actualParent}'` : actual.parent ? `id ${actual.parent.id} (not in the plan)` : 'none'}` +
        `, the plan says ${plannedParent ? `'${plannedParent}'` : 'none'}. The tree a ` +
        'storefront browses is the one in the project.',
    });
  }

  if (planned.orderHint !== undefined && actual.orderHint !== planned.orderHint) {
    diagnostics.push({
      severity: 'warning',
      code: 'category-order-hint-differs',
      message:
        `Category '${planned.key}': orderHint is '${actual.orderHint}' in the project and ` +
        `'${planned.orderHint}' in the plan, so siblings will not be in the source order.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Products and variants
// ---------------------------------------------------------------------------

function compareProduct(
  planned: ProductDraftImport,
  actual: Product,
  plannedVariants: PlannedVariant[],
  snapshot: ProjectSnapshot,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  // Staged, not current: the pipeline imports unpublished on purpose, so
  // `current` would be empty on a first load and every check would misfire.
  const data = actual.masterData.staged;

  const actualTypeKey = snapshot.productTypeKeyById.get(actual.productType.id);
  if (actualTypeKey !== planned.productType.key) {
    diagnostics.push({
      severity: 'error',
      code: 'product-type-differs',
      message:
        `Product '${planned.key}': the project's ProductType is ` +
        `${actualTypeKey ? `'${actualTypeKey}'` : `id ${actual.productType.id} (not in the plan)`}` +
        `, the plan says '${planned.productType.key}'. A product's ProductType cannot be ` +
        'changed once set.',
    });
  }

  compareLocalized('product', planned.key, 'slug', planned.slug, data.slug, diagnostics);
  compareLocalized('product', planned.key, 'name', planned.name, data.name, diagnostics);

  const plannedCategories = new Set((planned.categories ?? []).map((c) => c.key));
  const actualCategories = new Set(
    data.categories.map((c) => snapshot.categoryKeyById.get(c.id) ?? `id:${c.id}`),
  );
  const missingCats = [...plannedCategories].filter((k) => !actualCategories.has(k));
  const extraCats = [...actualCategories].filter((k) => !plannedCategories.has(k));
  if (missingCats.length > 0 || extraCats.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'product-categories-differ',
      message:
        `Product '${planned.key}': category membership differs.` +
        (missingCats.length > 0 ? ` Planned but absent: ${missingCats.join(', ')}.` : '') +
        (extraCats.length > 0 ? ` Present but unplanned: ${extraCats.join(', ')}.` : '') +
        ' A product in the wrong categories is unreachable by browsing.',
    });
  }

  // Absent means Embedded, per the API default — the same rule the audit gate
  // applies, and the difference that makes a catalog silently priceless.
  const expectedMode = config.target.priceMode === 'standalone' ? 'Standalone' : 'Embedded';
  const actualMode = actual.priceMode ?? 'Embedded';
  if (actualMode !== expectedMode) {
    diagnostics.push({
      severity: 'error',
      code: 'product-price-mode-differs',
      message:
        `Product '${planned.key}': priceMode is '${actualMode}' in the project` +
        `${actual.priceMode === undefined ? ' (unset, which means Embedded)' : ''} but the ` +
        `configuration says '${config.target.priceMode}'. Price selection reads only the ` +
        'kind of price the product declares, so the prices that exist would never be read.',
    });
  }

  compareVariants(planned, plannedVariants, actual, snapshot, diagnostics);
}

/**
 * A variant as the project returns it, in whichever model.
 *
 * The two reads differ in more than location. A Classic variant is a
 * `ProductVariant` inside the product's staged data. A Modular variant is a
 * `Variant` resource with its own `current`/`staged` pair — and the precedence
 * is the other way round from the product: a Variant created unpublished puts
 * its data in `current` and leaves `staged` null, so `staged ?? current` is
 * what actually holds it.
 */
interface ActualVariant {
  sku?: string;
  attributes?: ReadAttribute[];
  prices?: NonNullable<ProductVariant['prices']>;
  assets?: { key?: string; sources?: { uri?: string }[] }[];
}

function actualVariantsOf(
  planned: ProductDraftImport,
  plannedVariants: PlannedVariant[],
  actual: Product,
  snapshot: ProjectSnapshot,
): { variants: ActualVariant[]; modular: boolean } {
  // A Modular plan is recognised by its variants carrying their own keys in
  // the snapshot, not by re-reading the config: the question here is where the
  // project keeps them, and the project has already answered it.
  const fromSnapshot = plannedVariants
    .map((v) => snapshot.variants.get(v.key))
    .filter((v): v is NonNullable<typeof v> => v !== undefined);

  if (snapshot.variants.size > 0) {
    return {
      modular: true,
      variants: fromSnapshot.map((v) => {
        const data = v.staged ?? v.current;
        return {
          sku: data.sku,
          attributes: data.attributes,
          prices: [],
          assets: data.assets as ActualVariant['assets'],
        };
      }),
    };
  }

  const data = actual.masterData.staged;
  return {
    modular: false,
    variants: [data.masterVariant, ...data.variants] as ActualVariant[],
  };
}

function compareVariants(
  planned: ProductDraftImport,
  plannedVariants: PlannedVariant[],
  actual: Product,
  snapshot: ProjectSnapshot,
  diagnostics: Diagnostic[],
): void {
  const { variants: actualVariants, modular } = actualVariantsOf(
    planned,
    plannedVariants,
    actual,
    snapshot,
  );

  const actualBySku = new Map<string, ActualVariant>();
  for (const v of actualVariants) {
    if (v.sku !== undefined) actualBySku.set(v.sku, v);
  }

  const definitions = new Map<string, ReadAttributeDefinition>();
  const productType = snapshot.productTypes.get(planned.productType.key);
  for (const def of productType?.attributes ?? []) definitions.set(def.name, def);

  const plannedSkus = new Set<string>();
  for (const plannedVariant of plannedVariants) {
    const sku = plannedVariant.sku;
    if (sku === undefined) continue;
    plannedSkus.add(sku);

    const got = actualBySku.get(sku);
    if (!got) {
      diagnostics.push({
        severity: 'error',
        code: 'variant-missing',
        message:
          `Product '${planned.key}' has no variant with SKU '${sku}' in the project. The ` +
          'SKU is what inventory, orders and fulfilment join on, so an absent one is not ' +
          'a cosmetic difference.' +
          (modular
            ? ' Modular variants are separate resources, so this one may have been ' +
              'rejected while its product imported cleanly.'
            : ''),
      });
      continue;
    }

    compareAttributes(planned.key, sku, plannedVariant, got, definitions, diagnostics);
    compareEmbeddedPrices(planned.key, sku, plannedVariant, got, diagnostics);
    compareAssets(`variant '${sku}' on product '${planned.key}'`, plannedVariant.assets, got.assets, diagnostics);
  }

  // A master variant that is not the one the plan chose changes what a
  // storefront shows by default, which is why `plan` records the choice. Under
  // Modular there is nothing to compare: the product has `defaultVariant`,
  // which the Import API cannot set at all, so the plan declares that as
  // information loss rather than pretending to have set it.
  const plannedMasterSku = planned.masterVariant?.sku;
  if (!modular && plannedMasterSku !== undefined) {
    const masterSku = actual.masterData.staged.masterVariant.sku;
    if (masterSku !== plannedMasterSku) {
      diagnostics.push({
        severity: 'warning',
        code: 'master-variant-differs',
        message:
          `Product '${planned.key}': the project's master variant is ` +
          `'${masterSku ?? '(no sku)'}' but the plan chose '${plannedMasterSku}'. ` +
          'The master variant is what a storefront shows by default.',
      });
    }
  }

  for (const sku of actualBySku.keys()) {
    if (!plannedSkus.has(sku)) {
      diagnostics.push({
        severity: 'warning',
        code: 'variant-unexpected',
        message:
          `Product '${planned.key}' has a variant with SKU '${sku}' in the project that ` +
          'the plan does not contain. A ProductDraftImport replaces a product wholesale, ' +
          'so this usually means an earlier run of a different plan — or that the source ' +
          'dropped a variant and nothing removed it here.',
      });
    }
  }
}

/**
 * Assets, by key.
 *
 * Compared by key and source URI rather than deeply: the key is what a re-run
 * updates, and the URI is the part that is visibly wrong on a storefront. An
 * asset present with the wrong sources shows the wrong picture, which no other
 * check would catch.
 */
function compareAssets(
  owner: string,
  planned: Asset[] | undefined,
  actual: ActualVariant['assets'],
  diagnostics: Diagnostic[],
): void {
  if (planned === undefined || planned.length === 0) return;

  const actualByKey = new Map<string, NonNullable<ActualVariant['assets']>[number]>();
  for (const a of actual ?? []) {
    if (a.key !== undefined) actualByKey.set(a.key, a);
  }

  for (const asset of planned) {
    const got = actualByKey.get(asset.key);
    if (!got) {
      diagnostics.push({
        severity: 'error',
        code: 'asset-missing',
        message:
          `${owner} has no asset '${asset.key}' in the project, though the plan carries ` +
          `one with ${asset.sources.length} source(s).`,
      });
      continue;
    }

    const plannedUris = asset.sources.map((s) => s.uri);
    const actualUris = (got.sources ?? []).map((s) => s.uri);
    if (plannedUris.length !== actualUris.length) {
      diagnostics.push({
        severity: 'error',
        code: 'asset-sources-differ',
        message:
          `${owner}, asset '${asset.key}': the project has ${actualUris.length} source(s) ` +
          `and the plan has ${plannedUris.length}. A missing rendition is a picture a ` +
          'storefront cannot render at the size it asked for.',
      });
      continue;
    }
    for (const [i, uri] of plannedUris.entries()) {
      if (actualUris[i] !== uri) {
        diagnostics.push({
          severity: 'error',
          code: 'asset-sources-differ',
          message:
            `${owner}, asset '${asset.key}', source ${i + 1}: the project has ` +
            `'${actualUris[i] ?? '(none)'}' and the plan says '${uri}'. A wrong media URL ` +
            'renders as a broken image and nothing else reports it.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute values
// ---------------------------------------------------------------------------

/**
 * Comparing an attribute value means normalising both sides first.
 *
 * The API does not hand back what was sent: an `enum` is written as a key and
 * read as `{key, label}`, and a set comes back as an array of those. Comparing
 * raw would report every enum attribute in the catalog as differing, which is
 * the fastest way to get a verification stage switched off.
 */
/**
 * A product selection, read back.
 *
 * `mode` is the field worth checking hardest, because it is the one that
 * cannot be repaired: there is no `changeMode` action, so a selection that
 * came back with the other mode is not a drift to fix but a resource to
 * delete and recreate — along with every store reference to it.
 *
 * `productCount` is compared rather than the assignments themselves. The
 * assignment list is not on the ProductSelection representation — it is read
 * through a separate paginated endpoint per selection — and a count mismatch
 * is enough to say "go look", which is what a verifier is for.
 */
function compareProductSelection(
  planned: ProductSelectionImport,
  actual: ProductSelection,
  diagnostics: Diagnostic[],
): void {
  const plannedMode = planned.mode ?? 'Individual';
  if (actual.mode !== plannedMode) {
    diagnostics.push({
      severity: 'error',
      code: 'selection-mode-differs',
      message:
        `Product selection '${planned.key}' has mode ${actual.mode} in the project and ` +
        `${plannedMode} in the plan. There is no update action that changes a mode, so ` +
        'this cannot be corrected by re-running: the selection has to be deleted and ' +
        'recreated, and every store referencing it re-wired. Re-importing looks like it ' +
        'works — a live attempt reported `imported` and changed nothing — which is why ' +
        'this is checked here rather than trusted to the load.\n' +
        '      Until then the assortment is inverted — the assignments mean the opposite ' +
        'of what was planned.',
    });
  }

  const plannedCount = (planned.assignments ?? []).length;
  const actualCount = actual.productCount ?? 0;
  if (plannedCount !== actualCount) {
    diagnostics.push({
      severity: 'error',
      code: 'selection-assignment-count-differs',
      message:
        `Product selection '${planned.key}' holds ${actualCount} product(s); the plan ` +
        `assigned ${plannedCount}. The whole assignment list travels in one import ` +
        'resource and replaces what was there, so a shortfall usually means the import ' +
        'was rejected or a referenced product never arrived.\n' +
        `      Read the assignments at /product-selections/key=${planned.key}/products.`,
    });
  }
}

/**
 * A store, read back.
 *
 * Every field here is a list the API **replaces** rather than merges, so a
 * mismatch is not partial drift: it is a different storefront. The comparison
 * is by set, not order, because neither the API nor this pipeline promises an
 * order for them.
 */
function compareStore(
  planned: MigrationPlan['prerequisites']['stores'][number],
  actual: Store,
  snapshot: ProjectSnapshot,
  diagnostics: Diagnostic[],
): void {
  const differs = (kind: string, want: string[], have: string[]) => {
    const missingKeys = want.filter((k) => !have.includes(k));
    const extra = have.filter((k) => !want.includes(k));
    if (missingKeys.length === 0 && extra.length === 0) return;
    diagnostics.push({
      severity: 'error',
      code: `store-${kind}-differ`,
      message:
        `Store '${planned.key}' ${kind}: the plan wants [${want.join(', ') || 'none'}] and ` +
        `the project has [${have.join(', ') || 'none'}].` +
        (missingKeys.length > 0 ? ` Absent: ${missingKeys.join(', ')}.` : '') +
        (extra.length > 0 ? ` Unplanned: ${extra.join(', ')}.` : '') +
        '\n      `load` never modifies an existing store, so this is either a store that ' +
        'predates the migration or one whose creation partly failed.',
    });
  };

  // Channel references come back as ids; there is no channel map in the
  // snapshot, so only the *count* is checkable without another read. Saying
  // that plainly beats a comparison that looks exact and is not.
  const wantDistribution = planned.distributionChannels.length;
  const haveDistribution = (actual.distributionChannels ?? []).length;
  if (wantDistribution !== haveDistribution) {
    diagnostics.push({
      severity: 'error',
      code: 'store-distribution-channels-differ',
      message:
        `Store '${planned.key}' has ${haveDistribution} distribution channel(s); the plan ` +
        `wants ${wantDistribution}. Distribution channels decide which prices apply in ` +
        'this store, so a shortfall means shoppers fall through to channel-less prices.',
    });
  }

  const wantSupply = planned.supplyChannels.length;
  const haveSupply = (actual.supplyChannels ?? []).length;
  if (wantSupply !== haveSupply) {
    diagnostics.push({
      severity: 'warning',
      code: 'store-supply-channels-differ',
      message:
        `Store '${planned.key}' has ${haveSupply} supply channel(s); the plan wants ` +
        `${wantSupply}. A warning, not an error: this pipeline imports no inventory, so ` +
        'the supply wiring affects nothing it loaded.',
    });
  }

  // Selections *can* be compared by key, because the snapshot fetched them and
  // built the reverse map.
  const haveSelections = (actual.productSelections ?? [])
    .map((setting) => snapshot.productSelectionKeyById.get(setting.productSelection.id))
    .filter((k): k is string => k !== undefined);
  differs('product-selections', planned.productSelections.map((sel) => sel.key), haveSelections);

  for (const wanted of planned.productSelections) {
    const setting = (actual.productSelections ?? []).find(
      (x) => snapshot.productSelectionKeyById.get(x.productSelection.id) === wanted.key,
    );
    if (!setting) continue;
    if (setting.active !== wanted.active) {
      diagnostics.push({
        severity: 'error',
        code: 'store-selection-active-differs',
        message:
          `Store '${planned.key}' has selection '${wanted.key}' ` +
          `${setting.active ? 'active' : 'inactive'}; the plan wants it ` +
          `${wanted.active ? 'active' : 'inactive'}. Activation is not cosmetic: if every ` +
          'selection on a store is inactive and one has mode Individual, the store offers ' +
          'no products at all.',
      });
    }
  }
}

function normaliseActual(value: unknown, typeName: string | undefined): unknown {
  if (typeName === 'enum' || typeName === 'lenum') {
    return (value as { key?: string } | null)?.key ?? value;
  }
  if (typeName === 'set' && Array.isArray(value)) {
    return value.map((v) => (v as { key?: string } | null)?.key ?? v);
  }
  return value;
}

function plannedValueOf(attribute: Attribute): unknown {
  // The plan's Attribute is a discriminated union carrying `type`; the value
  // sits alongside it under whichever key the variant uses.
  return (attribute as unknown as { value?: unknown }).value;
}

function compareAttributes(
  productKey: string,
  sku: string,
  planned: PlannedVariant,
  actual: ActualVariant,
  definitions: Map<string, ReadAttributeDefinition>,
  diagnostics: Diagnostic[],
): void {
  const actualByName = new Map<string, ReadAttribute>(
    (actual.attributes ?? []).map((a) => [a.name, a]),
  );

  for (const attribute of planned.attributes ?? []) {
    const name = attribute.name;
    if (name === undefined) continue;

    const got = actualByName.get(name);
    if (!got) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-value-missing',
        message:
          `Variant '${sku}' on product '${productKey}' has no value for '${name}' in the ` +
          'project, though the plan sets one.',
      });
      continue;
    }

    const typeName = definitions.get(name)?.type.name;
    // A reference attribute is read back as an id and planned as a key, so
    // comparing the two would always differ. Left alone rather than guessed at.
    if (typeName === 'reference' || typeName === 'nested') continue;

    const expected = plannedValueOf(attribute);
    const got2 = normaliseActual(got.value, typeName);
    if (!deepEqual(expected, got2)) {
      diagnostics.push({
        severity: 'error',
        code: 'attribute-value-differs',
        message:
          `Variant '${sku}' on product '${productKey}', attribute '${name}': the project ` +
          `has ${JSON.stringify(got2)} and the plan says ${JSON.stringify(expected)}.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function moneyEqual(a: TypedMoney | undefined, b: PriceDraftImport['value'] | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.currencyCode === b.currencyCode &&
    a.centAmount === b.centAmount &&
    (a.fractionDigits ?? 2) === (b.fractionDigits ?? 2)
  );
}

function describeMoney(m: { currencyCode: string; centAmount: number } | undefined): string {
  return m ? `${m.currencyCode} ${m.centAmount}` : '(none)';
}

function compareEmbeddedPrices(
  productKey: string,
  sku: string,
  planned: PlannedVariant,
  actual: ActualVariant,
  diagnostics: Diagnostic[],
): void {
  const actualByKey = new Map<string, NonNullable<ProductVariant['prices']>[number]>();
  for (const price of actual.prices ?? []) {
    if (price.key !== undefined) actualByKey.set(price.key, price);
  }

  for (const price of pricesOf(planned)) {
    const got = actualByKey.get(price.key);
    if (!got) {
      diagnostics.push({
        severity: 'error',
        code: 'embedded-price-missing',
        message:
          `Variant '${sku}' on product '${productKey}' has no price '${price.key}' ` +
          `(${describeMoney(price.value)}) in the project. A variant with no price in a ` +
          'scope returns nothing from price selection, and adding it to a cart fails with ' +
          'MatchingPriceNotFound.',
      });
      continue;
    }
    if (!moneyEqual(got.value, price.value)) {
      diagnostics.push({
        severity: 'error',
        code: 'price-value-differs',
        message:
          `Variant '${sku}' on product '${productKey}', price '${price.key}': the project ` +
          `has ${describeMoney(got.value)} and the plan says ${describeMoney(price.value)}. ` +
          'A wrong amount is the defect that looks most like success.',
      });
    }
  }
}

function compareStandalonePrice(
  planned: StandalonePriceImport,
  actual: StandalonePrice,
  diagnostics: Diagnostic[],
): void {
  if (actual.sku !== planned.sku) {
    diagnostics.push({
      severity: 'error',
      code: 'standalone-price-sku-differs',
      message:
        `Standalone price '${planned.key}': the project has it against SKU ` +
        `'${actual.sku}' and the plan says '${planned.sku}'. It prices the wrong variant.`,
    });
  }

  if (!moneyEqual(actual.value, planned.value)) {
    diagnostics.push({
      severity: 'error',
      code: 'price-value-differs',
      message:
        `Standalone price '${planned.key}': the project has ${describeMoney(actual.value)} ` +
        `and the plan says ${describeMoney(planned.value)}. A wrong amount is the defect ` +
        'that looks most like success.',
    });
  }

  // Scope is part of a price's identity, and none of it can be updated: the
  // Import API returns InvalidFieldsUpdate for country, customerGroup and
  // channel. A difference here means the price has to be deleted and remade.
  const scope: [string, unknown, unknown][] = [
    ['country', actual.country, planned.country],
    ['validFrom', actual.validFrom, planned.validFrom],
    ['validUntil', actual.validUntil, planned.validUntil],
  ];
  for (const [field, got, expected] of scope) {
    if ((got ?? undefined) !== (expected ?? undefined)) {
      diagnostics.push({
        severity: 'error',
        code: 'standalone-price-scope-differs',
        message:
          `Standalone price '${planned.key}': ${field} is ` +
          `${got === undefined ? '(unset)' : `'${got}'`} in the project and ` +
          `${expected === undefined ? '(unset)' : `'${expected}'`} in the plan. Price scope ` +
          'cannot be updated — the Import API rejects it — so this price has to be ' +
          'deleted and recreated.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareLocalized(
  kind: string,
  key: string,
  field: string,
  planned: Record<string, string> | undefined,
  actual: Record<string, string> | undefined,
  diagnostics: Diagnostic[],
): void {
  for (const [locale, value] of Object.entries(planned ?? {})) {
    const got = (actual ?? {})[locale];
    if (got === value) continue;
    diagnostics.push({
      severity: field === 'slug' ? 'error' : 'warning',
      code: `${kind}-${field}-differs`,
      message:
        `${kind === 'product' ? 'Product' : 'Category'} '${key}', ${field} in ${locale}: ` +
        `the project has ${got === undefined ? '(nothing)' : `'${got}'`} and the plan says ` +
        `'${value}'.` +
        (field === 'slug' ? ' The slug is the URL a storefront serves this on.' : ''),
    });
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
