/**
 * A record of the prerequisites a load created, kept so a teardown can tell
 * them from the ones that were already in the project.
 *
 * Tax categories, channels, customer groups and stores are keyed verbatim and
 * belong to the project, so teardown leaves them. But one that this plan's load
 * created is this run's own, and the only way to empty a trial project was a
 * delete by hand. `load-result.json` cannot say which: it is rewritten by every
 * `--execute`, and a second load finds what it created the first time and
 * reports it as `existing`. So the creations go into a file of their own, which
 * only ever grows.
 *
 * It holds keys, not a claim about the project: teardown still reads each one
 * and the API still refuses a delete while something uses it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePrivateDir, writePrivateFile } from '../model/private-file.js';

import type { LoadResult } from './run.js';

export const CREATED_PREREQUISITES_FILE = 'created-prerequisites.json';

/** The kinds a load creates through the platform API, as the file names them. */
export const CREATED_KINDS = ['taxCategories', 'channels', 'customerGroups', 'stores'] as const;
export type CreatedKind = (typeof CREATED_KINDS)[number];

/** Keys a load of this plan created, per kind. */
export type CreatedPrerequisites = Record<CreatedKind, string[]>;

const KIND_OF_STAGE: Record<string, CreatedKind> = {
  'tax-category': 'taxCategories',
  channel: 'channels',
  'customer-group': 'customerGroups',
  store: 'stores',
};

const empty = (): CreatedPrerequisites => ({
  taxCategories: [],
  channels: [],
  customerGroups: [],
  stores: [],
});

export function readCreatedPrerequisites(outDir: string): CreatedPrerequisites {
  const path = join(outDir, CREATED_PREREQUISITES_FILE);
  if (!existsSync(path)) return empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}).`);
  }
  const out = empty();
  for (const kind of CREATED_KINDS) {
    const keys = (parsed as Record<string, unknown> | null)?.[kind];
    // A file written before a kind was recorded lacks it: nothing is known to have
    // been created, which is a different thing from a damaged list.
    if (keys === undefined) continue;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
      throw new Error(`${path} must hold { "${kind}": [<key>, ...] } for each kind it names.`);
    }
    out[kind] = keys as string[];
  }
  return out;
}

/** Adds what an executed load created. Never removes a key, and writes nothing if nothing is new. */
export function recordCreatedPrerequisites(outDir: string, result: LoadResult): void {
  if (!result.executed) return;
  const known = readCreatedPrerequisites(outDir);
  const merged = empty();
  let grew = false;
  for (const kind of CREATED_KINDS) {
    const created = result.prerequisites
      .filter((p) => KIND_OF_STAGE[p.stage] === kind)
      .flatMap((p) => p.created);
    merged[kind] = [...new Set([...known[kind], ...created])];
    if (merged[kind].length > known[kind].length) grew = true;
  }
  if (!grew) return;

  makePrivateDir(outDir);
  writePrivateFile(join(outDir, CREATED_PREREQUISITES_FILE), JSON.stringify(merged, null, 2) + '\n');
}
