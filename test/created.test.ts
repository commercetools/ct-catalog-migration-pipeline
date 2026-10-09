/**
 * The record of prerequisites a load created, and teardown's use of it.
 *
 * Teardown leaves tax categories alone because they are the project's. One that
 * this plan's load created is this run's own, but `load-result.json` cannot say
 * so: a second `--execute` finds it and calls it existing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATED_PREREQUISITES_FILE,
  readCreatedPrerequisites,
  recordCreatedPrerequisites,
} from '../src/load/created.js';
import type { LoadResult } from '../src/load/run.js';

function loadResult(executed: boolean, taxCreated: string[], taxExisting: string[] = []): LoadResult {
  return {
    executed,
    prerequisites: [
      { stage: 'channel', existing: [], created: ['retail-uk'], unusable: [] },
      { stage: 'tax-category', existing: taxExisting, created: taxCreated, unusable: [] },
    ],
  } as unknown as LoadResult;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'created-'));

test('created: an executed load records the tax categories it created, and only those', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(true, ['standard']));
  assert.deepEqual(readCreatedPrerequisites(dir), { taxCategories: ['standard'] });
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, CREATED_PREREQUISITES_FILE), 'utf8')),
    { taxCategories: ['standard'] },
    'the channel the same load created is not in it',
  );
});

test('created: a dry run records nothing', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(false, ['standard']));
  assert.equal(existsSync(join(dir, CREATED_PREREQUISITES_FILE)), false);
});

test('created: a second load that finds the category existing does not forget it', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(true, ['standard']));
  recordCreatedPrerequisites(dir, loadResult(true, [], ['standard']));
  assert.deepEqual(readCreatedPrerequisites(dir).taxCategories, ['standard']);
});

test('created: later creations are added and nothing is listed twice', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(true, ['standard']));
  recordCreatedPrerequisites(dir, loadResult(true, ['reduced', 'standard']));
  assert.deepEqual(readCreatedPrerequisites(dir).taxCategories, ['standard', 'reduced']);
});

test('created: a missing file reads as empty and a damaged one is an error that names the file', () => {
  const dir = tmp();
  assert.deepEqual(readCreatedPrerequisites(dir), { taxCategories: [] });
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), '{not json');
  assert.throws(() => readCreatedPrerequisites(dir), /created-prerequisites\.json is not valid JSON/);
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), '{"taxCategories": "standard"}');
  assert.throws(() => readCreatedPrerequisites(dir), /must hold/);
});
