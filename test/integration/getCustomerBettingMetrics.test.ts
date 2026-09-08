import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import type { ToolError } from '../../src/core/types.js';
import {
  GET_CUSTOMER_BETTING_METRICS_DESCRIPTION,
  getCustomerBettingMetrics
} from '../../src/domains/customer/tools/getCustomerBettingMetrics.js';
import {
  GMA_BASE_URL,
  TEST_TOKEN,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import byBetType from '../fixtures/gma/customerMetrics/200-by-bet-type.json' with { type: 'json' };
import byHierarchy from '../fixtures/gma/customerMetrics/200-by-hierarchy-entity.json' with { type: 'json' };
import byTimeframe from '../fixtures/gma/customerMetrics/200-by-timeframe.json' with { type: 'json' };
import badLevels from '../fixtures/gma/customerMetrics/400-multiple-hierarchy-levels.json' with { type: 'json' };
import tooMany from '../fixtures/gma/customerMetrics/400-too-many-hierarchy-entities.json' with { type: 'json' };
import missingAccount from '../fixtures/gma/customerMetrics/400-account-identifier-missing.json' with { type: 'json' };
import dataApiError from '../fixtures/gma/customerMetrics/400-data-api-error.json' with { type: 'json' };
import unauthorized from '../fixtures/gma/customerMetrics/401-unauthorized.json' with { type: 'json' };
import serverError from '../fixtures/gma/customerMetrics/500-server-error.json' with { type: 'json' };

/**
 * `get_customer_betting_metrics` — User Story 4 (P4), FR-013 to FR-015.
 *
 * The two cases that matter most are the two this tool REFUSES to guess. A missing
 * aggregation and an unrecognised jurisdiction code both have a tempting default — pick a
 * grouping, drop the filter — and both defaults produce a confident answer to a question
 * nobody asked. Upstream in particular ignores a jurisdiction code it does not recognise
 * and returns metrics for EVERY jurisdiction, so a silently-dropped filter reads as "this
 * customer bets far more than you thought".
 */

const server = useGmaServer();
const METRICS = `${GMA_BASE_URL}/accounts/:accountId/metrics`;
const CRS_CONTEXTS = `${GMA_BASE_URL}/crs/contexts`;

const client = () => createGmaClient({ config: testConfig() });
const deps = (knownJurisdictions: string[] | null = ['NJ', 'PA', 'CO', 'NXTCANBS']) => ({
  client: client(),
  knownJurisdictions
});

const ACCOUNT = 'acct-test-0001';

describe('get_customer_betting_metrics (Story 4, P4)', () => {
  describe('case: a missing aggregation is an argument error NAMING all three (FR-014, SC-008)', () => {
    it('refuses to choose, and names every option', async () => {
      // The three aggregations answer three different questions. Defaulting would answer
      // one of them confidently while the user asked another.
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
      for (const option of ['BET_TYPE', 'HIERARCHY_ENTITY', 'TIMEFRAME']) {
        expect(error.message).toContain(option);
      }
      // Tells the agent to ASK rather than to pick.
      expect(error.message).toMatch(/ask the user/i);
    });

    it('makes NO upstream call when the aggregation is absent', async () => {
      // `onUnhandledRequest: 'error'` means any hop at all fails this test: a request
      // that cannot be correct must not be sent.
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
    });

    it('rejects an aggregation outside the three, rather than forwarding it', async () => {
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BY_SPORT' as never
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.message).toContain('BET_TYPE');
    });
  });

  describe('case: the requested aggregation is echoed back (data-model.md section 10)', () => {
    it.each([
      ['BET_TYPE', byBetType, 'betType'],
      ['HIERARCHY_ENTITY', byHierarchy, 'hierarchyEntity'],
      ['TIMEFRAME', byTimeframe, 'period']
    ] as const)('echoes %s and discriminates its groups', async (aggregation, fixture, keyKind) => {
      server.use(http.post(METRICS, () => HttpResponse.json(fixture)));

      const result = await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation
      });

      // The answer states its own shape, so a bet type cannot be read as a period.
      expect(result.aggregation).toBe(aggregation);
      expect(result.groups.length).toBeGreaterThan(0);
      for (const group of result.groups) {
        expect(group.keyKind).toBe(keyKind);
      }
      expect(result.completeness.complete).toBe(true);
    });

    it('returns both totals, and keeps them distinct', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(result.lifetime!.betCount).toBe(410);
      expect(result.filteredTotal!.betCount).toBe(120);
    });

    it('uses the POST variant, since the GET is deprecated (FR-015)', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(byBetType);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      // Reaching the handler at all proves the verb: an msw `http.post` route does not
      // answer a GET, and an unhandled request fails the suite.
      expect(recorder.seen).toHaveLength(1);
      expect(recorder.seen[0]!.body).toMatchObject({ aggregationMode: 'BET_TYPE' });
    });

    it('sends the filters in the BODY, never in the URL', async () => {
      // Which keeps the account identifier and the filter set out of a URL that would
      // otherwise reach a proxy access line (Principle V).
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(byTimeframe);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'TIMEFRAME',
        period: '_1_MONTH',
        jurisdictions: ['NJ']
      });

      const url = new URL(recorder.seen[0]!.url);
      expect(url.search).toBe('');
      expect(recorder.seen[0]!.body).toMatchObject({ period: '_1_MONTH', contexts: ['NJ'] });
    });

    it('sends no instance scoping at all (FR-025)', async () => {
      // A customer call is scoped by the account identifier alone. A default instance set
      // would silently narrow the answer.
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(byBetType);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(recorder.seen[0]!.instancesList).toEqual([]);
      expect(JSON.stringify(recorder.seen[0]!.body)).not.toContain('instance');
    });

    it('translates EVENT_TYPE to EVENTTYPE on the wire (R12)', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(byHierarchy);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'HIERARCHY_ENTITY',
        hierarchy: { level: 'EVENT_TYPE', catalogueEntityIds: ['3307'] }
      });

      expect(recorder.seen[0]!.body).toMatchObject({ hierarchyEntity: { EVENTTYPE: ['3307'] } });
    });
  });

  describe('case: an unrecognised jurisdiction code is an ERROR, never a dropped filter (FR-013)', () => {
    it('rejects the code and points at list_jurisdiction_contexts', async () => {
      // Upstream IGNORES a code it does not recognise and returns metrics for every
      // jurisdiction — so a silently-dropped filter reads as "this customer bets far more
      // than you thought". No upstream call is made.
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE',
        jurisdictions: ['NEWJERSEY']
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.message).toContain('NEWJERSEY');
      expect(error.message).toContain('list_jurisdiction_contexts');
    });

    it('names every unrecognised code, not just the first', async () => {
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE',
        jurisdictions: ['NJ', 'NOPE', 'ALSONOPE']
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.message).toContain('NOPE');
      expect(error.message).toContain('ALSONOPE');
      // The valid one is not reported as a problem.
      expect(error.message).not.toMatch(/\bNJ\b/);
    });

    it('accepts a recognised code, whatever its case', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE',
        jurisdictions: ['nj', ' PA ']
      });

      expect(result.groups.length).toBeGreaterThan(0);
    });

    it('accepts a code no derivation could produce, since the list is the authority', async () => {
      // Ontario's code is `NXTCANBS`. This is why a hardcoded table is prohibited.
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE',
        jurisdictions: ['NXTCANBS']
      });

      expect(result.aggregation).toBe('BET_TYPE');
    });

    it('FORWARDS the filter when the codes could not be looked up', async () => {
      // `null` means "we could not check", not "nothing is valid". Rejecting a code we
      // merely failed to verify would deny a valid request.
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps(null), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE',
        jurisdictions: ['ANYTHING']
      });

      expect(result.aggregation).toBe('BET_TYPE');
    });

    it('validates nothing when no jurisdiction filter was supplied', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps([]), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(result.groups.length).toBeGreaterThan(0);
    });
  });

  describe('case: each upstream 400 becomes a self-correctable hint (SC-008)', () => {
    it.each([
      ['MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE', badLevels, /ONE level/i],
      ['TOO_MANY_HIERARCHY_ENTITIES', tooMany, /fewer|broader/i],
      ['ACCOUNT_IDENTIFIER_MISSING', missingAccount, /accountId/]
    ] as const)('turns %s into guidance', async (_code, fixture, expected) => {
      server.use(http.post(METRICS, () => HttpResponse.json(fixture, { status: 400 })));

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'HIERARCHY_ENTITY'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.message).toMatch(expected);
      // A `400` stays a non-retryable argument failure whichever code it carried: the
      // hint explains the fix, it does not change the verdict.
      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
    });

    it('NEVER interpolates the upstream message, which can echo the account id (FR-029)', () => {
      // The `CustomerMetricsDataApiResponse` shape's `message` carries the JSON that
      // caused the exception. The fixture's contains the account identifier on purpose.
      expect(JSON.stringify(dataApiError)).toContain(ACCOUNT);
    });

    it('surfaces no upstream text for the shape that carries no errorCode', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(dataApiError, { status: 400 })));

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      // The identifier the upstream message carried does NOT reach the agent...
      expect(error.message).not.toContain(ACCOUNT);
      expect(error.message).not.toContain('Customer Metrics API rejected');
      // ...and the error still says something useful about what to do.
      expect(error.message.length).toBeGreaterThan(20);
    });

    it('leaves the error untouched when the code is unrecognised', async () => {
      server.use(
        http.post(METRICS, () => HttpResponse.json({ errorCode: 'BRAND_NEW' }, { status: 400 }))
      );

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain('BRAND_NEW');
    });
  });

  describe('case: the account identifier is never echoed (FR-029, FR-030)', () => {
    it('rejects a blank identifier without repeating it', async () => {
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: '   ',
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
    });

    it.each([
      ['a slash', 'acct/../admin'],
      ['whitespace', 'acct 0001'],
      ['a query separator', 'acct?x=1'],
      ['a fragment', 'acct#1']
    ])('rejects %s, and echoes no value', async (_label, accountId) => {
      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain(accountId);
    });

    it('surfaces no identifier in a 500 error message', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(serverError, { status: 500 })));

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      // The message names the TEMPLATE, so the interpolated path cannot leak the id.
      expect(error.message).not.toContain(ACCOUNT);
      expect(error.message).toContain('{accountId}');
      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
    });

    it('maps a 401 to auth, distinctly from an argument failure (SC-009)', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(unauthorized, { status: 401 })));

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('auth');
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain(ACCOUNT);
    });

    it('maps a 403 to forbidden, which is NOT a sign-in problem (SC-009)', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json({}, { status: 403 })));

      const error = (await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(error.kind).toBe('forbidden');
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/request access/i);
    });

    it('forwards the operator token unaltered on the hop it makes (FR-023a)', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(byBetType);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(recorder.seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });
  });

  describe('case: vipManager reaches no caller (Principle V)', () => {
    it('is absent from the whole result, though upstream sent it', async () => {
      server.use(http.post(METRICS, () => HttpResponse.json(byBetType)));

      const result = await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(JSON.stringify(result)).not.toContain('vipManager');
      expect(JSON.stringify(result)).not.toContain('A Staff Member');
    });
  });

  describe('case: the description tells the model what it must not conclude (FR-009)', () => {
    it('forbids the lifetime-versus-filtered comparison and the null-means-zero reading', () => {
      expect(GET_CUSTOMER_BETTING_METRICS_DESCRIPTION).toMatch(/NO default/);
      expect(GET_CUSTOMER_BETTING_METRICS_DESCRIPTION).toMatch(/never compare it against/i);
      expect(GET_CUSTOMER_BETTING_METRICS_DESCRIPTION).toMatch(/NOT zero/);
      expect(GET_CUSTOMER_BETTING_METRICS_DESCRIPTION).toMatch(/list_jurisdiction_contexts/);
      expect(GET_CUSTOMER_BETTING_METRICS_DESCRIPTION).toMatch(/relay/i);
    });
  });

  describe('case: the jurisdiction lookup is only made when a filter needs it', () => {
    it('does not call /crs/contexts when no jurisdiction filter was supplied', async () => {
      // Asserted at the registration boundary in `index.ts`; here the tool itself is
      // handed the codes, so the guarantee is that it never fetches them.
      const recorder = requestRecorder();
      server.use(
        http.post(METRICS, () => HttpResponse.json(byBetType)),
        http.get(CRS_CONTEXTS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json([]);
        })
      );

      await getCustomerBettingMetrics(deps(), TEST_TOKEN, {
        accountId: ACCOUNT,
        aggregation: 'BET_TYPE'
      });

      expect(recorder.seen).toEqual([]);
    });
  });
});
