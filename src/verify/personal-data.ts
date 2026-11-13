/**
 * The reminder a clean `verify` prints when the plan carried customers or orders.
 *
 * After a load, the personal data also sits on this machine: in the feed, in
 * `plan.json` and in the request and result files of the load. Nothing else in
 * the pipeline ever says when those copies have served their purpose, and a
 * verified load is the first point at which they may have. The files are not
 * deleted here, because `teardown` reads `plan.json` and a trial load may still
 * need removing; the reader decides when.
 */

import { join, relative } from 'node:path';

export function personalDataReminder(
  checked: { customers: number; orders: number },
  feedDir: string,
  outDir: string,
): string[] {
  const kinds = [
    checked.customers > 0 ? 'customers' : undefined,
    checked.orders > 0 ? 'orders' : undefined,
  ].filter((k): k is string => k !== undefined);
  if (kinds.length === 0) return [];

  const shown = (p: string): string => relative(process.cwd(), p) || '.';
  return [
    `Personal data: the ${kinds.join(' and ')} of this plan are also held on this machine, in`,
    `  ${shown(feedDir)}/  (the feed)`,
    `  ${shown(join(outDir, 'plan.json'))}`,
    `  ${shown(outDir)}/load-requests*.json and load-result*.json`,
    'and in the source export. Delete them once the migration no longer needs them;',
    'keep plan.json until any trial load is torn down, because teardown reads it.',
  ];
}
