/**
 * A fingerprint of the feed a plan was built from.
 *
 * `audit` reads the plan from disk rather than from the mapper's memory, which
 * is deliberate — it checks what will actually be sent, and it keeps working
 * on a hand-edited or replayed plan. But it also means the plan and the feed
 * can disagree, and nothing noticed.
 *
 * A dogfood run found the failure shape: `plan` failed and wrote nothing,
 * leaving the previous run's `plan.json` in place, and `audit` then reported
 * **zero errors** against a plan that no longer matched the feed. The feed had
 * a duplicate SKU — precisely the invariant the gate exists to catch. A false
 * pass in the gate whose whole purpose is preventing false passes.
 *
 * Neither the fixtures nor a live project could surface that, because both
 * always run the stages in order. It took a *failed* intermediate stage.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { feedFiles, type Diagnostic } from './validate.js';

/**
 * Hashes the same files `validate` reads, in the same order.
 *
 * File *names* are hashed alongside contents, so renaming or splitting a feed
 * file changes the digest even when the records are identical — the record set
 * is what matters to the plan, but a rename is a change to the thing the plan
 * claims provenance from, and claiming otherwise would be a lie about what was
 * checked.
 *
 * Paths are reduced to their basenames so a feed moved between directories —
 * or the same feed read through a different relative path — keeps its digest.
 * The plan is portable; its provenance should be too.
 */
export function feedDigest(feedDir: string): string {
  const hash = createHash('sha256');
  for (const file of feedFiles(feedDir)) {
    hash.update(basename(file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Whether a plan read from disk still describes the feed on disk.
 *
 * Three outcomes, and the middle one is the reason this exists:
 *
 * - **match** — nothing to say.
 * - **mismatch** — an error. The plan was built from different feed content,
 *   so every gate check ran against data that will not be sent. `plan` failing
 *   and leaving the previous file behind is the common cause, and it is silent.
 * - **absent** — a warning, not an error. A plan written by hand or by an
 *   older build carries no digest, and refusing those outright would break a
 *   legitimate workflow the audit gate explicitly supports. But it cannot be
 *   called fresh either, so it is reported as unknown.
 *
 * A feed that cannot be read at all is left to the caller: `audit` already
 * fails loudly on an unreadable feed elsewhere, and duplicating that here
 * would report the same problem twice in different words.
 */
export function checkPlanFreshness(
  plan: { provenance?: { feedDigest: string; generatedAt: string } },
  feedDir: string,
  stage: string,
): Diagnostic[] {
  if (!plan.provenance) {
    return [
      {
        severity: 'warning',
        code: 'plan-provenance-unknown',
        message:
          'This plan carries no record of the feed it was built from, so ' +
          `\`${stage}\` cannot tell whether it is still current.\n` +
          '      Written by hand, or by a build before provenance existed. Re-run ' +
          '`plan` to stamp it.',
      },
    ];
  }

  let actual: string;
  try {
    actual = feedDigest(feedDir);
  } catch {
    // Unreadable or empty feed. Reported by the stage that actually needs to
    // read it, in its own terms.
    return [];
  }

  if (actual === plan.provenance.feedDigest) return [];

  return [
    {
      severity: 'error',
      code: 'plan-stale',
      message:
        `The plan does not match the feed. \`${stage}\` refuses rather than checking ` +
        'the wrong data.\n' +
        `      plan built from  ${plan.provenance.feedDigest}  at ${plan.provenance.generatedAt}\n` +
        `      feed is now      ${actual}\n` +
        '      The usual cause is a `plan` run that failed and left the previous ' +
        "plan.json in place. Every gate check would then pass or fail against a plan " +
        'nobody is going to load — a green audit over data that no longer exists.\n' +
        '      Re-run `plan`, then this stage.',
    },
  ];
}
