/**
 * ProductType derivation.
 *
 * Two paths, and the difference matters:
 *
 * - **Declared.** The feed carries `attributeDefinition` records because the
 *   source has a type system. Derivation is a translation, and every choice has
 *   a defensible origin.
 * - **Inferred.** The feed carries none, so definitions are reconstructed from
 *   observed values. This is a fallback: it guesses, so every guess is recorded
 *   with `review: true` and has to be signed off before loading.
 *
 * Inference reads *values*, never field names. Deciding "these four fields are
 * dates" from a name allowlist fails silently on the next export — the value
 * lands as the wrong JSON type and commercetools rejects the whole record with
 * a terse error.
 */

import type { PipelineConfig } from '../model/config.js';
import type {
  AttributeValue,
  CatalogFeed,
  FeedAttributeDefinition,
  LocalizedString,
} from '../model/feed.js';
import type {
  AttributeConstraintEnum,
  AttributeDefinition,
  AttributeLevel,
  AttributeType,
  DerivedModel,
  MappingDecision,
  ProductTypeImport,
  TextInputHint,
} from '../model/plan.js';
import type { Diagnostic } from '../contract/validate.js';
import { attributeDefinitionsOf } from '../model/plan.js';
import { resourceKey } from '../map/identity.js';

/** Soft project limit; exceeding it needs a performance review with support. */
const MAX_PRODUCT_TYPES = 1000;

/** Beyond this many characters a text attribute is easier to edit multi-line. */
const MULTILINE_THRESHOLD = 120;

/** Above this cardinality a low-cardinality string stops looking like an enum. */
const ENUM_CANDIDATE_MAX_DISTINCT = 20;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface DeriveResult extends DerivedModel {
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

type ValueKind = 'boolean' | 'number' | 'localized' | 'set' | 'string';

interface Observation {
  name: string;
  /** Which levels the value was seen at. More than one is a conflict. */
  levels: Set<'product' | 'variant'>;
  /** True when at least one product uses it as a variant axis. */
  isAxis: boolean;
  /** Products using it as an axis, and products not — both non-empty is a conflict. */
  axisIn: string[];
  nonAxisIn: string[];
  kinds: Set<ValueKind>;
  /** Distinct scalar values, for enum candidacy and date detection. */
  distinct: Set<string>;
  /** Observed keys for an axis, with a label if one was supplied. */
  axisKeys: Map<string, LocalizedString | undefined>;
  /**
   * Every distinct label seen for each axis key, serialised for comparison.
   *
   * `axisKeys` keeps the first and discards the rest, which is a defensible
   * choice but was a silent one — and "first" is decided by feed line order,
   * so the winner could change when the adapter reordered its output. One
   * source legitimately carried two display labels for a shared key.
   */
  axisLabelVariants: Map<string, Set<string>>;
  occurrences: number;
  /** Holders (products or variants) that actually set a value. */
  populated: number;
  maxLength: number;
  hasNewline: boolean;
  /** Element kinds, when the value was an array. */
  elementKinds: Set<ValueKind>;
}

function newObservation(name: string): Observation {
  return {
    name,
    levels: new Set(),
    isAxis: false,
    axisIn: [],
    nonAxisIn: [],
    kinds: new Set(),
    distinct: new Set(),
    axisKeys: new Map(),
    axisLabelVariants: new Map(),
    occurrences: 0,
    populated: 0,
    maxLength: 0,
    hasNewline: false,
    elementKinds: new Set(),
  };
}

function kindOf(value: AttributeValue): ValueKind {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'set';
  if (value !== null && typeof value === 'object') return 'localized';
  return 'string';
}

function record(obs: Observation, value: AttributeValue): void {
  obs.occurrences++;
  const kind = kindOf(value);
  obs.kinds.add(kind);

  if (kind === 'string') {
    const s = value as string;
    if (s !== '') obs.populated++;
    obs.distinct.add(s);
    obs.maxLength = Math.max(obs.maxLength, s.length);
    if (s.includes('\n')) obs.hasNewline = true;
    return;
  }

  if (kind === 'localized') {
    const map = value as LocalizedString;
    const texts = Object.values(map);
    if (texts.some((t) => t !== '')) obs.populated++;
    for (const t of texts) {
      obs.maxLength = Math.max(obs.maxLength, t.length);
      if (t.includes('\n')) obs.hasNewline = true;
    }
    return;
  }

  if (kind === 'set') {
    const arr = value as (string | number | boolean)[];
    if (arr.length > 0) obs.populated++;
    for (const el of arr) {
      obs.elementKinds.add(kindOf(el));
      if (typeof el === 'string') {
        obs.distinct.add(el);
        obs.maxLength = Math.max(obs.maxLength, el.length);
      }
    }
    return;
  }

  // boolean, number
  obs.populated++;
  obs.distinct.add(String(value));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Products group into ProductTypes by their declared `productType`, falling
 * back to the configured default.
 *
 * A ProductType per product is a modelling mistake — it defeats the point of a
 * shared blueprint and burns through the 1000-type project limit — so the
 * grouping never invents keys.
 */
function groupProducts(
  feed: CatalogFeed,
  config: PipelineConfig,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const product of feed.products.values()) {
    const key = product.productType ?? config.productTypes.defaultKey;
    const members = groups.get(key) ?? [];
    members.push(product.code);
    groups.set(key, members);
  }
  return groups;
}

function observeGroup(feed: CatalogFeed, productCodes: string[]): Map<string, Observation> {
  const observations = new Map<string, Observation>();
  const get = (name: string) => {
    let obs = observations.get(name);
    if (!obs) {
      obs = newObservation(name);
      observations.set(name, obs);
    }
    return obs;
  };

  for (const code of productCodes) {
    const product = feed.products.get(code);
    if (!product) continue;

    const axes = product.axes ?? [];
    for (const axis of axes) {
      const obs = get(axis);
      obs.isAxis = true;
      obs.levels.add('variant');
      obs.axisIn.push(code);
    }

    for (const [name, value] of Object.entries(product.attributes ?? {})) {
      const obs = get(name);
      obs.levels.add('product');
      if (!axes.includes(name)) obs.nonAxisIn.push(code);
      record(obs, value);
    }

    for (const sku of feed.variantsByProduct.get(code) ?? []) {
      const variant = feed.variants.get(sku);
      if (!variant) continue;

      for (const [axis, key] of Object.entries(variant.axisValues ?? {})) {
        if (!axes.includes(axis)) continue;
        const obs = get(axis);
        obs.occurrences++;
        obs.populated++;
        obs.kinds.add('string');
        obs.distinct.add(key);
        const label = variant.axisLabels?.[axis];
        if (!obs.axisKeys.has(key)) {
          obs.axisKeys.set(key, label);
        }
        if (label !== undefined) {
          // Sorted keys so two equal labels written in a different order are
          // not mistaken for a conflict.
          const rendered = JSON.stringify(
            Object.fromEntries(Object.entries(label).sort(([a], [b]) => a.localeCompare(b))),
          );
          const seen = obs.axisLabelVariants.get(key) ?? new Set<string>();
          seen.add(rendered);
          obs.axisLabelVariants.set(key, seen);
        }
      }

      for (const [name, value] of Object.entries(variant.attributes ?? {})) {
        const obs = get(name);
        obs.levels.add('variant');
        if (!axes.includes(name)) obs.nonAxisIn.push(code);
        record(obs, value);
      }
    }
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

/**
 * Builds an `enum` or `lenum` type, resolving every value's display label.
 *
 * All four ways a label can be under-specified used to be handled differently,
 * and three of them put the text somewhere nobody asked for:
 *
 * - a declared `lenum` value with no label became `label: {}` — blank in every
 *   locale, silently, which is how a dogfood run got a value with no display
 *   text anywhere;
 * - a declared `lenum` value with a plain-string label became `{ und: … }`, and
 *   `und` is never one of a project's configured languages, so the label was
 *   unreachable;
 * - a `lenum` built from *observed* values fell back to a hardcoded `'en'`,
 *   which is wrong for any project that does not happen to list it;
 * - a declared `enum` given a localized object took `Object.values(...)[0]`,
 *   an arbitrary locale decided by JSON key order.
 *
 * One rule now: the key doubles as the label, in the **default locale**, and a
 * derived label is recorded as a decision rather than applied quietly. Losing
 * a display label is small, but it is still information loss, and this pipeline
 * reports rather than absorbs.
 */
function enumType(
  kind: 'enum' | 'lenum',
  values: { key: string; label?: string | LocalizedString }[],
  locale: string,
  subject: string,
  decisions: MappingDecision[],
): AttributeType {
  const derived: string[] = [];
  const nonDefaultLocale: string[] = [];

  const resolved = values.map((v) => {
    const label = v.label;

    if (kind === 'lenum') {
      if (typeof label === 'string') {
        // A plain string on a localized enum is the adapter saying "one
        // language"; the default locale is the only defensible one to pick.
        return { key: v.key, label: { [locale]: label } as LocalizedString };
      }
      if (label && Object.keys(label).length > 0) {
        return { key: v.key, label };
      }
      derived.push(v.key);
      return { key: v.key, label: { [locale]: v.key } as LocalizedString };
    }

    if (typeof label === 'string') return { key: v.key, label };
    if (label && Object.keys(label).length > 0) {
      // A localized object on a plain enum has to collapse to one string.
      // Prefer the default locale; picking by key order would make the output
      // depend on how the adapter happened to serialise its JSON.
      const preferred = label[locale];
      if (preferred !== undefined) return { key: v.key, label: preferred };
      const [fallbackLocale, fallbackLabel] = Object.entries(label)[0]!;
      nonDefaultLocale.push(`${v.key} (${fallbackLocale})`);
      return { key: v.key, label: fallbackLabel };
    }
    derived.push(v.key);
    return { key: v.key, label: v.key };
  });

  if (derived.length > 0) {
    decisions.push({
      subject,
      outcome: `${derived.length} value label(s) derived from the key`,
      rationale:
        `No label was supplied for ${derived.join(', ')}, so the key doubles as the ` +
        `display text in '${locale}'. Merchandisers see the raw code in the Merchant ` +
        'Center — supply labels in the adapter to fix that.',
      lossy: true,
      review: true,
    });
  }
  if (nonDefaultLocale.length > 0) {
    decisions.push({
      subject,
      outcome: `${nonDefaultLocale.length} value label(s) taken from a non-default locale`,
      rationale:
        `A plain enum holds one label per value, and '${locale}' was not among those ` +
        `supplied for ${nonDefaultLocale.join(', ')}. Declare the attribute as lenum to ` +
        'keep every locale.',
      lossy: true,
      review: true,
    });
  }

  return kind === 'lenum'
    ? { name: 'lenum', values: resolved as { key: string; label: LocalizedString }[] }
    : { name: 'enum', values: resolved as { key: string; label: string }[] };
}

function declaredType(
  def: FeedAttributeDefinition,
  obs: Observation | undefined,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
  subject: string,
  locale: string,
): AttributeType | undefined {
  const base = (): AttributeType | undefined => {
    switch (def.type) {
      case 'text':
        return { name: 'text' };
      case 'ltext':
        return { name: 'ltext' };
      case 'number':
        return { name: 'number' };
      case 'boolean':
        return { name: 'boolean' };
      case 'date':
        return { name: 'date' };
      case 'datetime':
        return { name: 'datetime' };
      case 'time':
        return { name: 'time' };
      case 'money':
        return { name: 'money' };
      case 'reference':
        diagnostics.push({
          severity: 'error',
          code: 'reference-attribute-unsupported',
          message:
            `${subject} is declared as a reference attribute, which needs a ` +
            'referenceTypeId the feed contract does not carry. Model it as text ' +
            'holding the target key, or extend the contract deliberately.',
        });
        return undefined;
      case 'enum':
      case 'lenum': {
        const values = def.values ?? [];
        if (values.length === 0) {
          // Fall back to observed axis keys rather than failing: a source that
          // declares an enum without listing its values is common, and the
          // feed's own axis values are authoritative.
          const observed = [...(obs?.axisKeys ?? new Map()).entries()];
          if (observed.length === 0) {
            diagnostics.push({
              severity: 'error',
              code: 'enum-without-values',
              message:
                `${subject} is declared as ${def.type} but lists no values, and no ` +
                'values were observed in the feed either. An enum with no permitted ' +
                'values rejects every write.',
            });
            return undefined;
          }
          decisions.push({
            subject,
            outcome: `${def.type} with ${observed.length} value(s) taken from the feed`,
            rationale:
              'The declaration listed no permitted values, so the observed axis values ' +
              'were used instead. Any value absent from the feed will be rejected later.',
            review: true,
          });
          return enumType(def.type, observed.map(([key, label]) => ({ key, label })), locale, subject, decisions);
        }

        return enumType(def.type, values, locale, subject, decisions);
      }
    }
  };

  const resolved = base();
  if (!resolved) return undefined;
  return def.set === true ? { name: 'set', elementType: resolved } : resolved;
}

function inferType(
  obs: Observation,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
  subject: string,
): AttributeType | undefined {
  const kinds = [...obs.kinds];

  if (kinds.length === 0) {
    // An axis declared but never valued — the validator already reported it.
    return undefined;
  }

  if (kinds.length > 1) {
    diagnostics.push({
      severity: 'error',
      code: 'mixed-value-types',
      message:
        `${subject} holds more than one kind of value in the feed (${kinds.join(', ')}). ` +
        'An inferred type would be wrong for some records. Declare it explicitly with an ' +
        'attributeDefinition, or fix the adapter so it emits one kind.',
    });
    return undefined;
  }

  const kind = kinds[0];
  const locale = config.market.defaultLocale;

  // An axis is always a code set by contract, so enum keys are safe here in a
  // way that arbitrary strings are not.
  if (obs.isAxis) {
    const entries = [...obs.axisKeys.entries()];
    const anyLabels = entries.some(([, label]) => label !== undefined);
    decisions.push({
      subject,
      outcome: anyLabels
        ? `lenum with ${entries.length} value(s)`
        : `enum with ${entries.length} value(s)`,
      rationale: anyLabels
        ? 'Used as a variant axis and axisLabels supplied display text, so a localized ' +
          'enum keeps the code as identity and the label for display.'
        : 'Used as a variant axis with no axisLabels, so the code doubles as the label. ' +
          'Supply axisLabels in the adapter to get human-readable text in the Merchant Center.',
      review: true,
    });
    // One key, two display labels, across different products. Keeping the
    // first is as good a rule as any — but it was silent, and "first" is feed
    // line order, so the winner changed when an adapter reordered its output.
    const conflicting = [...obs.axisLabelVariants.entries()].filter(([, v]) => v.size > 1);
    if (conflicting.length > 0) {
      decisions.push({
        subject,
        outcome: `${conflicting.length} axis key(s) had more than one label; the first was kept`,
        rationale:
          conflicting
            .map(([key, seen]) => `'${key}' was labelled ${[...seen].join(' and ')}`)
            .join('; ') +
          '. A lenum holds one label per key, so the others are dropped. If the ' +
          'difference matters, the labels are describing different things and the keys ' +
          'should differ too — or carry the exact per-variant text as its own attribute.',
        lossy: true,
        review: true,
      });
    }

    return anyLabels
      ? {
          name: 'lenum',
          values: entries.map(([key, label]) => ({
            key,
            label: label ?? { [locale]: key },
          })),
        }
      : { name: 'enum', values: entries.map(([key]) => ({ key, label: key })) };
  }

  switch (kind) {
    case 'boolean':
      decisions.push({
        subject,
        outcome: 'boolean',
        rationale: 'Every observed value was a JSON boolean.',
        review: true,
      });
      return { name: 'boolean' };

    case 'number':
      decisions.push({
        subject,
        outcome: 'number',
        rationale: 'Every observed value was a JSON number.',
        review: true,
      });
      return { name: 'number' };

    case 'localized':
      decisions.push({
        subject,
        outcome: 'ltext',
        rationale: 'Every observed value was a locale-keyed map.',
        review: true,
      });
      return { name: 'ltext' };

    case 'set': {
      const elements = [...obs.elementKinds];
      if (elements.length !== 1) {
        diagnostics.push({
          severity: 'error',
          code: 'mixed-set-element-types',
          message:
            `${subject} is a set whose elements are not all the same kind ` +
            `(${elements.join(', ') || 'none'}). Declare the element type explicitly.`,
        });
        return undefined;
      }
      const element: AttributeType =
        elements[0] === 'boolean'
          ? { name: 'boolean' }
          : elements[0] === 'number'
            ? { name: 'number' }
            : { name: 'text' };
      decisions.push({
        subject,
        outcome: `set of ${element.name}`,
        rationale: `Every observed value was an array of ${elements[0]}.`,
        review: true,
      });
      return { name: 'set', elementType: element };
    }

    case 'string': {
      const values = [...obs.distinct].filter((v) => v !== '');

      if (values.length > 0 && values.every((v) => ISO_DATE.test(v))) {
        decisions.push({
          subject,
          outcome: 'date',
          rationale:
            `All ${values.length} distinct value(s) match an ISO calendar date. Inferred ` +
            'as date so range queries work; if these are really opaque codes, declare ' +
            'the attribute as text.',
          review: true,
        });
        return { name: 'date' };
      }

      if (values.length > 0 && values.every((v) => ISO_DATETIME.test(v))) {
        decisions.push({
          subject,
          outcome: 'datetime',
          rationale:
            `All ${values.length} distinct value(s) match an ISO timestamp. Inferred as ` +
            'datetime so range queries work.',
          review: true,
        });
        return { name: 'datetime' };
      }

      // Low-cardinality strings look like an enum, but source strings are
      // usually display text and would make unstable enum keys. Map as text
      // and raise it as a modelling question instead of guessing.
      const looksEnumerable =
        values.length > 1 &&
        values.length <= ENUM_CANDIDATE_MAX_DISTINCT &&
        obs.occurrences >= values.length * 3;

      decisions.push({
        subject,
        outcome: 'text',
        rationale: looksEnumerable
          ? `Only ${values.length} distinct value(s) across ${obs.occurrences} occurrences, ` +
            'so this is a candidate for enum — but enum keys must be stable codes and ' +
            'these values may be display text. Mapped as text; switch it to enum in the ' +
            'adapter if the values are codes.'
          : 'Observed values were plain strings with no localization and no recognizable ' +
            'date format.',
        review: true,
      });
      return { name: 'text' };
    }
  }
}

// ---------------------------------------------------------------------------
// Definition assembly
// ---------------------------------------------------------------------------

function humanize(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function resolveConstraint(
  obs: Observation | undefined,
  level: 'product' | 'variant',
  config: PipelineConfig,
): { constraint: AttributeConstraintEnum; ctLevel: AttributeLevel; rationale: string } {
  if (obs?.isAxis) {
    return {
      constraint: 'CombinationUnique',
      ctLevel: 'Variant',
      rationale:
        'Part of variant identity, so the platform enforces one variant per combination.',
    };
  }

  if (level === 'product') {
    if (config.productTypes.productLevelStrategy === 'native') {
      return {
        constraint: 'None',
        ctLevel: 'Product',
        rationale:
          'Invariant across variants, modelled as a native Product-level attribute. Note ' +
          'that Product-level attributes are not supported by Product Projection Search — ' +
          'only by Product Search.',
      };
    }
    return {
      constraint: 'SameForAll',
      ctLevel: 'Variant',
      rationale:
        'Invariant across variants, modelled at variant level with SameForAll so it stays ' +
        'usable from both Product Search and Product Projection Search.',
    };
  }

  return {
    constraint: 'None',
    ctLevel: 'Variant',
    rationale: 'Varies freely between variants and is not part of variant identity.',
  };
}

function inputHintFor(type: AttributeType, obs: Observation | undefined): TextInputHint {
  const textual = type.name === 'text' || type.name === 'ltext';
  if (!textual || !obs) return 'SingleLine';
  return obs.hasNewline || obs.maxLength > MULTILINE_THRESHOLD ? 'MultiLine' : 'SingleLine';
}

function buildDefinition(
  name: string,
  obs: Observation | undefined,
  declared: FeedAttributeDefinition | undefined,
  productTypeKey: string,
  config: PipelineConfig,
  decisions: MappingDecision[],
  diagnostics: Diagnostic[],
): AttributeDefinition | undefined {
  const subject = `${productTypeKey}.${name}`;
  const locale = config.market.defaultLocale;

  const type = declared
    ? declaredType(declared, obs, decisions, diagnostics, subject, locale)
    : inferType(obs!, config, decisions, diagnostics, subject);
  if (!type) return undefined;

  // `axisLabels` only has somewhere to go on an enum or lenum, where a value
  // carries a key *and* display text. Declared as text, the axis values are
  // the display text, and every label the adapter supplied is dropped —
  // silently, until now. Found while fixing the conflicting-label case: same
  // defect, a path the dogfood run did not happen to take.
  const labelled = obs?.axisLabelVariants.size ?? 0;
  if (declared && labelled > 0 && type.name !== 'enum' && type.name !== 'lenum') {
    diagnostics.push({
      severity: 'warning',
      code: 'axis-labels-ignored',
      message:
        `${subject} is declared as ${declared.type} and the feed supplies axisLabels for ` +
        `${labelled} value(s), which are dropped: only enum and lenum carry a key and ` +
        'display text separately.\n' +
        '      Declare it as enum or lenum to keep them, or stop emitting the labels so ' +
        'the feed says what actually happens.',
    });
  }

  const level: 'product' | 'variant' = declared
    ? declared.level
    : obs!.levels.has('product') && !obs!.levels.has('variant')
      ? 'product'
      : 'variant';

  const { constraint, ctLevel, rationale } = resolveConstraint(obs, level, config);

  // A constraint can only ever be relaxed to None later, so this is effectively
  // a one-way door and is recorded as such.
  if (constraint !== 'None') {
    decisions.push({
      subject,
      outcome: `${constraint} (level ${ctLevel})`,
      rationale:
        rationale +
        ' changeAttributeConstraint accepts only None, so this can later be relaxed but ' +
        'never tightened or switched — it has to be right before the first load.',
      irreversible: true,
      review: declared === undefined,
    });
  }

  // isRequired is only safe when every holder actually has a value: a required
  // attribute with a missing value rejects the whole product.
  let isRequired = false;
  if (declared?.required === true) {
    const fullyPopulated = obs !== undefined && obs.populated >= obs.occurrences && obs.occurrences > 0;
    if (fullyPopulated) {
      isRequired = true;
    } else {
      decisions.push({
        subject,
        outcome: 'isRequired downgraded to false',
        rationale:
          `Declared required, but only ${obs?.populated ?? 0} of ${obs?.occurrences ?? 0} ` +
          'observed occurrences carry a value. Keeping it required would reject every ' +
          'product with a gap, so the requirement is dropped and the gap preserved.',
        lossy: true,
      });
    }
  }

  // Labels: populate the default locale only. Filling other locales with the
  // same text would look translated without being translated.
  let label: LocalizedString;
  const labelWasDeclared = Boolean(
    declared?.label && Object.keys(declared.label).length > 0,
  );
  if (labelWasDeclared) {
    label = { ...declared!.label };
  } else {
    label = { [locale]: humanize(name) };
    decisions.push({
      subject,
      outcome: `label derived as "${label[locale]}" in ${locale} only`,
      rationale:
        'No label was supplied. The attribute name was humanized for the default locale; ' +
        'other locales are left empty rather than filled with untranslated text.',
      review: true,
    });
  }

  // Only worth saying when a label *was* declared but is incomplete. For a
  // derived label the decision above already states it covers one locale.
  if (labelWasDeclared) {
    const missing = config.market.requiredLocales.filter((l) => !label[l]);
    if (missing.length > 0) {
      decisions.push({
        subject,
        outcome: `label missing for ${missing.join(', ')}`,
        rationale:
          'The Merchant Center shows an empty label in those locales. Harmless to the ' +
          'data, but worth handing to whoever owns translations.',
      });
    }
  }

  // commercetools has no unit concept on attributes, so a bare number loses its
  // unit unless the unit is carried into the label.
  if (declared?.unit) {
    for (const l of Object.keys(label)) label[l] = `${label[l]} (${declared.unit})`;
    decisions.push({
      subject,
      outcome: `unit '${declared.unit}' appended to the label`,
      rationale:
        'commercetools attributes carry no unit, so the unit is preserved in the label ' +
        'only. It is no longer machine-readable — a consumer cannot convert or compare ' +
        'across units.',
      lossy: true,
    });
  }

  // An axis is always searchable — it is variant identity, and a facet on it
  // is the normal reason to have one. Otherwise a declared value wins over the
  // project-wide default: a source that says `search="false"` is expressing
  // intent, and replacing it with a default silently widens the search index.
  const isSearchable =
    obs?.isAxis === true
      ? true
      : (declared?.searchable ?? config.productTypes.searchableByDefault);

  if (declared?.searchable !== undefined && obs?.isAxis !== true) {
    if (declared.searchable !== config.productTypes.searchableByDefault) {
      decisions.push({
        subject,
        outcome: `isSearchable ${declared.searchable} (declared, overriding the default)`,
        rationale:
          'The source declared searchability for this attribute and it disagrees with ' +
          'productTypes.searchableByDefault, so the declaration was honoured. Note that a ' +
          'shared attribute name must agree on this value across every ProductType, or it ' +
          'becomes unavailable for search, filters and facets everywhere — derive reports ' +
          'any disagreement as an error.',
        review: true,
      });
    }
  } else if (declared !== undefined && obs?.isAxis !== true) {
    decisions.push({
      subject,
      outcome: `isSearchable ${isSearchable} (from searchableByDefault)`,
      rationale:
        'The declaration did not state searchability, so the configured default applies. ' +
        'If the source does carry the flag, emit it as `searchable` on the ' +
        'attributeDefinition rather than losing it.',
    });
  }

  // Populated even where the draft would let the API default it, so the plan
  // states exactly what the ProductType will contain.
  return {
    name,
    label,
    type,
    isRequired,
    level: ctLevel,
    attributeConstraint: constraint,
    inputHint: inputHintFor(type, obs),
    isSearchable,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function deriveProductTypes(
  feed: CatalogFeed,
  config: PipelineConfig,
): DeriveResult {
  const diagnostics: Diagnostic[] = [];
  const decisions: MappingDecision[] = [];
  const declaredDefs = feed.attributeDefinitions;
  const inferred = declaredDefs.size === 0;

  if (inferred && config.productTypes.onMissingDefinitions === 'require') {
    diagnostics.push({
      severity: 'error',
      code: 'definitions-required',
      message:
        'The feed carries no attributeDefinition records and ' +
        "productTypes.onMissingDefinitions is 'require'. Either emit declarations from " +
        "the adapter, or set it to 'infer' and accept that every attribute type is a " +
        'guess needing review.',
    });
    return {
      productTypes: new Map(),
      assignment: new Map(),
      decisions,
      inferred,
      diagnostics,
    };
  }

  const groups = groupProducts(feed, config);
  const productTypes = new Map<string, ProductTypeImport>();
  const assignment = new Map<string, string>();

  for (const [sourceKey, memberCodes] of groups) {
    // The feed's ProductType code is the *source* identity; the resource key is
    // prefixed like every other resource the migration creates, so a teardown
    // scoped to `keys.prefix` finds it and two engagements in one project do
    // not collide on a shared name like `apparel-basic`.
    //
    // Both the map key and the assignment carry the prefixed form, because
    // `plan` uses the assignment value directly as the ProductType
    // KeyReference and looks the definition up by the same string.
    const key = resourceKey(config.keys.prefix, sourceKey);
    for (const code of memberCodes) assignment.set(code, key);

    const observations = observeGroup(feed, memberCodes);

    // An attribute that is an axis for some products in a group and an ordinary
    // attribute for others cannot be expressed: the constraint belongs to the
    // ProductType, not the product.
    for (const obs of observations.values()) {
      if (obs.axisIn.length > 0 && obs.nonAxisIn.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'axis-inconsistent-in-product-type',
          message:
            `In ProductType '${key}', '${obs.name}' is a variant axis for ` +
            `${obs.axisIn.length} product(s) (e.g. ${obs.axisIn[0]}) but an ordinary ` +
            `attribute for ${obs.nonAxisIn.length} other(s) (e.g. ${obs.nonAxisIn[0]}). ` +
            'Attribute constraints belong to the ProductType, so one ProductType cannot ' +
            'be both. Split the ProductType, or make the axis consistent.',
        });
      }
      if (obs.levels.has('product') && obs.levels.has('variant') && !obs.isAxis) {
        diagnostics.push({
          severity: 'error',
          code: 'level-inconsistent-in-product-type',
          message:
            `In ProductType '${key}', '${obs.name}' appears at product level on some ` +
            'records and variant level on others. One attribute cannot be both ' +
            'SameForAll and free-varying within a ProductType.',
        });
      }
    }

    // The ProductType's attribute set is the union across its members, since
    // any member may set any of them.
    const names = new Set<string>([...observations.keys()]);
    if (!inferred) for (const name of declaredDefs.keys()) names.add(name);

    const attributes: AttributeDefinition[] = [];
    for (const name of [...names].sort()) {
      const obs = observations.get(name);
      const declared = declaredDefs.get(name);

      // Declared but unused by this group: skip rather than creating a
      // permanently empty attribute on every ProductType.
      if (!obs && declared) continue;
      if (!obs) continue;

      const def = buildDefinition(
        name,
        obs,
        declared,
        key,
        config,
        decisions,
        diagnostics,
      );
      if (def) attributes.push(def);
    }

    productTypes.set(key, {
      key,
      // Both from the *source* key: the prefix is a migration artefact, so
      // humanising the resource key would read "Mig Apparel Basic" in the
      // Merchant Center, and the configured default name would never match.
      name:
        sourceKey === config.productTypes.defaultKey
          ? config.productTypes.defaultName
          : humanize(sourceKey),
      description: `Derived from the catalog feed for ${memberCodes.length} product(s).`,
      attributes,
    });
  }

  checkCrossTypeConsistency(productTypes, diagnostics);

  if (productTypes.size > MAX_PRODUCT_TYPES) {
    diagnostics.push({
      severity: 'warning',
      code: 'product-type-limit',
      message:
        `${productTypes.size} ProductTypes derived, above the soft project limit of ` +
        `${MAX_PRODUCT_TYPES}. Either consolidate, or arrange a limit increase before ` +
        'the load.',
    });
  }

  return { productTypes, assignment, decisions, inferred, diagnostics };
}

/**
 * An attribute name shared across ProductTypes must agree on `isSearchable`.
 *
 * The docs are explicit that mismatched values make the attribute unavailable
 * for search, filters and facets — and it fails silently: the import succeeds
 * and the facet is simply missing.
 */
function checkCrossTypeConsistency(
  productTypes: Map<string, ProductTypeImport>,
  diagnostics: Diagnostic[],
): void {
  interface Seen {
    typeName: string;
    isSearchable: boolean;
    level: AttributeLevel;
    owner: string;
  }
  const seen = new Map<string, Seen>();

  for (const pt of productTypes.values()) {
    for (const attr of attributeDefinitionsOf(pt)) {
      // isSearchable and level are optional on AttributeDefinition because the
      // API supplies defaults. This pipeline always sets them, so the fallbacks
      // below only apply to a definition that came from somewhere else.
      const isSearchable = attr.isSearchable ?? false;
      const level: AttributeLevel = attr.level ?? 'Variant';

      const prior = seen.get(attr.name);
      if (!prior) {
        seen.set(attr.name, {
          typeName: attr.type.name,
          isSearchable,
          level,
          owner: pt.key,
        });
        continue;
      }

      if (prior.isSearchable !== isSearchable) {
        diagnostics.push({
          severity: 'error',
          code: 'searchable-mismatch-across-product-types',
          message:
            `'${attr.name}' has isSearchable=${prior.isSearchable} on ProductType ` +
            `'${prior.owner}' and ${isSearchable} on '${pt.key}'. When the values ` +
            'differ the attribute becomes unavailable for search, filters and facets ' +
            'across every ProductType — and nothing errors at import time.',
        });
      }

      if (prior.typeName !== attr.type.name) {
        // Not a style question — the API refuses it. A live load returned
        // `AttributeDefinitionTypeConflict`: "the attribute with name
        // 'material' has a different type on product type '...'". This was a
        // warning saying "legal, but a storefront has to handle both shapes",
        // which was wrong on the only point that matters.
        diagnostics.push({
          severity: 'error',
          code: 'type-mismatch-across-product-types',
          message:
            `'${attr.name}' is ${prior.typeName} on ProductType '${prior.owner}' and ` +
            `${attr.type.name} on '${pt.key}'. An attribute name may hold only one type ` +
            'across the whole Project, so the API rejects the second ProductType with ' +
            'AttributeDefinitionTypeConflict — and the products that reference it then ' +
            'fail with AttributeNameDoesNotExist.\n' +
            '      Either give them one type, or use two names. Enum *values* may differ ' +
            'freely between ProductTypes; only the type may not.',
        });
      }

      if (prior.level !== level) {
        diagnostics.push({
          severity: 'warning',
          code: 'level-mismatch-across-product-types',
          message:
            `'${attr.name}' sits at ${prior.level} level on '${prior.owner}' and ` +
            `${level} level on '${pt.key}'. Product-level and variant-level ` +
            'attributes are read through different search APIs.',
        });
      }
    }
  }
}
