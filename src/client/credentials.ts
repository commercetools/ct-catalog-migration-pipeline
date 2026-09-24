/**
 * Credentials and hosts.
 *
 * Read from the environment, never from the pipeline config: the config
 * describes the migration and is committed, while credentials are per-operator
 * and must not be. A `.env` file is parsed directly rather than pulling in a
 * dependency for nine lines of work.
 *
 * The three hosts are genuinely different. In particular the Import API is NOT
 * on the HTTP API host, which is an easy and confusing thing to get wrong:
 *
 *   auth    https://auth.{region}.commercetools.com
 *   api     https://api.{region}.commercetools.com
 *   import  https://import.{region}.commercetools.com
 */

import { existsSync, readFileSync } from 'node:fs';

export const REGIONS = [
  'us-central1.gcp',
  'us-east-2.aws',
  'europe-west1.gcp',
  'eu-central-1.aws',
  'australia-southeast1.gcp',
] as const;

export type Region = (typeof REGIONS)[number];

export interface Credentials {
  projectKey: string;
  clientId: string;
  clientSecret: string;
  authUrl: string;
  apiUrl: string;
  importUrl: string;
  /**
   * Omitted by default. When no scope is requested, the token is granted every
   * scope the API Client has, which is what an operator almost always wants.
   */
  scopes?: string;
}

/** Parses a dotenv-style file. Values may be quoted; `export ` prefixes are tolerated. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

export class MissingCredentialsError extends Error {}

/**
 * Environment first, then `.env`. An explicitly exported variable should always
 * win over a file someone forgot they had.
 *
 * With one exception, and it is the whole reason this function is not two
 * lines: **if both name a project and they disagree, refuse.** Precedence is
 * a fine rule for hosts and regions and a dangerous one for the identity of
 * the project about to be written to. The realistic accident is someone with
 * working credentials exported in their shell writing a second project's
 * details into a file, passing `--env` to point at it, and loading a catalog
 * into the first project while reading the second one's name off their screen.
 * Silent precedence is exactly wrong there: the disagreement is the signal.
 */
export function loadCredentials(
  envPath = '.env',
  env: Record<string, string | undefined> = process.env,
): Credentials {
  const fromFile = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, 'utf8'))
    : {};
  const get = (name: string): string | undefined => env[name] ?? fromFile[name];

  const fileProject = fromFile['CTP_PROJECT_KEY'];
  const envProject = env['CTP_PROJECT_KEY'];
  if (fileProject && envProject && fileProject !== envProject) {
    throw new MissingCredentialsError(
      `Two different projects are configured.\n\n` +
        `  environment      CTP_PROJECT_KEY=${envProject}\n` +
        `  ${envPath}${' '.repeat(Math.max(1, 16 - envPath.length))}CTP_PROJECT_KEY=${fileProject}\n\n` +
        'The environment would win, so the run would use ' +
        `'${envProject}' — not the project named in the file you passed. Refusing ` +
        'rather than picking: loading a catalog into the wrong project is not ' +
        'something to discover afterwards.\n\n' +
        `Either unset the exported variables (unset CTP_PROJECT_KEY CTP_CLIENT_ID \n` +
        `CTP_CLIENT_SECRET) to use ${envPath}, or drop the file to use the environment.`,
    );
  }

  // No env file at all, and the environment names a project. That is either a
  // deliberate ambient setup — CI, a container — or the accident this refusal
  // exists for: a working directory with no credentials of its own, silently
  // borrowing whatever project the operator happened to export.
  //
  // A dogfood run did exactly that. It had no `.env`, so it targeted a project
  // nobody chose, and the disagreement check above could not fire because
  // there was no file to disagree with. What saved it was `preflight` printing
  // the project name, which is luck, not a guard.
  if (!existsSync(envPath) && envProject) {
    if (env['CTP_AMBIENT_OK'] !== '1') {
      throw new MissingCredentialsError(
        `No ${envPath}, so the run would use credentials from the environment:\n\n` +
          `  CTP_PROJECT_KEY=${envProject}\n\n` +
          'Refusing rather than proceeding. A directory with no credentials of its own ' +
          'is exactly where a run picks up a project nobody chose for it, and a catalog ' +
          'load is not something to discover in the wrong project afterwards.\n\n' +
          `Either write the credentials you mean into ${envPath} (or pass --env), or, if ` +
          'the ambient environment is deliberate — CI, a container — set ' +
          'CTP_AMBIENT_OK=1 to say so.',
      );
    }
  }

  const projectKey = get('CTP_PROJECT_KEY');
  const clientId = get('CTP_CLIENT_ID');
  const clientSecret = get('CTP_CLIENT_SECRET');

  const missing = [
    ['CTP_PROJECT_KEY', projectKey],
    ['CTP_CLIENT_ID', clientId],
    ['CTP_CLIENT_SECRET', clientSecret],
  ]
    .filter(([, v]) => !v)
    .map(([n]) => n as string);

  const region = get('CTP_REGION');
  const authUrl = get('CTP_AUTH_URL') ?? (region ? `https://auth.${region}.commercetools.com` : undefined);
  const apiUrl = get('CTP_API_URL') ?? (region ? `https://api.${region}.commercetools.com` : undefined);

  // The conventional commercetools environment set is PROJECT_KEY, CLIENT_ID,
  // CLIENT_SECRET, AUTH_URL and API_URL — there is no import URL in it, because
  // most integrations never touch the Import API. Derive it from the API host
  // so an existing setup works unchanged.
  const importUrl =
    get('CTP_IMPORT_URL') ??
    (region ? `https://import.${region}.commercetools.com` : undefined) ??
    deriveImportUrl(apiUrl);

  if (!authUrl || !apiUrl) {
    missing.push('CTP_REGION (or CTP_AUTH_URL and CTP_API_URL)');
  } else if (!importUrl) {
    // Both other hosts are known, so the only gap is an import host that could
    // not be derived — which happens behind a proxy or on a non-standard host.
    // Saying "CTP_REGION is missing" here would send the reader the wrong way.
    missing.push(
      `CTP_IMPORT_URL (it could not be derived from CTP_API_URL '${apiUrl}', which does ` +
        "not look like 'https://api.{region}.commercetools.com')",
    );
  }

  if (region && !REGIONS.includes(region as Region) && !get('CTP_API_URL')) {
    throw new MissingCredentialsError(
      `CTP_REGION '${region}' is not a known region. Expected one of:\n` +
        REGIONS.map((r) => `  ${r}`).join('\n') +
        '\nOr set CTP_AUTH_URL, CTP_API_URL and CTP_IMPORT_URL explicitly.',
    );
  }

  if (missing.length > 0) {
    throw new MissingCredentialsError(
      `Missing credential(s): ${missing.join(', ')}.\n\n` +
        'Copy .env.example to .env and fill it in, or export the variables.\n' +
        'The API Client needs view_project_settings for preflight, plus\n' +
        'manage_products and manage_import_containers for the load.',
    );
  }

  return {
    projectKey: projectKey!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    authUrl: stripSlash(authUrl!),
    apiUrl: stripSlash(apiUrl!),
    importUrl: stripSlash(importUrl!),
    ...(get('CTP_SCOPES') ? { scopes: get('CTP_SCOPES') } : {}),
  };
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `https://api.{region}.commercetools.com` → `https://import.{region}…`. */
function deriveImportUrl(apiUrl: string | undefined): string | undefined {
  if (!apiUrl) return undefined;
  const match = /^(https?:\/\/)api\.(.+)$/.exec(stripSlash(apiUrl));
  return match ? `${match[1]}import.${match[2]}` : undefined;
}

/** Never log a secret; this is what goes in diagnostics. */
export function describeCredentials(credentials: Credentials): string {
  return [
    `project  ${credentials.projectKey}`,
    `api      ${credentials.apiUrl}`,
    `import   ${credentials.importUrl}`,
    `client   ${credentials.clientId.slice(0, 4)}…${credentials.clientId.slice(-2)}`,
  ].join('\n');
}
