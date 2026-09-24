/**
 * Clients, built on the official SDK.
 *
 * `@commercetools/ts-client` owns the transport: the client-credentials flow
 * and token lifecycle, retry with backoff, a concurrency queue, and correlation
 * IDs. All of that was previously hand-written here, and none of it was
 * migration-specific — the only reason it existed was to avoid a dependency.
 *
 * Two roots, because the Import API is on a different host from the HTTP API.
 * They share nothing but the credentials.
 *
 * What the SDK deliberately does NOT own, and this pipeline still must:
 *
 *   - Chunking resources into Import Requests of at most 20. The SDK posts the
 *     array it is given; it does not split it.
 *   - Container strategy (one per resource type, not per temporal batch).
 *   - Which Import Operation states to resubmit. `rejected` needs a new Import
 *     Request while `unresolved` must be left alone — and both arrive as HTTP
 *     200 with the state in the body, so no transport middleware can see them.
 */

import { ClientBuilder, type Client } from '@commercetools/ts-client';
import {
  createApiBuilderFromCtpClient as createPlatformApi,
  type ByProjectKeyRequestBuilder,
} from '@commercetools/platform-sdk';
import {
  createApiBuilderFromCtpClient as createImportApi,
  type ByProjectKeyRequestBuilder as ImportRequestBuilder,
} from '@commercetools/importapi-sdk';

import type { Credentials } from './credentials.js';

export interface ClientOptions {
  /**
   * In-flight requests. The Import API rate-limits per project, so a migration
   * competing with a storefront should stay modest rather than saturate.
   */
  concurrency?: number;
  maxRetries?: number;
  /** Injected by the tests; defaults to the platform's fetch. */
  httpClient?: unknown;
}

const RETRY_CODES = [429, 500, 502, 503, 504];

/**
 * Sent as the User-Agent, so a migration's traffic is identifiable in a
 * project's request logs. No version: it would have to be kept in step with
 * package.json by hand, and per-request traceability already comes from the
 * correlation ID middleware.
 */
const USER_AGENT = 'ct-catalog-migration-pipeline';

function build(credentials: Credentials, host: string, options: ClientOptions): Client {
  let builder = new ClientBuilder()
    .withProjectKey(credentials.projectKey)
    .withClientCredentialsFlow({
      host: credentials.authUrl,
      projectKey: credentials.projectKey,
      credentials: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      },
      ...(credentials.scopes ? { scopes: credentials.scopes.split(/\s+/) } : {}),
      ...(options.httpClient ? { httpClient: options.httpClient as Function } : {}),
    })
    .withHttpMiddleware({
      host,
      enableRetry: true,
      retryConfig: {
        maxRetries: options.maxRetries ?? 3,
        backoff: true,
        retryDelay: 300,
        retryCodes: RETRY_CODES,
      },
      ...(options.httpClient ? { httpClient: options.httpClient as Function } : {}),
    })
    // Serialises writes that collide on version rather than failing them.
    .withConcurrentModificationMiddleware()
    // A correlation ID per request makes a failed load traceable in support.
    .withCorrelationIdMiddleware()
    // The argument is NOT optional, whatever the types say: the builder
    // declares `options?: HttpUserAgentOptions`, but the middleware reads
    // `options.name` unconditionally, so calling this bare throws a TypeError
    // on the first request — before any network call, and nowhere near here.
    // A name is worth sending regardless: it identifies this pipeline's
    // traffic in a project's request logs.
    .withUserAgentMiddleware({ name: USER_AGENT });

  if (options.concurrency !== undefined) {
    builder = builder.withQueueMiddleware({ concurrency: options.concurrency });
  }

  return builder.build();
}

export interface Clients {
  /** HTTP API, scoped to the project. */
  platform: ByProjectKeyRequestBuilder;
  /** Import API, scoped to the project — a different host. */
  importApi: ImportRequestBuilder;
}

export function createClients(
  credentials: Credentials,
  options: ClientOptions = {},
): Clients {
  return {
    platform: createPlatformApi(
      build(credentials, credentials.apiUrl, options),
    ).withProjectKey({ projectKey: credentials.projectKey }),
    // The Import API's generated root names this differently from the
    // platform's — withProjectKeyValue, not withProjectKey.
    importApi: createImportApi(
      build(credentials, credentials.importUrl, options),
    ).withProjectKeyValue({ projectKey: credentials.projectKey }),
  };
}
