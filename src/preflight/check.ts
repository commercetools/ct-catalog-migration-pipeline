/**
 * Preflight: the first stage that touches the network, and the cheapest.
 *
 * It answers one question — will this project accept this plan? — with four
 * GETs. Every failure it catches would otherwise surface as a wall of rejected
 * Import Operations, hours into a load, with an error per record.
 *
 * It is read-only unless `apply` is requested, and even then it only ever *adds*
 * locales and currencies. It will not change `productCatalogModel`: switching
 * a project's catalog model is a decision about the whole implementation, not
 * something a migration tool should do on the way past.
 */

import type { Project } from '@commercetools/platform-sdk';

import type { PipelineConfig } from '../model/config.js';
import type { MigrationPlan } from '../model/plan.js';
import type { ProjectUpdateAction } from '@commercetools/platform-sdk';

import type { Diagnostic } from '../contract/validate.js';
import type { Clients } from '../client/factory.js';
import {
  attributeDefinitionsOf,
  attributesOf,
  indexVariants,
  pricesOf,
} from '../model/plan.js';

/**
 * `Project` and `ProductCatalogModel` come from the platform SDK. The catalog
 * model is optional there too, which is the API's own statement that a project
 * may simply not have one — and that absence means Classic.
 */
export type { Project } from '@commercetools/platform-sdk';
export type CatalogModel = NonNullable<Project['productCatalogModel']>;

export interface PreflightResult {
  project?: Project;
  diagnostics: Diagnostic[];
  /** Additive changes preflight would make, or made. */
  pending: { languages: string[]; currencies: string[] };
  applied: boolean;
  /** Existing resource counts, to catch a load aimed at the wrong project. */
  counts?: { productTypes: number; categories: number; products: number };
}

/**
 * The catalog model is optional on the Project resource. Absent means Classic —
 * the documented default — so treating absence as a mismatch would fail every
 * project that predates the setting.
 */
export function effectiveCatalogModel(project: Project): CatalogModel {
  return project.productCatalogModel ?? 'Classic';
}

export async function preflight(
  clients: Clients,
  config: PipelineConfig,
  plan: MigrationPlan | undefined,
  options: { apply?: boolean } = {},
): Promise<PreflightResult> {
  const diagnostics: Diagnostic[] = [];
  const pending = { languages: [] as string[], currencies: [] as string[] };

  let project: Project;
  try {
    project = (await clients.platform.get().execute()).body;
  } catch (err) {
    // A missing `view_project_settings` is not the same failure as an
    // unreachable project, and treating them alike made preflight
    // all-or-nothing: an API Client with every load and verify scope but not
    // that one got `project-unreachable` and *nothing else checked*, even
    // though the resource counts — the check that catches a load aimed at the
    // wrong project — need only `view_products`.
    const scopeProblem = isMissingScope(err);
    diagnostics.push({
      severity: 'error',
      code: scopeProblem ? 'project-settings-unreadable' : 'project-unreachable',
      message: scopeProblem
        ? `Could not read the project's settings: ${describeError(err)}\n` +
          '      This is a scope problem, not an unreachable project. The catalog model, ' +
          'locales, currencies and price countries cannot be checked without ' +
          'view_project_settings — so none of what preflight exists to verify is verified, ' +
          'and a load would be going in blind on every one of them.\n' +
          '      Everything below was still checked. Add view_project_settings and re-run ' +
          'rather than treating a partial pass as a pass.'
        : `Could not read the project: ${describeError(err)}`,
    });

    // Degrade rather than stop. Whatever can still be established is worth
    // more than nothing, and the caller can tell the difference from the code.
    // Both of these need `view_products`, not `view_project_settings`, so a
    // client missing only the latter can still have them checked — the same
    // argument the comment above makes for the counts.
    if (scopeProblem) {
      await checkProjectProductTypes(clients, config, plan, diagnostics);
      // No project settings here, so the locale/country subset checks cannot
      // run — the rest still can.
      await checkStoresAndSelections(clients, undefined, plan, diagnostics);
    }
    const partialCounts = scopeProblem
      ? await resourceCounts(clients, diagnostics)
      : undefined;
    return {
      diagnostics,
      pending,
      applied: false,
      ...(partialCounts ? { counts: partialCounts } : {}),
    };
  }

  checkCatalogModel(project, config, diagnostics);

  const needed = requirements(config, plan);

  const missingLanguages = needed.locales.filter((l) => !project.languages.includes(l));
  const missingCurrencies = needed.currencies.filter((c) => !project.currencies.includes(c));
  const missingCountries = needed.countries.filter((c) => !project.countries.includes(c));

  // Price countries come only from the plan — nothing in the config declares
  // them — so without one this check cannot run at all. Saying "Preflight
  // passed" while silently skipping it is how a load gets a green light and
  // then rejects every country-scoped price. Locales and currencies are not
  // in the same position: the config declares those, so they are always
  // checked, just less thoroughly than with a plan.
  if (plan === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'price-countries-unchecked',
      message:
        'No plan was found, so the countries the prices are scoped to could not be ' +
        'checked against the project — and the config does not declare them, so nothing ' +
        `else can. The project lists [${project.countries.join(', ')}]. Run \`plan\` and ` +
        'then preflight again to have this verified rather than assumed.',
    });
  }

  if (missingLanguages.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'locales-not-accepted',
      message:
        `The project accepts [${project.languages.join(', ')}] but the plan needs ` +
        `[${missingLanguages.join(', ')}]. commercetools rejects a LocalizedString in a ` +
        'locale the project does not accept, so every affected record would fail. ' +
        'Re-run with --apply to add them.',
    });
    pending.languages = missingLanguages;
  }

  if (missingCurrencies.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'currencies-not-accepted',
      message:
        `The project accepts [${project.currencies.join(', ')}] but the plan needs ` +
        `[${missingCurrencies.join(', ')}]. Money in an unaccepted currency is rejected. ` +
        'Re-run with --apply to add them.',
    });
    pending.currencies = missingCurrencies;
  }

  if (missingCountries.length > 0) {
    // An error, not a warning. This was a warning phrased as though the
    // consequence were degraded price selection; the API in fact refuses the
    // price outright — "'GB' is not an allowed country code in this project",
    // as validationFailed, one operation at a time. A load that will reject
    // every country-scoped price is not something to note in passing.
    //
    // Still reported rather than fixed: the country list also drives shipping
    // and tax, so extending it is a commerce decision. Refusing without fixing
    // is what preflight already does for the catalog model.
    diagnostics.push({
      severity: 'error',
      code: 'countries-not-listed',
      message:
        `Prices in the plan are scoped to [${missingCountries.join(', ')}], which the ` +
        `project does not list (it has [${project.countries.join(', ')}]). The API rejects ` +
        "a price in an unlisted country — \"'XX' is not an allowed country code in this " +
        'project" — so every price scoped to one would fail validation while the rest of ' +
        'the load succeeds, leaving a partly priced catalog.\n' +
        '      --apply will not add them: the country list also drives shipping and tax, ' +
        'so it is a commerce decision. Either add them in the Merchant Center, or drop ' +
        'the country from those prices in the adapter.',
    });
  }

  if (!project.languages.includes(config.market.defaultLocale)) {
    diagnostics.push({
      severity: 'error',
      code: 'default-locale-not-accepted',
      message:
        `market.defaultLocale is '${config.market.defaultLocale}', which the project does ` +
        'not accept. Derived labels and slugs land in the default locale, so nothing ' +
        'would be readable.',
    });
  }

  await checkPrerequisites(clients, plan, diagnostics);
  await checkProjectProductTypes(clients, config, plan, diagnostics);
  await checkStoresAndSelections(clients, project, plan, diagnostics);

  const counts = await resourceCounts(clients, diagnostics);
  if (counts) warnIfPopulated(project, counts, config, diagnostics);

  let applied = false;
  if (options.apply && (pending.languages.length > 0 || pending.currencies.length > 0)) {
    applied = await applyAdditive(clients, project, pending, diagnostics);
  }

  return {
    project,
    // The checks ran against the project as it was found, so a successful
    // apply leaves its own findings behind as stale errors — each still
    // advising `--apply`, which is what just happened. Reporting a problem
    // that no longer exists, with a remedy already carried out, teaches the
    // reader to stop trusting the output.
    diagnostics: applied ? withoutResolvedByApply(diagnostics) : diagnostics,
    pending,
    applied,
    ...(counts ? { counts } : {}),
  };
}

/**
 * Exactly the findings an additive apply resolves.
 *
 * Kept as an explicit list rather than re-running the checks against a
 * refetched project: the set of things `--apply` changes is fixed and small —
 * it adds languages and currencies and nothing else — so naming them is
 * clearer than a second round trip, and it cannot accidentally clear a finding
 * the apply did not address. Anything outside this list survives, including a
 * catalog-model mismatch or a populated project.
 */
const RESOLVED_BY_APPLY = new Set([
  'locales-not-accepted',
  'currencies-not-accepted',
  // The default locale is always among the languages the plan needs, so adding
  // them covers it.
  'default-locale-not-accepted',
]);

function withoutResolvedByApply(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => !RESOLVED_BY_APPLY.has(d.code));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * The project's catalog model against the configured one.
 *
 * Both models are supported, so this is a genuine mismatch check rather than a
 * refusal: the two shapes are mutually exclusive on the wire, and a plan built
 * for one cannot be loaded into a project running the other. Preflight is the
 * first stage that can know, because the model is a project fact and nothing
 * offline can infer it.
 */
function checkCatalogModel(
  project: Project,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const actual = effectiveCatalogModel(project);
  const configured = config.target.catalogModel;
  if (actual === configured) return;

  diagnostics.push({
    severity: 'error',
    code: 'catalog-model-mismatch',
    message:
      `The project's productCatalogModel is ${actual}` +
      (project.productCatalogModel === undefined ? ' (unset, which means Classic)' : '') +
      `, but target.catalogModel is ${configured}. These are not interchangeable: ` +
      'Classic embeds variants in the Product; Modular manages them as standalone ' +
      'resources imported through VariantImport, and forbids embedded prices. The ' +
      'plan was built for one shape and this project runs the other, so the load ' +
      'would be rejected resource by resource.\n' +
      '      Set target.catalogModel to ' +
      `'${actual}' and re-run \`plan\` — the shape is decided at map time, so ` +
      'changing the config alone is not enough. preflight will not change the ' +
      'project for you: switching a live catalog model is a decision about the whole ' +
      'implementation.',
  });
}

/**
 * What the plan actually needs, which is not the same as what the config
 * declares: a plan can carry a locale nobody remembered to list.
 */
function requirements(
  config: PipelineConfig,
  plan: MigrationPlan | undefined,
): { locales: string[]; currencies: string[]; countries: string[] } {
  const locales = new Set(config.market.requiredLocales);
  const currencies = new Set(config.market.requiredCurrencies);
  const countries = new Set<string>();

  if (!plan) return { locales: [...locales], currencies: [...currencies], countries: [] };

  const addLocales = (localized: Record<string, string> | undefined) => {
    for (const locale of Object.keys(localized ?? {})) locales.add(locale);
  };

  for (const productType of plan.productTypes) {
    for (const attribute of attributeDefinitionsOf(productType)) {
      addLocales(attribute.label);
      if (attribute.type.name === 'lenum') {
        for (const value of attribute.type.values) addLocales(value.label);
      }
    }
  }

  for (const category of plan.categories) {
    addLocales(category.name);
    addLocales(category.slug);
    addLocales(category.description);
  }

  // Through the index, not the products: under Modular the variants are a
  // separate collection, and a localized attribute value on one of them still
  // needs its locale accepted by the project.
  const variantsByProduct = indexVariants(plan);
  for (const product of plan.products) {
    addLocales(product.name);
    addLocales(product.slug);
    addLocales(product.description);
    for (const variant of variantsByProduct.get(product.key) ?? []) {
      for (const attribute of attributesOf(variant)) {
        if (isLocalized(attribute.value)) addLocales(attribute.value);
      }
      for (const price of pricesOf(variant)) {
        currencies.add(price.value.currencyCode);
        if (price.country) countries.add(price.country);
      }
    }
  }

  // Standalone prices are not inside the variants, so walking products alone
  // misses every one of them. This is what made the country check silent on a
  // standalone plan: the check was there and correct, and it was being handed
  // an empty set. A live load then rejected eight of fifteen prices for a
  // country the project does not list, after preflight had passed.
  for (const price of plan.standalonePrices ?? []) {
    currencies.add(price.value.currencyCode);
    if (price.country) countries.add(price.country);
  }

  return {
    locales: [...locales].sort(),
    currencies: [...currencies].sort(),
    countries: [...countries].sort(),
  };
}

function isLocalized(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([k, v]) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k) && typeof v === 'string')
  );
}

/**
 * Three `limit=0&withTotal=true` reads. Cheap, and the only way to notice that
 * the credentials point at a populated project nobody meant to load into.
 */
/**
 * Channels and customer groups the plan's prices reference.
 *
 * The only place this can be checked, and the reason the feed declares them at
 * all. **Neither resource can be imported** — the Import API has no channel or
 * customer-group type — so a price referencing one the project does not hold
 * becomes an Import Operation that sits `unresolved` for 48 hours and then
 * expires. The load reports every request accepted, the operation reports
 * nothing once it is gone, and the price is simply absent.
 *
 * **Absent is a warning, not an error**, because `load` now creates them
 * through the platform API — blocking here would refuse a load that would have
 * fixed the problem. What preflight adds is that you learn it before running
 * the load, and that the creation is visible in advance rather than a surprise.
 *
 * **Present but under-rolled is an error.** Load reports that too and refuses
 * to modify it: a channel's roles govern stores and inventory, so widening
 * them is a project decision. Nothing downstream can proceed safely either
 * way, so it blocks here as well.
 */
async function checkPrerequisites(
  clients: Clients,
  plan: MigrationPlan | undefined,
  diagnostics: Diagnostic[],
): Promise<void> {
  const channels = plan?.prerequisites?.channels ?? [];
  const groups = plan?.prerequisites?.customerGroups ?? [];

  if (plan === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'prerequisites-unchecked',
      message:
        'No plan was found, so the channels and customer groups the prices reference could ' +
        'not be checked. Neither can be created by this pipeline, and a missing one makes ' +
        'its prices expire unresolved after 48 hours — run `plan` and preflight again.',
    });
    return;
  }

  if (channels.length === 0 && groups.length === 0) return;

  const byKey = async (
    kind: string,
    keys: string[],
    read: (where: string) => Promise<{ key?: string }[]>,
  ): Promise<Map<string, { key?: string }> | undefined> => {
    if (keys.length === 0) return new Map();
    const quoted = keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',');
    try {
      const found = await read(`key in (${quoted})`);
      return new Map(found.filter((f) => f.key !== undefined).map((f) => [f.key!, f]));
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        code: 'prerequisites-unreadable',
        message:
          // Not describeError: its 403 branch enumerates *preflight's* scopes,
          // which are not the ones this call needs — naming
          // view_project_settings when view_customer_groups is missing sends
          // the reader to the wrong place.
          `Could not read ${kind} from the project: ${messageOf(err)}\n` +
          `      ${keys.length} ${kind} the plan's prices reference could not be verified. ` +
          'Reading channels needs view_products (or manage_products); customer groups need ' +
          'view_customer_groups.',
      });
      return undefined;
    }
  };

  const actualChannels = await byKey('channel(s)', channels.map((c) => c.key), async (where) =>
    (await clients.platform.channels().get({ queryArgs: { where, limit: 500 } }).execute()).body
      .results,
  );
  if (actualChannels) {
    for (const channel of channels) {
      const found = actualChannels.get(channel.key) as
        | { roles?: string[] }
        | undefined;
      if (!found) {
        diagnostics.push({
          severity: 'warning',
          code: 'channel-will-be-created',
          message:
            `The project has no channel with key '${channel.key}'. \`load --execute\` will ` +
            `create it with roles [${channel.roles.join(', ')}] through the platform API, ` +
            'because the Import API has no channel resource.\n' +
            '      Stated in advance rather than left as a surprise: it is a write to the ' +
            'project outside the catalog, and creating it needs manage_products. If the ' +
            'channel should already exist, the key in the feed is probably wrong — a ' +
            'typo here creates a second channel nothing else uses.',
        });
        continue;
      }
      const missingRoles = channel.roles.filter((r) => !(found.roles ?? []).includes(r));
      if (missingRoles.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'channel-roles-insufficient',
          message:
            `Channel '${channel.key}' exists but has roles ` +
            `[${(found.roles ?? []).join(', ')}], missing [${missingRoles.join(', ')}]. ` +
            'A price-scoped channel without ProductDistribution is refused outright for ' +
            'Standalone Prices and unusable for channel price selection either way.',
        });
      }
    }
  }

  const actualGroups = await byKey(
    'customer group(s)',
    groups.map((g) => g.key),
    async (where) =>
      (await clients.platform.customerGroups().get({ queryArgs: { where, limit: 500 } }).execute())
        .body.results,
  );
  if (actualGroups) {
    for (const group of groups) {
      if (!actualGroups.has(group.key)) {
        diagnostics.push({
          severity: 'warning',
          code: 'customer-group-will-be-created',
          message:
            `The project has no customer group with key '${group.key}'. ` +
            `\`load --execute\` will create it as '${group.name}' through the platform ` +
            'API. That needs manage_customer_groups, which manage_products does not ' +
            'grant — and a wrong key here creates a group nothing else uses.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute types, across the whole project
//
// An attribute *name* may hold only one type per Project. The API enforces it
// across ProductTypes that have nothing else to do with each other, so a plan
// can be internally consistent and still be refused by what the project
// already holds. A live load hit exactly this: the project's `apparel-basic`
// had `material` as ltext, the plan declared it text, and the ProductType came
// back `AttributeDefinitionTypeConflict` with the product then failing
// `AttributeNameDoesNotExist`.
//
// It is the third project-wide constraint in this pipeline, alongside SKU and
// slug uniqueness, and the only one that was not being checked.
// ---------------------------------------------------------------------------

/** The shape both SDKs' attribute types share, as far as identity goes. */
interface TypeLike {
  name: string;
  elementType?: TypeLike;
  referenceTypeId?: string;
  typeReference?: { id?: string };
}

/**
 * A comparable rendering of an attribute type.
 *
 * `enum` and `lenum` compare by name alone, deliberately: the documentation's
 * own example gives `Color` different value sets on different ProductTypes, so
 * values are not part of a type's identity. A set's element type and a
 * reference's target are.
 */
export function renderAttributeType(type: TypeLike): string {
  switch (type.name) {
    case 'set':
      return `set<${type.elementType ? renderAttributeType(type.elementType) : 'unknown'}>`;
    case 'reference':
      return `reference<${type.referenceTypeId ?? 'unknown'}>`;
    case 'nested':
      return `nested<${type.typeReference?.id ?? 'unknown'}>`;
    default:
      return type.name;
  }
}

/** Every ProductType in the project, with attributes. Paginated. */
async function readAllProductTypes(clients: Clients): Promise<
  { key?: string; name: string; attributes?: { name: string; type: TypeLike; isSearchable?: boolean }[] }[]
> {
  const all: Awaited<ReturnType<typeof readAllProductTypes>> = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const res = await clients.platform
      .productTypes()
      .get({ queryArgs: { limit, offset, withTotal: true } })
      .execute();
    const page = res.body.results as unknown as Awaited<ReturnType<typeof readAllProductTypes>>;
    all.push(...page);
    // The length guard is what stops this loop: a total that lies, or a page
    // that comes back empty, must not spin.
    if (page.length === 0 || all.length >= (res.body.total ?? all.length)) break;
  }
  return all;
}

type ExistingProductTypes = Awaited<ReturnType<typeof readAllProductTypes>>;

/**
 * Everything that needs the project's ProductTypes, over a single read.
 *
 * Two unrelated questions share the list: whether any attribute name clashes
 * on type, and whether the project looks like it was loaded before ProductType
 * keys were prefixed.
 */
async function checkProjectProductTypes(
  clients: Clients,
  config: PipelineConfig,
  plan: MigrationPlan | undefined,
  diagnostics: Diagnostic[],
): Promise<void> {
  if (plan === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'attribute-types-unchecked',
      message:
        'No plan, so the project\'s attribute types could not be compared against it. ' +
        'An attribute name may hold only one type per Project, and a conflict is ' +
        'rejected at load time with AttributeDefinitionTypeConflict.\n' +
        '      Run `plan`, then preflight again.',
    });
    return;
  }

  let existing: ExistingProductTypes;
  try {
    existing = await readAllProductTypes(clients);
  } catch (err) {
    diagnostics.push({
      severity: 'warning',
      code: 'attribute-types-unreadable',
      message:
        `Could not read the project's ProductTypes: ${describeError(err)}\n` +
        '      Reading them needs view_products. Without them, a conflict between an ' +
        'attribute name in the plan and the same name already in the project will only ' +
        'surface as a rejected ProductType during the load.',
    });
    return;
  }

  checkAttributeTypes(existing, plan, diagnostics);
  checkProductTypeKeys(existing, config, plan, diagnostics);
}

/**
 * A project loaded before ProductType keys carried `keys.prefix`.
 *
 * ProductType keys used to be emitted verbatim, so an engagement that loaded
 * then holds `apparel-basic` where the plan now says `mig-apparel-basic`. The
 * load would happily create the new ProductType — and then be unable to move
 * the existing products onto it, because **a Product's ProductType cannot be
 * changed after creation** and no update action exists for it.
 *
 * Worth a warning rather than an error: on an *empty* project, or one loaded
 * after the change, this is simply the normal case.
 */
function checkProductTypeKeys(
  existing: ExistingProductTypes,
  config: PipelineConfig,
  plan: MigrationPlan,
  diagnostics: Diagnostic[],
): void {
  const present = new Set(existing.map((pt) => pt.key).filter((k): k is string => !!k));
  const prefix = `${config.keys.prefix}-`;

  const stale = plan.productTypes
    .map((pt) => pt.key)
    .filter((key) => key.startsWith(prefix) && !present.has(key))
    .map((key) => ({ planned: key, unprefixed: key.slice(prefix.length) }))
    .filter((pair) => present.has(pair.unprefixed));

  if (stale.length === 0) return;

  diagnostics.push({
    severity: 'warning',
    code: 'product-type-keys-unprefixed',
    message:
      `The project holds ${stale.length} ProductType(s) under the plan's key without its ` +
      `'${config.keys.prefix}-' prefix: ` +
      stale.map((p) => `'${p.unprefixed}' (plan wants '${p.planned}')`).join(', ') +
      '.\n' +
      '      That is what a load from before ProductType keys were prefixed looks like. ' +
      'This load would create the prefixed ProductType(s) and then fail to move the ' +
      "existing products onto them: a Product's ProductType cannot be changed after " +
      'creation, and there is no update action for it.\n' +
      '      For a throwaway project, delete the products and re-load. For one with data ' +
      'worth keeping, decide deliberately — this is a migration decision, not a fix.',
  });
}

function checkAttributeTypes(
  existing: ExistingProductTypes,
  plan: MigrationPlan,
  diagnostics: Diagnostic[],
): void {
  // First definition wins. A plan that disagrees with *itself* is already an
  // error out of `derive` (`type-mismatch-across-product-types`), so there is
  // no need to report the same pair twice from here.
  const planned = new Map<string, { type: string; searchable: boolean; owner: string }>();
  for (const pt of plan.productTypes) {
    for (const attr of attributeDefinitionsOf(pt)) {
      if (planned.has(attr.name)) continue;
      planned.set(attr.name, {
        type: renderAttributeType(attr.type as TypeLike),
        searchable: attr.isSearchable ?? false,
        owner: pt.key,
      });
    }
  }
  if (planned.size === 0) return;

  const planKeys = new Set(plan.productTypes.map((pt) => pt.key));

  for (const pt of existing) {
    for (const attr of pt.attributes ?? []) {
      const mine = planned.get(attr.name);
      if (!mine) continue;
      const theirs = renderAttributeType(attr.type);
      const sameProductType = pt.key !== undefined && planKeys.has(pt.key);
      const where = `ProductType '${pt.key ?? pt.name}'`;

      if (mine.type !== theirs) {
        diagnostics.push({
          severity: 'error',
          code: 'attribute-type-conflict',
          message:
            `Attribute '${attr.name}' is ${theirs} on the project's ${where}, and the ` +
            `plan defines it as ${mine.type} on '${mine.owner}'. An attribute name may ` +
            'hold only one type per Project, so the load would be rejected with ' +
            'AttributeDefinitionTypeConflict, and the products using it would then fail ' +
            'with AttributeNameDoesNotExist.\n' +
            (sameProductType
              ? '      This is the same ProductType the plan loads, and there is no update ' +
                "action that changes an attribute's type: it would have to be removed and " +
                're-added, which deletes the values on every existing product. Treat this ' +
                'as a migration decision, not a fix.'
              : `      Nothing in the plan touches ${where} — the constraint is ` +
                'project-wide. Either match the existing type, or use a different ' +
                'attribute name.'),
        });
        continue;
      }

      if (mine.searchable !== (attr.isSearchable ?? false)) {
        diagnostics.push({
          severity: 'warning',
          code: 'attribute-searchable-conflict',
          message:
            `Attribute '${attr.name}' has isSearchable=${attr.isSearchable ?? false} on ` +
            `the project's ${where} and ${mine.searchable} in the plan. The types agree, ` +
            'so the load succeeds — but when the values differ the attribute becomes ' +
            'unavailable for search, filters and facets across **every** ProductType, ' +
            'including ones already working today.\n' +
            '      Nothing errors at import time; the facet simply stops existing.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stores and product selections
//
// Both are checked here for different reasons. A **selection's mode is
// immutable** — the update actions are setKey, changeName, add/exclude/remove
// product and the variant setters; there is no changeMode — so importing a
// different mode onto an existing key cannot do what the plan says, and the
// assortment ends up inverted. A **store is never modified** by `load`, so a
// store whose wiring already differs is a storefront selling something other
// than what was planned, and only preflight can say so before the load.
// ---------------------------------------------------------------------------

async function checkStoresAndSelections(
  clients: Clients,
  project: Project | undefined,
  plan: MigrationPlan | undefined,
  diagnostics: Diagnostic[],
): Promise<void> {
  if (plan === undefined) return; // already reported by the plan-less warnings

  const wantedStores = plan.prerequisites?.stores ?? [];
  const wantedSelections = plan.productSelections ?? [];
  if (wantedStores.length === 0 && wantedSelections.length === 0) return;

  if (wantedSelections.length > 0) {
    let existing: Map<string, { mode?: string }>;
    try {
      const res = await clients.platform
        .productSelections()
        .get({ queryArgs: { limit: 500 } })
        .execute();
      existing = new Map(
        res.body.results
          .filter((sel) => sel.key !== undefined)
          .map((sel) => [sel.key as string, sel as { mode?: string }]),
      );
    } catch (err) {
      diagnostics.push({
        severity: 'warning',
        code: 'product-selections-unreadable',
        message:
          `Could not read the project's product selections: ${describeError(err)}\n` +
          '      Reading needs view_product_selections and importing needs ' +
          'manage_product_selections. Without the read, a selection whose mode already ' +
          'differs in the project cannot be caught before the load — and a mode cannot ' +
          'be changed afterwards.',
      });
      existing = new Map();
    }

    for (const selection of wantedSelections) {
      const found = existing.get(selection.key);
      if (!found) {
        diagnostics.push({
          severity: 'warning',
          code: 'product-selection-will-be-created',
          message:
            `The project has no product selection '${selection.key}'. \`load --execute\` ` +
            `will import it with mode ${selection.mode ?? 'Individual'}.\n` +
            '      Stated in advance because the mode is permanent: there is no update ' +
            'action that changes it, so getting it wrong means deleting the selection and ' +
            'every store reference to it.',
        });
        continue;
      }
      const plannedMode = selection.mode ?? 'Individual';
      if (found.mode !== undefined && found.mode !== plannedMode) {
        diagnostics.push({
          severity: 'error',
          code: 'product-selection-mode-conflict',
          message:
            `Product selection '${selection.key}' already exists in the project with mode ` +
            `${found.mode}, and the plan declares ${plannedMode}. A selection's mode is ` +
            'fixed at creation — there is no changeMode action — so the import cannot ' +
            'apply the plan, **and it will not say so**: a live import of a conflicting ' +
            'mode reported `imported` and left the mode untouched. Nothing downstream ' +
            'fails, which is why this is caught here.\n' +
            `      The two are opposites: ${found.mode} means the assignments are ` +
            `${found.mode === 'Individual' ? 'the only products offered' : 'the products withheld'}` +
            `, while ${plannedMode} means ${plannedMode === 'Individual' ? 'the only products offered' : 'the products withheld'}. ` +
            'Loading anyway would invert the assortment.\n' +
            '      Use a different key, or delete the existing selection and every store ' +
            'reference to it.',
        });
      }
    }
  }

  if (wantedStores.length === 0) return;

  let stores: Map<string, { productSelections?: unknown[]; distributionChannels?: unknown[] }>;
  try {
    const res = await clients.platform.stores().get({ queryArgs: { limit: 500 } }).execute();
    stores = new Map(
      res.body.results
        .filter((st) => st.key !== undefined)
        .map((st) => [st.key, st as { productSelections?: unknown[] }]),
    );
  } catch (err) {
    diagnostics.push({
      severity: 'warning',
      code: 'stores-unreadable',
      message:
        `Could not read the project's stores: ${describeError(err)}\n` +
        '      Reading needs view_stores and creating needs manage_stores. Neither is ' +
        'granted by manage_products.',
    });
    return;
  }

  for (const store of wantedStores) {
    const found = stores.get(store.key);
    if (!found) {
      diagnostics.push({
        severity: 'warning',
        code: 'store-will-be-created',
        message:
          `The project has no store '${store.key}'. \`load --execute\` will create it ` +
          'through the platform API, after the import stages — a store references product ' +
          'selections, and those are imported asynchronously.',
      });
    } else if (
      store.productSelections.length > 0 &&
      (found.productSelections ?? []).length !== store.productSelections.length
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'store-wiring-differs',
        message:
          `Store '${store.key}' already exists with ${(found.productSelections ?? []).length} ` +
          `product selection(s); the plan describes ${store.productSelections.length}. ` +
          '`load` will not modify an existing store: `setProductSelections` replaces the ' +
          "whole array, so applying the plan would discard the project's own wiring — and " +
          "a store's selections decide what the storefront sells.\n" +
          '      Reconcile it deliberately, or drop the store from the feed.',
      });
    }

    // Store languages and countries must be subsets of the project's. The API
    // refuses otherwise, and this is the only stage that can see both.
    if (project) {
      const badLocales = (store.languages ?? []).filter((l) => !project.languages.includes(l));
      if (badLocales.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'store-locales-not-accepted',
          message:
            `Store '${store.key}' declares language(s) [${badLocales.join(', ')}] that the ` +
            `project does not accept (it has [${project.languages.join(', ')}]). A store's ` +
            "languages must be a subset of the project's, so the API refuses the store.",
        });
      }
      const badCountries = (store.countries ?? []).filter(
        (c) => !project.countries.includes(c),
      );
      if (badCountries.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'store-countries-not-accepted',
          message:
            `Store '${store.key}' declares country(ies) [${badCountries.join(', ')}] that ` +
            `the project does not list (it has [${project.countries.join(', ')}]). Unlike ` +
            'locales and currencies, `--apply` will not add a country — it drives shipping ' +
            'and tax, so it is a commerce decision.',
        });
      }
    }
  }
}

async function resourceCounts(
  clients: Clients,
  diagnostics: Diagnostic[],
): Promise<PreflightResult['counts']> {
  const query = { queryArgs: { limit: 0, withTotal: true } };
  try {
    const [productTypes, categories, products] = await Promise.all([
      clients.platform.productTypes().get(query).execute(),
      clients.platform.categories().get(query).execute(),
      clients.platform.products().get(query).execute(),
    ]);
    return {
      productTypes: productTypes.body.total ?? 0,
      categories: categories.body.total ?? 0,
      products: products.body.total ?? 0,
    };
  } catch (err) {
    // Not fatal: the counts are a safety net, not a gate. A client with
    // project-settings scope but no product scope still gets a useful preflight.
    diagnostics.push({
      severity: 'warning',
      code: 'counts-unavailable',
      message:
        `Could not read existing resource counts: ${describeError(err)} ` +
        'Preflight continues, but it cannot warn you about loading into a populated ' +
        'project.',
    });
    return undefined;
  }
}

function warnIfPopulated(
  project: Project,
  counts: NonNullable<PreflightResult['counts']>,
  config: PipelineConfig,
  diagnostics: Diagnostic[],
): void {
  const total = counts.productTypes + counts.categories + counts.products;
  if (total === 0) return;

  diagnostics.push({
    severity: 'warning',
    code: 'project-not-empty',
    message:
      `Project '${project.key}' already holds ${counts.productTypes} product type(s), ` +
      `${counts.categories} category(ies) and ${counts.products} product(s). Keys are ` +
      `prefixed '${config.keys.prefix}-', so the load is additive and a re-run updates ` +
      'rather than duplicating — but confirm this is the project you meant.',
  });
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Adds missing locales and currencies.
 *
 * `changeLanguages` and `changeCurrencies` **replace** the whole array, so the
 * new value is the union of what the project has and what the plan needs.
 * Sending only the missing entries would silently delete every locale and
 * currency already configured — which, on a shared project, is a far worse
 * outcome than the error preflight was trying to fix.
 */
async function applyAdditive(
  clients: Clients,
  project: Project,
  pending: { languages: string[]; currencies: string[] },
  diagnostics: Diagnostic[],
): Promise<boolean> {
  const actions: ProjectUpdateAction[] = [];

  if (pending.languages.length > 0) {
    actions.push({
      action: 'changeLanguages',
      languages: [...new Set([...project.languages, ...pending.languages])],
    });
  }
  if (pending.currencies.length > 0) {
    actions.push({
      action: 'changeCurrencies',
      currencies: [...new Set([...project.currencies, ...pending.currencies])],
    });
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await clients.platform
        .post({ body: { version: project.version, actions } })
        .execute();
      diagnostics.push({
        severity: 'warning',
        code: 'project-updated',
        message:
          'Project settings updated additively: ' +
          [
            pending.languages.length > 0 ? `languages += [${pending.languages.join(', ')}]` : null,
            pending.currencies.length > 0
              ? `currencies += [${pending.currencies.join(', ')}]`
              : null,
          ]
            .filter(Boolean)
            .join('; ') +
          '. Nothing was removed.',
      });
      return true;
    } catch (err) {
      // A 409 means someone else changed the project between the read and the
      // write. Re-read and retry with the fresh version — never the stale one.
      if (statusOf(err) === 409 && attempt === 1) {
        try {
          project = (await clients.platform.get().execute()).body;
          continue;
        } catch {
          // fall through to the error below
        }
      }
      diagnostics.push({
        severity: 'error',
        code: 'project-update-failed',
        message:
          `Could not update project settings: ${describeError(err)}\n` +
          'Applying changes needs manage_project_settings.',
      });
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status;
}

/**
 * The SDK throws rich error objects; this renders the parts an operator can act
 * on and adds the scope hint the raw message never carries.
 */
/**
 * Whether a failure is a missing OAuth scope rather than a real outage.
 *
 * commercetools answers an insufficient scope with 403 and names the scope in
 * the message, so both are checked: the status alone would also catch a
 * genuinely forbidden project, and the message alone would be prose-matching
 * of the kind that already broke the container check once.
 */
function isMissingScope(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string };
  const status = e.statusCode ?? e.status;
  const message = e.message ?? '';
  return status === 403 || /[Ii]nsufficient.?scope|scope is missing/.test(message);
}

/** The error's own message, without preflight's generic scope advice. */
function messageOf(err: unknown): string {
  const e = err as { statusCode?: number; status?: number; message?: string };
  const status = e.statusCode ?? e.status;
  const message = e.message ?? String(err);
  return status === undefined ? message : `${status}: ${message}`;
}

function describeError(err: unknown): string {
  const status = statusOf(err);
  const message = (err as { message?: string }).message ?? String(err);

  if (status === 403) {
    return (
      `${message} — the API Client lacks a required scope. preflight needs ` +
      'view_project_settings; --apply needs manage_project_settings; the load needs ' +
      'manage_products and manage_import_containers.'
    );
  }
  if (status === 401) {
    return `${message} — the client id or secret is wrong, or it belongs to another project.`;
  }
  if (status === 404) {
    return `${message} — check the project key and the region host.`;
  }
  return message;
}
