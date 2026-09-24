# Product model review

The feed carried no attribute declarations, so **every attribute type below was guessed from observed values**. Inference is a fallback, not the happy path: the reliable fix is to emit `attributeDefinition` records from the adapter.

## Irreversible — decide before the first load

Attribute constraints can only ever be relaxed to `None` afterwards: `changeAttributeConstraint` accepts no other value. Tightening or switching a constraint later means recreating the attribute and rewriting its data.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-dated.pack` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |

## Guessed or filled in

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-dated.careInstructions` | text | Observed values were plain strings with no localization and no recognizable date format. |
| `mig-dated.careInstructions` | label derived as "Care Instructions" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-dated.launchAt` | datetime | All 2 distinct value(s) match an ISO timestamp. Inferred as datetime so range queries work. |
| `mig-dated.launchAt` | label derived as "Launch At" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-dated.pack` | enum with 2 value(s) | Used as a variant axis with no axisLabels, so the code doubles as the label. Supply axisLabels in the adapter to get human-readable text in the Merchant Center. |
| `mig-dated.pack` | label derived as "Pack" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-dated.releasedOn` | date | All 2 distinct value(s) match an ISO calendar date. Inferred as date so range queries work; if these are really opaque codes, declare the attribute as text. |
| `mig-dated.releasedOn` | label derived as "Released On" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-dated.tags` | set of text | Every observed value was an array of string. |
| `mig-dated.tags` | label derived as "Tags" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |

## Attribute summary

### ProductType `mig-dated`

| Attribute | Type | Level | Constraint | Required | Searchable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `careInstructions` | text | Variant | None | no | yes |
| `launchAt` | datetime | Variant | None | no | yes |
| `pack` | enum (2) | Variant | CombinationUnique | no | yes |
| `releasedOn` | date | Variant | None | no | yes |
| `tags` | set of text | Variant | None | no | yes |

## Checklist

- [ ] Every axis is a language-independent code, not display text.
- [ ] `SameForAll` and `CombinationUnique` are right — they cannot be tightened later.
- [ ] Each information loss above is accepted, or the adapter is fixed.
- [ ] Attribute names shared across ProductTypes agree on `isSearchable`.
- [ ] Labels exist in every locale the storefront renders.
- [ ] Nothing that must facet or drive a discount predicate is nested or set-of-nested.
