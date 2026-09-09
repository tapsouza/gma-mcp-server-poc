import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { ToolError } from '../../src/core/types.js';
import {
  GET_CUSTOMER_RISK_PROFILE_DESCRIPTION,
  GET_CUSTOMER_RISK_PROFILE_TEMPLATE,
  getCustomerRiskProfile
} from '../../src/domains/customer/tools/getCustomerRiskProfile.js';
import { GMA_BASE_URL, TEST_TOKEN, testConfig, useGmaServer } from '../helpers/gma.js';

import crsThree from '../fixtures/gma/crsAccounts/200-three-jurisdictions.json' with { type: 'json' };
import crsNulls from '../fixtures/gma/crsAccounts/200-nulls.json' with { type: 'json' };
import crs401 from '../fixtures/gma/crsAccounts/401-unauthorized.json' with { type: 'json' };
import crs403 from '../fixtures/gma/crsAccounts/403-forbidden.json' with { type: 'json' };
import crs404 from '../fixtures/gma/crsAccounts/404-not-found.json' with { type: 'json' };
import crs500 from '../fixtures/gma/crsAccounts/500-server-error.json' with { type: 'json' };

/**
 * `get_customer_risk_profile` — User Story 1 (P1) acceptance scenarios 1 to 5.
 *
 * The MVP, and the slice that proves the two properties the rest of the domain rests
 * on: per-jurisdiction fidelity, and an honest completeness verdict on a surface that
 * publishes no partial-failure signal of its own.
 */

const server = useGmaServer();
const ACCOUNT = 'acct-test-0001';
const CRS_ACCOUNT = `${GMA_BASE_URL}/crs/accounts/:accountId`;
const client = () => createGmaClient({ config: testConfig() });

describe('get_customer_risk_profile (Story 1, P1)', () => {
  describe('case: scenario 1 — three jurisdictions return three configurations, unmerged (FR-006, SC-003)', () => {
    it('returns one configuration per jurisdiction with nothing collapsed', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(result.jurisdictionConfigurations).toHaveLength(3);
      expect(result.jurisdictionConfigurations.map((c) => c.stakeFactor)).toEqual([0.5, 1, 2]);
    });

    it("echoes the account identifier back for the agent's own correlation", async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      // In the RESULT, which is the agent's own context — never in a log or an error.
      expect(result.accountId).toBe(ACCOUNT);
    });

    it('carries each override with its named catalogue path, needing no second lookup (FR-007)', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });
      const nj = result.jurisdictionConfigurations[0]!;

      expect(nj.overrides).toHaveLength(4);
      for (const override of nj.overrides) {
        expect(override.path.length).toBeGreaterThan(0);
        for (const node of override.path) {
          expect(node.name.length).toBeGreaterThan(0);
        }
      }
    });

    it('makes exactly ONE upstream call — no catalogue hops (research.md R3)', async () => {
      // GMA already enriches every override with its named ancestor chain, and
      // Principle IV forbids duplicating resolution GMA has done. msw's
      // onUnhandledRequest:'error' means a stray catalogue call fails this test.
      let calls = 0;
      server.use(
        http.get(CRS_ACCOUNT, () => {
          calls += 1;
          return HttpResponse.json(crsThree);
        })
      );

      await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(calls).toBe(1);
    });

    it('forwards the operator token unaltered', async () => {
      let observed: string | null = null;
      server.use(
        http.get(CRS_ACCOUNT, ({ request }) => {
          observed = request.headers.get('authorization');
          return HttpResponse.json(crsThree);
        })
      );

      await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(observed).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it('sends no instance query parameter — a customer call is scoped by account alone', async () => {
      let url = '';
      server.use(
        http.get(CRS_ACCOUNT, ({ request }) => {
          url = request.url;
          return HttpResponse.json(crsThree);
        })
      );

      await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(url).not.toContain('instancesList');
      expect(url).not.toContain('instance=');
    });
  });

  describe('case: scenario 5 — completeness is present on full success with BOTH axes (FR-005, FR-026)', () => {
    it('carries a complete verdict whose two axes are both present and empty', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
      expect(result.completeness.failedInstances).toEqual([]);
      expect(result.completeness.unavailableComponents).toEqual([]);
      expect(result.completeness.caveat).toBeNull();
    });

    it('returns exactly the three documented top-level fields', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(Object.keys(result).sort()).toEqual([
        'accountId',
        'completeness',
        'jurisdictionConfigurations'
      ]);
    });
  });

  describe('case: the CRS honesty rule — complete or error, never a synthesised partial (research.md R2)', () => {
    it('reports complete on a 200, since CRS declares no partial-failure signal', async () => {
      // Principle II: "Where a surface publishes no partial-failure signal at all …
      // a tool MUST NOT invent one." A fabricated PARTIAL here would devalue every
      // genuine caveat the catalogue domain emits.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
    });

    it("never emits unavailableComponents from THIS tool — that is the composite's job", async () => {
      // Here the configuration IS the whole answer, so its absence is a tool error.
      // Inside `get_bet_risk_context` it is one SECTION, and there the same failure
      // becomes `unavailableComponents: ['customerRiskConfiguration']` (FR-026).
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(result.completeness.unavailableComponents).toEqual([]);
    });

    it('reports a customer with settings in ONE jurisdiction as complete, not partial', async () => {
      // One jurisdiction is not evidence of a truncated answer: a customer simply may
      // have settings in one state. Caveating this would train the agent to distrust
      // whole data.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsNulls)));

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: ACCOUNT });

      expect(result.jurisdictionConfigurations).toHaveLength(1);
      expect(result.completeness.complete).toBe(true);
    });
  });

  describe('case: scenario 3 — an unknown account is notFound, not an empty success', () => {
    it('throws a notFound error rather than returning zero configurations', async () => {
      // The failure mode this rules out is the worst one available here: an empty
      // success would let the agent report "this customer has no restrictions".
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs404, { status: 404 })));

      try {
        await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: 'acct-does-not-exist' });
        expect.unreachable('an unknown account must not resolve to an empty success');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError).toBeInstanceOf(ToolError);
        expect(toolError.kind).toBe('notFound');
        expect(toolError.retryable).toBe(false);
      }
    });

    it('fabricates no default settings on a 404', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs404, { status: 404 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct-does-not-exist'
      }).catch((e) => e as ToolError);

      expect(error).not.toHaveProperty('jurisdictionConfigurations');
      expect(error).not.toHaveProperty('completeness');
      expect(error.message).not.toMatch(/default/i);
    });

    it('does NOT echo the account identifier in the not-found message (FR-030, SC-007)', async () => {
      // The trap this catches is `operation`, not the log field: `errors.ts` builds
      // "GMA returned HTTP 404 for {operation}", and without `pathTemplate` that
      // operation is the INTERPOLATED path. This assertion is the one that fails if
      // only half of the R13 fix landed.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs404, { status: 404 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct-recognisable-99887'
      }).catch((e) => e as ToolError);

      expect(error.message).not.toContain('acct-recognisable-99887');
      expect(error.message).not.toContain('99887');
      // It names the TEMPLATE, which is what makes the message still useful.
      expect(error.message).toContain(GET_CUSTOMER_RISK_PROFILE_TEMPLATE);
    });
  });

  describe('case: scenario 4 — an expired identity is an auth error a human can act on (FR-003)', () => {
    it('maps a 401 to kind auth, not retryable', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs401, { status: 401 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('auth');
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/re-?authenticate/i);
    });

    it('is never framed as "no results found"', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs401, { status: 401 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.message).toMatch(/no results found/i);
      expect(error.kind).not.toBe('notFound');
    });
  });

  describe('case: insufficient permission is forbidden, not retryable, never auth (FR-028, SC-009)', () => {
    it('maps a 403 to kind forbidden with retryable false', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs403, { status: 403 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('forbidden');
      expect(error.retryable).toBe(false);
    });

    it('is distinct from the 401 outcome on the same operation', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs403, { status: 403 })));
      const forbidden = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs401, { status: 401 })));
      const auth = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      expect(forbidden.kind).toBe('forbidden');
      expect(auth.kind).toBe('auth');
      expect(forbidden.kind).not.toBe(auth.kind);
      expect(forbidden.retryable).toBe(false);
    });

    it('echoes no account identifier in the forbidden message either', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs403, { status: 403 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct-recognisable-99887'
      }).catch((e) => e as ToolError);

      expect(error.message).not.toContain('acct-recognisable-99887');
    });
  });

  describe('case: a 500 is a retryable upstream error, not an empty configuration set', () => {
    it('maps to kind upstream and returns no data at all', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })));

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error).not.toHaveProperty('completeness');
    });
  });

  describe('case: a malformed account identifier is an argument error echoing NO value (FR-030, SC-008)', () => {
    it('rejects a blank identifier before any upstream call', async () => {
      // No msw handler registered: onUnhandledRequest:'error' proves the validation
      // ran BEFORE the request, which is what keeps a malformed identifier out of
      // GMA's own logs as well as ours.
      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId: '   ' }).catch(
        (e) => e as ToolError
      );

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
    });

    it('rejects an identifier carrying a path separator, and echoes nothing', async () => {
      // `/crs/**` is a catch-all proxy, so a slash in the identifier would change
      // WHICH upstream resource is addressed. This is a read-only guard, not a nicety.
      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct-99887/riskSettings'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain('acct-99887');
      expect(error.message).not.toContain('riskSettings');
      // It describes the expected FORM instead, which is what lets the agent
      // self-correct without being told its own input back.
      expect(error.message).toMatch(/expected form/i);
    });

    it.each([
      ['whitespace', 'acct 99887'],
      ['a query separator', 'acct?x=1'],
      ['a fragment', 'acct#1'],
      ['a slash', 'a/b']
    ])('rejects an identifier containing %s without echoing it', async (_label, accountId) => {
      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, { accountId }).catch(
        (e) => e as ToolError
      );

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain(accountId);
    });

    it('says explicitly that the value is withheld because it is personal data', async () => {
      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct/x'
      }).catch((e) => e as ToolError);

      expect(error.message).toMatch(/personal data/i);
    });

    it('accepts and trims a well-formed identifier with surrounding whitespace', async () => {
      let observedUrl = '';
      server.use(
        http.get(CRS_ACCOUNT, ({ request }) => {
          observedUrl = request.url;
          return HttpResponse.json(crsThree);
        })
      );

      const result = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: `  ${ACCOUNT}  `
      });

      expect(result.accountId).toBe(ACCOUNT);
      expect(observedUrl).toContain(ACCOUNT);
    });
  });

  describe('case: an upstream 400 does NOT send the agent to check an instance code', () => {
    it('omits the list_instances hint, which this operation has no argument for', async () => {
      /**
       * A REGRESSION SUITE for a live misdirection.
       *
       * CRS returned `400` for every request — including `GET /crs/contexts`, which takes no
       * argument at all — and the `argument` guidance said unconditionally "If an instance
       * code was rejected, call list_instances for the valid codes." Directed at its
       * arguments, the agent concluded the ACCOUNT IDENTIFIER was invalid and told the user
       * to double-check it. The identifier was valid; CRS was down.
       *
       * Advice naming the wrong argument is worse than none: it steers the diagnosis away
       * from the truth, and the agent relays that to a human as a claim about their input.
       * A customer-domain call is scoped by the account identifier alone — there is no
       * instance code to have been rejected.
       */
      server.use(
        http.get(CRS_ACCOUNT, () => HttpResponse.json({ message: 'bad request' }, { status: 400 }))
      );

      const error = await getCustomerRiskProfile(client(), TEST_TOKEN, {
        accountId: 'acct-test-0001'
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain('list_instances');
      // The actionable half survives; only the wrong-argument hint is gone.
      expect(error.message).toMatch(/does not need the user/i);
      // And the identifier is still never echoed (FR-030).
      expect(error.message).not.toContain('acct-test-0001');
    });
  });

  describe('case: the description instructs the agent as FR-006 and FR-009 require', () => {
    it('forbids summarising across jurisdictions, in those words', () => {
      expect(GET_CUSTOMER_RISK_PROFILE_DESCRIPTION).toMatch(/never summarise/i);
      expect(GET_CUSTOMER_RISK_PROFILE_DESCRIPTION).toMatch(/jurisdiction/i);
    });

    it('tells the agent to relay a caveat, which the smoke test requires of every tool', () => {
      expect(GET_CUSTOMER_RISK_PROFILE_DESCRIPTION.toLowerCase()).toContain('relay');
    });

    it('warns that null is not zero, so an unset setting is not read as a block', () => {
      expect(GET_CUSTOMER_RISK_PROFILE_DESCRIPTION).toMatch(/null.*not the same as zero/i);
    });

    it('exposes no upstream DTO vocabulary to the model', () => {
      for (const upstreamName of ['contextId', 'hierarchyGroups', 'birDelay', 'gmltl', 'crs']) {
        expect(GET_CUSTOMER_RISK_PROFILE_DESCRIPTION).not.toContain(upstreamName);
      }
    });
  });
});
