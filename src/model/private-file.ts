/**
 * Writing into `out/` so that only the owner can read it.
 *
 * Once customers or orders are in scope, `plan.json`, `load-requests.json` and
 * the result files hold names, email addresses and postal addresses. Written
 * with Node's defaults they come out `0644`, readable by every account on the
 * machine. So every file the pipeline writes is `0600`, and a directory it
 * creates is `0700`.
 *
 * The mode option of `writeFileSync` and `appendFileSync` applies only when the
 * file is created, and a run usually overwrites the files of the last one, so
 * the mode is set again after each write.
 *
 * A directory that already exists keeps its mode. `--out` can name any
 * directory, a shared one included, and quietly locking down a directory the
 * reader chose is not this module's call; the files inside are protected
 * either way, and a readable directory shows only their names.
 *
 * On Windows `chmod` only toggles the read-only flag, so these calls leave the
 * files writable and change nothing else.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** Create `dir` (and missing parents) owner-only; an existing one is left as it is. */
export function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

export function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

export function appendPrivateFile(path: string, data: string): void {
  appendFileSync(path, data, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}
