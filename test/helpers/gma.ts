import { setupServer } from 'msw/node';
import type { SetupServerApi } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { Config } from '../../src/core/config.js';
import type { OperatorToken } from '../../src/core/identity.js';
import {
  resolveOperations,
  type CatalogueOperation,
  type Generation,
  type ResolvedOperation
} from '../../src/core/surface.js';

/** The base URL every test's GMA lives at. Not a real host. */
export const GMA_BASE_URL = 'https://gma.test.invalid';

/** A stand-in operator token. Realistic in shape so leak assertions are meaningful. */
export const TEST_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJqYW5lLmRvZUBleGFtcGxlLmNvbSJ9.test-signature' as OperatorToken;

/** A second, distinct token, for proving two identities do not bleed (FR-023a). */
export const OTHER_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6Im90aGVyIn0.eyJzdWIiOiJqb2huLnJvZUBleGFtcGxlLmNvbSJ9.other-signature' as OperatorToken;

/**
 * A test config. Overrides let a test shorten the timeout or change the generation.
 *
 * `defaultGeneration: 'v4'` mirrors what `loadConfig` produces from an unset
 * `GMA_CATALOGUE_GENERATION`, so a suite that overrides nothing exercises the DEFAULT
 * deployment rather than a test-only arrangement.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return Object.freeze({
    gmaBaseUrl: GMA_BASE_URL,
    defaultInstances: Object.freeze(['PP', 'BF']),
    oktaIssuer: 'https://example.okta.invalid/oauth2/aus0',
    requestTimeoutMs: 30_000,
    maxCandidates: 25,
    defaultGeneration: 'v4' as Generation,
    logLevel: 'error',
    ...overrides
  });
}

/**
 * The `ResolvedOperation` handle a tool would have been given at startup.
 *
 * The seam every parameterised suite uses: `describe.each(['v4','v5'])` builds the
 * handle for that generation, mounts a request handler at its path, and asserts the
 * request arrived there — which is what makes sharing one response body across both
 * generations honest rather than merely convenient (research.md R3).
 *
 * It goes through the real `resolveOperations`, not a hand-built object, so a suite
 * cannot accidentally assert against a handle the resolver would have refused to
 * produce — asking for `searchByName` on v4 fails here exactly as it would at startup.
 */
export function handle(
  operation: CatalogueOperation,
  generation: Generation = 'v4'
): ResolvedOperation {
  const resolved = resolveOperations({
    capability: 'test',
    operations: [operation],
    pins: { [operation]: generation },
    defaultGeneration: generation
  });

  return resolved[operation]!;
}

/** Handles for several operations at once, all on the same generation. */
export function handles<K extends CatalogueOperation>(
  operations: readonly K[],
  generation: Generation = 'v4'
): Record<K, ResolvedOperation> {
  return Object.fromEntries(
    operations.map((operation) => [operation, handle(operation, generation)])
  ) as Record<K, ResolvedOperation>;
}

/** Both generations, for `describe.each` over a parameterised suite. */
export const BOTH_GENERATIONS: readonly Generation[] = Object.freeze(['v4', 'v5']);

/**
 * Start an msw server for the calling suite and tear it down afterwards.
 *
 * `onUnhandledRequest: 'error'` is deliberate: a request to a path no handler covers
 * fails the test rather than silently returning nothing, so a wrong URL cannot pass
 * as a legitimate empty result.
 */
export function useGmaServer(): SetupServerApi {
  const server = setupServer();

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  return server;
}

/** What a handler observed about an inbound request, for header assertions. */
export interface ObservedRequest {
  readonly authorization: string | null;
  readonly traceparent: string | null;
  readonly url: string;
  readonly instancesList: string[];
  readonly body: unknown;
}

/** Record every request a suite's handlers saw. */
export function requestRecorder() {
  const seen: ObservedRequest[] = [];

  async function record(request: Request): Promise<void> {
    const url = new URL(request.url);
    let body: unknown = undefined;

    if (request.method === 'POST') {
      try {
        body = await request.clone().json();
      } catch {
        body = undefined;
      }
    }

    seen.push({
      authorization: request.headers.get('authorization'),
      traceparent: request.headers.get('traceparent'),
      url: request.url,
      instancesList: url.searchParams.getAll('instancesList'),
      body
    });
  }

  return { seen, record };
}
