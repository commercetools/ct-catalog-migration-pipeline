# ct-catalog-migration-pipeline

A source-agnostic pipeline that loads a product catalog into a commercetools
project through a canonical NDJSON **feed contract**.

The pipeline never parses your source system. You write a small **adapter**
that emits the feed; everything after that — type derivation, money conversion,
slug allocation, the invariant checks the API enforces, the load itself and the
read-back — is the same for every engagement.

```
source export ──▶ adapter ──▶ feed (*.ndjson) ──▶ validate ─▶ derive ─▶ plan ─▶ audit
                  (yours)      (the contract)                                    │
                                                                                 ▼
                                                        preflight ─▶ load ─▶ verify
```

That split is the whole design. A mapping layer that imports from a
source-specific parser cannot be retargeted, however carefully it is written —
so the contract is the only thing the pipeline knows about.

## Install

```bash
git clone https://github.com/commercetools/ct-catalog-migration-pipeline
cd ct-catalog-migration-pipeline
npm install
```

Node 20 or newer. No global install; every command runs through `npm run`.

## Stages

Each stage is independently runnable and reports rather than guesses. The first
four need no credentials at all.

| Stage | Needs credentials | What it does |
| :--- | :---: | :--- |
| `validate` | no | Checks the feed against the schema and the contract's integrity rules |
| `derive` | no | Builds ProductTypes from declared or observed attribute types |
| `plan` | no | Maps the feed to commercetools drafts and writes the decision log |
| `audit` | no | Re-derives every invariant the API enforces, from the written plan |
| `preflight` | yes | Asks whether the project will accept the plan, in a handful of GETs |
| `load` | yes | Dry run by default; `--execute` is the only thing that writes |
| `verify` | yes | Reads the project back and reconciles it against the plan |

```bash
npm run pipeline -- validate  --config ../migration/migration.config.json
npm run pipeline -- derive    --config ../migration/migration.config.json
npm run pipeline -- plan      --config ../migration/migration.config.json
npm run pipeline -- audit     --config ../migration/migration.config.json
npm run pipeline -- preflight --config ../migration/migration.config.json
npm run pipeline -- load      --config ../migration/migration.config.json            # dry run
npm run pipeline -- load      --config ../migration/migration.config.json --execute
npm run pipeline -- verify    --config ../migration/migration.config.json
```

The engagement lives **beside** this repo, not inside it:

```
<engagement-root>/
  ct-catalog-migration-pipeline/   this repo — the tool
  source-export/                   what the customer handed over
  migration/                       the engagement
    migration.config.json            written from the step-0 interview
    DECISIONS.md                     append-only record of what was decided
    adapter/                         the only code written per engagement
    feed/                            generated NDJSON — regenerated, disposable
    out/                             pipeline artefacts — regenerated, gitignored
```

`--out` defaults to `out` **relative to the config**, so pointing `--config` at
the engagement writes the artefacts there.

## Configuration

One JSON file per engagement, copied from `migration.config.json` at this
repository's root and edited. Five of its values are **decisions, not
settings**: each is either irreversible or fails silently, so the loader
refuses an absent or placeholder value rather than defaulting one.

| Value | Why it cannot be defaulted |
| :--- | :--- |
| `keys.prefix` | Written into every key the migration creates, and what bounds a teardown to its own work. Ships as `REPLACE-ME`, which the loader refuses. |
| `target.catalogModel` | `Classic` or `Modular`. Decides the whole import shape, and must match the project's own setting. |
| `target.priceMode` | `embedded` or `standalone`. A product whose mode disagrees with where its prices are imports cleanly, reports success, and shows no price. |
| `market.defaultLocale` | Derived labels and slugs land here. A locale the project does not accept makes every affected record fail. |
| `market.currencyFractionDigits` | Minor-unit conversion per currency. A wrong value is a silently wrong price, not an error. |

Two more shape the model rather than the load: `productTypes.onMissingDefinitions`
(`require` or `infer` — whether the feed declares its own attribute types) and
`productTypes.productLevelStrategy` (`sameForAll` or `native` — note the names
read backwards, `sameForAll` is the safe default and `native` is the one that
makes attributes invisible to Product Projection Search).

The skill that accompanies this pipeline conducts these as an interview and
writes the config from the answers, which is the intended path. The template
exists as a reference and a fallback.

## Credentials

From the environment or a `.env` file, never from the committed config. Copy
`.env.example` and fill it in; it lists which scope each stage needs.

Two things about project identity are refused rather than resolved, because
loading a catalog into the wrong project is not a mistake you want to discover
afterwards:

- A `.env` file and exported variables naming **different** projects.
- **No `.env` file** while the environment names a project — set
  `CTP_AMBIENT_OK=1` to declare an ambient environment deliberate, as CI should.

## The feed contract

The contract is a JSON Schema — [`schema/catalog-feed.schema.json`](schema/catalog-feed.schema.json) —
plus integrity rules `validate` enforces. Records are one per line, each tagged
with a `_type`:

| `_type` | Notes |
| :--- | :--- |
| `channel`, `customerGroup` | prerequisites; keys used **verbatim**, created by `load` through the platform API |
| `productSelection` | an assortment; importable, so its key is prefixed |
| `store` | a shopping context; key verbatim, created **last** because it references selections |
| `category` | hierarchy, slugs, order hints |
| `attributeDefinition` | declared attribute types — the alternative is inference, which needs review |
| `product`, `variant` | the catalog itself, with prices and assets |

`fixtures/` doubles as documentation: each directory is a runnable example of
one behaviour, including the deliberately broken ones.

## What it will not do

- **Parse your source.** That is the adapter's job, and the reason the contract
  exists.
- **Guess at a decision that cannot be undone.** Attribute constraints, catalog
  model, price mode and product-selection modes are all permanent; the pipeline
  refuses an absent value rather than defaulting one.
- **Claim zero information loss.** Every approximation is recorded as a
  decision, and `out/MODEL-REVIEW.md` is meant to be read before loading.
- **Sync after cutover.** This is a one-time migration tool.
- **Migrate customers, orders, carts, inventory or promotions.** Catalog only.

## Scale

The binding limit is not memory. Every artefact is written with
`JSON.stringify`, which builds the whole document as one string, and V8 caps
strings at ~537 MB whatever the heap size. Measured:

| Catalog | `plan.json` per variant | Ceiling |
| :--- | ---: | ---: |
| 2 product-level attributes | 0.9 KB | ~575,000 variants |
| 25 product-level attributes | 4.2 KB | ~125,000 variants |

Attribute count moves the ceiling more than variant count does, because
`productLevelStrategy: sameForAll` states a product attribute once in the feed
and writes it onto every variant in the plan — a measured 15× amplification.
Past the ceiling the pipeline explains itself rather than emitting V8's bare
`Invalid string length`; the way through today is to split the engagement across
configs with different `keys.prefix` values.

## Development

```bash
npm run typecheck     # tsc --noEmit over src/
npm test              # builds the tests, then runs them — the real gate
npm run build         # compile to dist/
```

`npm run typecheck` does **not** cover `test/`; only `npm test` does. There is
no linter configured.

## Licence

MIT — see [LICENSE](LICENSE).
