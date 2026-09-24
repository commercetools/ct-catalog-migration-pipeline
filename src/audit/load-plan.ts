/**
 * Reading a written plan back.
 *
 * The audit runs against the file, not the in-memory object the mapper just
 * produced. That is the point: it checks what will actually be sent, and it
 * keeps working when someone hand-edits a plan or replays an old one.
 *
 * The shape is checked defensively rather than cast, because a truncated or
 * half-written plan should say so instead of failing somewhere deep inside a
 * gate check.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LOAD_ORDER, type MigrationPlan } from '../model/plan.js';

export function loadPlan(outDir: string): MigrationPlan {
  const planPath = join(outDir, 'plan.json');

  let raw: string;
  try {
    raw = readFileSync(planPath, 'utf8');
  } catch (err) {
    // The same string ceiling applies on the way in: reading as utf8 builds one
    // string, so a plan large enough to be near the write limit can fail to be
    // read back even though it is on disk. Distinguishable from "no plan" only
    // by the error, so it is worth separating — the remedies are nothing alike.
    if (err instanceof RangeError || existsSync(planPath)) {
      const mb = existsSync(planPath) ? statSync(planPath).size / 1e6 : 0;
      throw new Error(
        `${planPath} exists (${mb.toFixed(0)} MB) but could not be read into memory: ` +
          `${(err as Error).message}\n` +
          '      A JSON document has to be read as a single string, and V8 caps strings ' +
          "at about 537 MB — so a plan can be written and then be too large to read.\n" +
          '      Split the engagement into several configs with different `keys.prefix` ' +
          'values; each plan is then its own document.',
      );
    }
    throw new Error(
      `No plan at ${planPath}.\nRun \`plan\` first — the audit checks the written plan, ` +
        'not the feed.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${planPath} is not valid JSON: ${(err as Error).message}`);
  }

  const plan = parsed as Partial<MigrationPlan>;
  for (const field of ['productTypes', 'categories', 'products'] as const) {
    if (!Array.isArray(plan[field])) {
      throw new Error(
        `${planPath} is missing the '${field}' array. It looks truncated or hand-edited; ` +
          're-run `plan`.',
      );
    }
  }

  // A plan written by an older version — or by hand — may name a load stage
  // this build does not know. Crashing deep inside the batch planner with
  // "cannot read properties of undefined" tells the reader nothing, so it is
  // checked here where the file is still in view.
  if (plan.loadOrder !== undefined) {
    const unknown = plan.loadOrder.filter(
      (stage) => !(LOAD_ORDER as readonly string[]).includes(stage),
    );
    if (unknown.length > 0) {
      throw new Error(
        `${planPath} names unknown load stage(s): ${unknown.join(', ')}.\n` +
          `This build knows: ${LOAD_ORDER.join(', ')}.\n` +
          'Re-run `plan` to regenerate it.',
      );
    }
  }

  // The key map lives in its own file and is not needed by the gate, so an
  // absent one is not an error here.
  let keyMap: MigrationPlan['keyMap'] = { categories: {}, products: {}, variants: {} };
  try {
    keyMap = JSON.parse(readFileSync(join(outDir, 'key-map.json'), 'utf8'));
  } catch {
    // Intentionally ignored.
  }

  return {
    // A plan written before stores existed has prerequisites without the
    // field, so it is backfilled rather than trusted to be present.
    productTypes: plan.productTypes!,
    categories: plan.categories!,
    products: plan.products!,
    // Neither of these is in the required list above: each is empty in one
    // catalog model or price mode, and a plan written before its stage existed
    // has no field at all. The gate cross-checks both against the config,
    // which is where an actually missing collection gets reported.
    variants: plan.variants ?? [],
    standalonePrices: plan.standalonePrices ?? [],
    productSelections: plan.productSelections ?? [],
    prerequisites: plan.prerequisites ?? { channels: [], customerGroups: [], stores: [] },
    decisions: plan.decisions ?? [],
    keyMap,
    loadOrder: plan.loadOrder ?? LOAD_ORDER,
    ...(plan.provenance ? { provenance: plan.provenance } : {}),
  };
}
