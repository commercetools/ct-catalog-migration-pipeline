/**
 * A record of the prerequisites a load created, kept so a teardown can tell
 * them from the ones that were already in the project.
 *
 * Tax categories are keyed verbatim and belong to the project, so teardown
 * leaves them. But one that this plan's load created is this run's own, and the
 * only way to empty a trial project was a delete by hand. `load-result.json`
 * cannot say which: it is rewritten by every `--execute`, and a second load
 * finds the category it created the first time and reports it as `existing`. So
 * the creations go into a file of their own, which only ever grows.
 *
 * It holds keys, not a claim about the project: teardown still reads each one
 * and the API still refuses a delete while a product uses the category.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LoadResult } from './run.js';

export const CREATED_PREREQUISITES_FILE = 'created-prerequisites.json';

export interface CreatedPrerequisites {
  /** Tax category keys a load of this plan created. */
  taxCategories: string[];
}

export function readCreatedPrerequisites(outDir: string): CreatedPrerequisites {
  const path = join(outDir, CREATED_PREREQUISITES_FILE);
  if (!existsSync(path)) return { taxCategories: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}).`);
  }
  const keys = (parsed as { taxCategories?: unknown } | null)?.taxCategories;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
    throw new Error(`${path} must hold { "taxCategories": [<key>, ...] }.`);
  }
  return { taxCategories: keys as string[] };
}

/** Adds what an executed load created. Never removes a key, and writes nothing if nothing is new. */
export function recordCreatedPrerequisites(outDir: string, result: LoadResult): void {
  if (!result.executed) return;
  const created = result.prerequisites
    .filter((p) => p.stage === 'tax-category')
    .flatMap((p) => p.created);
  if (created.length === 0) return;

  const known = readCreatedPrerequisites(outDir);
  const merged = [...new Set([...known.taxCategories, ...created])];
  if (merged.length === known.taxCategories.length) return;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, CREATED_PREREQUISITES_FILE),
    JSON.stringify({ taxCategories: merged }, null, 2) + '\n',
  );
}
