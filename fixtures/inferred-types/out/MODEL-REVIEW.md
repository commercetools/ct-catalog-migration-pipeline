# Product model review

The feed carried no attribute declarations, so **every attribute type below was guessed from observed values**. Inference is a fallback, not the happy path: the reliable fix is to emit `attributeDefinition` records from the adapter.

## Irreversible — decide before the first load

Attribute constraints can only ever be relaxed to `None` afterwards: `changeAttributeConstraint` accepts no other value. Tightening or switching a constraint later means recreating the attribute and rewriting its data.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.colour` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.material` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.organicCertified` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.size` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |

## Guessed or filled in

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.colour` | enum with 3 value(s) | Used as a variant axis with no axisLabels, so the code doubles as the label. Supply axisLabels in the adapter to get human-readable text in the Merchant Center. |
| `mig-apparel-basic.colour` | label derived as "Colour" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.material` | ltext | Every observed value was a locale-keyed map. |
| `mig-apparel-basic.material` | label derived as "Material" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.organicCertified` | boolean | Every observed value was a JSON boolean. |
| `mig-apparel-basic.organicCertified` | label derived as "Organic Certified" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.size` | enum with 3 value(s) | Used as a variant axis with no axisLabels, so the code doubles as the label. Supply axisLabels in the adapter to get human-readable text in the Merchant Center. |
| `mig-apparel-basic.size` | label derived as "Size" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.weightGrams` | number | Every observed value was a JSON number. |
| `mig-apparel-basic.weightGrams` | label derived as "Weight Grams" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |

## Attribute summary

### ProductType `mig-apparel-basic`

| Attribute | Type | Level | Constraint | Required | Searchable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `colour` | enum (3) | Variant | CombinationUnique | no | yes |
| `material` | ltext | Variant | SameForAll | no | yes |
| `organicCertified` | boolean | Variant | SameForAll | no | yes |
| `size` | enum (3) | Variant | CombinationUnique | no | yes |
| `weightGrams` | number | Variant | None | no | yes |

## Checklist

- [ ] Every axis is a language-independent code, not display text.
- [ ] `SameForAll` and `CombinationUnique` are right — they cannot be tightened later.
- [ ] Each information loss above is accepted, or the adapter is fixed.
- [ ] Attribute names shared across ProductTypes agree on `isSearchable`.
- [ ] Labels exist in every locale the storefront renders.
- [ ] Nothing that must facet or drive a discount predicate is nested or set-of-nested.
