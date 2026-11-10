/**
 * The record of prerequisites a load created, and teardown's use of it.
 *
 * Teardown leaves tax categories, channels, customer groups and stores alone
 * because they are the project's. One that this plan's load created is this run's
 * own, but `load-result.json` cannot say so: a second `--execute` finds it and
 * calls it existing.
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
      { stage: 'customer-group', existing: ['old-group'], created: ['trade'], unusable: [] },
      { stage: 'tax-category', existing: taxExisting, created: taxCreated, unusable: [] },
      { stage: 'store', existing: [], created: ['northwind-uk'], unusable: [] },
    ],
  } as unknown as LoadResult;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'created-'));

test('created: an executed load records the tax categories, channels, groups and stores it created, and only those', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(true, ['standard']));
  const expected = {
    taxCategories: ['standard'],
    channels: ['retail-uk'],
    customerGroups: ['trade'],
    stores: ['northwind-uk'],
  };
  assert.deepEqual(readCreatedPrerequisites(dir), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, CREATED_PREREQUISITES_FILE), 'utf8')), expected);
  assert.ok(
    !readCreatedPrerequisites(dir).customerGroups.includes('old-group'),
    'a group the project already held is not recorded: teardown must never delete it',
  );
});

test('created: a second load that finds them existing does not forget any kind', () => {
  const dir = tmp();
  recordCreatedPrerequisites(dir, loadResult(true, ['standard']));
  const second = {
    executed: true,
    prerequisites: [
      { stage: 'channel', existing: ['retail-uk'], created: [], unusable: [] },
      { stage: 'customer-group', existing: ['trade'], created: [], unusable: [] },
      { stage: 'store', existing: ['northwind-uk'], created: [], unusable: [] },
    ],
  } as unknown as LoadResult;
  recordCreatedPrerequisites(dir, second);
  assert.deepEqual(readCreatedPrerequisites(dir).channels, ['retail-uk']);
  assert.deepEqual(readCreatedPrerequisites(dir).customerGroups, ['trade']);
  assert.deepEqual(readCreatedPrerequisites(dir).stores, ['northwind-uk']);
});

test('created: a file written before channels, groups and stores were recorded still reads', () => {
  const dir = tmp();
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), JSON.stringify({ taxCategories: ['standard'] }));
  assert.deepEqual(readCreatedPrerequisites(dir), {
    taxCategories: ['standard'],
    channels: [],
    customerGroups: [],
    stores: [],
  });
});

test('created: a later load adds the other kinds to an old file without losing the tax category', () => {
  const dir = tmp();
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), JSON.stringify({ taxCategories: ['standard'] }));
  recordCreatedPrerequisites(dir, loadResult(true, []));
  const read = readCreatedPrerequisites(dir);
  assert.deepEqual(read.taxCategories, ['standard']);
  assert.deepEqual(read.channels, ['retail-uk']);
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
  assert.deepEqual(readCreatedPrerequisites(dir), {
    taxCategories: [],
    channels: [],
    customerGroups: [],
    stores: [],
  });
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), '{not json');
  assert.throws(() => readCreatedPrerequisites(dir), /created-prerequisites\.json is not valid JSON/);
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), '{"taxCategories": "standard"}');
  assert.throws(() => readCreatedPrerequisites(dir), /must hold/);
  writeFileSync(join(dir, CREATED_PREREQUISITES_FILE), '{"stores": [1]}');
  assert.throws(() => readCreatedPrerequisites(dir), /stores/);
});
