import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { extractOperatorToken, STDIO_TOKEN_ENV_VAR } from '../../src/core/identity.js';
import { GMA_BASE_URL, OTHER_TOKEN, TEST_TOKEN, testConfig, useGmaServer } from '../helpers/gma.js';

import instances200 from '../fixtures/gma/instances/200-success.json' with { type: 'json' };

/**
 * FR-023a and SC-010.
 *
 * This is the test that makes the later remote transport safe. Nothing in the local
 * stdio slice can exercise two concurrent operators, so the property is asserted NOW
 * — because retrofitting per-invocation identity later would be a cross-cutting
 * refactor whose failure mode is one operator seeing another operator's data.
 */

const server = useGmaServer();
const INSTANCES = `${GMA_BASE_URL}/v5/instances`;

/** Record which Authorization header each inbound request carried. */
function authRecorder() {
  const authorizations: (string | null)[] = [];

  server.use(
    http.get(INSTANCES, ({ request }) => {
      authorizations.push(request.headers.get('authorization'));
      return HttpResponse.json(instances200);
    })
  );

  return authorizations;
}

describe('identity isolation within one process (FR-023a, SC-010)', () => {
  it('forwards each sequential call its own token', async () => {
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });

    await client.get('/v5/instances', { token: TEST_TOKEN });
    await client.get('/v5/instances', { token: OTHER_TOKEN });

    expect(authorizations).toEqual([`Bearer ${TEST_TOKEN}`, `Bearer ${OTHER_TOKEN}`]);
  });

  it('forwards each CONCURRENT call its own token, with no bleed', async () => {
    // The real risk: two in-flight requests interleaving. If identity were held in
    // module state or in a client field, both would carry whichever token was set
    // last, and this would fail.
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });

    await Promise.all([
      client.get('/v5/instances', { token: TEST_TOKEN }),
      client.get('/v5/instances', { token: OTHER_TOKEN }),
      client.get('/v5/instances', { token: TEST_TOKEN }),
      client.get('/v5/instances', { token: OTHER_TOKEN })
    ]);

    expect(authorizations).toHaveLength(4);
    expect(authorizations.filter((a) => a === `Bearer ${TEST_TOKEN}`)).toHaveLength(2);
    expect(authorizations.filter((a) => a === `Bearer ${OTHER_TOKEN}`)).toHaveLength(2);
  });

  it('keeps identities separate across many interleaved calls', async () => {
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });

    const tokens = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? TEST_TOKEN : OTHER_TOKEN));
    await Promise.all(tokens.map((token) => client.get('/v5/instances', { token })));

    expect(authorizations.filter((a) => a === `Bearer ${TEST_TOKEN}`)).toHaveLength(10);
    expect(authorizations.filter((a) => a === `Bearer ${OTHER_TOKEN}`)).toHaveLength(10);
    expect(authorizations.filter((a) => a === null)).toHaveLength(0);
  });

  it('gives one shared client instance no memory of a previous caller', async () => {
    const authorizations = authRecorder();
    // One shared client, as a long-lived server would have. The token is a call
    // parameter, so the client itself holds no identity to leak.
    const client = createGmaClient({ config: testConfig() });

    await client.get('/v5/instances', { token: TEST_TOKEN });
    authorizations.length = 0;
    await client.get('/v5/instances', { token: OTHER_TOKEN });

    expect(authorizations).toEqual([`Bearer ${OTHER_TOKEN}`]);
    expect(authorizations[0]).not.toContain(TEST_TOKEN);
  });

  it('threads two different request-scoped identities end to end, extraction included', async () => {
    // The full path a remote transport will take: extract from the per-request
    // argument, then thread the value into the client. Both halves must stay
    // per-invocation for the property to hold.
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });

    const firstExtra = { authInfo: { token: TEST_TOKEN } };
    const secondExtra = { authInfo: { token: OTHER_TOKEN } };

    await Promise.all([
      client.get('/v5/instances', { token: extractOperatorToken(firstExtra, {}) }),
      client.get('/v5/instances', { token: extractOperatorToken(secondExtra, {}) })
    ]);

    expect(authorizations.sort()).toEqual([`Bearer ${TEST_TOKEN}`, `Bearer ${OTHER_TOKEN}`].sort());
  });

  it('lets a request-supplied identity override the ambient stdio one, per call', async () => {
    // Proves the stdio environment fallback is not a latch: a request that carries
    // its own bearer uses it, even while an env token exists. This is what makes the
    // HTTP transport additive rather than a behaviour change.
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });
    const env = { [STDIO_TOKEN_ENV_VAR]: TEST_TOKEN };

    await client.get('/v5/instances', { token: extractOperatorToken(undefined, env) });
    await client.get('/v5/instances', {
      token: extractOperatorToken({ authInfo: { token: OTHER_TOKEN } }, env)
    });

    expect(authorizations).toEqual([`Bearer ${TEST_TOKEN}`, `Bearer ${OTHER_TOKEN}`]);
  });

  it('never sends a request with no identity at all', async () => {
    const authorizations = authRecorder();
    const client = createGmaClient({ config: testConfig() });

    await client.get('/v5/instances', { token: TEST_TOKEN });

    expect(authorizations[0]).not.toBeNull();
    expect(authorizations[0]).toMatch(/^Bearer \S+$/);
  });
});
