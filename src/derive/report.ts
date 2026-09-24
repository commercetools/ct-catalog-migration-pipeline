/**
 * Writing the derived model out.
 *
 * Three artefacts, with different audiences:
 *
 * - `product-types.json` — the drafts, for the load stage and for diffing.
 * - `decisions.json` — the machine-readable decision log.
 * - `MODEL-REVIEW.md` — what a human has to sign off before the load, which is
 *   the point of the whole stage. Nobody reviews a JSON file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  attributeDefinitionsOf,
  type AttributeType,
  type DerivedModel,
  type MappingDecision,
} from '../model/plan.js';

export interface WrittenArtefacts {
  productTypesPath: string;
  decisionsPath: string;
  reviewPath?: string;
}

export function writeDerived(outDir: string, model: DerivedModel): WrittenArtefacts {
  mkdirSync(outDir, { recursive: true });

  const productTypesPath = join(outDir, 'product-types.json');
  writeFileSync(
    productTypesPath,
    JSON.stringify([...model.productTypes.values()], null, 2) + '\n',
  );

  const decisionsPath = join(outDir, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify(model.decisions, null, 2) + '\n');

  const needsReview = model.decisions.filter((d) => d.review || d.lossy || d.irreversible);
  if (needsReview.length === 0) {
    return { productTypesPath, decisionsPath };
  }

  const reviewPath = join(outDir, 'MODEL-REVIEW.md');
  writeFileSync(reviewPath, renderReview(model, needsReview));
  return { productTypesPath, decisionsPath, reviewPath };
}

function renderReview(model: DerivedModel, needsReview: MappingDecision[]): string {
  const lines: string[] = [];

  lines.push('# Product model review');
  lines.push('');
  lines.push(
    model.inferred
      ? 'The feed carried no attribute declarations, so **every attribute type below was ' +
          'guessed from observed values**. Inference is a fallback, not the happy path: ' +
          'the reliable fix is to emit `attributeDefinition` records from the adapter.'
      : 'Attribute types came from the feed\'s declarations. The items below still need a ' +
          'decision because they lose information, cannot be undone, or were filled in ' +
          'where the declaration was silent.',
  );
  lines.push('');

  const irreversible = needsReview.filter((d) => d.irreversible);
  const lossy = needsReview.filter((d) => d.lossy);
  const guessed = needsReview.filter((d) => d.review && !d.lossy && !d.irreversible);

  if (irreversible.length > 0) {
    lines.push('## Irreversible — decide before the first load');
    lines.push('');
    lines.push(
      'Attribute constraints can only ever be relaxed to `None` afterwards: ' +
        '`changeAttributeConstraint` accepts no other value. Tightening or switching a ' +
        'constraint later means recreating the attribute and rewriting its data.',
    );
    lines.push('');
    lines.push(...table(irreversible));
    lines.push('');
  }

  if (lossy.length > 0) {
    lines.push('## Information loss — needs sign-off');
    lines.push('');
    lines.push(
      'Each of these carries less information into commercetools than the source held. ' +
        'A migration claiming zero information loss is not being honest; the point is that ' +
        'each loss is deliberate and someone has accepted it.',
    );
    lines.push('');
    lines.push(...table(lossy));
    lines.push('');
  }

  if (guessed.length > 0) {
    lines.push('## Guessed or filled in');
    lines.push('');
    lines.push(...table(guessed));
    lines.push('');
  }

  lines.push('## Attribute summary');
  lines.push('');
  for (const pt of model.productTypes.values()) {
    lines.push(`### ProductType \`${pt.key}\``);
    lines.push('');
    lines.push('| Attribute | Type | Level | Constraint | Required | Searchable |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const a of attributeDefinitionsOf(pt)) {
      lines.push(
        `| \`${a.name}\` | ${describeType(a.type)} | ${a.level} | ${a.attributeConstraint} | ` +
          `${a.isRequired ? 'yes' : 'no'} | ${a.isSearchable ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Checklist');
  lines.push('');
  lines.push('- [ ] Every axis is a language-independent code, not display text.');
  lines.push('- [ ] `SameForAll` and `CombinationUnique` are right — they cannot be tightened later.');
  lines.push('- [ ] Each information loss above is accepted, or the adapter is fixed.');
  lines.push('- [ ] Attribute names shared across ProductTypes agree on `isSearchable`.');
  lines.push('- [ ] Labels exist in every locale the storefront renders.');
  lines.push('- [ ] Nothing that must facet or drive a discount predicate is nested or set-of-nested.');
  lines.push('');

  return lines.join('\n');
}

function table(decisions: MappingDecision[]): string[] {
  const rows = ['| Subject | Outcome | Rationale |', '| :--- | :--- | :--- |'];
  for (const d of decisions) {
    rows.push(
      `| \`${d.subject}\` | ${escapePipes(d.outcome)} | ${escapePipes(d.rationale)} |`,
    );
  }
  return rows;
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function describeType(type: AttributeType): string {
  switch (type.name) {
    case 'set':
      return `set of ${describeType(type.elementType)}`;
    case 'enum':
      return `enum (${type.values.length})`;
    case 'lenum':
      return `lenum (${type.values.length})`;
    case 'reference':
      return `reference → ${type.referenceTypeId}`;
    default:
      return type.name;
  }
}
