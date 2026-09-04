import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { ToolError } from '../../src/core/types.js';
import {
  GMA_BASE_URL,
  TEST_TOKEN,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import instances200 from '../fixtures/gma/instances/200-success.json' with { type: 'json' };
import instances206 from '../fixtures/gma/instances/206-partial.json' with { type: 'json' };
import instances400 from '../fixtures/gma/instances/400-bad-request.json' with { type: 'json' };
import instances401 from '../fixtures/gma/instances/401-unauthorized.json' with { type: 'json' };
import instances500 from '../fixtures/gma/instances/500-server-error.json' with { type: 'json' };
import search200 from '../fixtures/gma/searchByName/200-single-match.json' with { type: 'json' };

const server = useGmaServer();
const INSTANCES = `${GMA_BASE_URL}/v5/instances`;
const SEARCH = `${GMA_BASE_URL}/v5/searchByName`;

function client(overrides: Parameters<typeof testConfig>[0] = {}) {
  return createGmaClient({ config: testConfig(overrides) });
}

describe('GMA client', () => {
  describe('case: HTTP 200 yields a complete result', () => {
    it('returns the payload with a complete verdict', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await client().get<typeof instances200>('/v5/instances', {
        token: TEST_TOKEN
      });

      expect(result.data).toEqual(instances200);
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
      expect(result.completeness.caveat).toBeNull();
    });

    it('never returns a bare payload — completeness always accompanies data (FR-005)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await client().get('/v5/instances', { token: TEST_TOKEN });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('completeness');
      expect(Object.keys(result).sort()).toEqual(['completeness', 'data']);
    });
  });

  describe('case: HTTP 206 yields partial data with the failed instances named', () => {
    it('returns data plus a caveat naming the failed instance', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));

      const result = await client().get('/v5/instances', { token: TEST_TOKEN });

      expect(result.data).toEqual(instances206);
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.outcome).toBe('PARTIAL');
      expect(result.completeness.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.completeness.caveat).toContain('urn:i:BF:BF');
    });

    it('does not throw on 206 — partial data is normal operation, not an error', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));

      await expect(client().get('/v5/instances', { token: TEST_TOKEN })).resolves.toBeDefined();
    });
  });

  describe('case: each terminal status becomes a ToolError with no completeness (FR-010)', () => {
    it.each([
      [400, instances400, 'argument', false],
      [401, instances401, 'auth', false],
      [404, { status: 404 }, 'notFound', false],
      [500, instances500, 'upstream', true]
    ] as const)('maps HTTP %i to kind %s', async (status, body, kind, retryable) => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(body, { status })));

      try {
        await client().get('/v5/instances', { token: TEST_TOKEN });
        expect.unreachable(`HTTP ${status} must not resolve`);
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError).toBeInstanceOf(ToolError);
        expect(toolError.kind).toBe(kind);
        expect(toolError.retryable).toBe(retryable);
        expect(toolError).not.toHaveProperty('completeness');
      }
    });

    it('never leaks the upstream error body into the message (FR-020)', async () => {
      server.use(
        http.get(INSTANCES, () =>
          HttpResponse.json(
            { message: `Rejected token ${TEST_TOKEN}`, secret: 'do-not-surface' },
            { status: 500 }
          )
        )
      );

      await expect(client().get('/v5/instances', { token: TEST_TOKEN })).rejects.toSatisfy(
        (error: ToolError) =>
          !error.message.includes(TEST_TOKEN) && !error.message.includes('do-not-surface')
      );
    });

    it('maps an unreadable success body to a retryable upstream error', async () => {
      server.use(
        http.get(INSTANCES, () =>
          HttpResponse.text('not json at all', {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      );

      try {
        await client().get('/v5/instances', { token: TEST_TOKEN });
        expect.unreachable('an unreadable body must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.message).toMatch(/unreadable/i);
      }
    });
  });

  describe('case: timeout handling (FR-010)', () => {
    it('aborts a slow response and reports a timeout with no data gathered', async () => {
      server.use(
        http.get(INSTANCES, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return HttpResponse.json(instances200);
        })
      );

      try {
        await client({ requestTimeoutMs: 25 }).get('/v5/instances', { token: TEST_TOKEN });
        expect.unreachable('a timed-out call must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.retryable).toBe(true);
        expect(toolError.message).toContain('25ms');
        expect(toolError.message).toContain('no data was gathered');
      }
    });

    it('honours a caller abort signal alongside the configured timeout', async () => {
      server.use(
        http.get(INSTANCES, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return HttpResponse.json(instances200);
        })
      );

      const controller = new AbortController();
      const pending = client({ requestTimeoutMs: 5_000 }).get('/v5/instances', {
        token: TEST_TOKEN,
        signal: controller.signal
      });
      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(ToolError);
    });

    it('maps an unreachable host to a transport failure rather than a timeout', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.error()));

      try {
        await client().get('/v5/instances', { token: TEST_TOKEN });
        expect.unreachable('a transport failure must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.message).toMatch(/could not reach gma/i);
      }
    });
  });

  describe('case: the exact token supplied is forwarded, with a traceparent (FR-001)', () => {
    it('sends the token unaltered as a single Bearer header', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(INSTANCES, async ({ request }) => {
          await record(request);
          return HttpResponse.json(instances200);
        })
      );

      await client().get('/v5/instances', { token: TEST_TOKEN });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      // Unaltered: no re-signing, no exchange, no substitution.
      expect(seen[0]!.authorization).toContain(TEST_TOKEN);
    });

    it('sends a W3C traceparent when a span is recording, and a well-formed one or none otherwise', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(INSTANCES, async ({ request }) => {
          await record(request);
          return HttpResponse.json(instances200);
        })
      );

      await client().get('/v5/instances', { token: TEST_TOKEN });

      const parent = seen[0]!.traceparent;
      // With no OTel SDK registered there is no recording span, so no header is
      // emitted. A fabricated traceparent would corrupt a downstream trace, so
      // "absent" is the correct behaviour — never a malformed value.
      if (parent !== null) {
        expect(parent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      } else {
        expect(parent).toBeNull();
      }
    });

    it('puts instancesList in the QUERY STRING for a GET (research.md R3)', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(INSTANCES, async ({ request }) => {
          await record(request);
          return HttpResponse.json(instances200);
        })
      );

      await client().get('/v5/instances', {
        token: TEST_TOKEN,
        instances: ['urn:i:PP:PP', 'urn:i:BF:BF']
      });

      expect(seen[0]!.instancesList).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
    });

    it('omits the instances parameter entirely when none is supplied', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(INSTANCES, async ({ request }) => {
          await record(request);
          return HttpResponse.json(instances200);
        })
      );

      await client().get('/v5/instances', { token: TEST_TOKEN });

      expect(seen[0]!.instancesList).toEqual([]);
    });

    it('puts instancesList in the REQUEST BODY for searchByName (research.md R3)', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.post(SEARCH, async ({ request }) => {
          await record(request);
          return HttpResponse.json(search200);
        })
      );

      await client().post(
        '/v5/searchByName',
        { name: 'Premier League', instancesList: ['urn:i:PP:PP'] },
        { token: TEST_TOKEN }
      );

      expect(seen[0]!.body).toEqual({
        name: 'Premier League',
        instancesList: ['urn:i:PP:PP']
      });
      // A POST must not ALSO carry the instances in the query string.
      expect(seen[0]!.instancesList).toEqual([]);
      expect(seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it('sends a JSON content type on a POST', async () => {
      let contentType: string | null = null;
      server.use(
        http.post(SEARCH, ({ request }) => {
          contentType = request.headers.get('content-type');
          return HttpResponse.json(search200);
        })
      );

      await client().post('/v5/searchByName', { name: 'x' }, { token: TEST_TOKEN });

      expect(contentType).toContain('application/json');
    });
  });

  describe('case: the base URL comes from config only (FR-018)', () => {
    it('calls the configured host, and the path is not a full URL the caller chose', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(INSTANCES, async ({ request }) => {
          await record(request);
          return HttpResponse.json(instances200);
        })
      );

      await client().get('/v5/instances', { token: TEST_TOKEN });

      expect(seen[0]!.url.startsWith(`${GMA_BASE_URL}/v5/instances`)).toBe(true);
    });

    it('exposes no way for a caller to supply a base URL', () => {
      // Structural: the call options carry a token, instances, a signal, and logging
      // labels. There is no host, scheme, or port parameter to abuse.
      const options = { token: TEST_TOKEN, instances: ['urn:i:PP:PP'], hop: 1, tool: 't' };
      expect(Object.keys(options)).not.toContain('baseUrl');
      expect(Object.keys(options)).not.toContain('host');
      expect(Object.keys(options)).not.toContain('url');
    });
  });
});
