import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import type { ToolError } from '../../src/core/types.js';
import { QBS_GRAPHQL_PATH } from '../../src/domains/customer/gql/searchBets.js';
import {
  FIND_CUSTOMER_BETS_DESCRIPTION,
  findCustomerBets
} from '../../src/domains/customer/tools/findCustomerBets.js';
import {
  GMA_BASE_URL,
  TEST_TOKEN,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import qbsSingle from '../fixtures/gma/qbsSearchBets/200-single-bet.json' with { type: 'json' };
import qbsMultiLeg from '../fixtures/gma/qbsSearchBets/200-multi-leg-bet.json' with { type: 'json' };
import qbsMultiple from '../fixtures/gma/qbsSearchBets/200-multiple-matches.json' with { type: 'json' };
import qbsNoMatch from '../fixtures/gma/qbsSearchBets/200-no-match.json' with { type: 'json' };
import qbsOverLimit from '../fixtures/gma/qbsSearchBets/200-over-limit.json' with { type: 'json' };
import qbsWithErrors from '../fixtures/gma/qbsSearchBets/200-success-with-errors.json' with { type: 'json' };
import qbs401 from '../fixtures/gma/qbsSearchBets/401-unauthorized.json' with { type: 'json' };
import qbs403 from '../fixtures/gma/qbsSearchBets/403-forbidden.json' with { type: 'json' };
import qbs500 from '../fixtures/gma/qbsSearchBets/500-server-error.json' with { type: 'json' };

/**
 * `find_customer_bets` — User Story 2 (P2) acceptance scenarios 1 to 6.
 *
 * The case that matters most is scenario 4: a `200` carrying GraphQL `errors[]` must be
 * marked incomplete. The plan calls presenting that as complete "the single worst
 * defect this feature could ship".
 */

const server = useGmaServer();
const QBS = `${GMA_BASE_URL}${QBS_GRAPHQL_PATH}`;
const MAX_BETS = 20;
const client = () => createGmaClient({ config: testConfig() });

describe('find_customer_bets (Story 2, P2)', () => {
  describe('case: scenario 1 — searching by account returns the curated projection', () => {
    it('returns kind "bets" with the projection and a complete verdict', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsSingle)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      expect(result.kind).toBe('bets');
      expect(result.bets).toHaveLength(1);
      expect(result.bets![0]!.betId).toBe('bet-000111');
      expect(result.completeness.complete).toBe(true);
    });

    it('places the caller value ONLY in variables.input.ids, never in the document', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: 'acct-test-0001' });
      const body = recorder.seen[0]!.body as {
        query: string;
        variables: { input: { ids: Record<string, string[]> } };
      };

      expect(body.variables.input.ids).toEqual({ accountId: ['acct-test-0001'] });
      // The document is a constant, so the caller value appears nowhere in it. An
      // agent that could reach the query could send a mutation (Principle IV).
      expect(body.query).not.toContain('acct-test-0001');
      expect(body.query).not.toContain('mutation');
    });

    it('requests sort PLACEMENT_DATE DESC upstream (research.md R6)', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: 'acct-test-0001' });
      const body = recorder.seen[0]!.body as {
        variables: { params: { sort: { field: string; order: string }; itemsPerPage: number } };
      };

      expect(body.variables.params.sort).toEqual({ field: 'PLACEMENT_DATE', order: 'DESC' });
      expect(body.variables.params.itemsPerPage).toBe(MAX_BETS);
    });

    it('requests the ZERO-th page, because QBS pageNumber is zero-based', async () => {
      // A REGRESSION TEST for a live defect: this sent `pageNumber: 1`, which asks for the
      // SECOND page. A single-bet lookup is one page long, so QBS answered HTTP 200 with
      // `pageInfo.count: 0` and no `errors[]` — and the tool honestly reported "no match"
      // for a bet visible in the UI. Nothing signalled a fault.
      //
      // Note what this assertion can and cannot do. `msw` ignores `pageNumber` entirely, so
      // no fixture-based test can catch the WRONG value by observing a wrong result — the
      // defect was found against live GMA. What it does catch is the value silently
      // changing back, which is the regression that matters.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { betId: 'bet-000111' });
      const body = recorder.seen[0]!.body as { variables: { params: { pageNumber: number } } };

      expect(body.variables.params.pageNumber).toBe(0);
    });

    it('sends NO instance query parameter (FR-025, constitution v1.2.0)', async () => {
      // `?instance=` is ROUTING, not scoping. It must not be sent while multi-instance
      // routing is disabled, and must never be a tool argument in any case.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: 'acct-test-0001' });

      expect(recorder.seen[0]!.url).not.toContain('instance=');
      expect(recorder.seen[0]!.url).toBe(`${GMA_BASE_URL}${QBS_GRAPHQL_PATH}`);
      expect(JSON.stringify(recorder.seen[0]!.body)).not.toContain('"instance"');
    });

    it('makes exactly ONE upstream call', async () => {
      let calls = 0;
      server.use(
        http.post(QBS, () => {
          calls += 1;
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: 'acct-test-0001' });

      expect(calls).toBe(1);
    });

    it('forwards the operator token unaltered', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: 'acct-test-0001' });

      expect(recorder.seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });
  });

  describe('case: scenario 2 — a receipt identifier searches directly, no conversion needed', () => {
    it('sends the receipt id as receiptId, so the operator converts nothing', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        receiptId: 'R-000111'
      });
      const body = recorder.seen[0]!.body as {
        variables: { input: { ids: Record<string, string[]> } };
      };

      expect(body.variables.input.ids).toEqual({ receiptId: ['R-000111'] });
      expect(result.bets![0]!.receiptId).toBe('R-000111');
    });

    it('sends a bet id as betId', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { betId: 'bet-000111' });
      const body = recorder.seen[0]!.body as {
        variables: { input: { ids: Record<string, string[]> } };
      };

      expect(body.variables.input.ids).toEqual({ betId: ['bet-000111'] });
    });
  });

  describe('case: scenario 3 — nothing matched is "none", not an error and not a caveat (FR-012)', () => {
    it('returns kind "none" with a COMPLETE verdict', async () => {
      // "Nothing matched" is an ANSWER. Treating it as an error would make the agent
      // retry; caveating it would make the agent hedge a fact, and every genuine
      // caveat is worth less as a result.
      server.use(http.post(QBS, () => HttpResponse.json(qbsNoMatch)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-nothing'
      });

      expect(result.kind).toBe('none');
      expect(result.bets).toBeUndefined();
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.caveat).toBeNull();
    });

    it('reports limitReached false, since nothing was truncated', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsNoMatch)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-nothing'
      });

      expect(result.limitReached).toBe(false);
    });

    it('still carries the ordering caveat, which is unconditional', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsNoMatch)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-nothing'
      });

      expect(result.orderingCaveat.length).toBeGreaterThan(0);
    });
  });

  describe('case: scenario 4 — a 200 carrying errors[] is INCOMPLETE (FR-011, SC-002)', () => {
    it('marks the result incomplete and names what was unavailable', async () => {
      // THE assertion. The upstream status is 200 and GMA's own client treats this as
      // usable data; a tool that trusted the status line would present a
      // half-populated bet as complete.
      server.use(http.post(QBS, () => HttpResponse.json(qbsWithErrors)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000222'
      });

      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.unavailableComponents.length).toBeGreaterThan(0);
      expect(result.completeness.unavailableComponents).toContain('betDetail');
      expect(result.completeness.unavailableComponents).toContain('legCataloguePositions');
    });

    it('is NEVER presented as complete, even though the data is usable', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsWithErrors)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000222'
      });

      // The usable part IS returned — discarding it would be the opposite error.
      expect(result.kind).toBe('bets');
      expect(result.bets![0]!.betId).toBe('bet-000222');
      // But it is not complete.
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.caveat).not.toBeNull();
    });

    it('reports it through unavailableComponents and NOT through failedInstances (FR-026)', async () => {
      // The axis distinction: every source ANSWERED, so nothing failed to answer.
      // Reporting this as a failed instance would tell the agent to retry with
      // narrower scoping, which cannot help, so it would retry forever.
      server.use(http.post(QBS, () => HttpResponse.json(qbsWithErrors)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000222'
      });

      expect(result.completeness.failedInstances).toEqual([]);
      expect(result.completeness.errors).toEqual([]);
    });

    it('tells the agent NOT to retry with different scoping', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsWithErrors)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000222'
      });

      expect(result.completeness.caveat?.toLowerCase()).toContain(
        'do not retry with different scoping'
      );
    });

    it('surfaces no upstream error TEXT, which could echo an identifier', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsWithErrors)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000222'
      });

      expect(result.completeness.caveat).not.toContain('Exception while fetching');
      expect(result.completeness.caveat).not.toContain('DataFetchingException');
    });
  });

  describe('case: scenario 5 — insufficient permission is forbidden and not retryable (SC-009)', () => {
    it('maps a 403 to kind forbidden with retryable false', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbs403, { status: 403 })));

      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('forbidden');
      expect(error.retryable).toBe(false);
    });

    it('is distinct from the 401 outcome on the same operation', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbs403, { status: 403 })));
      const forbidden = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      }).catch((e) => e as ToolError);

      server.use(http.post(QBS, () => HttpResponse.json(qbs401, { status: 401 })));
      const auth = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      }).catch((e) => e as ToolError);

      expect(forbidden.kind).toBe('forbidden');
      expect(auth.kind).toBe('auth');
      expect(forbidden.retryable).toBe(false);
    });

    it('maps a 500 to a retryable upstream error, not an empty bet list', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbs500, { status: 500 })));

      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error).not.toHaveProperty('bets');
    });

    it('echoes no identifier in any error message (FR-030)', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbs403, { status: 403 })));

      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-recognisable-99887'
      }).catch((e) => e as ToolError);

      expect(error.message).not.toContain('acct-recognisable-99887');
      expect(error.message).not.toContain('99887');
    });
  });

  describe('case: zero or two identifiers is an argument error naming the choices (FR-008, SC-008)', () => {
    it('rejects ZERO identifiers before any upstream call, naming all three', async () => {
      // No msw handler: onUnhandledRequest:'error' proves no request was made.
      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {}).catch(
        (e) => e as ToolError
      );

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('accountId');
      expect(error.message).toContain('betId');
      expect(error.message).toContain('receiptId');
    });

    it('rejects TWO identifiers, naming which kinds were supplied', async () => {
      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001',
        betId: 'bet-000111'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      // The KINDS are named so the agent knows what to drop...
      expect(error.message).toContain('accountId');
      expect(error.message).toContain('betId');
    });

    it('echoes NO supplied value in either message (FR-030)', async () => {
      // ...but never the VALUES, all three of which are personal data.
      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-recognisable-99887',
        receiptId: 'R-secret-12345'
      }).catch((e) => e as ToolError);

      expect(error.message).not.toContain('acct-recognisable-99887');
      expect(error.message).not.toContain('R-secret-12345');
      expect(error.message).not.toContain('99887');
      expect(error.message).toMatch(/personal data/i);
    });

    it('rejects all three supplied at once', async () => {
      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'a',
        betId: 'b',
        receiptId: 'c'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      expect(error.message).toContain('3 were supplied');
    });

    it('treats a blank identifier as absent rather than as a value', async () => {
      const error = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: '   '
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      expect(error.message).toContain('none was supplied');
    });

    it('trims a well-formed identifier', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, { accountId: '  acct-test-0001  ' });
      const body = recorder.seen[0]!.body as {
        variables: { input: { ids: Record<string, string[]> } };
      };

      expect(body.variables.input.ids).toEqual({ accountId: ['acct-test-0001'] });
    });
  });

  describe('case: the configured bound is REPORTED, never silently truncating (FR-010)', () => {
    it('sets limitReached true when the cap truncated the set', async () => {
      // The fixture holds 25 bets and reports 137 upstream, against a cap of 20.
      server.use(http.post(QBS, () => HttpResponse.json(qbsOverLimit)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      expect(result.limitReached).toBe(true);
      expect(result.totalMatched).toBe(137);
    });

    it('sets limitReached false when everything that matched was returned', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsSingle)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      expect(result.limitReached).toBe(false);
      expect(result.totalMatched).toBe(1);
    });

    it('requests the CONFIGURED cap, so the bound comes from deployment (Principle V)', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      await findCustomerBets(client(), 3, TEST_TOKEN, { accountId: 'acct-test-0001' });
      const body = recorder.seen[0]!.body as { variables: { params: { itemsPerPage: number } } };

      expect(body.variables.params.itemsPerPage).toBe(3);
    });

    it('lets a caller ask for FEWER but never for more than the configured cap', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsSingle);
        })
      );

      // Narrowing is allowed...
      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001',
        limit: 5
      });
      // ...widening is clamped, because the bound is operational (Principle V).
      await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001',
        limit: 5000
      });

      const bodies = recorder.seen.map(
        (seen) =>
          (seen.body as { variables: { params: { itemsPerPage: number } } }).variables.params
            .itemsPerPage
      );
      expect(bodies).toEqual([5, MAX_BETS]);
    });

    it('reports the bound as reached rather than returning bets and staying silent', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsOverLimit)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      // Silent truncation is prohibited: the agent must be able to tell the user that
      // more bets exist than it is looking at.
      expect(result.limitReached).toBe(true);
      expect(result.totalMatched!).toBeGreaterThan(result.bets!.length);
    });
  });

  describe('case: the ordering caveat is present on EVERY success (FR-010)', () => {
    it.each([
      ['a single match', qbsSingle],
      ['several matches', qbsMultiple],
      ['no match', qbsNoMatch],
      ['a truncated set', qbsOverLimit],
      ['a success carrying errors', qbsWithErrors]
    ])('is present for %s', async (_label, fixture) => {
      server.use(http.post(QBS, () => HttpResponse.json(fixture)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      expect(result.orderingCaveat).toMatch(/most recent first/i);
      expect(result.orderingCaveat).toMatch(/may not be the globally most recent/i);
    });

    it('is stated unconditionally even though the sort IS requested upstream', async () => {
      // R6 resolved the sort question, which narrowed the caveat from "ordering is
      // unknown" to "this is the first page". The remaining claim is still true and
      // still worth saying: an operator who believes they see the latest activity and
      // does not would draw a wrong conclusion about a customer.
      server.use(http.post(QBS, () => HttpResponse.json(qbsSingle)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        accountId: 'acct-test-0001'
      });

      expect(result.orderingCaveat).not.toMatch(/unknown/i);
      expect(result.orderingCaveat).toMatch(/first bets of the upstream result set/i);
    });
  });

  describe('case: several matches are all returned, none chosen (FR-014-equivalent)', () => {
    it('returns both candidates for one receipt identifier', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsMultiple)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        receiptId: 'R-000111'
      });

      expect(result.bets).toHaveLength(2);
      expect(result.bets!.map((bet) => bet.betId).sort()).toEqual(['bet-000111', 'bet-000444']);
    });
  });

  describe('case: a multi-leg bet returns every leg with its own entities', () => {
    it('returns three legs, two of which share one event', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsMultiLeg)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000333'
      });
      const bet = result.bets![0]!;

      expect(bet.legs).toHaveLength(3);
      expect(bet.legCount).toBe(3);
      expect(new Set(bet.legs.map((leg) => leg.event.id)).size).toBe(2);
    });

    it('carries NO risk-side catalogue level on any leg (research.md R5)', async () => {
      // A leg's tree is sport/competition/event/market/selection. The risk tree is
      // SUPERCLASS/SUBCLASS/EVENT_TYPE/MARKET_TYPE. They meet only through the event,
      // which is why the composite exists — and why this tool must not imply a match.
      server.use(http.post(QBS, () => HttpResponse.json(qbsMultiLeg)));

      const result = await findCustomerBets(client(), MAX_BETS, TEST_TOKEN, {
        betId: 'bet-000333'
      });
      const serialised = JSON.stringify(result.bets);

      for (const riskLevel of ['SUPERCLASS', 'SUBCLASS', 'EVENT_TYPE', 'MARKET_TYPE']) {
        expect(serialised).not.toContain(riskLevel);
      }
    });
  });

  describe('case: the description instructs the agent as FR-008 and FR-009 require', () => {
    it('tells the agent to relay the ordering caveat, satisfying the smoke test', () => {
      expect(FIND_CUSTOMER_BETS_DESCRIPTION.toLowerCase()).toContain('relay');
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toContain('orderingCaveat');
    });

    it('says exactly one identifier is required, and names all three', () => {
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toMatch(/exactly one/i);
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toMatch(/receipt/i);
    });

    it('says "none" means nothing matched and is not worth retrying (FR-012)', () => {
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toMatch(/nothing matched/i);
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toMatch(/do not retry/i);
    });

    it('refuses to explain a limit, and points at the composite for leg positions', () => {
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toMatch(/does NOT explain how/i);
      expect(FIND_CUSTOMER_BETS_DESCRIPTION).toContain('get_bet_risk_context');
    });

    it('exposes no upstream DTO vocabulary to the model', () => {
      for (const upstreamName of ['riskInfo', 'wageInfo', 'searchBets', 'graphql', 'qbs']) {
        expect(FIND_CUSTOMER_BETS_DESCRIPTION).not.toContain(upstreamName);
      }
    });
  });
});
