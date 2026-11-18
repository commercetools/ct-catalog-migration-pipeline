/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 *   npm run build
 *   node dist/examples/magento/cli.js --snapshot <dump.sql[.gz] | table-dir> \
 *     --options <adapter-options.json> --out <feed-dir> [--report <file>]
 *
 * Writes <feed-dir>/catalog.ndjson and the report (default: adapter-report.json
 * next to the feed directory). Exits 1 with the reason when the adapter stops.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { makePrivateDir, writePrivateFile } from '../../model/private-file.js';
import { AdapterStop, EXAMPLE_NOTICE, OPTIONAL_TABLES, REQUIRED_TABLES, convert, type AdapterOptions } from './adapter.js';
import { readSnapshot } from './tables.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      options: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
    },
    strict: true,
  });
  if (!values.snapshot || !values.options || !values.out) {
    throw new AdapterStop('Usage: --snapshot <dump.sql[.gz] | table-dir> --options <file> --out <feed-dir> [--report <file>]');
  }
  process.stderr.write(`NOTE: ${EXAMPLE_NOTICE}\n`);

  const options = JSON.parse(readFileSync(values.options, 'utf8')) as AdapterOptions;
  const tables = await readSnapshot(values.snapshot, new Set<string>([...REQUIRED_TABLES, ...OPTIONAL_TABLES]));
  const { records, report } = convert(tables, options);

  const out = resolve(values.out);
  makePrivateDir(out);
  writePrivateFile(join(out, 'catalog.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const reportPath = resolve(values.report ?? join(dirname(out), 'adapter-report.json'));
  writePrivateFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  process.stdout.write(`${JSON.stringify(report.counts)}\n`);
  for (const bucket of ['decisions', 'losses'] as const) {
    for (const [key, entry] of Object.entries(report[bucket])) {
      process.stdout.write(`${bucket}: ${key}: ${entry.count}${entry.examples.length ? `  e.g. ${entry.examples.slice(0, 2).join(' | ')}` : ''}\n`);
    }
  }
  process.stdout.write(`Report: ${reportPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof AdapterStop ? 'STOP' : 'ERROR'}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
