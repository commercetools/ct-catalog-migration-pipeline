/**
 * What the pipeline writes is readable by its owner only, and a clean verify of
 * a plan with personal data says where the local copies are.
 *
 * Once customers or orders are in scope, the files in `out/` hold names, email
 * addresses and postal addresses; Node's default mode would leave them readable
 * by every account on the machine.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendPrivateFile,
  makePrivateDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  writePrivateFile,
} from '../src/model/private-file.js';
import { personalDataReminder } from '../src/verify/personal-data.js';

// Windows has no POSIX modes: chmod only toggles the read-only flag.
const posix = { skip: process.platform === 'win32' ? 'no POSIX file modes on Windows' : false };

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'ct-private-'));

test('writePrivateFile: a new file is 0600', posix, () => {
  const file = join(scratch(), 'plan.json');
  writePrivateFile(file, '{}\n');
  assert.equal(modeOf(file), PRIVATE_FILE_MODE);
  assert.equal(readFileSync(file, 'utf8'), '{}\n');
});

test('writePrivateFile: overwriting a 0644 file from an earlier run makes it 0600', posix, () => {
  // writeFileSync's mode applies only on create, and runs overwrite the last run's files.
  const file = join(scratch(), 'plan.json');
  writeFileSync(file, 'old\n');
  chmodSync(file, 0o644);
  writePrivateFile(file, 'new\n');
  assert.equal(modeOf(file), PRIVATE_FILE_MODE);
  assert.equal(readFileSync(file, 'utf8'), 'new\n');
});

test('appendPrivateFile: the progress log is 0600, also when it already existed', posix, () => {
  const file = join(scratch(), 'progress.log');
  writeFileSync(file, 'a\n');
  chmodSync(file, 0o644);
  appendPrivateFile(file, 'b\n');
  assert.equal(modeOf(file), PRIVATE_FILE_MODE);
  assert.equal(readFileSync(file, 'utf8'), 'a\nb\n');
});

test('makePrivateDir: a directory it creates is 0700', posix, () => {
  const dir = join(scratch(), 'migration', 'out');
  makePrivateDir(dir);
  assert.equal(modeOf(dir), PRIVATE_DIR_MODE);
});

test('makePrivateDir: an existing directory keeps its mode', posix, () => {
  // --out can name any directory, a shared one included; the files inside are protected anyway.
  const dir = join(scratch(), 'shared');
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  makePrivateDir(dir);
  assert.equal(modeOf(dir), 0o755);
});

test('personalDataReminder: a catalog-only plan prints nothing', () => {
  assert.deepEqual(personalDataReminder({ customers: 0, orders: 0 }, '/e/migration/feed', '/e/migration/out'), []);
});

test('personalDataReminder: names the feed, plan.json and the load files, and keeps plan.json for teardown', () => {
  const lines = personalDataReminder({ customers: 3, orders: 0 }, '/e/migration/feed', '/e/migration/out').join('\n');
  assert.match(lines, /the customers of this plan/);
  assert.doesNotMatch(lines, /orders/);
  assert.match(lines, /migration\/feed\/ +\(the feed\)/);
  assert.match(lines, /migration\/out\/plan\.json/);
  assert.match(lines, /load-requests\*\.json and load-result\*\.json/);
  assert.match(lines, /source export/);
  assert.match(lines, /keep plan\.json until any trial load is torn down/);
});

test('personalDataReminder: customers and orders together', () => {
  const lines = personalDataReminder({ customers: 1, orders: 2 }, '/f', '/o');
  assert.match(lines[0], /the customers and orders of this plan/);
});
