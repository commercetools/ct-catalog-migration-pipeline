/**
 * Writing the plan out.
 *
 * `plan.json` is what the load stage consumes. `key-map.json` is split out
 * deliberately: it is the artefact a delta run and a rollback need, it is small,
 * and it should survive even if the plan is regenerated.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  indexVariants,
  pricesOf,
  type MigrationPlan,
  type PriceDraftImport,
  type StandalonePriceImport,
} from '../model/plan.js';
import { fromTypedMoney } from './money.js';
import { stringifyArtefact } from '../model/artefact.js';

export interface PlanArtefacts {
  planPath: string;
  keyMapPath: string;
  decisionsPath: string;
  payloadsPath?: string;
}

export function writePlan(
  outDir: string,
  plan: MigrationPlan,
  includePayloads: boolean,
): PlanArtefacts {
  mkdirSync(outDir, { recursive: true });

  const planPath = join(outDir, 'plan.json');
  const variantCount = plan.products.reduce(
    (n, product) =>
      n + (product.masterVariant ? 1 : 0) + (product.variants?.length ?? 0),
    plan.variants?.length ?? 0,
  );
  writeFileSync(
    planPath,
    stringifyArtefact(
      {
        loadOrder: plan.loadOrder,
        productTypes: plan.productTypes,
        categories: plan.categories,
        products: plan.products,
        variants: plan.variants,
        standalonePrices: plan.standalonePrices,
        productSelections: plan.productSelections,
        inventory: plan.inventory,
        prerequisites: plan.prerequisites,
        // Last, so a human skimming the file sees the catalog first — but
        // written unconditionally, because a plan with no provenance is one the
        // gate cannot vouch for.
        provenance: plan.provenance,
      },
      {
        artefact: 'plan.json',
        counts: {
          'variant(s)': variantCount,
          'category(ies)': plan.categories.length,
          'product(s)': plan.products.length,
          'standalone price(s)': plan.standalonePrices?.length ?? 0,
          'product selection(s)': plan.productSelections?.length ?? 0,
          'inventory entry(ies)': plan.inventory?.length ?? 0,
          'tax category(ies)': plan.prerequisites?.taxCategories?.length ?? 0,
          'product type(s)': plan.productTypes.length,
        },
      },
    ),
  );

  const keyMapPath = join(outDir, 'key-map.json');
  writeFileSync(keyMapPath, JSON.stringify(plan.keyMap, null, 2) + '\n');

  const decisionsPath = join(outDir, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify(plan.decisions, null, 2) + '\n');

  if (!includePayloads) return { planPath, keyMapPath, decisionsPath };

  // One product of each shape, rendered readably. Eyeballing a real payload
  // catches things a summary cannot — a price in the wrong currency, an
  // attribute that never got a value, a slug nobody would want in a URL.
  const payloadsPath = join(outDir, 'sample-payloads.md');
  writeFileSync(payloadsPath, renderPayloads(plan));
  return { planPath, keyMapPath, decisionsPath, payloadsPath };
}

/**
 * One product per variant-count shape, written as the load will send it.
 *
 * "As it will be sent" means every resource that carries the product's data,
 * not just the product draft: under Modular the variants are their own
 * `VariantImport` resources, and under `priceMode: 'standalone'` the prices are
 * `StandalonePriceImport` resources keyed by SKU. Rendering only the product
 * left both out — so in standalone mode, the mode Modular forces, the file had
 * no prices in it and the money check it exists for could not be done.
 *
 * Exported for the tests.
 */
export function renderPayloads(plan: MigrationPlan): string {
  const lines: string[] = ['# Sample payloads', ''];
  lines.push(
    'One product per variant-count shape, as it will be sent. Check the money values ' +
      'against the source before loading: minor-unit conversion is the defect that looks ' +
      'most like success.',
  );
  lines.push('');
  const standalone = plan.standalonePrices ?? [];
  lines.push(
    standalone.length > 0
      ? `Prices are Standalone Prices (${standalone.length} in the plan), each a ` +
          'separate `StandalonePriceImport` keyed by SKU and loaded after the products.'
      : 'Prices are embedded in the variant drafts.',
  );
  lines.push('');

  // Through the index so a Modular plan, whose products carry no variants at
  // all, still groups by variant count rather than collapsing to one shape.
  const variantsByProduct = indexVariants(plan);
  const byShape = new Map<number, (typeof plan.products)[number]>();
  for (const product of plan.products) {
    const count = (variantsByProduct.get(product.key) ?? []).length;
    if (!byShape.has(count)) byShape.set(count, product);
  }

  // Indexed once: per-product filtering would be quadratic on exactly the
  // catalogs that are large enough to need standalone pricing.
  const standaloneBySku = new Map<string, StandalonePriceImport[]>();
  for (const price of standalone) {
    const group = standaloneBySku.get(price.sku) ?? [];
    group.push(price);
    standaloneBySku.set(price.sku, group);
  }

  const detached = new Set((plan.variants ?? []).map((v) => v.key));

  for (const count of [...byShape.keys()].sort((a, b) => a - b)) {
    const product = byShape.get(count)!;
    const variants = variantsByProduct.get(product.key) ?? [];
    lines.push(`## \`${product.key}\` — ${count} variant(s)`);
    lines.push('');
    pushJson(lines, product);

    const ownVariants = variants.filter((v) => detached.has(v.key));
    if (ownVariants.length > 0) {
      lines.push(`Its ${ownVariants.length} \`VariantImport\` resource(s):`);
      lines.push('');
      for (const v of ownVariants) pushJson(lines, v);
    }

    const rows: { sku: string; kind: string; price: PriceDraftImport | StandalonePriceImport }[] =
      [];
    for (const v of variants) {
      for (const p of pricesOf(v)) rows.push({ sku: v.sku ?? v.key, kind: 'embedded', price: p });
      for (const p of v.sku ? (standaloneBySku.get(v.sku) ?? []) : []) {
        rows.push({ sku: v.sku!, kind: 'standalone', price: p });
      }
    }

    const sampleStandalone = rows.find((r) => r.kind === 'standalone');
    if (sampleStandalone) {
      lines.push('One of its `StandalonePriceImport` resources:');
      lines.push('');
      pushJson(lines, sampleStandalone.price);
    }

    if (rows.length > 0) {
      lines.push('Prices decoded back from minor units:');
      lines.push('');
      lines.push('| SKU | Kind | Currency | Minor units | Decimal | Scope |');
      lines.push('| :--- | :--- | :--- | ---: | ---: | :--- |');
      for (const { sku, kind, price: p } of rows) {
        const scope = [
          p.country ? `country=${p.country}` : null,
          p.customerGroup ? `group=${p.customerGroup.key}` : null,
          p.channel ? `channel=${p.channel.key}` : null,
          p.validFrom || p.validUntil ? `valid ${p.validFrom ?? '-'}..${p.validUntil ?? '-'}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(
          `| \`${sku}\` | ${kind} | ${p.value.currencyCode} | ${p.value.centAmount} | ` +
            `${fromTypedMoney(p.value)} | ${scope || 'base'} |`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function pushJson(lines: string[], value: unknown): void {
  lines.push('```json');
  lines.push(JSON.stringify(value, null, 2));
  lines.push('```');
  lines.push('');
}
