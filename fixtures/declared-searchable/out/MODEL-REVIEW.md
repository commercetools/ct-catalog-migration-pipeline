# Product model review

Attribute types came from the feed's declarations. The items below still need a decision because they lose information, cannot be undone, or were filled in where the declaration was silent.

## Irreversible — decide before the first load

Attribute constraints can only ever be relaxed to `None` afterwards: `changeAttributeConstraint` accepts no other value. Tightening or switching a constraint later means recreating the attribute and rewriting its data.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.colour` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.fabricWeight` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.internalNote` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.material` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |

## Guessed or filled in

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.colour` | label derived as "Colour" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.fabricWeight` | label derived as "Fabric Weight" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.internalNote` | label derived as "Internal Note" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |
| `mig-apparel-basic.internalNote` | isSearchable false (declared, overriding the default) | The source declared searchability for this attribute and it disagrees with productTypes.searchableByDefault, so the declaration was honoured. Note that a shared attribute name must agree on this value across every ProductType, or it becomes unavailable for search, filters and facets everywhere — derive reports any disagreement as an error. |
| `mig-apparel-basic.material` | label derived as "Material" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |

## Attribute summary

### ProductType `mig-apparel-basic`

| Attribute | Type | Level | Constraint | Required | Searchable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `colour` | enum (2) | Variant | CombinationUnique | no | yes |
| `fabricWeight` | number | Variant | SameForAll | no | yes |
| `internalNote` | text | Variant | SameForAll | no | no |
| `material` | text | Variant | SameForAll | no | yes |

## Checklist

- [ ] Every axis is a language-independent code, not display text.
- [ ] `SameForAll` and `CombinationUnique` are right — they cannot be tightened later.
- [ ] Each information loss above is accepted, or the adapter is fixed.
- [ ] Attribute names shared across ProductTypes agree on `isSearchable`.
- [ ] Labels exist in every locale the storefront renders.
- [ ] Nothing that must facet or drive a discount predicate is nested or set-of-nested.
