/**
 * Writing artefacts that can outgrow a JavaScript string.
 *
 * `JSON.stringify` has to materialise its whole result as one string, and V8
 * caps strings at `buffer.constants.MAX_STRING_LENGTH` — 536,870,888 bytes on
 * 64-bit Node 20. Past that it throws `RangeError: Invalid string length`
 * **regardless of available memory**: an 8 GB heap does not help, because the
 * limit is on the string, not the heap.
 *
 * Measured on this pipeline: a plan costs roughly 0.9 KB per variant for a
 * catalog with two product-level attributes, and **4.2 KB per variant** for one
 * with twenty-five — because `productLevelStrategy: sameForAll` states a
 * product attribute once in the feed and replicates it onto every variant in
 * the plan, a 15× amplification from feed to plan. So the ceiling is somewhere
 * between about 125,000 and 575,000 variants depending on how attribute-heavy
 * the catalog is.
 *
 * Without this wrapper the failure is the five-word message `Invalid string
 * length`, printed by the top-level handler after a long successful run on the
 * largest and most expensive catalog anyone has tried. That is the worst
 * possible moment for a message that says nothing.
 */

import { constants } from 'node:buffer';

export interface ArtefactScale {
  /** e.g. `plan.json`. Named in the message. */
  artefact: string;
  /** Resource counts, largest first, for the "why" half of the message. */
  counts: Record<string, number>;
}

/**
 * `JSON.stringify`, with the size ceiling explained if it is hit.
 *
 * Deliberately not a streaming writer. Streaming would remove the ceiling
 * altogether, but it changes the shape of a documented artefact that the
 * freshness digest, the round-trip test and the dry-run review all depend on —
 * so it is worth doing when an engagement actually needs it, not before.
 * Until then, failing clearly is the honest behaviour.
 */
export function stringifyArtefact(value: unknown, scale: ArtefactScale): string {
  try {
    return JSON.stringify(value, null, 2) + '\n';
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;

    const counted = Object.entries(scale.counts)
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([kind, n]) => `${n.toLocaleString('en-GB')} ${kind}`)
      .join(', ');
    const limitMb = Math.round(constants.MAX_STRING_LENGTH / 1e6);

    throw new Error(
      `${scale.artefact} is too large to write as a single JSON document.\n\n` +
        `  this plan holds  ${counted || 'an unknown number of resources'}\n` +
        `  the limit is     ${limitMb} MB, V8's maximum string length\n\n` +
        'This is not a memory problem and more RAM will not fix it: ' +
        '`JSON.stringify` must build the whole document as one string, and a string ' +
        'cannot exceed that size.\n\n' +
        'A plan costs roughly 4 KB per variant for an attribute-heavy catalog, because a ' +
        'product-level attribute is stated once in the feed and written onto every ' +
        'variant in the plan. That puts the ceiling near 125,000 variants; a catalog with ' +
        'few attributes reaches about 575,000.\n\n' +
        'Until the artefacts are written incrementally, the way through is to split the ' +
        'engagement: several configs with different `keys.prefix` values, each covering ' +
        'part of the catalog. Each plan is then its own document, and the load is still ' +
        'additive.',
    );
  }
}
