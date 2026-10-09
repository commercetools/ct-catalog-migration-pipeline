/**
 * Progress is reported on ticks, never on change. These tests drive a fake
 * clock, so nothing here sleeps.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProgress, formatDuration, noProgress } from '../src/progress/progress.js';

function harness(intervalMs = 30_000, extra: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const lines: string[] = [];
  const progress = createProgress({
    command: 'load',
    intervalMs,
    now: () => t,
    write: (l) => lines.push(l),
    timer: false,
    ...extra,
  });
  return { progress, lines, advance: (ms: number) => (t += ms) };
}

test('progress: counters can change as often as they like; only a tick prints', () => {
  const { progress, lines, advance } = harness();
  let done = 0;
  progress.activity('load').status(() => `${done}/1000 requests`);
  for (let i = 0; i < 1000; i++) {
    done++;
    progress.poll();
  }
  assert.deepEqual(lines, [], 'a thousand updates and polls inside one interval print nothing');

  advance(30_000);
  progress.poll();
  assert.deepEqual(lines, ['30s  load: 1000/1000 requests']);
});

test('progress: one line per tick however often poll is called, and a missed tick is not made up for', () => {
  const { progress, lines, advance } = harness();
  progress.activity('verify').status(() => 'reading products');
  advance(30_000);
  progress.poll();
  progress.poll();
  progress.poll();
  assert.equal(lines.length, 1);

  advance(95_000); // three intervals pass without a poll, as in a long synchronous step
  progress.poll();
  progress.poll();
  assert.equal(lines.length, 2, 'one line for the whole gap, not three');
  assert.match(lines[1], /^2m05s {2}verify: reading products$/);
});

test('progress: an activity reports until it is done, and an idle command still says it is running', () => {
  const { progress, lines, advance } = harness();
  const a = progress.activity('teardown');
  a.status(() => 'deleting products 3/10');
  advance(30_000);
  progress.poll();
  a.done();
  advance(30_000);
  progress.poll();
  assert.equal(lines[0], '30s  teardown: deleting products 3/10');
  assert.equal(lines[1], '1m00s  load: still running');
});

test('progress: several activities each get a line on the tick', () => {
  const { progress, lines, advance } = harness();
  progress.activity('a').status(() => 'one');
  progress.activity('b').status(() => 'two');
  advance(30_000);
  progress.poll();
  assert.deepEqual(lines, ['30s  a: one', '30s  b: two']);
});

test('progress: a command shorter than one interval prints only the closing line', () => {
  const { progress, lines, advance } = harness();
  progress.activity('validate').status(() => 'reading');
  advance(3_200);
  progress.poll();
  progress.finish();
  assert.deepEqual(lines, ['done in 3.2s']);
});

test('progress: a failing command says so on the closing line, and finishing twice prints once', () => {
  const { progress, lines, advance } = harness();
  advance(61_000);
  progress.finish(1);
  progress.finish(1);
  assert.deepEqual(lines, ['done in 1m01s (exit 1)']);
});

test('progress: an interval of zero switches ticks off but keeps the closing line', () => {
  const { progress, lines, advance } = harness(0);
  progress.activity('load').status(() => 'x');
  advance(10 * 60_000);
  progress.poll();
  assert.deepEqual(lines, []);
  progress.finish();
  assert.deepEqual(lines, ['done in 10m00s']);
});

test('progress: quiet silences the stream and not the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-'));
  const file = join(dir, 'out', 'progress.log');
  const { progress, lines, advance } = harness(30_000, { quiet: true, file });
  progress.activity('load').status(() => 'waiting');
  advance(30_000);
  progress.poll();
  progress.finish();
  assert.deepEqual(lines, []);
  const text = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(text.length, 3);
  assert.match(text[0], /^\S+ {2}# load started$/);
  assert.match(text[1], /^\S+ {2}30s {2}load: waiting$/);
  assert.match(text[2], /^\S+ {2}done in 30s$/);
});

test('progress: a file that cannot be written does not fail the command', () => {
  const { progress, lines } = harness(30_000, { file: '/dev/null/progress.log' });
  progress.finish();
  assert.deepEqual(lines, ['done in 0.0s']);
});

test('progress: durations read the same on every line', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(3_200), '3.2s');
  assert.equal(formatDuration(42_900), '42s');
  assert.equal(formatDuration(310_000), '5m10s');
  assert.equal(formatDuration(3_725_000), '1h02m05s');
});

test('progress: no reporter at all is safe to call', () => {
  const a = noProgress.activity('x');
  a.status(() => 'y');
  a.done();
  noProgress.poll();
  noProgress.finish();
  assert.ok(noProgress.now() > 0);
});
