/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 * Reads Magento tables from a snapshot, in one of two shapes:
 *
 * - a mysqldump file (`.sql` or `.sql.gz`): what a DBA or `ece-tools db-dump`
 *   hands over;
 * - a directory of `<table>.ndjson` files, one row per line: what a session
 *   writes when it copies the tables itself through a read-only login.
 *
 * Both readers return every non-NULL value as a string, exactly as the source
 * wrote it. That keeps a DECIMAL's digits intact (money never passes through a
 * float) and makes the two shapes interchangeable: the mapping parses numbers
 * where it means to, and nowhere else.
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

export type Row = Record<string, string | null>;
export type Tables = Map<string, Row[]>;

/** Reads only the tables named in `wanted`; every other table is skipped unparsed. */
export async function readSnapshot(path: string, wanted: ReadonlySet<string>): Promise<Tables> {
  if (!existsSync(path)) throw new Error(`Snapshot not found: ${path}`);
  return statSync(path).isDirectory() ? readNdjsonDir(path, wanted) : readMysqlDump(path, wanted);
}

// ---------------------------------------------------------------- NDJSON

function readNdjsonDir(dir: string, wanted: ReadonlySet<string>): Tables {
  const tables: Tables = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ndjson')) continue;
    const table = file.slice(0, -'.ndjson'.length);
    if (!wanted.has(table)) continue;
    const rows: Row[] = [];
    const text = readFileSync(join(dir, file), 'utf8');
    let lineNo = 0;
    for (const line of text.split('\n')) {
      lineNo++;
      if (line.trim() === '') continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const row: Row = {};
      for (const [column, value] of Object.entries(parsed)) {
        row[column] = ndjsonValue(value, `${file}:${lineNo} column ${column}`);
      }
      rows.push(row);
    }
    tables.set(table, rows);
  }
  return tables;
}

function ndjsonValue(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    // A DECIMAL written as a JSON number may already have lost digits on the
    // way out, and nothing here could tell. Integers are safe; anything else
    // means the copy script should write decimals as strings.
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${where}: the non-integer number ${value} cannot be trusted to carry its exact digits. ` +
          'Write DECIMAL and FLOAT columns as strings when copying the tables.',
      );
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  throw new Error(`${where}: unexpected ${typeof value} value`);
}

// ---------------------------------------------------------------- mysqldump

/**
 * mysqldump writes each CREATE TABLE over several lines and each INSERT on one
 * line (string values escape their newlines), so the dump is read line by line
 * and only the INSERT lines of wanted tables are tokenised. A dump of a whole
 * shop can be many gigabytes; this never holds more than the wanted tables.
 */
async function readMysqlDump(path: string, wanted: ReadonlySet<string>): Promise<Tables> {
  const raw = createReadStream(path);
  const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const lines = createInterface({ input, crlfDelay: Infinity });

  const tables: Tables = new Map();
  const columnsOf = new Map<string, string[]>();
  let creating: { table: string; columns: string[] } | null = null;
  let lineNo = 0;

  for await (const line of lines) {
    lineNo++;
    if (creating) {
      const column = /^\s+`([^`]+)`\s/.exec(line);
      if (column) creating.columns.push(column[1]);
      else if (line.startsWith(')')) {
        columnsOf.set(creating.table, creating.columns);
        creating = null;
      }
      continue;
    }
    const create = /^CREATE TABLE `([^`]+)` \($/.exec(line);
    if (create) {
      creating = { table: create[1], columns: [] };
      continue;
    }
    const insert = /^(?:INSERT|REPLACE)(?: IGNORE)? INTO `([^`]+)`\s*(\([^)]*\))?\s*VALUES\s*/.exec(line);
    if (!insert) continue;
    const table = insert[1];
    if (!wanted.has(table)) continue;

    const columns = insert[2]
      ? [...insert[2].matchAll(/`([^`]+)`/g)].map((m) => m[1])
      : columnsOf.get(table);
    if (!columns) {
      throw new Error(
        `${path}:${lineNo}: INSERT into ${table} without a column list, and no CREATE TABLE for it ` +
          'earlier in the dump. Dump with the table definitions (no --no-create-info), or with --complete-insert.',
      );
    }
    const rows = tables.get(table) ?? [];
    for (const tuple of parseValues(line, insert[0].length, `${path}:${lineNo}`)) {
      if (tuple.length !== columns.length) {
        throw new Error(`${path}:${lineNo}: a row of ${table} has ${tuple.length} values for ${columns.length} columns`);
      }
      const row: Row = {};
      columns.forEach((column, i) => (row[column] = tuple[i]));
      rows.push(row);
    }
    tables.set(table, rows);
  }
  if (creating) throw new Error(`${path}: the dump ends inside CREATE TABLE ${creating.table}; it is truncated`);
  // A wanted table the dump defines but holds no rows for is present and empty,
  // which is different from missing: the caller decides what missing means.
  for (const table of wanted) if (columnsOf.has(table) && !tables.has(table)) tables.set(table, []);
  return tables;
}

/** Parses `(v,v,...),(v,...);` starting at `start`. Unquoted tokens are kept as written. */
export function parseValues(line: string, start: number, where: string): (string | null)[][] {
  const tuples: (string | null)[][] = [];
  let i = start;
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what} at character ${i}`);
  };
  for (;;) {
    if (line[i] !== '(') fail(`expected "(" but found "${line[i] ?? 'end of line'}"`);
    i++;
    const tuple: (string | null)[] = [];
    for (;;) {
      if (line[i] === "'") {
        let value = '';
        i++;
        for (;;) {
          const c = line[i];
          if (c === undefined) fail('unterminated string');
          if (c === '\\') {
            const n = line[i + 1];
            value += ESCAPES[n] ?? n;
            i += 2;
          } else if (c === "'") {
            if (line[i + 1] === "'") {
              value += "'";
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            value += c;
            i++;
          }
        }
        tuple.push(value);
      } else {
        const end = nextDelimiter(line, i);
        const token = line.slice(i, end).trim();
        if (token === '') fail('empty value');
        if (token.startsWith('_binary')) {
          fail(
            'a binary column dumped without --hex-blob, whose bytes cannot be read back as text; ' +
              're-dump with --hex-blob',
          );
        }
        tuple.push(token === 'NULL' ? null : token);
        i = end;
      }
      if (line[i] === ',') {
        i++;
        continue;
      }
      if (line[i] === ')') {
        i++;
        break;
      }
      fail(`expected "," or ")" but found "${line[i] ?? 'end of line'}"`);
    }
    tuples.push(tuple);
    if (line[i] === ',') {
      i++;
      continue;
    }
    if (line[i] === ';') return tuples;
    fail(`expected "," or ";" after a row but found "${line[i] ?? 'end of line'}"`);
  }
}

const ESCAPES: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

function nextDelimiter(line: string, from: number): number {
  let i = from;
  while (i < line.length && line[i] !== ',' && line[i] !== ')') i++;
  return i;
}
