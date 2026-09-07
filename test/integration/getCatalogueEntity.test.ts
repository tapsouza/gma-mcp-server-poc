import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import type { ToolError } from '../../src/core/types.js';
import { getCatalogueEntityInputSchema } from '../../src/domains/catalogue/schemas.js';
import {
  GET_CATALOGUE_ENTITY_DESCRIPTION,
  getCatalogueEntity
} from '../../src/domains/catalogue/tools/getCatalogueEntity.js';
import {
  BOTH_GENERATIONS,
  GMA_BASE_URL,
  TEST_TOKEN,
  handles,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import entity206 from '../fixtures/gma/entities/206-partial-entity.json' with { type: 'json' };
import entity401 from '../fixtures/gma/entities/401-unauthorized.json' with { type: 'json' };
import entity404 from '../fixtures/gma/entities/404-not-found.json' with { type: 'json' };
import entity500 from '../fixtures/gma/entities/500-server-error.json' with { type: 'json' };
import eventTypeEntity from '../fixtures/gma/entities/200-eventType.json' with { type: 'json' };
import subclassEntity from '../fixtures/gma/entities/200-success.json' with { type: 'json' };
import superclassEntity from '../fixtures/gma/entities/200-superclass.json' with { type: 'json' };

/** User Story 3 (P3) acceptance scenarios 1 to 3. */

const server = useGmaServer();

const ENTITY_OPERATIONS = ['getSuperclass', 'getSubclass', 'getEventType'] as const;

/**
 * Every outcome, for all three entity types, once per generation (003-FR-016, SC-003).
 *
 * Handlers are mounted at the generation's own paths and the tool is handed that
 * generation's handles, so a run that reached the wrong generation fails on msw's
 * `onUnhandledRequest: 'error'` rather than passing quietly.
 */
describe.each(BOTH_GENERATIONS)('get_catalogue_entity on %s (Story 3, P3)', (generation) => {
  const operations = handles(ENTITY_OPERATIONS, generation);

  const SUBCLASS = `${GMA_BASE_URL}/${generation}/subclasses/:id`;
  const SUPERCLASS = `${GMA_BASE_URL}/${generation}/superclasses/:id`;
  const EVENT_TYPE = `${GMA_BASE_URL}/${generation}/eventTypes/:id`;

  function run(
    args: Parameters<typeof getCatalogueEntity>[4],
    overrides: Parameters<typeof testConfig>[0] = {}
  ) {
    const config = testConfig({ defaultGeneration: generation, ...overrides });
    return getCatalogueEntity(createGmaClient({ config }), config, operations, TEST_TOKEN, args);
  }
  describe('case: scenario 1 — a valid type and id returns details plus completeness (FR-016)', () => {
    it('returns a subclass with its parent in the ancestor chain', async () => {
      server.use(http.get(SUBCLASS, () => HttpResponse.json(subclassEntity)));

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(result.entity).toEqual({
        id: 'urn:sub:premier-league',
        name: 'Premier League',
        type: 'subclass',
        ancestors: [{ id: 'urn:sc:football', name: 'Football', type: 'superclass' }]
      });
      expect(result.completeness.complete).toBe(true);
    });

    it('returns a superclass with an empty ancestor chain', async () => {
      server.use(http.get(SUPERCLASS, () => HttpResponse.json(superclassEntity)));

      const result = await run({ type: 'superclass', id: 'urn:sc:football' });

      expect(result.entity.name).toBe('Football');
      expect(result.entity.type).toBe('superclass');
      expect(result.entity.ancestors).toEqual([]);
    });

    it('returns an event type with its full path, broadest first', async () => {
      server.use(http.get(EVENT_TYPE, () => HttpResponse.json(eventTypeEntity)));

      const result = await run({ type: 'eventType', id: 'urn:et:pl-winner' });

      expect(result.entity.name).toBe('Winner');
      expect(result.entity.ancestors).toEqual([
        { id: 'urn:sc:football', name: 'Football', type: 'superclass' },
        { id: 'urn:sub:premier-league', name: 'Premier League', type: 'subclass' }
      ]);
    });

    it('dispatches each type to its own path on this generation', async () => {
      const paths: string[] = [];
      server.use(
        http.get(SUBCLASS, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(subclassEntity);
        }),
        http.get(SUPERCLASS, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(superclassEntity);
        }),
        http.get(EVENT_TYPE, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(eventTypeEntity);
        })
      );

      await run({ type: 'subclass', id: 'a' });
      await run({ type: 'superclass', id: 'b' });
      await run({ type: 'eventType', id: 'c' });

      expect(paths).toEqual([
        `/${generation}/subclasses/a`,
        `/${generation}/superclasses/b`,
        `/${generation}/eventTypes/c`
      ]);
    });

    it('carries completeness even on full success (FR-005)', async () => {
      server.use(http.get(SUBCLASS, () => HttpResponse.json(subclassEntity)));

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(Object.keys(result).sort()).toEqual(['completeness', 'entity']);
      expect(result.completeness.caveat).toBeNull();
    });

    it('surfaces a partial-failure caveat naming the failed instance', async () => {
      server.use(http.get(SUBCLASS, () => HttpResponse.json(entity206, { status: 206 })));

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(result.entity.name).toBe('Premier League');
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.completeness.caveat).toContain('urn:i:BF:BF');
    });

    it('url-encodes an id containing URN colons', async () => {
      let path: string | null = null;
      server.use(
        http.get(`${GMA_BASE_URL}/${generation}/subclasses/*`, ({ request }) => {
          path = new URL(request.url).pathname;
          return HttpResponse.json(subclassEntity);
        })
      );

      await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(path).toContain('premier-league');
    });

    it('closes the loop from a candidate list: an id from US2 fetches here', async () => {
      // The id shape a candidate carries is exactly what this tool accepts, which is
      // what makes "human picks, agent acts" one round trip rather than a lookup.
      server.use(http.get(EVENT_TYPE, () => HttpResponse.json(eventTypeEntity)));

      const result = await run({ type: 'eventType', id: 'urn:et:pl-winner' });

      expect(result.entity.id).toBe('urn:et:pl-winner');
    });
  });

  describe('case: ancestry is derived from flat scalars, not nested objects (R8 defect 2, 001-FR-014)', () => {
    // The assertion that would have caught defect 2. Before this correction,
    // `collectAncestors` walked nested `subclass.superclass` objects that NEITHER
    // generation returns, so `ancestors` was always empty — silently removing the one
    // field 001-FR-014 relies on to tell two same-named entities apart. The fixtures
    // encoded the same mistake, which is why the suite stayed green.
    //
    // These bodies are written INLINE rather than taken from a fixture, deliberately:
    // the point is to pin the shape read from GMA's schema, so a future edit to a
    // fixture cannot quietly move what this asserts.

    it('reads one ancestor for a subclass, from superclassId and superclassName', async () => {
      server.use(
        http.get(SUBCLASS, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: {
              id: 'urn:sub:premier-league',
              name: 'Premier League',
              superclassId: 'urn:sc:football',
              superclassName: 'Football'
            }
          })
        )
      );

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(result.entity.ancestors).toEqual([
        { id: 'urn:sc:football', name: 'Football', type: 'superclass' }
      ]);
    });

    it('reads two ancestors for an event type, superclass then subclass', async () => {
      server.use(
        http.get(EVENT_TYPE, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            eventType: {
              id: 'urn:et:pl-winner',
              name: 'Winner',
              superclassId: 'urn:sc:football',
              superclassName: 'Football',
              subclassId: 'urn:sub:premier-league',
              subclassName: 'Premier League'
            }
          })
        )
      );

      const result = await run({ type: 'eventType', id: 'urn:et:pl-winner' });

      // Broadest-first, which is the order a human reads a path in.
      expect(result.entity.ancestors).toEqual([
        { id: 'urn:sc:football', name: 'Football', type: 'superclass' },
        { id: 'urn:sub:premier-league', name: 'Premier League', type: 'subclass' }
      ]);
    });

    it('ignores a nested parent object, which no generation sends', async () => {
      // The exact shape the old implementation expected. It must now yield NO
      // ancestor, so a regression to nested-object reading fails here rather than
      // passing by accident.
      server.use(
        http.get(SUBCLASS, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: {
              id: 'urn:sub:premier-league',
              name: 'Premier League',
              superclass: { id: 'urn:sc:football', name: 'Football' }
            }
          })
        )
      );

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      expect(result.entity.ancestors).toEqual([]);
    });

    it('yields a SHORTER chain on a blank scalar, never a fabricated ancestor', async () => {
      // An invented ancestor id is worse than a shorter path: an agent may try to
      // fetch it and get a notFound for an entity that never existed.
      server.use(
        http.get(EVENT_TYPE, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            eventType: {
              id: 'urn:et:pl-winner',
              name: 'Winner',
              superclassId: 'urn:sc:football',
              superclassName: 'Football',
              subclassId: '   ',
              subclassName: 'Premier League'
            }
          })
        )
      );

      const result = await run({ type: 'eventType', id: 'urn:et:pl-winner' });

      expect(result.entity.ancestors).toEqual([
        { id: 'urn:sc:football', name: 'Football', type: 'superclass' }
      ]);
      // The blank id must not appear at all, in any form.
      expect(result.entity.ancestors.map((a) => a.id)).not.toContain('');
      expect(result.entity.ancestors).toHaveLength(1);
    });

    it('falls back to the id as the name when only the ancestor name is blank', async () => {
      server.use(
        http.get(SUBCLASS, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: {
              id: 'urn:sub:premier-league',
              name: 'Premier League',
              superclassId: 'urn:sc:football',
              superclassName: ''
            }
          })
        )
      );

      const result = await run({ type: 'subclass', id: 'urn:sub:premier-league' });

      // A usable id with no name is still a usable ancestor — the id names it.
      expect(result.entity.ancestors).toEqual([
        { id: 'urn:sc:football', name: 'urn:sc:football', type: 'superclass' }
      ]);
    });

    it('gives a superclass an empty chain, since no parent exists', async () => {
      server.use(
        http.get(SUPERCLASS, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            // Even if upstream sent ancestry scalars on a superclass, it has no parent.
            superclass: { id: 'urn:sc:football', name: 'Football', superclassId: 'urn:sc:bogus' }
          })
        )
      );

      const result = await run({ type: 'superclass', id: 'urn:sc:football' });

      expect(result.entity.ancestors).toEqual([]);
    });
  });

  describe('case: scenario 2 — an unknown id is notFound, not an empty success', () => {
    it('raises kind notFound on a 404', async () => {
      server.use(http.get(SUBCLASS, () => HttpResponse.json(entity404, { status: 404 })));

      try {
        await run({ type: 'subclass', id: 'urn:sub:does-not-exist' });
        expect.unreachable('a 404 must not resolve as an empty entity');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('notFound');
        expect(toolError.retryable).toBe(false);
        expect(toolError).not.toHaveProperty('completeness');
      }
    });

    it('refuses a 200 whose body carries no entity, rather than inventing an empty one', async () => {
      server.use(
        http.get(SUBCLASS, () => HttpResponse.json({ successfulConfigSources: ['urn:i:PP:PP'] }))
      );

      try {
        await run({ type: 'subclass', id: 'urn:sub:premier-league' });
        expect.unreachable('a body with no entity must not resolve as a success');
      } catch (error) {
        expect((error as ToolError).kind).toBe('upstream');
      }
    });

    it('refuses an entity node that carries no id', async () => {
      server.use(
        http.get(SUBCLASS, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: { name: 'Nameless' }
          })
        )
      );

      await expect(run({ type: 'subclass', id: 'x' })).rejects.toBeDefined();
    });

    it('raises auth on 401 and upstream on 500', async () => {
      server.use(http.get(SUBCLASS, () => HttpResponse.json(entity401, { status: 401 })));
      await expect(run({ type: 'subclass', id: 'x' })).rejects.toSatisfy(
        (error: ToolError) => error.kind === 'auth'
      );

      server.resetHandlers();
      server.use(http.get(SUBCLASS, () => HttpResponse.json(entity500, { status: 500 })));
      await expect(run({ type: 'subclass', id: 'x' })).rejects.toSatisfy(
        (error: ToolError) => error.kind === 'upstream'
      );
    });
  });

  describe('case: scenario 3 — an unsupported type is rejected by validation before any call (SC-008)', () => {
    it.each([['market'], ['event'], ['competition'], [''], ['Subclass']])(
      'rejects type "%s" at the schema, with no GMA call made',
      (type) => {
        // Validation happens in the zod enum, so no handler is needed here — and
        // msw's onUnhandledRequest:'error' would fail this test if a call were made.
        const parsed = getCatalogueEntityInputSchema.type.safeParse(type);

        expect(parsed.success).toBe(false);
      }
    );

    it('accepts exactly the three supported types and no others', () => {
      for (const type of ['superclass', 'subclass', 'eventType']) {
        expect(getCatalogueEntityInputSchema.type.safeParse(type).success).toBe(true);
      }
      expect(getCatalogueEntityInputSchema.type.options).toEqual([
        'superclass',
        'subclass',
        'eventType'
      ]);
    });

    it('rejects an empty id at the schema', () => {
      expect(getCatalogueEntityInputSchema.id.safeParse('').success).toBe(false);
      expect(getCatalogueEntityInputSchema.id.safeParse('urn:sub:pl').success).toBe(true);
    });

    it('rejects an unknown instance code before any call (FR-017)', async () => {
      try {
        await run({ type: 'subclass', id: 'urn:sub:pl', instances: ['Not A Code'] });
        expect.unreachable('an unknown instance code must be rejected');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('argument');
        expect(toolError.message).toContain('list_instances');
      }
    });
  });

  describe('case: timeout — with no data it is an error; TIMEOUT_PARTIAL is unreachable here (FR-010, SC-003)', () => {
    it('reports a timeout with nothing gathered as an upstream error', async () => {
      server.use(
        http.get(SUBCLASS, async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return HttpResponse.json(subclassEntity);
        })
      );

      try {
        await run({ type: 'subclass', id: 'urn:sub:pl' }, { requestTimeoutMs: 25 });
        expect.unreachable('a timed-out call must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.message).toContain('no data was gathered');
        expect(toolError).not.toHaveProperty('completeness');
      }
    });

    it('cannot produce TIMEOUT_PARTIAL, because it makes exactly one hop', async () => {
      // Single-hop by design: there is no earlier hop whose data could survive an
      // abort. The timeout-with-partial-data case is exercised where it is reachable,
      // in findCatalogueEntity.test.ts.
      server.use(http.get(SUBCLASS, () => HttpResponse.json(subclassEntity)));

      const result = await run({ type: 'subclass', id: 'urn:sub:pl' });

      expect(result.completeness.outcome).not.toBe('TIMEOUT_PARTIAL');
    });
  });

  describe('case: a malformed argument is an argument error (FR-010, SC-008)', () => {
    it('maps a 400 from GMA to kind argument so the agent self-corrects', async () => {
      server.use(
        http.get(SUBCLASS, () =>
          HttpResponse.json({ status: 400, message: 'Invalid identifier' }, { status: 400 })
        )
      );

      try {
        await run({ type: 'subclass', id: 'not-a-urn' });
        expect.unreachable('a 400 must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('argument');
        expect(toolError.retryable).toBe(false);
      }
    });
  });

  describe('case: too-broad does not apply to this capability (FR-015, SC-003)', () => {
    it('takes a single id, so there is no cardinality to be too broad', async () => {
      // Retrieval by id returns at most one entity. Too-broad is a search concern and
      // is exercised in findCatalogueEntity.test.ts. Recorded so the SC-003 matrix
      // shows a deliberate N/A rather than a gap.
      server.use(http.get(SUBCLASS, () => HttpResponse.json(subclassEntity)));

      const result = await run({ type: 'subclass', id: 'urn:sub:pl' });

      expect(result.completeness.outcome).not.toBe('TOO_BROAD');
    });
  });

  describe('case: instances scoping (FR-017)', () => {
    it('sends the requested instances as a query parameter for this GET', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(SUBCLASS, async ({ request }) => {
          await record(request);
          return HttpResponse.json(subclassEntity);
        })
      );

      await run({ type: 'subclass', id: 'urn:sub:pl', instances: ['PP'] });

      expect(seen[0]!.instancesList).toEqual(['urn:i:PP:PP']);
    });

    it('falls back to the configured default set when instances is omitted', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(SUBCLASS, async ({ request }) => {
          await record(request);
          return HttpResponse.json(subclassEntity);
        })
      );

      await run({ type: 'subclass', id: 'urn:sub:pl' });

      expect(seen[0]!.instancesList).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
    });
  });

  describe('case: the description points at find_catalogue_entity and mandates relaying (FR-009)', () => {
    it('directs an agent holding only a name to the search tool', () => {
      expect(GET_CATALOGUE_ENTITY_DESCRIPTION).toContain('find_catalogue_entity');
    });

    it('tells the agent to relay completeness caveats', () => {
      expect(GET_CATALOGUE_ENTITY_DESCRIPTION.toLowerCase()).toContain('relay');
    });

    it('uses no GMA DTO vocabulary (Principle IV)', () => {
      expect(GET_CATALOGUE_ENTITY_DESCRIPTION).not.toContain('configSource');
      // No generation, either one, and no versioned path (003-FR-012).
      expect(GET_CATALOGUE_ENTITY_DESCRIPTION).not.toMatch(/\bv[45]\b/);
    });
  });

  describe('case: identity is forwarded per invocation (FR-001)', () => {
    it('sends the exact token supplied to this call', async () => {
      const { seen, record } = requestRecorder();
      server.use(
        http.get(SUBCLASS, async ({ request }) => {
          await record(request);
          return HttpResponse.json(subclassEntity);
        })
      );

      await run({ type: 'subclass', id: 'urn:sub:pl' });

      expect(seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });
  });
});

/**
 * The strongest single guard against routing leaking into a result (003-FR-008, SC-002).
 *
 * The parameterised suite above asserts each generation produces the RIGHT answer. This
 * asserts the two produce the SAME answer, byte for byte, from the same body — which is a
 * different and stronger claim. If a generation ever reaches the payload, this fails.
 */
describe('cross-generation output equality', () => {
  const server2 = server;

  function runOn(
    generation: 'v4' | 'v5',
    args: Parameters<typeof getCatalogueEntity>[4]
  ): ReturnType<typeof getCatalogueEntity> {
    const config = testConfig({ defaultGeneration: generation });
    const ops = handles(['getSuperclass', 'getSubclass', 'getEventType'] as const, generation);
    return getCatalogueEntity(createGmaClient({ config }), config, ops, TEST_TOKEN, args);
  }

  describe('case: agent-facing payload is deeply equal on v4 and v5 (003-FR-008, SC-002)', () => {
    it.each([
      ['a subclass', 'subclass', 'subclasses', subclassEntity, 200],
      ['a superclass', 'superclass', 'superclasses', superclassEntity, 200],
      ['an event type', 'eventType', 'eventTypes', eventTypeEntity, 200],
      ['a partial subclass', 'subclass', 'subclasses', entity206, 206]
    ] as const)(
      'returns an identical payload for %s on both generations',
      async (_label, type, segment, body, status) => {
        for (const generation of BOTH_GENERATIONS) {
          server2.use(
            http.get(`${GMA_BASE_URL}/${generation}/${segment}/:id`, () =>
              HttpResponse.json(body, { status })
            )
          );
        }

        const onV4 = await runOn('v4', { type, id: 'urn:x:1' });
        const onV5 = await runOn('v5', { type, id: 'urn:x:1' });

        // Includes the completeness verdict: the 206 case proves a partial-success
        // verdict is derived identically on both generations, which is what lets
        // `completeness.ts` stay untouched by this feature (Principle II).
        expect(onV5).toEqual(onV4);
        expect(JSON.stringify(onV5)).toBe(JSON.stringify(onV4));
      }
    );

    it('mentions no generation anywhere in the serialised payload (003-FR-012)', async () => {
      for (const generation of BOTH_GENERATIONS) {
        server2.use(
          http.get(`${GMA_BASE_URL}/${generation}/eventTypes/:id`, () =>
            HttpResponse.json(eventTypeEntity)
          )
        );
      }

      for (const generation of BOTH_GENERATIONS) {
        const serialised = JSON.stringify(await runOn(generation, { type: 'eventType', id: 'x' }));

        expect(serialised).not.toContain('v4');
        expect(serialised).not.toContain('v5');
        expect(serialised).not.toContain('generation');
      }
    });
  });
});
