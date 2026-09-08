import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import type { ToolError } from '../../src/core/types.js';
import { QBS_GRAPHQL_PATH } from '../../src/domains/customer/gql/searchBets.js';
import {
  ATTRIBUTION_NOTICE,
  GET_BET_RISK_CONTEXT_DESCRIPTION,
  getBetRiskContext
} from '../../src/domains/customer/tools/getBetRiskContext.js';
import {
  GMA_BASE_URL,
  TEST_TOKEN,
  requestRecorder,
  testConfig,
  useGmaServer
} from '../helpers/gma.js';

import crsAccount from '../fixtures/gma/crsAccounts/200-three-jurisdictions.json' with { type: 'json' };
import crsNulls from '../fixtures/gma/crsAccounts/200-nulls.json' with { type: 'json' };
import crs500 from '../fixtures/gma/crsAccounts/500-server-error.json' with { type: 'json' };
import crsContexts from '../fixtures/gma/crsContexts/200-success.json' with { type: 'json' };
import contexts500 from '../fixtures/gma/crsContexts/500-server-error.json' with { type: 'json' };
import event1 from '../fixtures/gma/events/200-success.json' with { type: 'json' };
import event2 from '../fixtures/gma/events/200-second-event.json' with { type: 'json' };
import event206 from '../fixtures/gma/events/206-partial.json' with { type: 'json' };
import event500 from '../fixtures/gma/events/500-server-error.json' with { type: 'json' };
import qbsSingle from '../fixtures/gma/qbsSearchBets/200-single-bet.json' with { type: 'json' };
import qbsMultiLeg from '../fixtures/gma/qbsSearchBets/200-multi-leg-bet.json' with { type: 'json' };
import qbsMultiple from '../fixtures/gma/qbsSearchBets/200-multiple-matches.json' with { type: 'json' };
import qbsNoMatch from '../fixtures/gma/qbsSearchBets/200-no-match.json' with { type: 'json' };

/**
 * `get_bet_risk_context` — User Story 3 (P3), FR-016 to FR-023. THE COMPOSITE.
 *
 * The unit suites already prove the pure modules in isolation. What only this suite can
 * prove is that the `3 + N` hops are WIRED to them correctly, and three of its cases
 * would each pass a plausible-looking implementation that is confidently wrong:
 *
 *  - **The join actually joins.** CRS states override ids bare (`'3307'`); v5 returns
 *    URNs (`urn:sbk:pc:et:gpd:3307`). Compared verbatim they match nothing, and an empty
 *    `overridesInScope` is exactly the shape that reads as "no restriction applies". So
 *    the assertion is on a NON-EMPTY override list from fixtures whose two sides state
 *    the same entities in their own real vocabularies.
 *  - **A multi-match does zero further work**, asserted by counting requests rather than
 *    by inspecting the result, because a result-only assertion passes even when the tool
 *    fetched everything and then discarded it.
 *  - **Two missing sections stay on the SECOND axis.** A CRS failure must never appear as
 *    a failed instance: `failedInstances` is retryable and `unavailableComponents` is not,
 *    so conflating them tells an agent to retry something that cannot succeed.
 */

const server = useGmaServer();
const QBS = `${GMA_BASE_URL}${QBS_GRAPHQL_PATH}`;
const CRS_ACCOUNT = `${GMA_BASE_URL}/crs/accounts/:accountId`;
const CRS_CONTEXTS = `${GMA_BASE_URL}/crs/contexts`;
const EVENT = `${GMA_BASE_URL}/v5/events/:id`;

const client = () => createGmaClient({ config: testConfig() });
const deps = (maxEventResolutions = 10) => ({ client: client(), maxEventResolutions });

/** The happy path's four handlers. Individual cases override the one they are about. */
function allHopsSucceed(bet: unknown = qbsSingle): void {
  server.use(
    http.post(QBS, () => HttpResponse.json(bet)),
    http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
    http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
    http.get(EVENT, ({ params }) =>
      HttpResponse.json(String(params.id).includes('9202') ? event2 : event1)
    )
  );
}

describe('get_bet_risk_context (Story 3, P3)', () => {
  describe('case: scenario 1 — a single-leg matched bet returns the whole picture (FR-017)', () => {
    it('returns the applied figures, the governing configuration, and the resolved path', async () => {
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.bet!.betId).toBe('bet-000111');
      expect(result.bet!.appliedRisk).toMatchObject({ stakeFactor: 0.25, liabilityGroup: 'Tight' });
      expect(result.jurisdictionMatch).toBe('matched');
      expect(result.governingJurisdiction!.code).toBe('NJ');
      expect(result.resolvedLegs).toHaveLength(1);
      expect(result.resolvedLegs![0]!.resolution).toBe('resolved');
      expect(result.resolvedLegs![0]!.cataloguePath!.map((node) => node.level)).toEqual([
        'SUPERCLASS',
        'SUBCLASS',
        'EVENT_TYPE'
      ]);
      expect(result.completeness.complete).toBe(true);
    });

    it('JOINS the leg to its overrides across the two vocabularies (FR-019)', async () => {
      // THE case the composite exists for, and the one a plausible implementation fails
      // silently: CRS states `'3'`/`'7'`/`'3307'` and v5 returns
      // `urn:sbk:pc:spc:gpd:3` etc. An implementation comparing them verbatim returns an
      // EMPTY list here — which reads as "no restriction covers this leg", a confidently
      // wrong answer about a real customer's limits.
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });
      const [leg] = result.resolvedLegs!;

      expect(leg!.overridesInScope.length).toBeGreaterThan(0);
      expect(leg!.overridesInScope.map((override) => override.level)).toEqual([
        'SUPERCLASS',
        'SUBCLASS',
        'EVENT_TYPE'
      ]);
      // Each override carries its own settings, so the agent needs no second call.
      expect(leg!.overridesInScope[0]!.stakeFactor).toBe(0.25);
    });

    it('does NOT claim a MARKET_TYPE override is in scope, since the hop cannot resolve one', async () => {
      // The customer HAS a market-type override, and the event hop resolves only three
      // levels. Reporting it would attribute a restriction to a position never checked;
      // omitting it is honest, and `resolution: 'resolved'` is scoped to what was joined.
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(
        result.resolvedLegs![0]!.overridesInScope.some(
          (override) => override.level === 'MARKET_TYPE'
        )
      ).toBe(false);
      // ...and it is still visible in the full configuration list, unfiltered.
      expect(
        result.allJurisdictionConfigurations![0]!.overrides.some(
          (override) => override.level === 'MARKET_TYPE'
        )
      ).toBe(true);
    });

    it('reports a per-field agreement verdict with both values present (FR-020)', async () => {
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.agreement!.map((verdict) => verdict.field)).toEqual([
        'stakeFactor',
        'liabilityGroup'
      ]);
      const [stakeFactor] = result.agreement!;
      // NJ configures 0.5; the bet applied 0.25. Both shown, no explanation offered.
      expect(stakeFactor!.verdict).toBe('differs');
      expect(stakeFactor!.configuredValue).toBe(0.5);
      expect(stakeFactor!.appliedValue).toBe(0.25);
    });

    it('returns EVERY jurisdiction configuration, not only the governing one (FR-018)', async () => {
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.allJurisdictionConfigurations).toHaveLength(3);
      expect(result.appliedFiguresAreBetLevel).toBe(false);
      expect(result.attributionNotice).toBeUndefined();
    });

    it("reports resolvedVia, which is R9's closure evidence", async () => {
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      // A field LEVEL, never an identifier — so it carries no personal datum.
      expect(result.resolvedLegs![0]!.resolvedVia).toBe('rampId');
    });

    it('sends the event id in the URN form R9 documents, not the bare rampId', async () => {
      // `linkManager.ts:51` reads `event.entityIds.rampId`; `:88` PREFIXES it. Sending
      // `9201` bare 404s every leg — and because that surfaces as
      // `notResolvedIdentifierUnusable`, it looks exactly like R9 being wrong rather than
      // like this transformation being absent.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(event1);
        })
      );

      await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(recorder.seen[0]!.url).toContain(encodeURIComponent('urn:sbk:pc:e:gpd:9201'));
    });

    it("scopes the event hop by the BET's catalogue instance, using the `sources` parameter", async () => {
      // `getEventById` declares `sources`, NOT `instancesList` (api_catalogue.yaml). A
      // wrong name does not error — it is ignored, and the lookup silently fans out.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(event1);
        })
      );

      await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });
      const url = new URL(recorder.seen[0]!.url);

      expect(url.searchParams.getAll('sources')).toEqual(['urn:i:FD:US-NJ']);
      expect(url.searchParams.getAll('instancesList')).toEqual([]);
    });
  });

  describe('case: scenario 2 — a multi-leg bet is never attributed to one leg (FR-021, SC-006)', () => {
    it('carries attributionNotice and makes EVERY verdict notComparable', async () => {
      allHopsSucceed(qbsMultiLeg);

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000333' });

      expect(result.appliedFiguresAreBetLevel).toBe(true);
      expect(result.attributionNotice).toBe(ATTRIBUTION_NOTICE);
      expect(result.agreement!.every((verdict) => verdict.verdict === 'notComparable')).toBe(true);
      for (const verdict of result.agreement!) {
        expect(verdict.reason).toMatch(/bet-level/i);
      }
    });

    it('still resolves every leg and puts a covering override on EACH of them (FR-019)', async () => {
      // The duplication is deliberate: a normalised list would make the model perform a
      // join in-context to answer "is this leg restricted?", and that is where it errs.
      allHopsSucceed(qbsMultiLeg);

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000333' });

      expect(result.resolvedLegs).toHaveLength(3);
      for (const leg of result.resolvedLegs!) {
        expect(leg.resolution).toBe('resolved');
        expect(leg.overridesInScope.map((override) => override.level)).toContain('SUPERCLASS');
      }
    });

    it('resolves a DISTINCT event once, however many legs share it (SC-013)', async () => {
      // Legs 1 and 3 are both on event 9201; leg 2 is on 9202. Two calls, not three.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsMultiLeg)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, async ({ request, params }) => {
          await recorder.record(request);
          return HttpResponse.json(String(params.id).includes('9202') ? event2 : event1);
        })
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000333' });

      expect(recorder.seen).toHaveLength(2);
      // And both shared legs still carry their position — dedupe must not cost a leg.
      expect(result.resolvedLegs![0]!.cataloguePath).not.toBeNull();
      expect(result.resolvedLegs![2]!.cataloguePath).not.toBeNull();
    });
  });

  describe('case: scenario 3 — several matches return candidates and do ZERO further work (FR-022)', () => {
    it('makes NO CRS call, NO context call, and NO event calls', async () => {
      // Asserted by COUNTING REQUESTS, not by inspecting the result: a result-only
      // assertion passes even when the tool fetched everything and threw it away, and
      // resolving one of several plausible bets is exactly the auto-picking Principle IV
      // prohibits. `onUnhandledRequest: 'error'` means a stray hop fails the test.
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(qbsMultiple);
        })
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { receiptId: 'R-AMBIGUOUS' });

      expect(recorder.seen).toHaveLength(1);
      expect(result.candidates!.length).toBeGreaterThan(1);
      expect(result.bet).toBeUndefined();
      expect(result.resolvedLegs).toBeUndefined();
      expect(result.agreement).toBeUndefined();
    });

    it('gives each candidate enough to choose by, and no risk context at all', async () => {
      server.use(http.post(QBS, () => HttpResponse.json(qbsMultiple)));

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { receiptId: 'R-AMBIGUOUS' });

      for (const candidate of result.candidates!) {
        expect(candidate.betId.length).toBeGreaterThan(0);
        expect(candidate.placedAt.length).toBeGreaterThan(0);
        expect(candidate).not.toHaveProperty('appliedRisk');
      }
    });

    it('returns an empty candidate list when nothing matched, not an error', async () => {
      // Neither a failure nor a bet with no risk context. An empty `candidates` states
      // the absence without echoing the identifier back.
      server.use(http.post(QBS, () => HttpResponse.json(qbsNoMatch)));

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-missing' });

      expect(result.candidates).toEqual([]);
      expect(result.bet).toBeUndefined();
    });
  });

  describe('case: a missing SECTION is the second axis, never a failed instance (FR-026, SC-001)', () => {
    it('reports a CRS failure as unavailableComponents and still answers', async () => {
      // THE distinction Principle II forbids merging: `failedInstances` says "retry may
      // help", `unavailableComponents` says "retry cannot". Conflating them tells an agent
      // to retry something that will never succeed.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.unavailableComponents).toContain('customerRiskConfiguration');
      expect(result.completeness.failedInstances).toEqual([]);
      expect(result.completeness.complete).toBe(false);
      // The bet itself is still returned — one missing section is not a failed tool.
      expect(result.bet!.betId).toBe('bet-000111');
    });

    it('names the missing section in a caveat a human can act on', async () => {
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.caveat).not.toBeNull();
      expect(result.completeness.caveat).toMatch(/risk/i);
      // Never the account identifier, which is personal data (Principle V).
      expect(result.completeness.caveat).not.toContain('acct-test-0001');
    });

    it('does not claim a configuration governed the bet when CRS failed', async () => {
      // The tempting wrong answer: no configurations fetched reads as "the customer has
      // none", which would become "they were on default settings".
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.jurisdictionMatch).not.toBe('matched');
      expect(result.governingJurisdiction).toBeUndefined();
      expect(result.agreement!.every((verdict) => verdict.verdict === 'notComparable')).toBe(true);
    });

    it('reports a CONTEXT failure separately and still answers, without guessing', async () => {
      // The context list is PRIMARY (constitution v1.2.0) and its hop is NOT fatal — but
      // "not fatal" does not mean "no loss". CRS names a jurisdiction by `contextId`
      // (`ctx-us-nj`) while the bet names it by CODE (`NJ`), and the context list is the
      // only thing that bridges the two. Without it, this bet's jurisdiction genuinely
      // cannot be matched.
      //
      // So the honest outcome is `jurisdictionNotMatched` — a failure of OUR matching,
      // explicitly NOT `noConfigurationForJurisdiction`, which would assert a fact about
      // the customer we have not established. The tool still answers everything else.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(contexts500, { status: 500 })),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.unavailableComponents).toContain('jurisdictionContexts');
      expect(result.completeness.failedInstances).toEqual([]);
      expect(result.jurisdictionMatch).toBe('jurisdictionNotMatched');
      expect(result.jurisdictionMatch).not.toBe('noConfigurationForJurisdiction');
      // Everything not downstream of the match is still delivered in full.
      expect(result.bet!.betId).toBe('bet-000111');
      expect(result.resolvedLegs![0]!.resolution).toBe('resolved');
      expect(result.allJurisdictionConfigurations).toHaveLength(3);
    });

    it('does not claim the customer was on default settings when matching failed', async () => {
      // The inference the description exists to forbid, asserted on the payload: no
      // governing jurisdiction, and no verdict that could read as a comparison.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(contexts500, { status: 500 })),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.governingJurisdiction).toBeUndefined();
      expect(result.agreement!.every((verdict) => verdict.verdict === 'notComparable')).toBe(true);
      // An unresolved leg's overrides would be misleading; a matched-nothing leg's
      // position is still known, and its override list is honestly empty.
      expect(result.resolvedLegs![0]!.overridesInScope).toEqual([]);
    });

    it('keeps the two missing sections DISTINCT when both hops fail', async () => {
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(contexts500, { status: 500 })),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect([...result.completeness.unavailableComponents].sort()).toEqual([
        'customerRiskConfiguration',
        'jurisdictionContexts'
      ]);
    });

    it('reports an unresolved leg as legCataloguePositions, never as "no overrides"', async () => {
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event500, { status: 500 }))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.unavailableComponents).toContain('legCataloguePositions');
      const [leg] = result.resolvedLegs!;
      expect(leg!.resolution).toBe('notResolvedUpstreamFailure');
      // Empty here means NOTHING IS KNOWN, and `resolution` is what says so.
      expect(leg!.overridesInScope).toEqual([]);
      expect(leg!.cataloguePath).toBeNull();
    });
  });

  describe('case: a 206 on ONE event hop makes the WHOLE result partial (Principle II)', () => {
    it('marks the composite PARTIAL and names the failed instance', async () => {
      // The hop-merge rule: a partial answer anywhere cannot be absorbed by the hops that
      // succeeded. This one IS a failed instance — an instance genuinely did not answer —
      // which is what makes it the mirror image of the missing-section cases above.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event206, { status: 206 }))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.outcome).toBe('PARTIAL');
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.failedInstances).toContain('urn:i:FD:US-PA');
      expect(result.completeness.caveat).not.toBeNull();
    });

    it("still returns the leg's position from the instance that DID answer", async () => {
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event206, { status: 206 }))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.resolvedLegs![0]!.resolution).toBe('resolved');
      expect(result.resolvedLegs![0]!.overridesInScope.length).toBeGreaterThan(0);
    });

    it('keeps a partial event hop OFF the second axis', async () => {
      // A 206 is a partial instance answer, not a missing section. Reporting it as
      // `unavailableComponents` would tell the agent retrying cannot help, when it can.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event206, { status: 206 }))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.completeness.unavailableComponents).toEqual([]);
    });
  });

  describe('case: the resolution bound is REPORTED, never silently truncated (FR-023)', () => {
    it('names the deferred legs and flags the missing section', async () => {
      // Bound of 1 against a bet with two distinct events. The second leg must be NAMED
      // as deferred: a dropped leg reads as a leg with no restrictions.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsMultiLeg)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(1), TEST_TOKEN, { betId: 'bet-000333' });

      expect(result.completeness.unavailableComponents).toContain('legCataloguePositions');
      const deferred = result.resolvedLegs!.filter(
        (leg) => leg.resolution === 'notAttemptedBoundReached'
      );
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.legNumber).toBe(2);
      // The identifier WAS usable; we simply did not spend a lookup on it.
      expect(deferred[0]!.resolvedVia).toBe('rampId');
    });

    it('makes exactly as many event calls as the bound allows', async () => {
      const recorder = requestRecorder();
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsMultiLeg)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, async ({ request }) => {
          await recorder.record(request);
          return HttpResponse.json(event1);
        })
      );

      await getBetRiskContext(deps(1), TEST_TOKEN, { betId: 'bet-000333' });

      expect(recorder.seen).toHaveLength(1);
    });
  });

  describe('case: matching is NOT a form of incompleteness (FR-027)', () => {
    it('leaves a result COMPLETE when the customer has no configuration for the jurisdiction', async () => {
      // Every source answered fully; the customer simply has no settings for this
      // jurisdiction. Marking this incomplete would train the agent to caveat data that
      // is in fact whole, devaluing every genuine caveat.
      //
      // The bet is in NJ and this account is configured only for PA and CO, so the
      // platform knows the jurisdiction and the absence is a FACT ABOUT THE CUSTOMER.
      const noNjAccount = {
        ...crsAccount,
        contexts: (crsAccount as { contexts: { contextId: string }[] }).contexts.filter(
          (context) => context.contextId !== 'ctx-us-nj'
        )
      };
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(noNjAccount)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.jurisdictionMatch).toBe('noConfigurationForJurisdiction');
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
      expect(result.completeness.unavailableComponents).toEqual([]);
      expect(result.completeness.caveat).toBeNull();
    });

    it('keeps that DISTINCT from a matching failure for the same customer (SC-003, SC-004)', async () => {
      // Folding these would make a systematic matching defect indistinguishable from a
      // fact about the customer — and the defect would then be unobservable, because it
      // would look like data. `200-nulls.json` is configured for NJ and matches.
      server.use(
        http.post(QBS, () => HttpResponse.json(qbsSingle)),
        http.get(CRS_ACCOUNT, () => HttpResponse.json(crsNulls)),
        http.get(CRS_CONTEXTS, () => HttpResponse.json(crsContexts)),
        http.get(EVENT, () => HttpResponse.json(event1))
      );

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { betId: 'bet-000111' });

      expect(result.jurisdictionMatch).toBe('matched');
      expect(result.completeness.complete).toBe(true);
    });
  });

  describe('case: exactly one identifier, and neither value is ever echoed (FR-016, FR-030)', () => {
    it.each([
      ['neither', {}],
      ['both', { betId: 'bet-000111', receiptId: 'R-000111' }],
      ['a blank betId', { betId: '   ' }]
    ])('rejects %s as an argument error', async (_label, args) => {
      const error = (await getBetRiskContext(deps(), TEST_TOKEN, args).catch(
        (caught: ToolError) => caught
      )) as ToolError;

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
      // The self-correction hint travels in the message (SC-008).
      expect(error.message).toMatch(/exactly one/i);
      expect(error.message).toMatch(/betId|receiptId/);
    });

    it('never repeats a supplied identifier back, since bet ids are personal data', async () => {
      const error = (await getBetRiskContext(deps(), TEST_TOKEN, {
        betId: 'bet-000111',
        receiptId: 'R-000111'
      }).catch((caught: ToolError) => caught)) as ToolError;

      expect(JSON.stringify(error)).not.toContain('bet-000111');
      expect(JSON.stringify(error)).not.toContain('R-000111');
    });

    it('accepts a receiptId, which is the reference a customer actually quotes (SC-005)', async () => {
      // One call, no manual identifier conversion by the agent.
      allHopsSucceed();

      const result = await getBetRiskContext(deps(), TEST_TOKEN, { receiptId: 'R-000111' });

      expect(result.bet!.betId).toBe('bet-000111');
    });
  });

  describe('case: the description tells the model what it must not conclude (FR-009)', () => {
    it('forbids narrating a calculation and claiming default settings', async () => {
      expect(GET_BET_RISK_CONTEXT_DESCRIPTION).toMatch(/never narrate/i);
      expect(GET_BET_RISK_CONTEXT_DESCRIPTION).toMatch(/MUST NOT tell the user/);
      expect(GET_BET_RISK_CONTEXT_DESCRIPTION).toMatch(/jurisdictionMatch FIRST/);
      expect(GET_BET_RISK_CONTEXT_DESCRIPTION).toMatch(/relay/i);
    });
  });
});
