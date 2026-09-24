/**
 * Rendering the load, for a terminal and for a file.
 *
 * A dry run writes `out/load-requests.json` holding the exact request bodies.
 * That file is the thing to read before executing: it is what will be sent,
 * byte for byte, not a summary of it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LoadResult } from './run.js';
import { stringifyArtefact } from '../model/artefact.js';

export function writeLoadArtefacts(outDir: string, result: LoadResult): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, result.executed ? 'load-result.json' : 'load-requests.json');

  writeFileSync(
    path,
    stringifyArtefact(
      result.executed
        ? {
            executed: true,
            prerequisites: result.prerequisites,
            stages: result.stages,
            summaries: result.summaries,
          }
        : {
            executed: false,
            // Before the request bodies, because they run before them and are
            // the part a reviewer cannot undo: a created channel stays in the
            // project whether or not the import that wanted it succeeds.
            prerequisites: result.prerequisites,
            containers: result.batches.containers,
            requests: result.batches.batches.map((b) => ({
              stage: b.stage,
              containerKey: b.containerKey,
              index: b.index,
              resourceKeys: b.resourceKeys,
              body: b.body,
            })),
          },
      {
        // A dry run's `load-requests.json` carries every request body, so it is
        // within a factor of the plan's size and hits the same ceiling.
        artefact: result.executed ? 'load-result.json' : 'load-requests.json',
        counts: {
          'request(s)': result.batches.batches.length,
          'resource(s)': result.batches.batches.reduce(
            (n, b) => n + b.resourceKeys.length,
            0,
          ),
          'container(s)': result.batches.containers.length,
        },
      },
    ),
  );
  return path;
}

export function renderLoad(result: LoadResult): string[] {
  const lines: string[] = [];

  // An executed run with no stages did not simply import nothing — it was
  // stopped, and the containers listed below are what it *would* have used.
  // Saying "Load executed" over that reads as success.
  const halted = result.executed && result.stages.length === 0;

  lines.push(
    halted
      ? 'LOAD STOPPED before the first import. See below.'
      : result.executed
        ? 'Load executed.'
        : 'DRY RUN — nothing was sent. Re-run with --execute to load.',
  );
  lines.push('');

  // Platform stages first, matching the order they run in. They are reported
  // separately because they are a different mechanism: created synchronously
  // through the platform API, with no container and no operation states.
  if (result.prerequisites.length > 0) {
    lines.push(
      result.executed
        ? 'Prerequisites (platform API — the Import API cannot create these):'
        : 'Prerequisites (platform API) — nothing was created:',
    );
    lines.push('');
    for (const p of result.prerequisites) {
      const bits: string[] = [];
      if (p.existing.length > 0) bits.push(`${p.existing.length} already present`);
      if (p.created.length > 0) {
        bits.push(
          result.executed
            ? `${p.created.length} created (${p.created.join(', ')})`
            : `${p.created.length} would be created (${p.created.join(', ')})`,
        );
      }
      if (p.unusable.length > 0) {
        bits.push(`${p.unusable.length} unusable as planned`);
      }
      if (p.unknown && p.unknown.length > 0) {
        bits.push(`${p.unknown.length} planned, existence unknown (read failed)`);
      }
      if (p.deferred && p.deferred.length > 0) {
        bits.push(`${p.deferred.length} not created (another stage was unreadable)`);
      }
      if (p.failed && p.failed.length > 0) {
        bits.push(`${p.failed.length} refused by the API (${p.failed.join(', ')})`);
      }
      lines.push(`  ${p.stage.padEnd(17)} ${bits.join(', ') || 'nothing to do'}`);
      for (const u of p.unusable) {
        lines.push(`      ${u.key}: ${u.reason} — not modified`);
      }
    }
    lines.push('');
  }

  lines.push(
    halted
      ? 'Containers that were planned (none was created):'
      : 'Containers (one per resource type, reused across runs):',
  );
  for (const container of result.batches.containers) {
    lines.push(
      `  ${container.key.padEnd(28)} ${container.resourceType.padEnd(17)} ` +
        `${container.operations} operation(s)`,
    );
  }
  lines.push('');

  lines.push(halted ? 'Requests (none sent):' : 'Requests:');
  for (const stage of result.stages) {
    const detail = result.executed
      ? `${stage.accepted}/${stage.requests} accepted` +
        (stage.failed.length > 0 ? `, ${stage.failed.length} failed` : '')
      : `${stage.requests} request(s)`;
    lines.push(
      `  ${stage.stage.padEnd(17)} ${String(stage.resources).padStart(6)} resource(s)  ${detail}`,
    );
  }
  lines.push('');

  if (result.summaries.length > 0) {
    // Per container, not per run. Import Operations accumulate in a container
    // and are retained 48 hours, so a container loaded three times shows three
    // times the operations — and a failure from an earlier attempt is still
    // counted here after a later one succeeded.
    lines.push('Operation states (per container, cumulative over 48h — not just this run):');
    lines.push('');
    lines.push('| Container | total | imported | processing | unresolved | rejected | failed |');
    lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const { containerKey, summary } of result.summaries) {
      const s = summary.states;
      lines.push(
        `| \`${containerKey}\` | ${summary.total} | ${s.imported} | ${s.processing} | ` +
          `${s.unresolved} | ${s.rejected} | ${s.validationFailed} |`,
      );
    }
    lines.push('');
  }

  return lines;
}
