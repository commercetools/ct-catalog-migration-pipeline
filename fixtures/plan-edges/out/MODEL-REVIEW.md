# Product model review

Attribute types came from the feed's declarations. The items below still need a decision because they lose information, cannot be undone, or were filled in where the declaration was silent.

## Irreversible — decide before the first load

Attribute constraints can only ever be relaxed to `None` afterwards: `changeAttributeConstraint` accepts no other value. Tightening or switching a constraint later means recreating the attribute and rewriting its data.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.size` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |

## Guessed or filled in

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.size` | label derived as "Size" in en-GB only | No label was supplied. The attribute name was humanized for the default locale; other locales are left empty rather than filled with untranslated text. |

## Attribute summary

### ProductType `mig-apparel-basic`

| Attribute | Type | Level | Constraint | Required | Searchable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `size` | enum (2) | Variant | CombinationUnique | no | yes |

## Checklist

- [ ] Every axis is a language-independent code, not display text.
- [ ] `SameForAll` and `CombinationUnique` are right — they cannot be tightened later.
- [ ] Each information loss above is accepted, or the adapter is fixed.
- [ ] Attribute names shared across ProductTypes agree on `isSearchable`.
- [ ] Labels exist in every locale the storefront renders.
- [ ] Nothing that must facet or drive a discount predicate is nested or set-of-nested.
