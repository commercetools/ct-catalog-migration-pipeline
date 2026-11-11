/**
 * Turning a plan into Import Requests.
 *
 * Pure, and deliberately so: chunking, container assignment and ordering are
 * the decisions that matter, and none of them need a network to test. The SDK
 * does not do any of this — it posts the array it is given.
 *
 * Two constraints shape the output:
 *
 *   - An Import Request carries at most **20** resources.
 *   - Stay under **200,000 Import Operations per container** (one operation per
 *     resource), and under 1000 containers per project.
 *
 * Containers are organised **by resource type, not by temporal batch**, per the
 * Import API best practices. A container named for the run's timestamp would
 * exhaust the 1000-container limit and make a re-run unable to find its own
 * earlier work; a container named for the resource type is stable across runs.
 */

import type {
  CategoryImport,
  CategoryImportRequest,
  CustomerImport,
  CustomerImportRequest,
  ImportResourceType,
  InventoryImport,
  InventoryImportRequest,
  OrderImport,
  OrderImportRequest,
  ProductDraftImport,
  ProductDraftImportRequest,
  ProductSelectionImport,
  ProductSelectionImportRequest,
  ProductTypeImport,
  ProductTypeImportRequest,
  StandalonePriceImport,
  StandalonePriceImportRequest,
  VariantImport,
  VariantImportRequest,
} from '@commercetools/importapi-sdk';

import type { PipelineConfig } from '../model/config.js';
import { importStages, type LoadStage, type MigrationPlan } from '../model/plan.js';

/** Hard limit: resources per Import Request. */
export const MAX_RESOURCES_PER_REQUEST = 20;
/** Performance recommendation: operations per container. */
export const MAX_OPERATIONS_PER_CONTAINER = 200_000;
/** Soft project limit on containers. */
export const MAX_CONTAINERS = 1000;

export type ImportRequestBody =
  | ProductTypeImportRequest
  | CategoryImportRequest
  | ProductDraftImportRequest
  | VariantImportRequest
  | StandalonePriceImportRequest
  | ProductSelectionImportRequest
  | InventoryImportRequest
  | CustomerImportRequest
  | OrderImportRequest;

/**
 * The `resourceType` a container is restricted to, per Import API stage.
 *
 * `channel`, `customer-group`, `tax-category` and `store` are absent on
 * purpose: they are load stages
 * but not *import* stages — the platform API creates them, so they have no
 * container, no batching and no resource type. `ImportStage` excludes them at
 * the type level rather than a runtime skip, so adding another platform stage
 * cannot silently fall through into batching.
 */
type ImportStage = Exclude<LoadStage, 'channel' | 'customer-group' | 'tax-category' | 'store'>;

const RESOURCE_TYPE: Record<ImportStage, ImportResourceType> = {
  'product-type': 'product-type',
  category: 'category',
  'product-draft': 'product-draft',
  variant: 'variant',
  'standalone-price': 'standalone-price',
  inventory: 'inventory',
  'product-selection': 'product-selection',
  customer: 'customer',
  order: 'order',
};

/**
 * Stages whose first request carries a single record, so the load can read that
 * record's result before it sends the rest.
 *
 * The Import API has no dry run, so no offline stage can show that it accepts the
 * shape a mapper sends, and these are the stages where finding out late is
 * expensive: orders are create-only and wake every `OrderImported` subscription
 * once per record, and customers are personal data. A shape the API refuses then
 * costs one failed operation instead of one per record. The other stages upsert
 * by key, so a wrong guess there is fixed by running them again.
 */
export const CANARY_STAGES: readonly LoadStage[] = ['customer', 'order'];

/** The most records a canary request may hold. */
export const MAX_CANARY_RECORDS = 5;

/**
 * The structure of a record: every key path it carries, with array positions
 * collapsed (`addresses[].city`) and empty values skipped. Values are ignored on
 * purpose: this asks which fields and nestings a record exercises, which is
 * what the API's validation of a shape depends on, and it needs no knowledge of
 * the API or of the mapper.
 */
export function structureOf(resource: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${path}[]`);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (inner === null || inner === undefined || inner === '') continue;
        if (Array.isArray(inner) && inner.length === 0) continue;
        if (typeof inner === 'object' && !Array.isArray(inner) && Object.keys(inner).length === 0) continue;
        const next = path === '' ? key : `${path}.${key}`;
        out.add(next);
        walk(inner, next);
      }
    }
  };
  walk(resource, '');
  return out;
}

/**
 * Which records go first: the fewest that together show every key path any record
 * of the stage has, richest first, and at most {@link MAX_CANARY_RECORDS}. Returns
 * indexes in plan order.
 *
 * The plan's first record proves only its own structure. In the first live run of
 * customers it was the one customer with no address, so it passed and the 47 with
 * one were refused; the first order had no custom line item. Choosing by what a
 * record carries makes the first request as informative as the stage allows, and
 * in practice one record is enough: a record that has every optional field.
 */
export function pickCanary(resources: unknown[]): number[] {
  if (resources.length === 0) return [];
  // One entry per distinct structure, in first-seen order, so a very long stage
  // costs one pass and a handful of sets in memory.
  const distinct = new Map<string, { index: number; paths: Set<string> }>();
  for (let i = 0; i < resources.length; i++) {
    const paths = structureOf(resources[i]);
    const key = [...paths].sort().join('\u0000');
    if (!distinct.has(key)) distinct.set(key, { index: i, paths });
  }
  const left = new Set<string>();
  for (const { paths } of distinct.values()) for (const p of paths) left.add(p);

  const chosen: number[] = [];
  const pool = [...distinct.values()];
  while (left.size > 0 && chosen.length < MAX_CANARY_RECORDS) {
    let best: { index: number; paths: Set<string> } | undefined;
    let bestGain = 0;
    for (const candidate of pool) {
      let gain = 0;
      for (const p of candidate.paths) if (left.has(p)) gain++;
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (best === undefined) break;
    chosen.push(best.index);
    for (const p of best.paths) left.delete(p);
  }
  // Records with no key path at all cannot be told apart: the first one will do.
  if (chosen.length === 0) return [0];
  return chosen.sort((a, b) => a - b);
}

export interface Batch {
  stage: LoadStage;
  containerKey: string;
  /** 1-based, within the stage. */
  index: number;
  /** Keys of the resources in this request, for reporting and resubmission. */
  resourceKeys: string[];
  body: ImportRequestBody;
  /** The request that goes first in a {@link CANARY_STAGES} stage: the records that show every structure (usually one). */
  canary?: true;
}

export interface ContainerPlan {
  key: string;
  resourceType: ImportResourceType;
  stage: LoadStage;
  operations: number;
}

export interface LoadBatches {
  containers: ContainerPlan[];
  /** In dependency order: product types, then categories, then products. */
  batches: Batch[];
  warnings: string[];
}

/**
 * Container key for a stage. Numbered only when a stage needs more than one,
 * so the common case reads as `mig-product-draft` rather than
 * `mig-product-draft-1`.
 */
export function containerKey(prefix: string, stage: LoadStage, part: number): string {
  const base = `${prefix}-${RESOURCE_TYPE[stage as ImportStage]}`;
  return part === 1 ? base : `${base}-${part}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bodyFor(stage: ImportStage, resources: unknown[]): ImportRequestBody {
  switch (stage) {
    case 'product-type':
      return { type: 'product-type', resources: resources as ProductTypeImport[] };
    case 'category':
      return { type: 'category', resources: resources as CategoryImport[] };
    case 'product-selection':
      return {
        type: 'product-selection',
        resources: resources as ProductSelectionImport[],
      };
    case 'product-draft':
      return { type: 'product-draft', resources: resources as ProductDraftImport[] };
    case 'variant':
      return { type: 'variant', resources: resources as VariantImport[] };
    case 'standalone-price':
      return { type: 'standalone-price', resources: resources as StandalonePriceImport[] };
    case 'inventory':
      return { type: 'inventory', resources: resources as InventoryImport[] };
    case 'customer':
      return { type: 'customer', resources: resources as CustomerImport[] };
    case 'order':
      return { type: 'order', resources: resources as OrderImport[] };
  }
}

export function planBatches(plan: MigrationPlan, config: PipelineConfig): LoadBatches {
  const perRequest = Math.min(config.load.batchSize, MAX_RESOURCES_PER_REQUEST);
  const perContainer = Math.min(
    config.load.maxOperationsPerContainer,
    MAX_OPERATIONS_PER_CONTAINER,
  );

  const resourcesByStage: Record<ImportStage, { key: string; resource: unknown }[]> = {
    'product-type': plan.productTypes.map((r) => ({ key: r.key, resource: r })),
    category: plan.categories.map((r) => ({ key: r.key, resource: r })),
    'product-draft': plan.products.map((r) => ({ key: r.key, resource: r })),
    // Empty under Classic, where variants travel inside the product draft.
    variant: (plan.variants ?? []).map((r) => ({ key: r.key, resource: r })),
    // Empty under embedded pricing. A stage with no resources is skipped
    // rather than creating an unused container.
    'standalone-price': (plan.standalonePrices ?? []).map((r) => ({
      key: r.key,
      resource: r,
    })),
    // One resource per selection, each carrying its whole assignment list —
    // the Import API replaces omitted fields, so splitting a selection across
    // resources would drop every assignment but the last batch's.
    'product-selection': (plan.productSelections ?? []).map((r) => ({
      key: r.key,
      resource: r,
    })),
    // Empty for a catalog-only migration, which is the normal case. Optional
    // on the plan so a plan written before inventory existed still loads.
    inventory: (plan.inventory ?? []).map((r) => ({ key: r.key, resource: r })),
    // Empty unless the config opts in to customers.
    customer: (plan.customers ?? []).map((r) => ({ key: r.key, resource: r })),
    // Orders have no key; the order number is their identity, verbatim.
    order: (plan.orders ?? []).map((r) => ({ key: r.orderNumber, resource: r })),
  };

  const containers: ContainerPlan[] = [];
  const batches: Batch[] = [];
  const warnings: string[] = [];

  for (const stage of importStages(plan.loadOrder)) {
    const resources = resourcesByStage[stage as ImportStage];
    if (resources.length === 0) continue;

    // Split across containers first, then into requests. Doing it the other way
    // round could straddle a request across two containers.
    const parts = chunk(resources, perContainer);
    if (parts.length > 1) {
      warnings.push(
        `${resources.length} ${stage} resources exceed ${perContainer} operations per ` +
          `container, so they are split across ${parts.length} containers. Import ` +
          'Summaries are per container, so the report aggregates them.',
      );
    }

    let index = 0;
    parts.forEach((part, partIndex) => {
      const key = containerKey(config.keys.prefix, stage, partIndex + 1);
      containers.push({
        key,
        resourceType: RESOURCE_TYPE[stage as ImportStage],
        stage,
        operations: part.length,
      });

      // The first request of a canary stage holds the records that show every
      // structure in the stage (see pickCanary): usually one. It is the first
      // request of the first container, the one the load sends first.
      const withCanary = CANARY_STAGES.includes(stage) && partIndex === 0 && part.length > 0;
      let groups: typeof part[];
      if (withCanary) {
        const picked = new Set(pickCanary(part.map((g) => g.resource)));
        groups = [
          part.filter((_, i) => picked.has(i)),
          ...chunk(
            part.filter((_, i) => !picked.has(i)),
            perRequest,
          ),
        ];
      } else {
        groups = chunk(part, perRequest);
      }
      groups.forEach((group, groupIndex) => {
        index++;
        batches.push({
          stage,
          containerKey: key,
          index,
          resourceKeys: group.map((g) => g.key),
          body: bodyFor(
            stage as ImportStage,
            group.map((g) => g.resource),
          ),
          ...(withCanary && groupIndex === 0 ? { canary: true as const } : {}),
        });
      });
    });
  }

  if (containers.length > MAX_CONTAINERS) {
    warnings.push(
      `${containers.length} containers exceed the soft project limit of ${MAX_CONTAINERS}. ` +
        'Delete obsolete containers or arrange a limit increase.',
    );
  }

  return { containers, batches, warnings };
}

/** Totals for the report, without walking the batches twice at each call site. */
export function summarise(batches: LoadBatches): {
  requests: number;
  resources: number;
  byStage: Record<string, { requests: number; resources: number }>;
} {
  const byStage: Record<string, { requests: number; resources: number }> = {};
  for (const batch of batches.batches) {
    const entry = byStage[batch.stage] ?? { requests: 0, resources: 0 };
    entry.requests++;
    entry.resources += batch.resourceKeys.length;
    byStage[batch.stage] = entry;
  }
  return {
    requests: batches.batches.length,
    resources: Object.values(byStage).reduce((n, s) => n + s.resources, 0),
    byStage,
  };
}
