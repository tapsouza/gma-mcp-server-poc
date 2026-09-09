import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import type { ToolError } from '../../src/core/types.js';
import { getEventInputSchema } from '../../src/domains/catalogue/schemas.js';
import {
  GET_EVENT_DESCRIPTION,
  getEvent,
  toEventUrn
} from '../../src/domains/catalogue/tools/getEvent.js';
import {
  GMA_BASE_URL,
  TEST_TOKEN,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import event206 from '../fixtures/gma/events/206-partial.json' with { type: 'json' };
import event400 from '../fixtures/gma/events/400-bad-request.json' with { type: 'json' };
import event401 from '../fixtures/gma/events/401-unauthorized.json' with { type: 'json' };
import event404 from '../fixtures/gma/events/404-not-found.json' with { type: 'json' };
import event500 from '../fixtures/gma/events/500-server-error.json' with { type: 'json' };
import eventSuccess from '../fixtures/gma/events/200-success.json' with { type: 'json' };

/**
 * `get_event` — the catalogue lookup for one sporting event.
 *
 * The tool exists to make a bet leg's event id ACTIONABLE: `find_customer_bets` already
 * reports an event name and id per leg, and until this tool the id was inert.
 *
 * Three properties here would each pass a plausible-looking implementation that is
 * confidently wrong, and they are the reason this suite is not just a happy path:
 *
 *  - **The scoping parameter is `sources`.** `getEventById` declares that name;
 *    `instancesList` — which every sibling operation uses — is silently IGNORED here, so
 *    a wrong name does not error, it just fans the lookup out across every instance.
 *  - **A bare number is rejected, not prefixed.** The `source` namespace is data. Every
 *    id seen live carries `gpd`, which is exactly what makes a hardcoded `gpd` look
 *    correct until a bet arrives with another source and the tool fabricates an id.
 *  - **A 200 that does not carry the event is an ERROR, not an empty answer.** An empty
 *    success would tell the model the event has no hierarchy, which is never true.
 */

const server = useGmaServer();
const EVENT = `${GMA_BASE_URL}/v5/events/:id`;

function run(
  args: Parameters<typeof getEvent>[3],
  overrides: Parameters<typeof testConfig>[0] = {}
) {
  const config = testConfig(overrides);
  return getEvent(createGmaClient({ config }), config, TEST_TOKEN, args);
}

describe('get_event', () => {
  describe('case: an event resolves with its hierarchy and markets', () => {
    it('returns the event, its broadest-first ancestors, and its markets', async () => {
      server.use(http.get(EVENT, () => HttpResponse.json(eventSuccess)));

      const result = await run({ id: 'gpd:9201' });

      expect(result.event).toEqual({
        id: 'urn:sbk:pc:e:gpd:9201',
        name: 'Team A v Team B',
        // BROADEST FIRST, matching `get_catalogue_entity`'s `ancestors`, even though the
        // upstream shapes differ — that one nests its parents, this one states them flat.
        ancestors: [
          { id: 'urn:sbk:pc:spc:gpd:3', name: 'Football', type: 'superclass' },
          { id: 'urn:sbk:pc:sbc:gpd:7', name: '|Premier League|', type: 'subclass' },
          { id: 'urn:sbk:pc:et:gpd:3307', name: 'Match Winner', type: 'eventType' }
        ],
        markets: [
          { id: 'urn:sbk:pc:m:gpd:9301', name: 'Match Winner' },
          { id: 'urn:sbk:pc:m:gpd:9302', name: 'Total Goals' }
        ]
      });
      expect(result.completeness.complete).toBe(true);
    });

    it('never states an ancestor of type "event", which would be a level that cannot exist', () => {
      // Guards the schema decision: `eventAncestorSchema` reuses the three CONFIGURATION
      // levels. Widening it to include `'event'` would let a path claim an event as a
      // parent, and an event is never any other entity's ancestor.
      server.use(http.get(EVENT, () => HttpResponse.json(eventSuccess)));

      return run({ id: 'gpd:9201' }).then((result) => {
        expect(result.event.ancestors.map((a) => a.type)).toEqual([
          'superclass',
          'subclass',
          'eventType'
        ]);
      });
    });
  });

  describe('case: both id forms are accepted, and the source is never invented', () => {
    it('builds the long URN from the short "source:id" form a bet reports', async () => {
      const recorder = requestRecorder();
      server.use(
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(eventSuccess);
        })
      );

      await run({ id: 'gpd:14643022' });

      expect(recorder.seen[0]!.url).toContain(encodeURIComponent('urn:sbk:pc:e:gpd:14643022'));
    });

    it('passes an already-assembled long urn through unchanged', async () => {
      const recorder = requestRecorder();
      server.use(
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(eventSuccess);
        })
      );

      await run({ id: 'urn:sbk:pc:e:gpd:14643022' });

      expect(recorder.seen[0]!.url).toContain(encodeURIComponent('urn:sbk:pc:e:gpd:14643022'));
    });

    it('READS the source from the value rather than defaulting it to gpd', async () => {
      // The defect this guards is invisible while every live id happens to be `gpd`.
      const recorder = requestRecorder();
      server.use(
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(eventSuccess);
        })
      );

      await run({ id: 'abc:555' });

      expect(recorder.seen[0]!.url).toContain(encodeURIComponent('urn:sbk:pc:e:abc:555'));
      expect(recorder.seen[0]!.url).not.toContain('gpd');
    });
  });

  describe('case: a bare number is a self-correctable argument error, and costs NO upstream call', () => {
    it.each([
      ['a bare number', '14643022'],
      ['an empty source', ':9201'],
      ['an empty source id', 'gpd:'],
      ['too many segments', 'gpd:9201:extra'],
      ['a short urn', 'urn:gpd:14643022'],
      ['a truncated long urn', 'urn:sbk:pc:e:gpd']
    ])('rejects %s before calling GMA', async (_label, id) => {
      // NO handler registered: `onUnhandledRequest: 'error'` means any upstream call
      // fails this test, which is the property under test. A malformed argument must not
      // cost a round trip (SC-008).
      const error = (await run({ id }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
    });

    it('names where a real event id comes from, so the agent can self-correct', async () => {
      const error = (await run({ id: '14643022' }).catch((e: unknown) => e)) as ToolError;

      expect(error.message).toContain('find_customer_bets');
      // NOT the default `argument` guidance, which talks about instance codes and
      // `list_instances` — true for the scoped tools, misdirecting when the id was
      // the rejected argument.
      expect(error.message).not.toContain('list_instances');
    });

    it('does not echo the rejected value back at the agent', async () => {
      // The agent already knows what it sent; echoing teaches it nothing and puts a
      // caller-supplied string into a message a human may read.
      const error = (await run({ id: '99887766' }).catch((e: unknown) => e)) as ToolError;

      expect(error.message).not.toContain('99887766');
    });

    it('rejects a blank id at the SCHEMA, before the tool is even entered', () => {
      // Defence in depth: zod rejects `''` so the tool's own guard is not the only thing
      // standing between a blank id and an upstream call.
      expect(getEventInputSchema.id.safeParse('').success).toBe(false);
      expect(getEventInputSchema.id.safeParse('gpd:1').success).toBe(true);
    });
  });

  describe('case: scoping uses `sources`, the name THIS operation declares', () => {
    it('sends `sources` and never `instancesList`', async () => {
      // `instancesList` is not rejected by GMA — it is ignored, and the lookup fans out
      // across every instance. So this can only be caught by observing the request.
      const recorder = requestRecorder();
      server.use(
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(eventSuccess);
        })
      );

      await run({ id: 'gpd:9201', instances: ['PP'] });
      const url = new URL(recorder.seen[0]!.url);

      expect(url.searchParams.getAll('sources')).toEqual(['urn:i:PP:PP']);
      expect(url.searchParams.getAll('instancesList')).toEqual([]);
    });

    it('falls back to the configured default set when the caller omits instances', async () => {
      const recorder = requestRecorder();
      server.use(
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(eventSuccess);
        })
      );

      // Configuration holds short CODES (`GMA_DEFAULT_INSTANCES`); `resolveInstances`
      // is what turns them into the URNs GMA wants, so the tool never sees a URN shape.
      await run({ id: 'gpd:9201' }, { defaultInstances: ['FD'] });

      expect(new URL(recorder.seen[0]!.url).searchParams.getAll('sources')).toEqual([
        'urn:i:FD:FD'
      ]);
    });

    it('rejects an unknown instance code as an argument error naming list_instances', async () => {
      const error = (await run({ id: 'gpd:9201', instances: ['not a code'] }).catch(
        (e: unknown) => e
      )) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.message).toContain('list_instances');
    });
  });

  describe('case: every upstream outcome is distinguishable', () => {
    it('reports a 206 as incomplete, naming the failed instance as a RETRYABLE axis', async () => {
      server.use(http.get(EVENT, () => HttpResponse.json(event206, { status: 206 })));

      const result = await run({ id: 'gpd:9201' });

      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.outcome).toBe('PARTIAL');
      // A failed INSTANCE, not an unavailable component: retrying may help, and the two
      // axes must never merge (Principle II).
      expect(result.completeness.failedInstances).toHaveLength(1);
      expect(result.completeness.unavailableComponents ?? []).toEqual([]);
      // The event that DID come back is still returned in full.
      expect(result.event.name).toBe('Team A v Team B');
    });

    it('maps a 400 to argument, NOT retryable', async () => {
      // The live OpenBet-event answer: a well-formed URN the catalogue cannot serve. The
      // GMA UI receives the same 400, so this is upstream's verdict, not a bad request.
      server.use(http.get(EVENT, () => HttpResponse.json(event400, { status: 400 })));

      const error = (await run({ id: 'gpd:14643022' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
    });

    it('maps a 401 to auth, which a human must act on', async () => {
      server.use(http.get(EVENT, () => HttpResponse.json(event401, { status: 401 })));

      const error = (await run({ id: 'gpd:9201' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('auth');
      expect(error.retryable).toBe(false);
    });

    it('maps a 404 to notFound rather than an empty success', async () => {
      // An empty success would say "this event has no hierarchy", which is never true.
      server.use(http.get(EVENT, () => HttpResponse.json(event404, { status: 404 })));

      const error = (await run({ id: 'gpd:9201' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('notFound');
      expect(error.retryable).toBe(false);
    });

    it('maps a 500 to upstream, which is retryable', async () => {
      server.use(http.get(EVENT, () => HttpResponse.json(event500, { status: 500 })));

      const error = (await run({ id: 'gpd:9201' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
    });

    it('treats a 200 whose body carries no event as an upstream error', async () => {
      server.use(http.get(EVENT, () => HttpResponse.json({})));

      const error = (await run({ id: 'gpd:9201' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('upstream');
    });

    it('treats a 200 whose event has no id as an upstream error', async () => {
      // A body that parses but does not match GMA's own schema. `id` is `required` on
      // `Event`, so this is a contract violation rather than data.
      server.use(http.get(EVENT, () => HttpResponse.json({ event: { name: 'nameless' } })));

      const error = (await run({ id: 'gpd:9201' }).catch((e: unknown) => e)) as ToolError;

      expect(error.kind).toBe('upstream');
    });
  });

  describe('case: a partial event body degrades rather than failing', () => {
    it('omits a hierarchy level the response did not carry, rather than inventing one', async () => {
      server.use(
        http.get(EVENT, () =>
          HttpResponse.json({
            event: {
              id: 'urn:sbk:pc:e:gpd:9201',
              name: 'Team A v Team B',
              superclassId: 'urn:sbk:pc:spc:gpd:3',
              superclassName: 'Football'
              // No subclass or eventType: all three pairs are `required` upstream, so
              // this is degraded data rather than a shape to model.
            }
          })
        )
      );

      const result = await run({ id: 'gpd:9201' });

      expect(result.event.ancestors).toEqual([
        { id: 'urn:sbk:pc:spc:gpd:3', name: 'Football', type: 'superclass' }
      ]);
      expect(result.event.markets).toEqual([]);
    });

    it('falls back to the id when a name is absent, so no entry is nameless', async () => {
      server.use(
        http.get(EVENT, () =>
          HttpResponse.json({
            event: {
              id: 'urn:sbk:pc:e:gpd:9201',
              superclassId: 'urn:sbk:pc:spc:gpd:3',
              markets: [{ id: 'urn:sbk:pc:m:gpd:9301' }]
            }
          })
        )
      );

      const result = await run({ id: 'gpd:9201' });

      expect(result.event.name).toBe('urn:sbk:pc:e:gpd:9201');
      expect(result.event.ancestors[0]!.name).toBe('urn:sbk:pc:spc:gpd:3');
      expect(result.event.markets[0]!.name).toBe('urn:sbk:pc:m:gpd:9301');
    });

    it('drops a market with no id rather than emitting a nameless placeholder', async () => {
      server.use(
        http.get(EVENT, () =>
          HttpResponse.json({
            event: {
              id: 'urn:sbk:pc:e:gpd:9201',
              markets: [{ name: 'no id' }, null, { id: 'urn:sbk:pc:m:gpd:9301', name: 'Winner' }]
            }
          })
        )
      );

      const result = await run({ id: 'gpd:9201' });

      expect(result.event.markets).toEqual([{ id: 'urn:sbk:pc:m:gpd:9301', name: 'Winner' }]);
    });
  });

  describe('case: the description tells the model there is no event NAME search', () => {
    it('says so explicitly, because no upstream operation offers one', () => {
      // `POST /v5/searchByName` covers superclass, subclass and event type only —
      // `SearchByNameResult` is a three-field record. An agent that does not know this
      // will send a name and get an argument error it cannot fix.
      expect(GET_EVENT_DESCRIPTION).toContain('no search by event name');
      expect(GET_EVENT_DESCRIPTION).toContain('find_customer_bets');
    });
  });

  describe('case: toEventUrn is a pure mirror of GbpId, tested directly', () => {
    it.each([
      ['gpd:14643022', 'urn:sbk:pc:e:gpd:14643022'],
      ['abc:1', 'urn:sbk:pc:e:abc:1'],
      ['urn:sbk:pc:e:gpd:9201', 'urn:sbk:pc:e:gpd:9201']
    ])('maps %s to %s', (input, expected) => {
      expect(toEventUrn(input)).toBe(expected);
    });

    it('is idempotent, so a value already assembled survives a second pass', () => {
      expect(toEventUrn(toEventUrn('gpd:9201') as string)).toBe('urn:sbk:pc:e:gpd:9201');
    });

    it('tolerates surrounding whitespace an agent may include', () => {
      expect(toEventUrn('  gpd:9201  ')).toBe('urn:sbk:pc:e:gpd:9201');
    });

    it.each(['14643022', '', ':1', 'gpd:', 'a:b:c', 'urn:gpd:1'])(
      'returns null for %s rather than guessing',
      (input) => {
        expect(toEventUrn(input)).toBeNull();
      }
    );
  });
});
