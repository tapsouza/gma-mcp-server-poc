import { setupServer } from 'msw/node';
import type { SetupServerApi } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { Config } from '../../src/core/config.js';
import type { OperatorToken } from '../../src/core/identity.js';

/** The base URL every test's GMA lives at. Not a real host. */
export const GMA_BASE_URL = 'https://gma.test.invalid';

/** A stand-in operator token. Realistic in shape so leak assertions are meaningful. */
export const TEST_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJqYW5lLmRvZUBleGFtcGxlLmNvbSJ9.test-signature' as OperatorToken;

/** A second, distinct token, for proving two identities do not bleed (FR-023a). */
export const OTHER_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6Im90aGVyIn0.eyJzdWIiOiJqb2huLnJvZUBleGFtcGxlLmNvbSJ9.other-signature' as OperatorToken;

/**
 * A test config. Overrides let a test shorten the timeout or the candidate cap — and,
 * for the customer domain, drive a bound with a small value so reaching it can be
 * asserted without building a 20-bet fixture.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return Object.freeze({
    gmaBaseUrl: GMA_BASE_URL,
    defaultInstances: Object.freeze(['PP', 'BF']),
    oktaIssuer: 'https://example.okta.invalid/oauth2/aus0',
    requestTimeoutMs: 30_000,
    maxCandidates: 25,
    customerMaxBets: 20,
    customerMaxEventResolutions: 10,
    logLevel: 'error',
    ...overrides
  });
}

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
