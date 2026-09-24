/**
 * Platform limits needed by more than one stage.
 *
 * A limit enforced by exactly one stage stays with that stage. These are here
 * because two stages have to agree on them: `validate` reports the variant
 * ceiling against the feed, so a catalog that cannot fit the configured
 * catalog model says so before anything is derived or planned, and the audit
 * gate re-checks it against the written plan.
 *
 * Verified against public documentation in September 2026. Re-check before
 * relying on any of it: limits move.
 */

/** Variants per Product in the Classic catalog model. */
export const MAX_VARIANTS_CLASSIC = 100;

/**
 * Variants per Product in the Modular catalog model, where variants are
 * standalone resources. Quoted in diagnostics so a catalog that overflows
 * Classic learns what the alternative actually buys.
 */
export const MAX_VARIANTS_MODULAR = 10_000;

/** Warn before the Classic cap, so a catalog that grows does not hit it. */
export const VARIANT_WARN_THRESHOLD = 80;

/**
 * The catalog model a catalog's largest product requires.
 *
 * Purely a function of variant counts, which is why `validate` can answer it
 * from the feed alone — no credentials, no plan. A greenfield project can be
 * switched between models with one `setProductCatalogModel` action, so this is
 * a decision the data should inform rather than one to guess at in config.
 */
export function requiredCatalogModel(maxVariantsPerProduct: number): 'Classic' | 'Modular' {
  return maxVariantsPerProduct > MAX_VARIANTS_CLASSIC ? 'Modular' : 'Classic';
}
