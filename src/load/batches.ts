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
  ImportResourceType,
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
  | ProductSelectionImportRequest;

/**
 * The `resourceType` a container is restricted to, per Import API stage.
 *
 * `channel` and `customer-group` are absent on purpose: they are load stages
 * but not *import* stages — the platform API creates them, so they have no
 * container, no batching and no resource type. `ImportStage` excludes them at
 * the type level rather than a runtime skip, so adding another platform stage
 * cannot silently fall through into batching.
 */
type ImportStage = Exclude<LoadStage, 'channel' | 'customer-group' | 'store'>;

const RESOURCE_TYPE: Record<ImportStage, ImportResourceType> = {
  'product-type': 'product-type',
  category: 'category',
  'product-draft': 'product-draft',
  variant: 'variant',
  'standalone-price': 'standalone-price',
  'product-selection': 'product-selection',
};

export interface Batch {
  stage: LoadStage;
  containerKey: string;
  /** 1-based, within the stage. */
  index: number;
  /** Keys of the resources in this request, for reporting and resubmission. */
  resourceKeys: string[];
  body: ImportRequestBody;
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

      for (const group of chunk(part, perRequest)) {
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
        });
      }
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
