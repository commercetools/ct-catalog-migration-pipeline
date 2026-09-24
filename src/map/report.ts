/**
 * Writing the plan out.
 *
 * `plan.json` is what the load stage consumes. `key-map.json` is split out
 * deliberately: it is the artefact a delta run and a rollback need, it is small,
 * and it should survive even if the plan is regenerated.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { indexVariants, pricesOf, type MigrationPlan, type PlannedVariant } from '../model/plan.js';
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

function renderPayloads(plan: MigrationPlan): string {
  const lines: string[] = ['# Sample payloads', ''];
  lines.push(
    'One product per variant-count shape, as it will be sent. Check the money values ' +
      'against the source before loading: minor-unit conversion is the defect that looks ' +
      'most like success.',
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

  for (const count of [...byShape.keys()].sort((a, b) => a - b)) {
    const product = byShape.get(count)!;
    lines.push(`## \`${product.key}\` — ${count} variant(s)`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(product, null, 2));
    lines.push('```');
    lines.push('');

    const priced = (variantsByProduct.get(product.key) ?? []).filter(
      (v: PlannedVariant) => pricesOf(v).length > 0,
    );
    if (priced.length > 0) {
      lines.push('Prices decoded back from minor units:');
      lines.push('');
      lines.push('| SKU | Currency | Minor units | Decimal | Scope |');
      lines.push('| :--- | :--- | ---: | ---: | :--- |');
      for (const v of priced) {
        for (const p of pricesOf(v)) {
          const scope = [
            p.country ? `country=${p.country}` : null,
            p.customerGroup ? `group=${p.customerGroup.key}` : null,
            p.channel ? `channel=${p.channel.key}` : null,
            p.validFrom || p.validUntil
              ? `valid ${p.validFrom ?? '-'}..${p.validUntil ?? '-'}`
              : null,
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(
            `| \`${v.sku}\` | ${p.value.currencyCode} | ${p.value.centAmount} | ` +
              `${fromTypedMoney(p.value)} | ${scope || 'base'} |`,
          );
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
