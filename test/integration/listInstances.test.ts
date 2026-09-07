import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { requireOperations, resolveOperations } from '../../src/core/surface.js';
import { ToolError } from '../../src/core/types.js';
import {
  LIST_INSTANCES_DESCRIPTION,
  listInstances
} from '../../src/domains/catalogue/tools/listInstances.js';
import {
  BOTH_GENERATIONS,
  GMA_BASE_URL,
  TEST_TOKEN,
  handle,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import instances200 from '../fixtures/gma/instances/200-success.json' with { type: 'json' };
import instances400 from '../fixtures/gma/instances/400-bad-request.json' with { type: 'json' };
import instances206 from '../fixtures/gma/instances/206-partial.json' with { type: 'json' };
import instances401 from '../fixtures/gma/instances/401-unauthorized.json' with { type: 'json' };
import instances500 from '../fixtures/gma/instances/500-server-error.json' with { type: 'json' };

/** User Story 1 (P1) acceptance scenarios 1 to 4. */

const server = useGmaServer();
const client = () => createGmaClient({ config: testConfig() });

/**
 * Every outcome, asserted once per generation (003-FR-016, SC-003).
 *
 * Each run mounts its handler at that generation's own path and passes that generation's
 * handle, so the routing is genuinely exercised twice. The response bodies are shared
 * because both generations declare them identically (003 research.md R2), and the run
 * asserts the request arrived at the expected path — which is what makes the sharing
 * honest rather than merely convenient (R3).
 */
describe.each(BOTH_GENERATIONS)('list_instances on %s (Story 1, P1)', (generation) => {
  const operation = handle('listInstances', generation);
  const INSTANCES = `${GMA_BASE_URL}${operation.pathTemplate}`;
  describe('case: scenario 1 — full success returns codes marked complete (FR-011)', () => {
    it('returns the brand codes with a complete verdict', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([
        { code: 'PP', id: 'urn:i:PP:PP', name: 'PaddyPower' },
        { code: 'BF', id: 'urn:i:BF:BF', name: 'Betfair' }
      ]);
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
      expect(result.completeness.caveat).toBeNull();
    });

    it('carries completeness even on full success, never omitting it (FR-005)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result).toHaveProperty('completeness');
      expect(Object.keys(result).sort()).toEqual(['completeness', 'instances']);
    });

    it('gives the agent both a short code and an id, so it need not guess either (SC-005)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      for (const instance of result.instances) {
        expect(instance.code).toMatch(/^[A-Z0-9]+$/);
        expect(instance.id).toContain(instance.code);
        expect(instance.name.length).toBeGreaterThan(0);
      }
    });

    it('exposes no upstream vocabulary in the tool result (Principle IV)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));

      const result = await listInstances(client(), operation, TEST_TOKEN);
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain('configSource');
      expect(serialised).not.toContain('ConfigSources');
      expect(serialised).not.toContain('instancesList');
    });
  });

  describe('case: scenario 2 — partial failure returns data plus a caveat naming the failures', () => {
    it('returns the instances that answered and names the one that did not', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([{ code: 'PP', id: 'urn:i:PP:PP', name: 'PaddyPower' }]);
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.completeness.caveat).toContain('urn:i:BF:BF');
    });

    it('never presents the shortened list as the whole list (SC-001)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      // Data IS returned — partial failure is normal operation, not an error — but it
      // is inseparable from the verdict that says it is incomplete.
      expect(result.instances.length).toBeGreaterThan(0);
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.caveat).not.toBeNull();
    });

    it('carries the per-instance error detail the upstream reported (FR-007)', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.completeness.errors).toEqual([
        {
          instance: 'urn:i:BF:BF',
          message: 'Upstream config source did not respond within the read timeout'
        }
      ]);
    });
  });

  describe('case: scenario 3 — expired identity is an auth error a human can act on (FR-003)', () => {
    it('raises kind auth, distinguishable from a data or argument error', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances401, { status: 401 })));

      try {
        await listInstances(client(), operation, TEST_TOKEN);
        expect.unreachable('a 401 must not resolve as a result');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError).toBeInstanceOf(ToolError);
        expect(toolError.kind).toBe('auth');
        expect(toolError.retryable).toBe(false);
        expect(toolError.message).toMatch(/re-?authenticate/i);
      }
    });

    it('does not surface an expired identity as an empty instance list', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances401, { status: 401 })));

      await expect(listInstances(client(), operation, TEST_TOKEN)).rejects.toBeInstanceOf(
        ToolError
      );
    });
  });

  describe('case: scenario 4 — upstream failure errors rather than returning an empty list', () => {
    it('raises an upstream error on 500, never an empty list marked complete', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances500, { status: 500 })));

      try {
        await listInstances(client(), operation, TEST_TOKEN);
        expect.unreachable('a 500 must not resolve as an empty result');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.retryable).toBe(true);
        expect(toolError).not.toHaveProperty('completeness');
      }
    });

    it('reports a genuinely empty catalogue as complete-and-empty, which is different', async () => {
      // The distinction that matters: zero instances BECAUSE the upstream said so is a
      // complete answer; zero instances because the upstream failed is an error.
      server.use(
        http.get(INSTANCES, () =>
          HttpResponse.json({ successfulConfigSources: ['urn:i:PP:PP'], instances: [] })
        )
      );

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([]);
      expect(result.completeness.complete).toBe(true);
    });
  });

  describe('case: timeout — with no data it is an error; TIMEOUT_PARTIAL is unreachable here (FR-010, SC-003)', () => {
    it('reports a timeout with nothing gathered as an upstream error', async () => {
      server.use(
        http.get(INSTANCES, async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return HttpResponse.json(instances200);
        })
      );

      const config = testConfig({ requestTimeoutMs: 25 });
      try {
        await listInstances(createGmaClient({ config }), operation, TEST_TOKEN);
        expect.unreachable('a timed-out call must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.retryable).toBe(true);
        expect(toolError.message).toContain('no data was gathered');
        // Never a TIMEOUT_PARTIAL verdict: there was no partial data to caveat.
        expect(toolError).not.toHaveProperty('completeness');
      }
    });

    it('cannot produce TIMEOUT_PARTIAL, because one hop either answers or does not', () => {
      // Recorded rather than tested: TIMEOUT_PARTIAL needs an earlier hop that
      // already gathered data, and this tool makes exactly one hop. The
      // timeout-with-partial-data case is exercised where it is reachable, in
      // findCatalogueEntity.test.ts (hop 2 times out after hop 1 resolved).
      expect(operation.operation).toBe('listInstances');
    });
  });

  describe('case: a malformed argument is an argument error (FR-010, SC-008)', () => {
    it('maps a 400 to kind argument so the agent self-corrects', async () => {
      server.use(http.get(INSTANCES, () => HttpResponse.json(instances400, { status: 400 })));

      try {
        await listInstances(client(), operation, TEST_TOKEN);
        expect.unreachable('a 400 must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('argument');
        expect(toolError.retryable).toBe(false);
      }
    });
  });

  describe('case: too-broad does not apply to this capability (FR-015, SC-003)', () => {
    it('takes no query to be too broad about', () => {
      // list_instances has no input at all, so there is no query to narrow and no
      // cardinality to derive too-broad from. Recorded explicitly so the SC-003
      // matrix shows a deliberate N/A rather than an oversight.
      expect(listInstances.length).toBe(3); // (client, operation, token) — no query parameter
    });
  });

  describe('response shape robustness', () => {
    it('skips an entry with no id rather than inventing one', async () => {
      server.use(
        http.get(INSTANCES, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            instances: [{ name: 'Nameless' }, { id: 'urn:i:PP:PP', name: 'PaddyPower' }]
          })
        )
      );

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([{ code: 'PP', id: 'urn:i:PP:PP', name: 'PaddyPower' }]);
    });

    it('falls back to the code when the upstream supplies no display name', async () => {
      server.use(
        http.get(INSTANCES, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            instances: [{ id: 'urn:i:PP:PP' }]
          })
        )
      );

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([{ code: 'PP', id: 'urn:i:PP:PP', name: 'PP' }]);
    });

    it('returns an empty list with a verdict when the body has no instances field', async () => {
      server.use(
        http.get(INSTANCES, () => HttpResponse.json({ successfulConfigSources: ['urn:i:PP:PP'] }))
      );

      const result = await listInstances(client(), operation, TEST_TOKEN);

      expect(result.instances).toEqual([]);
      expect(result.completeness.complete).toBe(true);
    });
  });

  describe('case: the tool description instructs the agent to relay caveats (FR-009)', () => {
    it('tells the agent to relay a failed-instance caveat to the user', () => {
      expect(LIST_INSTANCES_DESCRIPTION.toLowerCase()).toContain('relay');
      expect(LIST_INSTANCES_DESCRIPTION.toLowerCase()).toContain('incomplete');
    });

    it('tells the agent to call this instead of guessing codes (SC-005)', () => {
      expect(LIST_INSTANCES_DESCRIPTION.toLowerCase()).toContain('guessing');
    });

    it('uses no GMA DTO vocabulary in the description (Principle IV)', () => {
      expect(LIST_INSTANCES_DESCRIPTION).not.toContain('configSource');
      expect(LIST_INSTANCES_DESCRIPTION).not.toContain('instancesList');
      expect(LIST_INSTANCES_DESCRIPTION).not.toContain('v5');
    });
  });

  describe('case: identity is forwarded per invocation (FR-001, FR-023a)', () => {
    it('sends the exact token supplied to this call', async () => {
      let authorization: string | null = null;
      server.use(
        http.get(INSTANCES, ({ request }) => {
          authorization = request.headers.get('authorization');
          return HttpResponse.json(instances200);
        })
      );

      await listInstances(client(), operation, TEST_TOKEN);

      expect(authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it('takes the token as a parameter, so no ambient identity is possible', () => {
      // Structural: `listInstances(client, operation, token)`. There is no overload that
      // omits the token and reads it from state.
      expect(listInstances.length).toBe(3);
    });
  });
});

/**
 * Generation routing, asserted directly rather than as an implication of the runs above.
 *
 * The parameterised suite proves each generation WORKS. These prove which one a real
 * deployment actually reaches — a different claim, and the one FR-001 and SC-001 make.
 */
describe('list_instances generation routing', () => {
  describe('case: default config routes every non-search operation to v4 (003-FR-001, FR-017, SC-001)', () => {
    it('reaches a /v4/ path when nothing is configured', async () => {
      // Resolution from a DEFAULT config, not a hand-built handle: this is the assertion
      // that would fail if the default were still v5, or if `loadConfig`'s default and
      // the resolver's disagreed.
      const config = testConfig();
      const operations = requireOperations(
        resolveOperations({
          capability: 'catalogue',
          operations: ['listInstances'],
          defaultGeneration: config.defaultGeneration
        }),
        ['listInstances'] as const
      );

      let pathname: string | null = null;
      server.use(
        http.get(`${GMA_BASE_URL}/v4/instances`, ({ request }) => {
          pathname = new URL(request.url).pathname;
          return HttpResponse.json(instances200);
        })
      );

      const result = await listInstances(
        createGmaClient({ config }),
        operations.listInstances,
        TEST_TOKEN
      );

      expect(pathname).toBe('/v4/instances');
      expect(operations.listInstances.generation).toBe('v4');
      // And the answer is the same one the tool always gave.
      expect(result.instances).toEqual([
        { code: 'PP', id: 'urn:i:PP:PP', name: 'PaddyPower' },
        { code: 'BF', id: 'urn:i:BF:BF', name: 'Betfair' }
      ]);
    });

    it('never touches a v5 path on a default deployment', async () => {
      // msw's `onUnhandledRequest: 'error'` does the work: with ONLY the v4 handler
      // mounted, any v5 request fails the test rather than passing silently.
      const config = testConfig();
      const operations = requireOperations(
        resolveOperations({
          capability: 'catalogue',
          operations: ['listInstances'],
          defaultGeneration: config.defaultGeneration
        }),
        ['listInstances'] as const
      );

      server.use(http.get(`${GMA_BASE_URL}/v4/instances`, () => HttpResponse.json(instances200)));

      await expect(
        listInstances(createGmaClient({ config }), operations.listInstances, TEST_TOKEN)
      ).resolves.toBeDefined();
    });
  });

  describe('case: GMA_CATALOGUE_GENERATION=v5 routes every operation to v5 (003-FR-013, SC-005, Story 3 scenario 2)', () => {
    it('reaches a /v5/ path, with an identical result', async () => {
      const v4Config = testConfig();
      const v5Config = testConfig({ defaultGeneration: 'v5' });

      const resolve = (config: ReturnType<typeof testConfig>) =>
        requireOperations(
          resolveOperations({
            capability: 'catalogue',
            operations: ['listInstances'],
            defaultGeneration: config.defaultGeneration
          }),
          ['listInstances'] as const
        );

      const paths: string[] = [];
      server.use(
        http.get(`${GMA_BASE_URL}/v4/instances`, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(instances200);
        }),
        http.get(`${GMA_BASE_URL}/v5/instances`, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(instances200);
        })
      );

      const onV4 = await listInstances(
        createGmaClient({ config: v4Config }),
        resolve(v4Config).listInstances,
        TEST_TOKEN
      );
      const onV5 = await listInstances(
        createGmaClient({ config: v5Config }),
        resolve(v5Config).listInstances,
        TEST_TOKEN
      );

      expect(paths).toEqual(['/v4/instances', '/v5/instances']);
      // The generation is an operational choice with NO agent-visible consequence
      // (003-FR-008, SC-002).
      expect(onV5).toEqual(onV4);
    });
  });
});
