/**
 * Progress while a command runs, reported on ticks and nowhere else.
 *
 * A stage that takes minutes used to print nothing until it finished, which
 * looks exactly like a hang. The fix has one rule: **output happens on a fixed
 * interval, never when something changes.** Code updates counters as often as it
 * likes; a tick samples them. So a load of two thousand requests costs the same
 * number of lines as one of twenty, and a reader can tell a slow command from a
 * stuck one by whether the lines keep coming.
 *
 * Three consequences of that rule:
 *
 *  - Work registers *what to say* (`activity().status(() => ...)`), and the
 *    ticker calls it when a tick is due. Nothing is formatted between ticks.
 *  - A tick is due by the clock, not by a timer alone. Most of the offline
 *    stages are synchronous, and a timer cannot fire inside a synchronous loop,
 *    so their loops call `poll()`. Awaiting stages are covered by a timer that
 *    calls the same `poll()`. Both read one schedule, so they cannot double up.
 *  - A command shorter than one interval prints a single line, `done in …`.
 *
 * Lines go to stderr, so stdout and the reports other documents quote are
 * unchanged. A file, when one is given, gets the same lines with a timestamp,
 * so a caller that pipes the command through `tail` (and so sees nothing until
 * it exits) can read it while the command runs.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Activity {
  /** What a tick says about this activity. Called on ticks only, so it may read live counters. */
  status(report: () => string): void;
  /** No longer reported. */
  done(): void;
}

export interface Progress {
  /** The clock the ticker uses, so a caller can measure "for how long" on the same one. */
  now(): number;
  activity(label: string): Activity;
  /** Emits a tick if one is due. Cheap; call it from synchronous loops. */
  poll(): void;
  /** Stops the timer and writes the closing line. */
  finish(exitCode?: number): void;
}

export interface ProgressOptions {
  /** Shown in the file's start line. */
  command: string;
  /** Between ticks. Zero or less switches ticks off; the closing line is still written. */
  intervalMs: number;
  /** Where lines go. Defaults to stderr. */
  write?: (line: string) => void;
  /** No lines to the stream (a file, if any, is still written). */
  quiet?: boolean;
  /** A file that gets every line, timestamped, appended. */
  file?: string;
  now?: () => number;
  /** Poll on a timer as well. Tests turn it off and drive `poll()` with a fake clock. */
  timer?: boolean;
}

const noActivity: Activity = { status() {}, done() {} };

/** For code that runs without a reporter: a library call, a test. */
export const noProgress: Progress = {
  now: () => Date.now(),
  activity: () => noActivity,
  poll() {},
  finish() {},
};

/** For hot loops: a function that calls `poll()` once per `every` calls, so the clock is read rarely. */
export function pollEvery(progress: Progress, every = 256): () => void {
  let n = 0;
  return () => {
    if (++n % every === 0) progress.poll();
  };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  return `${m}m${String(sec).padStart(2, '0')}s`;
}

export function createProgress(options: ProgressOptions): Progress {
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const started = now();
  const ticking = options.intervalMs > 0;
  let nextTick = started + options.intervalMs;
  let finished = false;
  const active = new Map<symbol, { label: string; report?: () => string }>();

  const toFile = (line: string): void => {
    if (options.file === undefined) return;
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      appendFileSync(options.file, `${new Date(now()).toISOString()}  ${line}\n`);
    } catch {
      // Progress must never be the reason a command fails.
    }
  };
  const emit = (line: string): void => {
    if (options.quiet !== true) write(line);
    toFile(line);
  };

  toFile(`# ${options.command} started`);

  const poll = (): void => {
    if (!ticking || finished) return;
    const t = now();
    if (t < nextTick) return;
    // A tick that was missed (a long synchronous step) is not made up for.
    nextTick = t + options.intervalMs;
    const elapsed = formatDuration(t - started);
    const lines = [...active.values()]
      .filter((a) => a.report !== undefined)
      .map((a) => `${elapsed}  ${a.label}: ${a.report!()}`);
    if (lines.length === 0) lines.push(`${elapsed}  ${options.command}: still running`);
    for (const line of lines) emit(line);
  };

  const timer =
    ticking && options.timer !== false
      ? setInterval(poll, Math.min(1000, options.intervalMs))
      : undefined;
  timer?.unref();

  return {
    now,
    poll,
    activity(label) {
      const id = Symbol(label);
      const entry: { label: string; report?: () => string } = { label };
      active.set(id, entry);
      return {
        status(report) {
          entry.report = report;
        },
        done() {
          active.delete(id);
        },
      };
    },
    finish(exitCode = 0) {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearInterval(timer);
      emit(`done in ${formatDuration(now() - started)}${exitCode === 0 ? '' : ` (exit ${exitCode})`}`);
    },
  };
}
