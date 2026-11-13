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

Fetch the source archive of the latest [release](https://github.com/commercetools/ct-catalog-migration-pipeline/releases)
into the engagement. It is a copy without git history, not a clone:

```bash
# from the engagement root
tag=$(gh release view --repo commercetools/ct-catalog-migration-pipeline --json tagName --jq .tagName)
echo "$tag"            # look at it before going on

mkdir ct-catalog-migration-pipeline && cd ct-catalog-migration-pipeline
curl -fsSL "https://github.com/commercetools/ct-catalog-migration-pipeline/archive/refs/tags/$tag.tar.gz" \
  | tar -xz --strip-components=1
npm ci --ignore-scripts
npm test               # no network, no credentials, a few seconds
```

Without the GitHub CLI, take the tag from the releases page. Node 22 or newer.
No global install; every command runs through `npm run`. `--ignore-scripts`
keeps the install scripts of dependencies from running on your machine; none of
them needs one, and CI installs the same way.

**What you have is plain files.** There is no `origin` to detach and no embedded
repository to ignore, so commit the directory with the engagement and change it
where the engagement needs it. Record the release tag in the engagement's
decision log, and say when the copy was changed, because then the tag is the
baseline and no longer an exact match.

**To upgrade**, fetch the new release into a scratch directory the same way and
diff it against your copy. Upstream fixes do not arrive by `git pull`.

## Stages

Each stage is independently runnable and reports rather than guesses. The first
four need no credentials at all.

| Stage | Needs credentials | What it does |
| :--- | :---: | :--- |
| `validate` | no | Checks the feed against the schema and the contract's integrity rules |
| `derive` | no | Builds ProductTypes from declared or observed attribute types |
| `plan` | no | Maps the feed to commercetools drafts and writes the decision log |
| `audit` | no | Re-derives every invariant the API enforces, from the written plan |
| `preflight` | yes | Asks whether the project will accept the plan, in a handful of GETs. Read-only unless a write is requested: `--apply` adds missing locales and currencies, and `--switch-catalog-model` switches a project that holds no products to `target.catalogModel` |
| `load` | yes | Dry run by default; `--execute` is the only thing that writes |
| `verify` | yes | Reads the project back and reconciles it against the plan |
| `teardown` | yes | Deletes what the plan created, scoped to `keys.prefix` (dry run unless `--execute --confirm-project <key>`) |

```bash
npm run pipeline -- validate  --config ../migration/migration.config.json
npm run pipeline -- derive    --config ../migration/migration.config.json
npm run pipeline -- plan      --config ../migration/migration.config.json
npm run pipeline -- audit     --config ../migration/migration.config.json
npm run pipeline -- preflight --config ../migration/migration.config.json
npm run pipeline -- load      --config ../migration/migration.config.json            # dry run
npm run pipeline -- load      --config ../migration/migration.config.json --execute
npm run pipeline -- verify    --config ../migration/migration.config.json
npm run pipeline -- teardown  --config ../migration/migration.config.json            # dry run
npm run pipeline -- teardown  --config ../migration/migration.config.json --execute --confirm-project <project-key>
npm run pipeline -- teardown  --config ../migration/migration.config.json --execute --confirm-project <project-key> --include-created-tax-categories   # also the tax categories this plan's load created
```

The engagement lives **beside** this repo, not inside it:

```
<engagement-root>/
  ct-catalog-migration-pipeline/   this repo — the tool, a fetched release, committed
  source-export/                   what the customer handed over
  migration/                       the engagement
    migration.config.json            written from the step-0 interview
    DECISIONS.md                     append-only record of what was decided
    adapter/                         the only code written per engagement
    feed/                            generated NDJSON — regenerated, never committed
    out/                             pipeline artefacts — regenerated, never committed
```

`--out` defaults to `out` **relative to the config**, so pointing `--config` at
the engagement writes the artefacts there.

**Give the engagement its own `.gitignore` before the first commit.** This repo's
`.gitignore` covers only its own folder: its `.env` files, `node_modules/`, and an
`out/` at its root. The engagement's `out/` sits next to the config, outside it.
Once customers or orders are in scope, `source-export/`, the feed,
`out/plan.json` and `out/load-requests.json` hold names, email addresses and
postal addresses, and a `git add .` in the engagement root would commit them.
Start the engagement's `.gitignore` at `<engagement-root>/.gitignore` as:

```text
/source-export/
/migration/feed/
/migration/out/
```

Anchor the entries with the leading `/`. A bare `out/` would also match the audit
fixtures this repo commits at `fixtures/*/out/plan.json`, which `npm test` reads,
so a copy committed without them fails its own tests for the next person.

### Progress

A command that takes a while says so on **stderr**, on a fixed interval and never
when something changes: one line per tick naming where it is, such as
`5m10s  load: waiting on ah12-category (container 1/3) · 7/12 imported · 5 unresolved · 0 processing · unchanged for 1m30s`,
and `done in 12m41s` when it ends. `--progress-interval <seconds>` sets the
interval (default 30, `0` for no ticks); a command shorter than that prints only
the closing line, and `--quiet` prints none. stdout is untouched, so `--json`
output stays parseable.

`derive`, `plan`, `load`, `verify` and `teardown --execute` also append the same
lines, timestamped, to `out/progress.log`, so a caller that pipes the command
through `tail` (and so sees nothing until it exits) can read it while the
command runs. Commands that write nothing else, such as `validate`, `audit`,
`preflight` and a `teardown` dry run, write no log.

Synchronous stages tick from their loops, so a tick can be late by the length of one
step between polls, never early.

## Configuration

One JSON file per engagement, copied from `migration.config.json` at this
repository's root and edited. Five of its values are **decisions, not
settings**: each is either irreversible or fails silently, so the loader
refuses an absent or placeholder value rather than defaulting one.

| Value | Why it cannot be defaulted |
| :--- | :--- |
| `keys.prefix` | Written into every key the migration creates, and what bounds a teardown to its own work. Ships as `REPLACE-ME`, which the loader refuses. |
| `target.catalogModel` | `Classic` or `Modular`. Decides the whole import shape, and must match the project's own setting. `preflight` checks it. A project that holds no products can be switched with `preflight --switch-catalog-model` (needs `manage_project_settings`; a write, never implied by `--apply`). One that holds products cannot: its variants are embedded, so it needs the staged [Modular Catalog migration](https://docs.commercetools.com/guides/migration-guides/modular-catalog-migration), whose Variant copy job only commercetools support can run. |
| `target.priceMode` | `embedded` or `standalone`. A product whose mode disagrees with where its prices are imports cleanly, reports success, and shows no price. |
| `market.defaultLocale` | Derived labels and slugs land here. A locale the project does not accept makes every affected record fail. |
| `market.currencyFractionDigits` | Minor-unit conversion per currency. A wrong value is a silently wrong price, not an error. |

Two more shape the model rather than the load: `productTypes.onMissingDefinitions`
(`require` or `infer` — whether the feed declares its own attribute types) and
`productTypes.productLevelStrategy` (`sameForAll` or `native` — note the names
read backwards, `sameForAll` is the safe default and `native` is the one that
makes attributes invisible to Product Projection Search).

One optional setting is for the small first run: `feed.subset: true` declares the
feed a slice of the catalog. `validate` then reports the tax categories and
channels nothing in the slice references as one line instead of one warning each,
because the products that use them sit outside it. Remove it for the full load.

The other optional setting is `target.taxMode`: `External` or `ExternalAmount` when
carts take their tax from an outside service, so a product with no tax category is
correct and `validate` stops warning about it, and about a category with no rates
or a country with no rate, for the same reason. Left out, it means `Platform`, the
default, and the warnings stay. It records an answer; it is not read from the
project, because the tax mode lives on each cart.

Customers and orders are **opt-in**: `entities.customers: true` and
`entities.orders: true` record that the user signed off on migrating personal
data. Left out, `validate` refuses every record of that entity, because nobody
has decided yet; `false` is the decision not to migrate that entity, and
`validate` then ignores its records with one warning. An order naming a customer
who is not migrated is refused: make it a guest order instead. The refusal is what
stops an adapter that emits customers nobody agreed to move at the first stage.
With the switch on, the feed, `plan.json` and the `load-requests` and `load-result`
files hold personal data. The pipeline writes every file in `out/` readable by its
owner only (`0600`), and an `out/` it creates is `0700`; a directory that already
exists keeps its mode. Keep them out of version control (the engagement's
`.gitignore` above), do not share them, and delete them once the migration no
longer needs them: a clean `verify` lists where they are. `teardown` reads
`plan.json`, so that one stays until any trial load is removed.

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
| `taxCategory` | a prerequisite like `channel`, carrying its rates; created if absent and **never modified** if present, so an existing category keeps the project's rates |
| `productSelection` | an assortment; importable, so its key is prefixed |
| `store` | a shopping context; key verbatim, created **last** because it references selections |
| `category` | hierarchy, slugs, order hints |
| `attributeDefinition` | declared attribute types — the alternative is inference, which needs review |
| `product`, `variant` | the catalog itself, with prices and assets |
| `inventoryEntry` | stock per `(sku, supplyChannel)`; a record of its own, so stock can be regenerated without rebuilding the catalog |
| `order` | opt-in (`entities.orders`); a snapshot: totals as given, never recomputed; order number **verbatim**, so outside `keys.prefix`; a SKU the feed does not declare becomes a custom line item; never sets `store` or `inventoryMode`; no payments |
| `customer` | opt-in (`entities.customers`); keyed on a source code, never the email; imported with `authenticationMode: ExternalAuth` and **no password field**, because no source hash can be imported; addresses named by code, Store-specific when `stores` is set |

`fixtures/` doubles as documentation: each directory is a runnable example of
one behaviour, including the deliberately broken ones.

## What it will not do

- **Parse your source.** That is the adapter's job, and the reason the contract
  exists.
- **Change a tax category that exists.** Its rates also tax shipping and belong
  to whoever owns tax. `preflight` names any difference from the feed; `load`
  only creates what is missing.
- **Guess at a decision that cannot be undone.** Attribute constraints, catalog
  model, price mode and product-selection modes are all permanent; the pipeline
  refuses an absent value rather than defaulting one.
- **Claim zero information loss.** Every approximation is recorded as a
  decision, and `out/MODEL-REVIEW.md` is meant to be read before loading.
- **Sync after cutover.** This is a one-time migration tool.
- **Migrate carts, payments or promotions,** or an order's shipping info,
  deliveries and returns. Catalog, its stock and, when the config opts in,
  customers and the core of each order. Stock is a one-time load to open on, not a sync:
  whatever owns inventory afterwards will move these numbers within the hour.
- **Migrate a password.** No source hash can be imported, so customers arrive
  under ExternalAuth, and how they sign in afterwards is the implementation's
  decision. `teardown` deletes customers and orders with `dataErasure`.
- **Delete an order it cannot vouch for.** Order numbers are verbatim, so a
  prefix cannot scope them: `teardown` deletes a planned order number only
  while its total and line counts still match the plan, and names the rest.
- **Keep old orders quiet.** Importing an order emits `OrderImported`, which
  every subscription listening for it receives: an order-confirmation email or
  an ERP export for a years-old order. Ask whoever owns the subscriptions before
  `load --execute`.

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

### Releases

Versions come from [changesets](https://github.com/changesets/changesets), and a
reader fetches the latest GitHub Release, so a change reaches readers when its
release is cut.

- A pull request that changes what the pipeline does adds a changeset
  (`npx changeset`). Before 1.0, a **minor** bump marks a change to anything the
  skill that drives this pipeline documents: the feed or config schema, a CLI
  flag, a diagnostic code, the `plan` or `key-map` format. A **patch** changes
  none of those. Say in the changeset what changed.
- A Dependabot update of a runtime dependency needs no changeset: `release.yml`
  adds a patch changeset when the lockfile's runtime packages differ from the
  last release. Dev dependencies and Actions updates do not release.
- On every push to `main`, `release.yml` opens or updates the **Version
  Packages** pull request. **A person merges it, and that merge is the
  release**: the workflow then tags the commit (`vX.Y.Z`) and creates the GitHub
  Release. Nothing approves or merges that pull request automatically. Merge a
  minor bump only once the skill's pages match it.
- `release.yml` starts CI on the Version Packages branch itself, because a pull
  request opened with the built-in token starts no workflow of its own.
- Protect release tags with a tag ruleset (`v*`: no update, no delete).
  Readers download and run what a tag points at.

## Licence

MIT — see [LICENSE](LICENSE).
