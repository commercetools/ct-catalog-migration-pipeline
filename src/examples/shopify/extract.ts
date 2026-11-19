/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 * A read-only extractor for the Shopify Admin GraphQL API. It copies the
 * catalog into files and maps nothing: the adapter reads those files, so the
 * feed can be regenerated without touching the shop again, and the snapshot
 * says exactly what the shop held at one moment.
 *
 * It sends plain queries and `bulkOperationRunQuery`, which runs a query
 * asynchronously over the whole catalog and leaves a JSONL file to download.
 * It changes nothing in the shop. It refuses a token that holds any `write_`
 * scope, because an extractor has no use for one, and it never sends the
 * token anywhere but the shop's own Admin API host: the result file is
 * downloaded from a signed URL on another host, without it.
 *
 * Every field below was checked against the API version it names. Check
 * them again for the version you run: Shopify removes fields between versions,
 * and a query naming a removed field fails as a whole.
 */

import { join } from 'node:path';

import { makePrivateDir, writePrivateFile } from '../../model/private-file.js';

export interface ExtractOptions {
  /** The shop's `*.myshopify.com` domain. */
  domain: string;
  /** An Admin API access token with read scopes only. Read from the environment, never from the command line. */
  token: string;
  /** A stable API version, `YYYY-MM`. Take it from Shopify's release notes, not from memory. */
  apiVersion: string;
  out: string;
  /** For tests. */
  fetch?: typeof fetch;
  pollMs?: number;
  log?: (line: string) => void;
}

export class ExtractStop extends Error {}

/** The Admin API answered with errors; `denied` when every one is a missing scope. */
class GraphqlErrors extends ExtractStop {
  constructor(
    message: string,
    readonly denied: boolean,
  ) {
    super(message);
  }
}

/** The first version that returns collections built with the 2026-07 collection model. */
export const MIN_API_VERSION = '2026-07';

/**
 * A bulk query holds at most five connections, nested at most two deep, so
 * the catalog is read in three operations: products with their variants,
 * collections, metafields and media; collections with their sources (rules,
 * hand-picked products, sub-collections); and, per variant, its own media and
 * its inventory levels. Deprecated fields (`ProductVariant.image`, `barcode`,
 * `Collection.ruleSet`) are left out, because a later version removes them and
 * the whole query fails.
 */
export const BULK_QUERIES: Record<'products' | 'collections' | 'variants', string> = {
  products: `{
  products {
    edges { node {
      id handle title descriptionHtml vendor productType tags status isGiftCard hasOnlyDefaultVariant
      createdAt updatedAt
      seo { title description }
      category { fullName }
      options { name position values }
      variants { edges { node {
        id sku position price compareAtPrice taxable inventoryPolicy
        selectedOptions { name value }
        inventoryItem { tracked measurement { weight { unit value } } }
      } } }
      collections { edges { node { id handle title } } }
      metafields { edges { node { id namespace key type value } } }
      media { edges { node { id mediaContentType ... on MediaImage { alt image { url width height } } } } }
    } }
  }
}`,
  collections: `{
  collections {
    edges { node {
      id handle title descriptionHtml sortOrder updatedAt
      sources { __typename ... on CollectionConditionsSource {
        inclusion { matchType conditions { __typename } } exclusion { conditions { __typename } }
      } }
    } }
  }
}`,
  variants: `{
  productVariants {
    edges { node {
      id sku
      media { edges { node { id mediaContentType ... on MediaImage { alt image { url width height } } } } }
      inventoryItem { id tracked
        inventoryLevels { edges { node {
          location { id name }
          quantities(names: ["available", "on_hand"]) { name quantity }
        } } }
      }
    } }
  }
}`,
};

const SHOP_QUERY = `{
  shop { name currencyCode taxesIncluded ianaTimezone }
  locations(first: 250) { edges { node { id name isActive } } }
  currentAppInstallation { accessScopes { handle } }
}`;

export async function extract(options: ExtractOptions): Promise<Record<string, number>> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const doFetch = options.fetch ?? fetch;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.domain)) {
    throw new ExtractStop(`"${options.domain}" is not a *.myshopify.com domain. The token is only ever sent to the shop's own Admin API host.`);
  }
  if (!/^\d{4}-(01|04|07|10)$/.test(options.apiVersion)) {
    throw new ExtractStop(`"${options.apiVersion}" is not a Shopify API version (YYYY-01, -04, -07 or -10). Take a supported one from Shopify's release notes.`);
  }
  if (options.apiVersion < MIN_API_VERSION) {
    // Older versions filter collections that use the 2026-07 collection model out of every result.
    throw new ExtractStop(`API version ${options.apiVersion} hides collections that use sub-collections or mixed sources; use ${MIN_API_VERSION} or later.`);
  }
  if (!options.token) throw new ExtractStop('No access token. Put it in the environment (SHOPIFY_ADMIN_TOKEN), never on the command line.');

  const endpoint = `https://${options.domain}/admin/api/${options.apiVersion}/graphql.json`;
  const gql = async (query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': options.token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 || res.status === 403) throw new ExtractStop(`The shop refused the token (HTTP ${res.status}). It may have been revoked, or lack a read scope.`);
    if (!res.ok) throw new ExtractStop(`HTTP ${res.status} from the Admin API: ${(await res.text()).slice(0, 300)}`);
    // An unsupported version is served as a newer one, and the query then runs against a schema it was not written for.
    const served = res.headers.get('x-shopify-api-version');
    if (served && served !== options.apiVersion) {
      throw new ExtractStop(`Asked for API version ${options.apiVersion}, the shop served ${served}: the requested version is not supported. Check the fields against ${served} and ask for it.`);
    }
    const body = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
    if (body.errors) {
      const errors = Array.isArray(body.errors) ? (body.errors as { extensions?: { code?: string } }[]) : [];
      const denied = errors.length > 0 && errors.every((e) => e.extensions?.code === 'ACCESS_DENIED');
      throw new GraphqlErrors(`The Admin API returned errors: ${JSON.stringify(body.errors).slice(0, 500)}`, denied);
    }
    return body.data ?? {};
  };

  const shopData = await gql(SHOP_QUERY);
  const scopes = ((shopData.currentAppInstallation as { accessScopes?: { handle: string }[] } | undefined)?.accessScopes ?? []).map((s) => s.handle);
  const writes = scopes.filter((s) => s.startsWith('write_'));
  if (writes.length > 0) {
    throw new ExtractStop(`The token holds ${writes.join(', ')}. An extractor only reads: ask for a token with read scopes only (read_products, read_inventory, read_locations, read_locales).`);
  }

  // The shop's locales tell the adapter which language the texts are in. They
  // need read_locales; without it the export goes on, and the adapter says the
  // language was not checked.
  let shopLocales: unknown;
  try {
    shopLocales = (await gql('{ shopLocales { locale primary published } }')).shopLocales;
  } catch (e) {
    if (!(e instanceof GraphqlErrors && e.denied)) throw e;
    log('shopLocales: not readable without the read_locales scope; the adapter will not be able to check the language of the texts.');
  }

  makePrivateDir(options.out);
  const edges = <T>(conn: unknown): T[] => ((conn as { edges?: { node: T }[] } | undefined)?.edges ?? []).map((e) => e.node);
  const shopFile = {
    apiVersion: options.apiVersion,
    extractedAt: new Date().toISOString(),
    shop: shopData.shop,
    locations: edges(shopData.locations),
    shopLocales,
  };
  writePrivateFile(join(options.out, 'shop.json'), JSON.stringify(shopFile, null, 2) + '\n');

  const counts: Record<string, number> = {};
  for (const [name, query] of Object.entries(BULK_QUERIES)) {
    const url = await runBulk(gql, name, query, options.pollMs ?? 5000, log);
    let text = '';
    if (url) {
      // A signed URL on Google Cloud Storage: the token must not go there.
      const res = await doFetch(url);
      if (!res.ok) throw new ExtractStop(`${name}: downloading the result failed with HTTP ${res.status}.`);
      text = await res.text();
    }
    writePrivateFile(join(options.out, `${name}.jsonl`), text);
    counts[name] = text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return counts;
}

async function runBulk(
  gql: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  name: string,
  query: string,
  pollMs: number,
  log: (line: string) => void,
): Promise<string | null> {
  const started = await gql(
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
    { q: query },
  );
  const run = started.bulkOperationRunQuery as { bulkOperation: { id: string } | null; userErrors: { message: string }[] };
  if (run.userErrors.length > 0 || !run.bulkOperation) throw new ExtractStop(`${name}: ${run.userErrors.map((e) => e.message).join('; ')}`);
  const id = run.bulkOperation.id;
  log(`${name}: bulk operation ${id} started`);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const polled = await gql(`query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount url partialDataUrl } } }`, { id });
    const op = polled.node as { status: string; errorCode: string | null; objectCount: string; url: string | null; partialDataUrl: string | null };
    log(`${name}: ${op.status} (${op.objectCount} objects)`);
    if (op.status === 'COMPLETED') return op.url; // null when the query matched nothing
    if (op.status !== 'CREATED' && op.status !== 'RUNNING') {
      // A partial file is not a snapshot: the adapter would map part of the catalog and say nothing.
      throw new ExtractStop(`${name}: the bulk operation ended ${op.status}${op.errorCode ? ` (${op.errorCode})` : ''}. Nothing was written for it; run the extractor again.`);
    }
  }
}
