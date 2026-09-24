/**
 * Keys, slugs and order hints — everything that has to be deterministic.
 *
 * Determinism is what makes the load re-runnable, the teardown bounded, and the
 * delta computable without a lookup table. Anything here that depended on feed
 * order or on a hash of mutable data would break all three.
 */

import type { LocalizedString } from '../model/feed.js';

/** commercetools slug and key pattern: [A-Za-z0-9_-], 2-256 characters. */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{2,256}$/;

/**
 * `<prefix>-<sourceCode>`.
 *
 * The prefix is what lets a teardown scope itself to data this migration
 * created, so it can never touch records the project already held.
 */
export function resourceKey(prefix: string, sourceCode: string): string {
  return `${prefix}-${sourceCode}`;
}

export function isValidKey(key: string): boolean {
  return SLUG_PATTERN.test(key);
}

/**
 * Turns arbitrary text into a slug-safe ASCII string.
 *
 * Diacritics are decomposed and stripped rather than dropped wholesale, so
 * "Oberbekleidung für Männer" keeps its letters instead of collapsing to a run
 * of dashes. German sharp s is special-cased because NFD does not decompose it.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/ß/g, 'ss')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 256);
}

export interface SlugOutcome {
  slug: LocalizedString;
  /** Locales where the slug had to be derived because none was supplied. */
  derived: string[];
  /** Locales where a collision forced a suffix, with the resulting slug. */
  disambiguated: { locale: string; slug: string }[];
}

/**
 * Allocates a unique slug per locale.
 *
 * Slugs are unique across the whole Project per locale — the same slug may be
 * reused for *different* locales of the same resource, but not by two
 * resources. Retail taxonomies reuse names freely ("Accessories" under both
 * Menswear and Womenswear), so collisions are normal and have to be resolved
 * rather than reported and abandoned.
 *
 * The suffix is the source code, not a counter, so the resulting slug stays
 * traceable back to the record that produced it.
 */
export function allocateSlug(
  sourceCode: string,
  name: LocalizedString,
  supplied: LocalizedString | undefined,
  locales: string[],
  taken: Map<string, Set<string>>,
): SlugOutcome {
  const slug: LocalizedString = {};
  const derived: string[] = [];
  const disambiguated: { locale: string; slug: string }[] = [];

  for (const locale of locales) {
    const provided = supplied?.[locale];
    let base = provided ? slugify(provided) : '';

    if (!base) {
      base = slugify(name[locale] ?? '');
      if (base) derived.push(locale);
    }

    // Names can be non-Latin, punctuation-only, or a single character. The
    // source code is the only thing guaranteed to be slug-safe.
    if (base.length < 2) {
      base = slugify(sourceCode);
      if (!derived.includes(locale)) derived.push(locale);
    }
    if (base.length < 2) base = `x-${slugify(sourceCode)}`.slice(0, 256);

    let used = taken.get(locale);
    if (!used) {
      used = new Set();
      taken.set(locale, used);
    }

    let candidate = base;
    if (used.has(candidate)) {
      candidate = truncateTo(`${base}-${slugify(sourceCode)}`, 256);
      let counter = 2;
      while (used.has(candidate)) {
        candidate = truncateTo(`${base}-${slugify(sourceCode)}`, 256 - 4) + `-${counter}`;
        counter++;
      }
      disambiguated.push({ locale, slug: candidate });
    }

    used.add(candidate);
    slug[locale] = candidate;
  }

  return { slug, derived, disambiguated };
}

function truncateTo(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).replace(/-+$/, '');
}

/**
 * Encodes a 1-based sibling position as a commercetools order hint.
 *
 * An order hint is a string holding a decimal strictly between 0 and 1 that
 * must not end in `0`. Both halves of that matter:
 *
 * - Zero-padding to a fixed width is what makes the strings sort in the same
 *   order as the positions they encode.
 * - Padding alone produces values like `0.10`, which end in zero and are
 *   rejected, so a non-zero terminal digit is appended. Because every value has
 *   the same width, appending it cannot change the relative order.
 */
export function orderHint(position: number, siblingCount: number): string {
  const width = String(Math.max(siblingCount, 1)).length;
  const padded = String(position).padStart(width, '0');
  return `0.${padded}1`;
}

/**
 * Picks the master variant deterministically.
 *
 * Every product has exactly one master variant, and it is what a storefront
 * shows by default. If the choice depended on feed order it would drift between
 * runs, silently changing the default variant of every product — so an explicit
 * claim wins, and otherwise the lowest SKU does.
 */
export function chooseMasterSku(
  skus: string[],
  claimed: string | undefined,
): { sku: string; byFallback: boolean } {
  if (claimed && skus.includes(claimed)) {
    return { sku: claimed, byFallback: false };
  }
  const sorted = [...skus].sort();
  return { sku: sorted[0], byFallback: true };
}
