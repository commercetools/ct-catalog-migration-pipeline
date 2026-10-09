/**
 * Where progress is reported: ticks only, from live counters, in every stage.
 *
 * A fake clock stands in for time, so a "five minute wait" takes no time and
 * the number of lines is exactly the number of intervals that passed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFeed } from '../src/contract/validate.js';
import { loadConfig } from '../src/model/config.js';
import { deriveProductTypes } from '../src/derive/product-types.js';
import { buildPlan } from '../src/map/plan.js';
import { auditPlan } from '../src/audit/gate.js';
import { createProgress } from '../src/progress/progress.js';

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the package root');
    dir = parent;
  }
  return dir;
}
const ROOT = packageRoot();
const SCHEMA = resolve(ROOT, 'schema', 'catalog-feed.schema.json');

/** A clock that moves one second every time anything reads it, and the lines written. */
function ticking(intervalMs: number) {
  let t = 0;
  const lines: string[] = [];
  const progress = createProgress({
    command: 'test',
    intervalMs,
    now: () => (t += 1000),
    write: (l) => lines.push(l),
    timer: false,
  });
  return { progress, lines };
}

test('stages: validate, derive, plan and audit each report on ticks, from counters, and far fewer times than they count', () => {
  const { config, feedDir } = loadConfig(resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json'));
  const { progress, lines } = ticking(5_000);

  const validation = validateFeed(feedDir, SCHEMA, config, progress);
  const model = deriveProductTypes(validation.feed, config, progress);
  const { plan } = buildPlan(validation.feed, model, config, progress);
  auditPlan(plan, config, progress);

  // Every poll reads the clock, so what matters here is the shape: lines are
  // the stages' own wording, and there are not as many lines as records.
  const text = lines.join('\n');
  const records = validation.accepted;
  assert.ok(lines.length < records, `${lines.length} lines for ${records} records`);
  for (const line of lines) assert.match(line, /^\d+(\.\d)?s {2}\S/, line);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('stages: the counters a tick prints are the ones the stage keeps', () => {
  const { config, feedDir } = loadConfig(resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json'));
  // Fire a tick on every poll so the wording can be read.
  let t = 0;
  const lines: string[] = [];
  const progress = createProgress({
    command: 'test',
    intervalMs: 1,
    now: () => (t += 10),
    write: (l) => lines.push(l),
    timer: false,
  });
  // The loops poll every 256 records; a tick on every poll needs at least one poll.
  // The fixture is small, so the status text is read through a direct poll instead.
  const validation = validateFeed(feedDir, SCHEMA, config, {
    ...progress,
    activity: (label) => {
      const a = progress.activity(label);
      return {
        status(report) {
          a.status(report);
          progress.poll();
        },
        done: () => a.done(),
      };
    },
  });
  const mine = lines.filter((l) => l.includes('validate:'));
  assert.ok(mine.some((l) => /reading the feed: \d+ record\(s\) in \d+ file\(s\)/.test(l)), mine.join('\n'));
  assert.ok(mine.some((l) => /checking \d+ record\(s\) against each other/.test(l)), mine.join('\n'));
  assert.ok(validation.accepted > 0);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const CLI = resolve(ROOT, 'dist-test', 'src', 'cli.js');
const CONFIG = resolve(ROOT, 'fixtures', 'classic-standalone', 'migration.config.json');

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
}

test('cli: a command shorter than the interval prints only the closing line, on stderr', () => {
  const r = cli(['validate', '--config', CONFIG]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^done in \d+\.\ds\n$/);
  assert.doesNotMatch(r.stdout, /done in/);
});

test('cli: --json stdout stays parseable with progress on', () => {
  const r = cli(['validate', '--config', CONFIG, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.match(r.stderr, /done in/);
});

test('cli: --quiet silences the progress lines', () => {
  const r = cli(['validate', '--config', CONFIG, '--quiet']);
  assert.equal(r.stderr, '');
});

test('cli: an interval that is not a number of seconds is refused', () => {
  for (const bad of ['soon', '-5']) {
    const r = cli(['validate', '--config', CONFIG, `--progress-interval=${bad}`]);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--progress-interval must be a number of seconds/);
  }
});

test('cli: a failing command says so on its closing line', () => {
  const r = cli(['validate', '--config', resolve(ROOT, 'fixtures', 'broken-schema', 'migration.config.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /done in \d+\.\ds \(exit 1\)/);
});

test('cli: plan writes out/progress.log beside its other artefacts; validate writes none', () => {
  const out = mkdtempSync(join(tmpdir(), 'progress-out-'));
  const planned = cli(['plan', '--config', CONFIG, '--out', out]);
  assert.equal(planned.status, 0, planned.stderr);
  const log = readFileSync(join(out, 'progress.log'), 'utf8').trim().split('\n');
  assert.match(log[0], /^\S+ {2}# plan started$/);
  assert.match(log[log.length - 1], /^\S+ {2}done in \d+\.\ds$/);

  const quiet = mkdtempSync(join(tmpdir(), 'progress-out-'));
  cli(['plan', '--config', CONFIG, '--out', quiet, '--quiet']);
  assert.ok(existsSync(join(quiet, 'progress.log')), 'quiet silences the terminal, not the file');

  const none = mkdtempSync(join(tmpdir(), 'progress-out-'));
  cli(['validate', '--config', CONFIG, '--out', none]);
  assert.equal(existsSync(join(none, 'progress.log')), false, 'a command that writes no artefacts writes no log');
});
