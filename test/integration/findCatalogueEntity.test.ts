import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { requireOperations, resolveOperations } from '../../src/core/surface.js';
import type { ToolError } from '../../src/core/types.js';
import {
  FIND_CATALOGUE_ENTITY_DESCRIPTION,
  findCatalogueEntity
} from '../../src/domains/catalogue/tools/findCatalogueEntity.js';
import { CATALOGUE_OPERATIONS, CATALOGUE_PINS } from '../../src/domains/catalogue/index.js';
import type { CatalogueEntity } from '../../src/domains/catalogue/schemas.js';
import {
  BOTH_GENERATIONS,
  GMA_BASE_URL,
  TEST_TOKEN,
  handle,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import childrenPartial from '../fixtures/gma/entities/206-partial.json' with { type: 'json' };
import eventTypes from '../fixtures/gma/entities/200-eventTypes-children.json' with { type: 'json' };
import superclass from '../fixtures/gma/entities/200-superclass.json' with { type: 'json' };
import search400 from '../fixtures/gma/searchByName/400-bad-request.json' with { type: 'json' };
import search401 from '../fixtures/gma/searchByName/401-unauthorized.json' with { type: 'json' };
import search500 from '../fixtures/gma/searchByName/500-server-error.json' with { type: 'json' };
import manyMatches from '../fixtures/gma/searchByName/200-many-matches.json' with { type: 'json' };
import multiMatch from '../fixtures/gma/searchByName/200-multi-match.json' with { type: 'json' };
import noMatch from '../fixtures/gma/searchByName/200-no-match.json' with { type: 'json' };
import singleMatch from '../fixtures/gma/searchByName/200-single-match.json' with { type: 'json' };

/** User Story 2 (P2) acceptance scenarios 1 to 6. */

const server = useGmaServer();

/**
 * The search hop is ALWAYS v5, on every deployment, because v4 has no by-name search of
 * any kind (003 research.md R1). So its path is fixed here while the CHILD hop below is
 * parameterised — which is the shape of this tool on a real v4-default deployment: one
 * tool call, two generations (003-FR-004, FR-009).
 */
const searchByName = handle('searchByName', 'v5');
const SEARCH = `${GMA_BASE_URL}${searchByName.pathTemplate}`;

/**
 * Every outcome, with the child hop asserted once per generation (003-FR-016, SC-003).
 *
 * `searchByName` has doubles for v5 ONLY, and no partial-success double, because that is
 * all the upstream declares — it offers 200/400/401/500 and no 206.
 */
describe.each(BOTH_GENERATIONS)(
  'find_catalogue_entity with children on %s (Story 2, P2)',
  (childGeneration) => {
    const operations = {
      searchByName,
      subclassEventTypes: handle('subclassEventTypes', childGeneration),
      getSuperclass: handle('getSuperclass', childGeneration)
    };

    const SUBCLASS_CHILDREN = `${GMA_BASE_URL}/${childGeneration}/subclasses/:id/eventTypes`;
    const SUPERCLASS = `${GMA_BASE_URL}/${childGeneration}/superclasses/:id`;

    function run(
      args: Parameters<typeof findCatalogueEntity>[4],
      overrides: Parameters<typeof testConfig>[0] = {}
    ) {
      const config = testConfig({ defaultGeneration: childGeneration, ...overrides });
      return findCatalogueEntity(createGmaClient({ config }), config, operations, TEST_TOKEN, args);
    }

    /** Search returns the given body; the subclass second hop returns event types. */
    function happyPath(searchBody: unknown, status = 200) {
      server.use(
        http.post(SEARCH, () => HttpResponse.json(searchBody, { status })),
        http.get(SUBCLASS_CHILDREN, () => HttpResponse.json(eventTypes))
      );
    }
    describe('case: scenario 1 — single match resolves with its immediate children (FR-013, SC-011)', () => {
      it('returns the resolved entity plus one level of children', async () => {
        happyPath(singleMatch);

        const payload = await run({ name: 'Premier League' });

        expect(payload.kind).toBe('resolved');
        expect((payload.entity as CatalogueEntity).name).toBe('Premier League');
        expect((payload.children as CatalogueEntity[]).map((c) => c.name)).toEqual([
          'Winner',
          'Top Goalscorer',
          'Relegation'
        ]);
      });

      it('answers in ONE tool call, with no manual id lookup (SC-004, SC-011)', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, async ({ request }) => {
            await record(request);
            return HttpResponse.json(singleMatch);
          }),
          http.get(SUBCLASS_CHILDREN, async ({ request }) => {
            await record(request);
            return HttpResponse.json(eventTypes);
          })
        );

        await run({ name: 'Premier League' });

        // Two GMA hops, but ONE tool call — the traversal is the tool's job.
        expect(seen).toHaveLength(2);
      });

      it('aggregates completeness across BOTH hops when both succeeded', async () => {
        happyPath(singleMatch);

        const payload = await run({ name: 'Premier League' });
        const completeness = payload.completeness as { complete: boolean; outcome: string };

        expect(completeness.complete).toBe(true);
        expect(completeness.outcome).toBe('COMPLETE');
      });

      it('gives each child the resolved entity in its ancestor chain', async () => {
        happyPath(singleMatch);

        const payload = await run({ name: 'Premier League' });
        const children = payload.children as CatalogueEntity[];

        for (const child of children) {
          expect(child.type).toBe('eventType');
          expect(child.ancestors.map((a) => a.name)).toEqual(['Football', 'Premier League']);
        }
      });

      it('traverses a matched superclass to its subclasses', async () => {
        server.use(
          http.post(SEARCH, () =>
            HttpResponse.json({
              successfulConfigSources: ['urn:i:PP:PP'],
              results: [{ superclass: { id: 'urn:sc:football', name: 'Football' } }]
            })
          ),
          http.get(SUPERCLASS, () => HttpResponse.json(superclass))
        );

        const payload = await run({ name: 'Football' });

        expect(payload.kind).toBe('resolved');
        expect((payload.children as CatalogueEntity[]).map((c) => c.name)).toEqual([
          'Premier League',
          'Championship'
        ]);
        expect((payload.children as CatalogueEntity[])[0]!.type).toBe('subclass');
      });

      it('makes NO second hop for a matched event type, and does not call that a failure (FR-025)', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, async ({ request }) => {
            await record(request);
            return HttpResponse.json({
              successfulConfigSources: ['urn:i:PP:PP'],
              results: [
                {
                  superclass: { id: 'urn:sc:football', name: 'Football' },
                  subclass: { id: 'urn:sub:pl', name: 'Premier League' },
                  eventType: { id: 'urn:et:w', name: 'Winner' }
                }
              ]
            });
          })
        );

        const payload = await run({ name: 'Winner' });

        // One hop only: an event type's children would be events, out of scope.
        expect(seen).toHaveLength(1);
        expect(payload.kind).toBe('resolved');
        expect(payload.children).toEqual([]);
        // Crucially, "no children in scope" must not read as an incomplete answer.
        expect((payload.completeness as { complete: boolean }).complete).toBe(true);
      });
    });

    describe('case: subclass children are read from entities[] (R8 defect 1)', () => {
      // The assertion that would have caught defect 1. Before this correction,
      // `traversal.ts` read `eventTypes[]` where both generations declare this
      // operation's 200 as `EntitiesResponse` — `{ entities: Entity[] }` — so EVERY
      // matched subclass reported no children under a fully-successful verdict.
      //
      // Written inline rather than from the fixture: the fixture is what encoded the
      // mistake, so pinning the schema shape here is what stops it recurring.

      it('returns non-empty children for a matched subclass', async () => {
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, () =>
            HttpResponse.json({
              successfulConfigSources: ['urn:i:PP:PP'],
              entities: [
                { id: 'urn:et:pl-winner', name: 'Winner' },
                { id: 'urn:et:pl-top-scorer', name: 'Top Goalscorer' }
              ]
            })
          )
        );

        const payload = await run({ name: 'Premier League' });
        const children = payload.children as CatalogueEntity[];

        expect(children).not.toEqual([]);
        expect(children.map((c) => c.name)).toEqual(['Winner', 'Top Goalscorer']);
      });

      it('ignores an eventTypes[] key, which no generation sends', async () => {
        // The exact shape the old implementation expected. It must now produce NO
        // children, so a regression fails here rather than passing by accident.
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, () =>
            HttpResponse.json({
              successfulConfigSources: ['urn:i:PP:PP'],
              eventTypes: [{ id: 'urn:et:pl-winner', name: 'Winner' }]
            })
          )
        );

        const payload = await run({ name: 'Premier League' });

        expect(payload.children).toEqual([]);
      });
    });

    describe('case: scenario 2 — several matches return all candidates, none resolved (FR-014, SC-002)', () => {
      it('returns every candidate and resolves nothing', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(multiMatch)));

        const payload = await run({ name: 'Winner' });

        expect(payload.kind).toBe('candidates');
        expect(payload.candidates).toHaveLength(3);
        expect(payload).not.toHaveProperty('entity');
      });

      it('makes no second hop, since nothing was resolved to traverse from', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, async ({ request }) => {
            await record(request);
            return HttpResponse.json(multiMatch);
          })
        );

        await run({ name: 'Winner' });

        expect(seen).toHaveLength(1);
      });

      it('gives a human enough detail to choose between same-named candidates', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(multiMatch)));

        const payload = await run({ name: 'Winner' });
        const candidates = payload.candidates as CatalogueEntity[];

        const paths = candidates.map((c) =>
          [...c.ancestors.map((a) => a.name), c.name].join(' / ')
        );
        expect(new Set(paths).size).toBe(3);
        expect(paths).toContain('Football / Premier League / Winner');
      });
    });

    describe('case: scenario 3 — no match is "none", not an error (FR-010)', () => {
      it('returns kind none with a completeness verdict', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(noMatch)));

        const payload = await run({ name: 'Nonexistent Competition' });

        expect(payload.kind).toBe('none');
        expect(payload).toHaveProperty('completeness');
        expect((payload.completeness as { complete: boolean }).complete).toBe(true);
      });

      it('resolves rather than rejecting, so the agent can report absence plainly', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(noMatch)));

        await expect(run({ name: 'Nonexistent' })).resolves.toBeDefined();
      });

      it('carries no caveat for a genuinely empty answer', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(noMatch)));

        const payload = await run({ name: 'Nonexistent' });

        expect((payload.completeness as { caveat: string | null }).caveat).toBeNull();
      });
    });

    describe('case: scenario 4 — too broad returns no resolution plus a narrowing hint (FR-015)', () => {
      it('returns tooBroad with the match count and the fields to narrow by', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(manyMatches)));

        const payload = await run({ name: 'a' });

        expect(payload.kind).toBe('tooBroad');
        expect(payload.matchCount).toBe(40);
        expect(payload.narrowBy).toContain('instances');
        expect(payload).not.toHaveProperty('entity');
        expect(payload).not.toHaveProperty('candidates');
      });

      it('marks a too-broad answer incomplete even though every instance answered', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(manyMatches)));

        const payload = await run({ name: 'a' });
        const completeness = payload.completeness as {
          complete: boolean;
          outcome: string;
          caveat: string;
        };

        expect(completeness.complete).toBe(false);
        expect(completeness.outcome).toBe('TOO_BROAD');
        expect(completeness.caveat).toContain('Narrow');
      });

      it('honours a lower configured threshold', async () => {
        server.use(http.post(SEARCH, () => HttpResponse.json(multiMatch)));

        const payload = await run({ name: 'Winner' }, { maxCandidates: 2 });

        expect(payload.kind).toBe('tooBroad');
        expect(payload.matchCount).toBe(3);
      });
    });

    describe('case: scenario 5 — a partial hop marks the WHOLE result incomplete (FR-008, SC-011)', () => {
      it('marks the result incomplete when hop 2 ALONE was partial', async () => {
        // The case the slice exists to prove: hop 1 fully succeeded, hop 2 did not, and
        // the aggregated verdict must reflect the worse of the two.
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, () => HttpResponse.json(childrenPartial, { status: 206 }))
        );

        const payload = await run({ name: 'Premier League' });
        const completeness = payload.completeness as {
          complete: boolean;
          outcome: string;
          failedInstances: string[];
          caveat: string;
        };

        expect(payload.kind).toBe('resolved');
        expect((payload.children as CatalogueEntity[]).length).toBeGreaterThan(0);
        expect(completeness.complete).toBe(false);
        expect(completeness.outcome).toBe('PARTIAL');
        expect(completeness.failedInstances).toEqual(['urn:i:BF:BF']);
        expect(completeness.caveat).toContain('urn:i:BF:BF');
      });

      it('marks the result incomplete when hop 1 ALONE was partial', async () => {
        server.use(
          http.post(SEARCH, () =>
            HttpResponse.json(
              {
                successfulConfigSources: ['urn:i:PP:PP'],
                failedConfigSources: ['urn:i:BF:BF'],
                errors: [{ configSource: 'urn:i:BF:BF', message: 'search provider unavailable' }],
                results: singleMatch.results
              },
              { status: 206 }
            )
          ),
          http.get(SUBCLASS_CHILDREN, () => HttpResponse.json(eventTypes))
        );

        const payload = await run({ name: 'Premier League' });
        const completeness = payload.completeness as {
          complete: boolean;
          failedInstances: string[];
        };

        expect(completeness.complete).toBe(false);
        expect(completeness.failedInstances).toEqual(['urn:i:BF:BF']);
      });

      it('names every instance that failed at ANY step, as a union', async () => {
        server.use(
          http.post(SEARCH, () =>
            HttpResponse.json(
              {
                successfulConfigSources: ['urn:i:PP:PP'],
                failedConfigSources: ['urn:i:SBG:SBG'],
                errors: [{ configSource: 'urn:i:SBG:SBG', message: 'hop one failure' }],
                results: singleMatch.results
              },
              { status: 206 }
            )
          ),
          http.get(SUBCLASS_CHILDREN, () => HttpResponse.json(childrenPartial, { status: 206 }))
        );

        const payload = await run({ name: 'Premier League' });
        const completeness = payload.completeness as { failedInstances: string[] };

        // Copy before sorting: the verdict's arrays are frozen so no caller can edit it.
        expect([...completeness.failedInstances].sort()).toEqual(['urn:i:BF:BF', 'urn:i:SBG:SBG']);
      });

      it('reports TIMEOUT_PARTIAL when hop 2 times out but hop 1 produced the entity (FR-010)', async () => {
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return HttpResponse.json(eventTypes);
          })
        );

        const payload = await run({ name: 'Premier League' }, { requestTimeoutMs: 30 });
        const completeness = payload.completeness as { complete: boolean; outcome: string };

        // The entity IS returned — it is the answer to "find X" — but unmissably
        // flagged as incomplete rather than silently missing its children.
        expect(payload.kind).toBe('resolved');
        expect(payload.children).toEqual([]);
        expect(completeness.complete).toBe(false);
        expect(completeness.outcome).toBe('TIMEOUT_PARTIAL');
      });

      it('still surfaces a 401 on hop 2 as an auth error, never as a softened result', async () => {
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, () => HttpResponse.json({ status: 401 }, { status: 401 }))
        );

        try {
          await run({ name: 'Premier League' });
          expect.unreachable('an expired identity on hop 2 must not resolve');
        } catch (error) {
          expect((error as ToolError).kind).toBe('auth');
        }
      });
    });

    describe('case: scenario 6 — explicit instances honoured, omitted falls back to config (FR-017)', () => {
      it('sends only the requested instances, in the request BODY (research.md R3)', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, async ({ request }) => {
            await record(request);
            return HttpResponse.json(noMatch);
          })
        );

        await run({ name: 'Premier League', instances: ['PP'] });

        expect(seen[0]!.body).toEqual({
          name: 'Premier League',
          instancesList: ['urn:i:PP:PP']
        });
        expect(seen[0]!.instancesList).toEqual([]);
      });

      it('falls back to the configured default set when instances is omitted', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, async ({ request }) => {
            await record(request);
            return HttpResponse.json(noMatch);
          })
        );

        await run({ name: 'Premier League' });

        expect((seen[0]!.body as { instancesList: string[] }).instancesList).toEqual([
          'urn:i:PP:PP',
          'urn:i:BF:BF'
        ]);
      });

      it('scopes the SECOND hop to the same instances', async () => {
        const { seen, record } = requestRecorder();
        server.use(
          http.post(SEARCH, () => HttpResponse.json(singleMatch)),
          http.get(SUBCLASS_CHILDREN, async ({ request }) => {
            await record(request);
            return HttpResponse.json(eventTypes);
          })
        );

        await run({ name: 'Premier League', instances: ['PP'] });

        expect(seen[0]!.instancesList).toEqual(['urn:i:PP:PP']);
      });

      it('rejects an unknown instance code before making any GMA call (SC-008)', async () => {
        // No handlers registered: if a call were made, msw's onUnhandledRequest:'error'
        // would fail the test. So this also proves no request went out.
        try {
          await run({ name: 'Premier League', instances: ['Not A Code'] });
          expect.unreachable('an unknown instance code must be rejected');
        } catch (error) {
          const toolError = error as ToolError;
          expect(toolError.kind).toBe('argument');
          expect(toolError.message).toContain('list_instances');
        }
      });

      it('rejects an explicitly empty instances list rather than widening the query', async () => {
        try {
          await run({ name: 'Premier League', instances: [] });
          expect.unreachable('an empty instances list must be rejected');
        } catch (error) {
          expect((error as ToolError).kind).toBe('argument');
        }
      });
    });

    describe('case: terminal failures on hop 1 (FR-010, SC-008)', () => {
      it.each([
        [400, search400, 'argument'],
        [401, search401, 'auth'],
        [500, search500, 'upstream']
      ] as const)('maps HTTP %i on search to kind %s', async (status, body, kind) => {
        server.use(http.post(SEARCH, () => HttpResponse.json(body, { status })));

        try {
          await run({ name: 'Premier League' });
          expect.unreachable(`HTTP ${status} must not resolve`);
        } catch (error) {
          const toolError = error as ToolError;
          expect(toolError.kind).toBe(kind);
          expect(toolError).not.toHaveProperty('completeness');
        }
      });
    });

    describe('case: the description forbids auto-picking and mandates relaying caveats (FR-009, FR-014)', () => {
      it('tells the agent not to pick from several candidates', () => {
        const lower = FIND_CATALOGUE_ENTITY_DESCRIPTION.toLowerCase();

        expect(lower).toContain('do not pick one yourself');
        expect(lower).toContain('ask which they mean');
      });

      it('tells the agent to relay completeness caveats', () => {
        expect(FIND_CATALOGUE_ENTITY_DESCRIPTION.toLowerCase()).toContain('relay');
      });

      it('uses no GMA DTO vocabulary (Principle IV)', () => {
        expect(FIND_CATALOGUE_ENTITY_DESCRIPTION).not.toContain('configSource');
        expect(FIND_CATALOGUE_ENTITY_DESCRIPTION).not.toContain('instancesList');
        // No generation, either one (003-FR-012).
        expect(FIND_CATALOGUE_ENTITY_DESCRIPTION).not.toMatch(/\bv[45]\b/);
      });
    });
  }
);

/**
 * The hero tool on a real v4-default deployment: one call, two generations (Story 2).
 *
 * Everything here resolves from a DEFAULT config with the domain's real pins, rather than
 * hand-built handles — so these assertions fail if the default changed, if the pin were
 * dropped, or if the two disagreed.
 */
describe('find_catalogue_entity across generations', () => {
  const CHILD_CHILDREN = `${GMA_BASE_URL}/v4/subclasses/:id/eventTypes`;

  /** Resolve exactly as `server/register.ts` does, from config plus the domain's pins. */
  function deployment(overrides: Parameters<typeof testConfig>[0] = {}) {
    const config = testConfig(overrides);
    const operations = requireOperations(
      resolveOperations({
        capability: 'catalogue',
        operations: CATALOGUE_OPERATIONS,
        pins: CATALOGUE_PINS,
        defaultGeneration: config.defaultGeneration
      }),
      CATALOGUE_OPERATIONS
    );
    return { config, operations };
  }

  function runDefault(
    args: Parameters<typeof findCatalogueEntity>[4],
    overrides: Parameters<typeof testConfig>[0] = {}
  ) {
    const { config, operations } = deployment(overrides);
    return findCatalogueEntity(createGmaClient({ config }), config, operations, TEST_TOKEN, args);
  }

  describe('case: the search is served by v5 on a v4-default deployment (003-FR-004, SC-004)', () => {
    it('sends the search to /v5/searchByName while the child hop goes to /v4/', async () => {
      // THE assertion for this feature's hardest constraint. v4 has no by-name search, so
      // a v4-default deployment that could not reach v5 for this one operation would have
      // lost the tool the server exists for.
      const paths: string[] = [];
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(singleMatch);
        }),
        http.get(CHILD_CHILDREN, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(eventTypes);
        })
      );

      const { operations } = deployment();
      expect(operations.searchByName.generation).toBe('v5');
      expect(operations.subclassEventTypes.generation).toBe('v4');

      const payload = await runDefault({ name: 'Premier League' });

      expect(paths).toEqual([
        '/v5/searchByName',
        // The id percent-encoded by the client, from the entity the v5 search returned:
        // an identifier obtained under one generation resolves under the other
        // (spec edge case 2).
        '/v4/subclasses/urn%3Asub%3Apremier-league/eventTypes'
      ]);
      expect(payload.kind).toBe('resolved');
    });
  });

  describe('case: a search on a v4 default is never degraded or refused (003-FR-004, Story 2 scenario 2)', () => {
    it.each([
      ['resolved', singleMatch, 'resolved'],
      ['candidates', multiMatch, 'candidates'],
      ['none', noMatch, 'none'],
      ['tooBroad', manyMatches, 'tooBroad']
    ] as const)(
      'produces a %s outcome with an unchanged shape',
      async (_label, searchBody, expectedKind) => {
        server.use(
          http.post(`${GMA_BASE_URL}/v5/searchByName`, () => HttpResponse.json(searchBody)),
          http.get(CHILD_CHILDREN, () => HttpResponse.json(eventTypes))
        );

        const payload = await runDefault({ name: 'Premier League' });

        // Not degraded, not refused, not an error: the same four outcomes as ever.
        expect(payload.kind).toBe(expectedKind);
        expect(payload.completeness).toBeDefined();
      }
    );
  });

  describe('case: one tool call spanning v5 search and v4 children aggregates completeness identically to a single-generation traversal (003-FR-009, FR-018, SC-008)', () => {
    it('marks the whole result incomplete when the v4 CHILD hop alone was partial', async () => {
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () => HttpResponse.json(singleMatch)),
        http.get(CHILD_CHILDREN, () => HttpResponse.json(childrenPartial, { status: 206 }))
      );

      const payload = await runDefault({ name: 'Premier League' });
      const completeness = payload.completeness as {
        complete: boolean;
        outcome: string;
        failedInstances: string[];
      };

      // The generation boundary is NOT a boundary for the verdict: a 206 on the v4 hop
      // marks a result whose first hop came from v5.
      expect(completeness.complete).toBe(false);
      expect(completeness.outcome).toBe('PARTIAL');
      expect(completeness.failedInstances).toEqual(['urn:i:BF:BF']);
    });

    it('marks the whole result incomplete when the v5 SEARCH hop alone was partial', async () => {
      // Upstream declares no 206 on searchByName, so this drives the aggregation from a
      // partial envelope on the operation that CAN report one. What is asserted is the
      // aggregation rule, not a response GMA would send.
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () =>
          HttpResponse.json(
            {
              successfulConfigSources: ['urn:i:PP:PP'],
              failedConfigSources: ['urn:i:BF:BF'],
              errors: [{ configSource: 'urn:i:BF:BF', message: 'did not respond' }],
              results: [
                {
                  superclass: { id: 'urn:sc:football', name: 'Football' },
                  subclass: { id: 'urn:sub:pl', name: 'Premier League' }
                }
              ]
            },
            { status: 206 }
          )
        ),
        http.get(CHILD_CHILDREN, () => HttpResponse.json(eventTypes))
      );

      const payload = await runDefault({ name: 'Premier League' });
      const completeness = payload.completeness as { complete: boolean; outcome: string };

      expect(completeness.complete).toBe(false);
      expect(completeness.outcome).toBe('PARTIAL');
    });

    it('produces the same verdict as an all-v5 traversal given the same statuses', async () => {
      // The equivalence FR-018 asks for: spanning two generations must not change the
      // verdict, only which host answered.
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () => HttpResponse.json(singleMatch)),
        http.get(CHILD_CHILDREN, () => HttpResponse.json(childrenPartial, { status: 206 })),
        http.get(`${GMA_BASE_URL}/v5/subclasses/:id/eventTypes`, () =>
          HttpResponse.json(childrenPartial, { status: 206 })
        )
      );

      const spanning = await runDefault({ name: 'Premier League' });
      const singleGeneration = await runDefault(
        { name: 'Premier League' },
        {
          defaultGeneration: 'v5'
        }
      );

      expect(spanning.completeness).toEqual(singleGeneration.completeness);
    });
  });

  describe('case: a timeout on the v4 child hop after a successful v5 search still yields TIMEOUT_PARTIAL (003-FR-010, FR-018)', () => {
    it('keeps the resolved entity and reports TIMEOUT_PARTIAL, not an error', async () => {
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () => HttpResponse.json(singleMatch)),
        http.get(CHILD_CHILDREN, async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return HttpResponse.json(eventTypes);
        })
      );

      const payload = await runDefault({ name: 'Premier League' }, { requestTimeoutMs: 25 });
      const completeness = payload.completeness as { complete: boolean; outcome: string };

      // The generation boundary must not reset, soften, or duplicate the verdict.
      expect(payload.kind).toBe('resolved');
      expect(completeness.outcome).toBe('TIMEOUT_PARTIAL');
      expect(completeness.complete).toBe(false);
      expect(payload.children).toEqual([]);
    });
  });

  describe('case: a 401 on the v4 child hop after a v5 search still surfaces as auth (001-FR-003)', () => {
    it('throws an auth error rather than returning the entity minus its children', async () => {
      server.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () => HttpResponse.json(singleMatch)),
        http.get(CHILD_CHILDREN, () => HttpResponse.json(search401, { status: 401 }))
      );

      try {
        await runDefault({ name: 'Premier League' });
        expect.unreachable('an expired identity must not be softened into a partial success');
      } catch (error) {
        // The auth-wins rule survives a cross-generation traversal: an expired identity
        // must reach the human, never be dressed as "here is the entity, minus children".
        expect((error as ToolError).kind).toBe('auth');
      }
    });
  });
});
