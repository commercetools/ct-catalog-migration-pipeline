/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 *   npm run build
 *   SHOPIFY_ADMIN_TOKEN=... node dist/examples/shopify/cli.js extract \
 *     --shop <name>.myshopify.com --api-version <YYYY-MM> --out <export-dir>
 *   node dist/examples/shopify/cli.js adapt \
 *     --export <export-dir> --options <adapter-options.json> --out <feed-dir> [--report <file>]
 *
 * `extract` reads the shop (read-only) into <export-dir>. `adapt` writes
 * <feed-dir>/catalog.ndjson and the report (default: adapter-report.json next
 * to the feed directory). Either exits 1 with the reason when it stops.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { makePrivateDir, writePrivateFile } from '../../model/private-file.js';
import { AdapterStop, EXAMPLE_NOTICE, convert, type AdapterOptions } from './adapter.js';
import { readExport } from './export.js';
import { ExtractStop, extract } from './extract.js';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'extract') {
    const { values } = parseArgs({
      args: rest,
      options: { shop: { type: 'string' }, 'api-version': { type: 'string' }, out: { type: 'string' } },
      strict: true,
    });
    if (!values.shop || !values['api-version'] || !values.out) {
      throw new ExtractStop('Usage: extract --shop <name>.myshopify.com --api-version <YYYY-MM> --out <export-dir> (token in SHOPIFY_ADMIN_TOKEN)');
    }
    const counts = await extract({ domain: values.shop, token: process.env.SHOPIFY_ADMIN_TOKEN ?? '', apiVersion: values['api-version'], out: resolve(values.out) });
    process.stdout.write(`${JSON.stringify(counts)}\n`);
    return;
  }
  if (command === 'adapt') {
    const { values } = parseArgs({
      args: rest,
      options: { export: { type: 'string' }, options: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' } },
      strict: true,
    });
    if (!values.export || !values.options || !values.out) {
      throw new AdapterStop('Usage: adapt --export <export-dir> --options <file> --out <feed-dir> [--report <file>]');
    }
    process.stderr.write(`NOTE: ${EXAMPLE_NOTICE}\n`);
    const options = JSON.parse(readFileSync(values.options, 'utf8')) as AdapterOptions;
    const { records, report } = convert(readExport(resolve(values.export)), options);
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
    return;
  }
  throw new AdapterStop('Usage: cli.js extract ... | adapt ...  (see README.md)');
}

main().catch((error: unknown) => {
  const stop = error instanceof AdapterStop || error instanceof ExtractStop;
  process.stderr.write(`${stop ? 'STOP' : 'ERROR'}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
