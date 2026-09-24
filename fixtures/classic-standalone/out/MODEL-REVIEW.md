# Product model review

Attribute types came from the feed's declarations. The items below still need a decision because they lose information, cannot be undone, or were filled in where the declaration was silent.

## Irreversible — decide before the first load

Attribute constraints can only ever be relaxed to `None` afterwards: `changeAttributeConstraint` accepts no other value. Tightening or switching a constraint later means recreating the attribute and rewriting its data.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.colour` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.material` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.organicCertified` | SameForAll (level Variant) | Invariant across variants, modelled at variant level with SameForAll so it stays usable from both Product Search and Product Projection Search. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |
| `mig-apparel-basic.size` | CombinationUnique (level Variant) | Part of variant identity, so the platform enforces one variant per combination. changeAttributeConstraint accepts only None, so this can later be relaxed but never tightened or switched — it has to be right before the first load. |

## Information loss — needs sign-off

Each of these carries less information into commercetools than the source held. A migration claiming zero information loss is not being honest; the point is that each loss is deliberate and someone has accepted it.

| Subject | Outcome | Rationale |
| :--- | :--- | :--- |
| `mig-apparel-basic.weightGrams` | unit 'g' appended to the label | commercetools attributes carry no unit, so the unit is preserved in the label only. It is no longer machine-readable — a consumer cannot convert or compare across units. |

## Attribute summary

### ProductType `mig-apparel-basic`

| Attribute | Type | Level | Constraint | Required | Searchable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `colour` | lenum (3) | Variant | CombinationUnique | no | yes |
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
