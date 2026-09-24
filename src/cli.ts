#!/usr/bin/env node
/**
 * Pipeline CLI.
 *
 * Stage order is deliberate: every stage that can run without credentials runs
 * without them, so a broken feed reports the real problem on a laptop with no
 * .env. Only `preflight`, `load` and `verify` touch the network.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig, outDirFor } from './model/config.js';
import { hasErrors, validateFeed, type Diagnostic } from './contract/validate.js';
import { deriveProductTypes } from './derive/product-types.js';
import { describeType, writeDerived } from './derive/report.js';
import { buildPlan } from './map/plan.js';
import { writePlan } from './map/report.js';
import { auditPlan } from './audit/gate.js';
import { loadPlan } from './audit/load-plan.js';
import { checkPlanFreshness, feedDigest } from './contract/digest.js';
import { attributeDefinitionsOf, indexVariants, pricesOf, variantsOf } from './model/plan.js';
import { requiredCatalogModel } from './model/limits.js';
import { describeCredentials, loadCredentials, MissingCredentialsError } from './client/credentials.js';
import { createClients } from './client/factory.js';
import { effectiveCatalogModel, preflight } from './preflight/check.js';
import { runLoad } from './load/run.js';
import { countInFlight, fetchSnapshot } from './verify/snapshot.js';
import { planBatches } from './load/batches.js';
import { reconcile } from './verify/reconcile.js';
import { renderLoad, writeLoadArtefacts } from './load/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(HERE, '..', 'schema', 'catalog-feed.schema.json');

const USAGE = `
Usage: npm run pipeline -- <command> [options]

Commands (offline — no credentials required):
  validate    Check the feed against the contract and report every defect
  derive      Derive ProductTypes from the feed (declared, or inferred)
  plan        Map the feed to commercetools drafts and write the decision log
              (--payloads also writes one sample product per variant shape)
  audit       Run the target-invariant gate over the written plan

Commands (require credentials):
  preflight   Check the project: catalog model, locales, currencies
  load        Import the plan via the Import API (dry run unless --execute)
  verify      Read the project back and reconcile against the plan

Options:
  --config <path>   Pipeline config (default: ./migration.config.json)
  --out <dir>       Where artefacts are written and read (default: ./out)
  --env <path>      Credentials file (default: ./.env)
  --apply           preflight only: additively add missing locales/currencies
  --execute         load only: actually send the Import Requests
  --wait            load only: poll Import Summaries until nothing is processing
  --concurrency <n> load only: in-flight Import Requests (default 4)
  --json            Emit diagnostics as JSON
  --quiet           Suppress warnings, report errors only
`.trim();

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: 'string', default: 'migration.config.json' },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        out: { type: 'string', default: 'out' },
        payloads: { type: 'boolean', default: false },
        env: { type: 'string', default: '.env' },
        apply: { type: 'boolean', default: false },
        execute: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        concurrency: { type: 'string', default: '4' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }

  const opts = {
    config: values.config as string,
    json: values.json as boolean,
    quiet: values.quiet as boolean,
    out: values.out as string,
    payloads: values.payloads as boolean,
    env: values.env as string,
    apply: values.apply as boolean,
    execute: values.execute as boolean,
    wait: values.wait as boolean,
    concurrency: Number(values.concurrency),
  };

  switch (command) {
    case 'validate':
      return runValidate(opts);

    case 'derive':
      return runDerive(opts);

    case 'plan':
      return runPlan(opts);

    case 'audit':
      return runAudit(opts);

    case 'preflight':
      return await runPreflight(opts);

    case 'load':
      return await runLoadCommand(opts);

    case 'verify':
      return await runVerify(opts);

    default:
      console.error(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}


function runValidate(opts: { config: string; json: boolean; quiet: boolean }): number {
  const { config, feedDir, configPath } = loadConfig(resolve(opts.config));
  const result = validateFeed(feedDir, SCHEMA, config);

  const shown = opts.quiet
    ? result.diagnostics.filter((d) => d.severity === 'error')
    : result.diagnostics;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config: configPath,
          feedDir,
          accepted: result.accepted,
          rejected: result.rejected,
          counts: counts(result.feed),
          diagnostics: shown,
        },
        null,
        2,
      ),
    );
    return hasErrors(result.diagnostics) ? 1 : 0;
  }

  report(feedDir, result, shown, config.market.defaultLocale);
  return hasErrors(result.diagnostics) ? 1 : 0;
}

interface Opts {
  config: string;
  json: boolean;
  quiet: boolean;
  out: string;
  payloads: boolean;
  env: string;
  apply: boolean;
  execute: boolean;
  wait: boolean;
  concurrency: number;
}

function runDerive(opts: Opts): number {
  const { config, feedDir, configPath } = loadConfig(resolve(opts.config));

  // Derivation over an invalid feed would report defects that are really just
  // consequences of the feed being broken, so validation gates it.
  const validation = validateFeed(feedDir, SCHEMA, config);
  if (hasErrors(validation.diagnostics)) {
    console.error(
      'The feed does not validate, so no model was derived.\n' +
        'Run `validate` and fix the errors first.',
    );
    return 1;
  }

  const model = deriveProductTypes(validation.feed, config);
  const shown = opts.quiet
    ? model.diagnostics.filter((d) => d.severity === 'error')
    : model.diagnostics;

  if (hasErrors(model.diagnostics)) {
    if (opts.json) {
      console.log(JSON.stringify({ config: configPath, diagnostics: shown }, null, 2));
    } else {
      for (const d of shown) {
        console.log(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
        console.log(`      ${d.message}`);
      }
      console.log('');
      console.log('No model written — resolve the errors above first.');
    }
    return 1;
  }

  const outDir = outDirFor(opts);
  const written = writeDerived(outDir, model);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config: configPath,
          inferred: model.inferred,
          productTypes: [...model.productTypes.values()],
          decisions: model.decisions,
          diagnostics: shown,
          written,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    model.inferred
      ? 'Attribute types were INFERRED from observed values — the feed declared none.'
      : 'Attribute types came from the feed declarations.',
  );
  console.log('');

  for (const pt of model.productTypes.values()) {
    const members = [...model.assignment.values()].filter((k) => k === pt.key).length;
    console.log(`ProductType '${pt.key}' — ${members} product(s), ${attributeDefinitionsOf(pt).length} attribute(s)`);
    for (const a of attributeDefinitionsOf(pt)) {
      const flags = [
        a.attributeConstraint !== 'None' ? a.attributeConstraint : null,
        a.level === 'Product' ? 'Product-level' : null,
        a.isRequired ? 'required' : null,
        a.isSearchable ? 'searchable' : null,
      ].filter(Boolean);
      console.log(
        `  ${a.name.padEnd(18)} ${describeType(a.type).padEnd(16)} ${flags.join(', ')}`,
      );
    }
    console.log('');
  }

  for (const d of shown.filter((x) => x.severity === 'warning')) {
    console.log(`warn  [${d.code}]`);
    console.log(`      ${d.message}`);
  }
  if (shown.some((x) => x.severity === 'warning')) console.log('');

  const irreversible = model.decisions.filter((d) => d.irreversible).length;
  const lossy = model.decisions.filter((d) => d.lossy).length;
  const review = model.decisions.filter((d) => d.review).length;

  console.log(
    `${model.decisions.length} decision(s) recorded: ${irreversible} irreversible, ` +
      `${lossy} lossy, ${review} needing review`,
  );
  console.log(`  ${relative(process.cwd(), written.productTypesPath)}`);
  console.log(`  ${relative(process.cwd(), written.decisionsPath)}`);
  if (written.reviewPath) {
    console.log(`  ${relative(process.cwd(), written.reviewPath)}  ← read this before loading`);
  }
  console.log('');
  console.log('Next: `plan` to map the feed to drafts.');
  return 0;
}

function runPlan(opts: Opts): number {
  const { config, feedDir, configPath } = loadConfig(resolve(opts.config));

  const validation = validateFeed(feedDir, SCHEMA, config);
  if (hasErrors(validation.diagnostics)) {
    console.error(
      'The feed does not validate, so no plan was built.\nRun `validate` and fix the errors first.',
    );
    return 1;
  }

  const model = deriveProductTypes(validation.feed, config);
  if (hasErrors(model.diagnostics)) {
    console.error(
      'The product model has unresolved errors, so no plan was built.\nRun `derive` and fix them first.',
    );
    return 1;
  }

  const { plan, diagnostics } = buildPlan(validation.feed, model, config);
  const shown = opts.quiet
    ? diagnostics.filter((d) => d.severity === 'error')
    : diagnostics;

  if (hasErrors(diagnostics)) {
    if (opts.json) {
      console.log(JSON.stringify({ config: configPath, diagnostics: shown }, null, 2));
    } else {
      for (const d of shown) {
        console.log(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
        console.log(`      ${d.message}`);
      }
      console.log('');
      console.log('No plan written — resolve the errors above first.');
    }
    return 1;
  }

  // Stamped here rather than in `buildPlan`, which is pure over the feed
  // object and worth keeping that way. This is the only place that knows both
  // the plan and the directory it came from.
  plan.provenance = {
    feedDigest: feedDigest(feedDir),
    generatedAt: new Date().toISOString(),
  };

  const written = writePlan(outDirFor(opts), plan, opts.payloads);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { config: configPath, plan, diagnostics: shown, written },
        null,
        2,
      ),
    );
    return 0;
  }

  // Counted through the index: a Modular plan keeps its variants beside the
  // products rather than inside them.
  const variantsByProduct = indexVariants(plan);
  const allVariants = [...variantsByProduct.values()].flat();
  const variants = allVariants.length;
  const prices = allVariants.reduce((n, v) => n + pricesOf(v).length, 0);

  // An empty stage is skipped by the loader, so showing it in the stage list
  // would invite the question of why nothing happened there.
  const populated = plan.loadOrder.filter((stage) => {
    if (stage === 'standalone-price') return plan.standalonePrices.length > 0;
    if (stage === 'variant') return plan.variants.length > 0;
    return true;
  });

  console.log(`Plan: ${populated.join(' → ')}`);
  console.log(`  ${plan.productTypes.length} product type(s)`);
  console.log(`  ${plan.categories.length} category(ies)`);
  console.log(`  ${plan.products.length} product(s), ${variants} variant(s)`);
  console.log(
    plan.standalonePrices.length > 0
      ? `  ${plan.standalonePrices.length} standalone price(s)`
      : `  ${prices} embedded price(s)`,
  );
  console.log('');

  for (const d of shown.filter((x) => x.severity === 'warning')) {
    console.log(`warn  [${d.code}]`);
    console.log(`      ${d.message}`);
  }
  if (shown.some((x) => x.severity === 'warning')) console.log('');

  const irreversible = plan.decisions.filter((d) => d.irreversible).length;
  const lossy = plan.decisions.filter((d) => d.lossy).length;
  const review = plan.decisions.filter((d) => d.review).length;
  console.log(
    `${plan.decisions.length} decision(s): ${irreversible} irreversible, ${lossy} lossy, ` +
      `${review} needing review`,
  );
  console.log(`  ${relative(process.cwd(), written.planPath)}`);
  console.log(`  ${relative(process.cwd(), written.keyMapPath)}`);
  console.log(`  ${relative(process.cwd(), written.decisionsPath)}`);
  if (written.payloadsPath) {
    console.log(`  ${relative(process.cwd(), written.payloadsPath)}`);
  }
  console.log('');
  console.log('Next: `audit` to check the plan against the invariants the API enforces.');
  return 0;
}

function runAudit(opts: Opts): number {
  const { config, feedDir } = loadConfig(resolve(opts.config));

  // Read the plan from disk rather than rebuilding it. The gate is meant to be
  // an independent check on what will be sent; sharing the mapper's in-memory
  // result would only confirm the mapper's own assumptions.
  let plan;
  try {
    plan = loadPlan(outDirFor(opts));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  // Before the gate, not after: a stale plan makes every check below it
  // meaningless, and a clean report over the wrong data is worse than no
  // report at all.
  const freshness = checkPlanFreshness(plan, feedDir, 'audit');
  if (freshness.some((d) => d.severity === 'error')) {
    for (const d of freshness) {
      console.log(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
      console.log(`      ${d.message}`);
    }
    console.log('');
    console.log('Nothing audited.');
    return 1;
  }

  const { diagnostics: gateDiagnostics, checked } = auditPlan(plan, config);
  const diagnostics = [...freshness, ...gateDiagnostics];
  const shown = opts.quiet
    ? diagnostics.filter((d) => d.severity === 'error')
    : diagnostics;

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (opts.json) {
    console.log(JSON.stringify({ checked, diagnostics: shown }, null, 2));
    return errors.length > 0 ? 1 : 0;
  }

  console.log(
    `Audited ${checked.productTypes} product type(s), ${checked.categories} category(ies), ` +
      `${checked.products} product(s), ${checked.variants} variant(s), ` +
      `${checked.prices} embedded price(s), ${checked.standalonePrices} standalone price(s), ` +
      `${checked.attributeValues} attribute value(s).`,
  );
  console.log('');

  const grouped = new Map<string, Diagnostic[]>();
  for (const d of shown) {
    const bucket = grouped.get(d.code) ?? [];
    bucket.push(d);
    grouped.set(d.code, bucket);
  }

  // Errors first, and grouped by check: a single broken assumption in an
  // adapter usually produces hundreds of instances of one code, and listing
  // them flat buries every other finding.
  const order = [...grouped.entries()].sort((a, b) => {
    const severity = (e: [string, Diagnostic[]]) => (e[1][0].severity === 'error' ? 0 : 1);
    return severity(a) - severity(b) || b[1].length - a[1].length;
  });

  const SHOW_PER_CODE = 5;
  for (const [code, items] of order) {
    const label = items[0].severity === 'error' ? 'ERROR' : 'warn ';
    console.log(`${label} [${code}] ${items.length} occurrence(s)`);
    for (const d of items.slice(0, SHOW_PER_CODE)) {
      console.log(`      ${d.message}`);
    }
    if (items.length > SHOW_PER_CODE) {
      console.log(`      … and ${items.length - SHOW_PER_CODE} more (use --json for all)`);
    }
    console.log('');
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('Audit passed with nothing to report.');
  } else {
    console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  }

  if (errors.length > 0) {
    console.log('');
    console.log('The load is blocked. Every error above would be rejected by the API,');
    console.log('and finding them here costs nothing.');
    return 1;
  }

  console.log('');
  console.log('Next: `preflight` to check the target project, then `load`.');
  return 0;
}


async function runPreflight(opts: Opts): Promise<number> {
  const { config } = loadConfig(resolve(opts.config));

  let credentials;
  try {
    credentials = loadCredentials(resolve(opts.env));
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      console.error((err as Error).message);
      return 1;
    }
    throw err;
  }

  // The plan is optional but much better to have: without it, preflight can
  // only check what the config declares, and a plan can carry a locale or
  // currency nobody remembered to list.
  let plan;
  try {
    plan = loadPlan(outDirFor(opts));
  } catch {
    plan = undefined;
  }

  const clients = createClients(credentials);
  const result = await preflight(clients, config, plan, { apply: opts.apply });

  const shown = opts.quiet
    ? result.diagnostics.filter((d) => d.severity === 'error')
    : result.diagnostics;
  const errors = result.diagnostics.filter((d) => d.severity === 'error');

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: result.project,
          counts: result.counts,
          pending: result.pending,
          applied: result.applied,
          planLoaded: plan !== undefined,
          diagnostics: shown,
        },
        null,
        2,
      ),
    );
    return errors.length > 0 ? 1 : 0;
  }

  // Print which project is about to be written to, prominently and first.
  console.log(describeCredentials(credentials));
  if (result.project) {
    console.log(`name     ${result.project.name}`);
    console.log(
      `model    ${effectiveCatalogModel(result.project)}` +
        (result.project.productCatalogModel === undefined ? ' (unset default)' : ''),
    );
    console.log(`accepts  languages [${result.project.languages.join(', ')}]`);
    console.log(`         currencies [${result.project.currencies.join(', ')}]`);
    console.log(`         countries [${result.project.countries.join(', ')}]`);
  }
  if (result.counts) {
    console.log(
      `holds    ${result.counts.productTypes} product type(s), ` +
        `${result.counts.categories} category(ies), ${result.counts.products} product(s)`,
    );
  }
  console.log(plan !== undefined ? 'plan     loaded, checked against it' : 'plan     none found — checked against the config only');
  console.log('');

  for (const d of shown) {
    console.log(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
    console.log(`      ${d.message}`);
    console.log('');
  }

  if (errors.length === 0) {
    console.log(result.applied ? 'Preflight passed, after applying the changes above.' : 'Preflight passed.');
    console.log('Next: `load` — a dry run writes the exact request bodies and sends nothing.');
    return 0;
  }

  console.log(`${errors.length} error(s).`);
  const fixable = result.pending.languages.length + result.pending.currencies.length > 0;
  if (fixable && !opts.apply) {
    console.log('Re-run with --apply to add the missing locales and currencies.');
    console.log('Existing values are preserved — the update sends the union, never a replacement.');
  }
  return 1;
}


async function runLoadCommand(opts: Opts): Promise<number> {
  const { config, feedDir } = loadConfig(resolve(opts.config));

  let plan;
  try {
    plan = loadPlan(outDirFor(opts));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  // Freshness first, for the same reason `audit` checks it first — and with
  // more at stake here, because this is the stage that writes. Loading a plan
  // that does not match the feed loads a catalog nobody reviewed.
  const freshness = checkPlanFreshness(plan, feedDir, 'load');
  for (const d of freshness) {
    console.error(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
    console.error(`      ${d.message}`);
  }
  if (freshness.some((d) => d.severity === 'error')) {
    console.error('');
    console.error('Nothing was loaded.');
    return 1;
  }

  // The gate runs again here rather than trusting that someone ran it. It is
  // free, and the alternative is discovering a rejected invariant one request
  // at a time, after some of the catalog has already landed.
  const audit = auditPlan(plan, config);
  const auditErrors = audit.diagnostics.filter((d) => d.severity === 'error');
  if (auditErrors.length > 0) {
    console.error(
      `The plan has ${auditErrors.length} audit error(s), so nothing was loaded.\n` +
        'Run `audit` to see them.',
    );
    return 1;
  }

  // Credentials are needed even for a dry run's host resolution. A dry run
  // sends no writes, but it is not request-free: it reads channels and
  // customer groups so it can name the ones it would create. That read failing
  // is a warning, not an error, so an unreachable project still yields a dry
  // run — just one that cannot split those two stages into existing/created.
  let credentials;
  try {
    credentials = loadCredentials(resolve(opts.env));
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      console.error((err as Error).message);
      return 1;
    }
    throw err;
  }

  if (opts.execute) {
    console.log(describeCredentials(credentials));
    console.log('');
  }

  const clients = createClients(credentials, { concurrency: opts.concurrency });
  const result = await runLoad(clients, plan, config, {
    execute: opts.execute,
    wait: opts.wait,
    concurrency: opts.concurrency,
  });

  const shown = opts.quiet
    ? result.diagnostics.filter((d) => d.severity === 'error')
    : result.diagnostics;
  const errors = result.diagnostics.filter((d) => d.severity === 'error');

  const artefact = writeLoadArtefacts(outDirFor(opts), result);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          executed: result.executed,
          prerequisites: result.prerequisites,
          stages: result.stages,
          summaries: result.summaries,
          diagnostics: shown,
          written: artefact,
        },
        null,
        2,
      ),
    );
    return errors.length > 0 ? 1 : 0;
  }

  for (const line of renderLoad(result)) console.log(line);

  for (const d of shown) {
    console.log(`${d.severity === 'error' ? 'ERROR' : 'warn '} [${d.code}]`);
    console.log(`      ${d.message}`);
    console.log('');
  }

  console.log(`  ${relative(process.cwd(), artefact)}`);
  console.log('');

  if (!result.executed) {
    console.log('Read the request bodies above, then re-run with --execute.');
    return 0;
  }

  if (errors.length > 0) {
    console.log(`${errors.length} error(s). Fix the cause and re-run — keys are`);
    console.log('deterministic, so a second run updates rather than duplicating.');
    return 1;
  }

  console.log('Next: `verify` to read the project back and reconcile it against the plan.');
  console.log('An accepted Import Request is not an imported resource — verify is what');
  console.log('tells the two apart.');
  return 0;
}

/**
 * Read the project back and reconcile it against the plan.
 *
 * The only credentialed stage that cannot change anything, so it is safe to
 * run whenever a load's outcome is in question — including against production.
 */
async function runVerify(opts: Opts): Promise<number> {
  const { config, configPath } = loadConfig(resolve(opts.config));

  let credentials;
  try {
    credentials = loadCredentials(resolve(opts.env));
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      console.error((err as Error).message);
      return 1;
    }
    throw err;
  }

  // Unlike preflight, the plan is not optional: there is nothing to reconcile
  // against without it.
  let plan;
  try {
    plan = loadPlan(outDirFor(opts));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const clients = createClients(credentials);
  console.log(describeCredentials(credentials));
  console.log('');

  const { snapshot, diagnostics: readDiagnostics, unreadable } = await fetchSnapshot(
    clients,
    plan,
  );

  // Comparing against a kind that could not be read would report every planned
  // resource as missing and bury the real cause in the noise.
  if (unreadable.length > 0) {
    for (const d of readDiagnostics) {
      console.log(`ERROR [${d.code}]`);
      console.log(`      ${d.message}`);
    }
    console.log('');
    console.log(
      `Could not read: ${unreadable.join(', ')}. Nothing was compared — a missing read ` +
        'scope looks exactly like an empty project.',
    );
    return 1;
  }

  const result = reconcile(plan, snapshot, config);

  // Absence has two causes, and they need different reactions: the load failed,
  // or the load is still resolving. Reading the operation states is the only way
  // to tell, and without it a verify run minutes after a load reports every
  // unresolved resource as missing — in wording written for a real failure.
  //
  // Only asked when something *is* absent. On a clean verify these requests
  // would buy nothing.
  const absent = result.diagnostics.filter((d) => d.code.endsWith('-missing'));
  const inFlightNotes: Diagnostic[] = [];
  if (absent.length > 0) {
    const containers = planBatches(plan, config).containers.map((c) => c.key);
    const flight = await countInFlight(clients, containers);
    const pending = flight.unresolved + flight.processing;
    if (flight.readable && pending > 0) {
      inFlightNotes.push({
        severity: 'warning',
        code: 'operations-in-flight',
        message:
          `${pending} import operation(s) are still in flight for this plan ` +
          `(${flight.unresolved} unresolved, ${flight.processing} processing), and ` +
          `${absent.length} planned resource(s) are reported absent below.\n` +
          '      Those two facts are probably the same fact. An `unresolved` operation is ' +
          'waiting for a KeyReference target — a category for its parent, a product for ' +
          'its category — and completes on its own once the target lands, any time within ' +
          '48 hours of the operation being created.\n' +
          '      `--wait` does **not** cover this: it drains `processing`, not the ' +
          'resolution window. Wait and re-run `verify` before treating the absences below ' +
          'as a failed load. If the count does not fall, something the plan referenced was ' +
          'never imported.',
      });
    }
  }

  const diagnostics = [...readDiagnostics, ...inFlightNotes, ...result.diagnostics];
  const shown = opts.quiet ? diagnostics.filter((d) => d.severity === 'error') : diagnostics;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (opts.json) {
    console.log(
      JSON.stringify(
        { config: configPath, checked: result.checked, found: result.found, diagnostics: shown },
        null,
        2,
      ),
    );
    return errors.length > 0 ? 1 : 0;
  }

  console.log(
    `Reconciled ${result.found.productTypes}/${result.checked.productTypes} product type(s), ` +
      `${result.found.categories}/${result.checked.categories} category(ies), ` +
      `${result.found.products}/${result.checked.products} product(s), ` +
      `${result.checked.variants} variant(s), ${result.checked.prices} price(s)` +
      // Only mentioned when the feed declares them: most engagements have
      // none, and a line of zeroes teaches the reader to skim the summary.
      (result.checked.productSelections > 0
        ? `, ${result.found.productSelections}/${result.checked.productSelections} product selection(s)`
        : '') +
      (result.checked.stores > 0
        ? `, ${result.found.stores}/${result.checked.stores} store(s)`
        : '') +
      '.',
  );
  console.log('');

  const grouped = new Map<string, Diagnostic[]>();
  for (const d of shown) {
    const bucket = grouped.get(d.code) ?? [];
    bucket.push(d);
    grouped.set(d.code, bucket);
  }

  for (const [code, group] of grouped) {
    console.log(
      `${group[0].severity === 'error' ? 'ERROR' : 'warn '} [${code}] ` +
        `${group.length} occurrence(s)`,
    );
    for (const d of group.slice(0, 5)) console.log(`      ${d.message}`);
    if (group.length > 5) console.log(`      … and ${group.length - 5} more`);
    console.log('');
  }

  if (errors.length === 0) {
    console.log(
      warnings.length === 0
        ? 'Verified. The project matches the plan.'
        : `Verified with ${warnings.length} warning(s). Nothing is missing or wrong.`,
    );
    return 0;
  }

  console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  console.log('The project does not match the plan. Because every key is deterministic,');
  console.log('re-running `load --execute` updates rather than duplicating — fix the cause');
  console.log('first, or the same operations will fail the same way.');
  return 1;
}

function counts(feed: ReturnType<typeof validateFeed>['feed']) {
  return {
    categories: feed.categories.size,
    attributeDefinitions: feed.attributeDefinitions.size,
    products: feed.products.size,
    variants: feed.variants.size,
  };
}

function report(
  feedDir: string,
  result: ReturnType<typeof validateFeed>,
  shown: Diagnostic[],
  defaultLocale: string,
): void {
  const c = counts(result.feed);

  console.log(`Feed: ${feedDir}`);
  console.log(
    `  ${c.categories} categories, ${c.products} products, ${c.variants} variants, ` +
      `${c.attributeDefinitions} attribute definitions`,
  );

  // The catalog model is a project-level decision, and variant counts are the
  // one input to it the feed can answer on its own. Stated even when it fits,
  // because "Classic is enough" is the answer someone is looking for.
  let largest = { code: '', variants: 0 };
  for (const [code, skus] of result.feed.variantsByProduct) {
    if (skus.length > largest.variants) largest = { code, variants: skus.length };
  }
  if (largest.variants > 0) {
    console.log(
      `  Largest product: '${largest.code}' with ${largest.variants} variant(s) — ` +
        `${requiredCatalogModel(largest.variants)} catalog model required`,
    );
  }
  if (c.attributeDefinitions === 0) {
    console.log(
      '  No attribute definitions in the feed — ProductTypes would be inferred from\n' +
        '  observed values, which needs an explicit review before loading.',
    );
  }
  if (result.rejected > 0) {
    console.log(
      `  ${result.rejected} record(s) rejected and excluded from these counts.\n` +
        '  Catalog-wide integrity checks are deferred until every record parses, so\n' +
        '  fix these first and re-run — there may be more to find behind them.',
    );
  }
  console.log('');

  const errors = shown.filter((d) => d.severity === 'error');
  const warnings = shown.filter((d) => d.severity === 'warning');

  for (const group of [errors, warnings]) {
    for (const d of group) {
      const where = d.file ? `${relative(process.cwd(), d.file)}:${d.line} ` : '';
      const label = d.severity === 'error' ? 'ERROR' : 'warn ';
      console.log(`${label} ${where}[${d.code}]`);
      console.log(`      ${d.message}`);
    }
  }

  if (shown.length > 0) console.log('');

  const total = result.diagnostics;
  const errorCount = total.filter((d) => d.severity === 'error').length;
  const warnCount = total.filter((d) => d.severity === 'warning').length;

  if (errorCount === 0 && warnCount === 0) {
    console.log(`Feed is valid. Default locale is ${defaultLocale}.`);
    console.log('Next: `derive` to build the ProductTypes.');
  } else {
    const suppressed = total.length - shown.length;
    console.log(
      `${errorCount} error(s), ${warnCount} warning(s)` +
        (suppressed > 0 ? ` (${suppressed} suppressed by --quiet)` : ''),
    );
    if (errorCount > 0) {
      // Almost every error here is the adapter's to fix. A few are not: the
      // feed is correct and a *decision* is missing. Pointing at the adapter
      // then sends someone off to change data that is already right.
      const notAdapterDefects = new Set([
        'catalog-model-insufficient',
        'media-base-url-required',
      ]);
      const decisionOnly = total
        .filter((d) => d.severity === 'error')
        .every((d) => notAdapterDefects.has(d.code));

      if (decisionOnly) {
        console.log('This is not an adapter defect — the feed is valid. What is missing is a');
        console.log('decision, and the error above says which and who can make it.');
      } else {
        console.log('Fix the errors in the adapter, not in the feed by hand — the feed is');
        console.log('regenerated on every run.');
      }
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error((err as Error).message ?? String(err));
    process.exitCode = 1;
  },
);
