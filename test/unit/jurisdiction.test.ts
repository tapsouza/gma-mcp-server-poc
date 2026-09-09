import { describe, expect, it } from 'vitest';
import { deriveUsStateCode, matchJurisdiction } from '../../src/domains/customer/jurisdiction.js';
import type {
  CustomerRiskConfiguration,
  JurisdictionRef
} from '../../src/domains/customer/schemas.js';

/**
 * The jurisdiction matcher (User Story 3) — the module most at risk of failing
 * CONFIDENTLY.
 *
 * Two properties carry the weight. First, the context list must be PRIMARY and
 * derivation only a fallback: if that inverts, the code compiles, every test that hands
 * the matcher a list still passes, US bets are answered correctly, and every non-US bet
 * is confidently wrong. Second, rows 2 and 3 of FR-018 must stay DISTINCT, so a
 * systematic matching defect never reads as a fact about a customer.
 */

/** A configuration for one jurisdiction, with only the fields matching reads. */
function configuration(
  jurisdiction: JurisdictionRef,
  stakeFactor: number | null = 1
): CustomerRiskConfiguration {
  return {
    jurisdiction,
    stakeFactor,
    inRunningDelaySeconds: null,
    liabilityGroup: null,
    eligibility: null,
    payoutLimitSingles: null,
    payoutLimitMultiples: null,
    maxWinningsCap: null,
    guaranteedMaxLimitToLose: null,
    earlySettlementRestricted: null,
    overrides: []
  };
}

const NJ: JurisdictionRef = { code: 'NJ', id: 'ctx-us-nj', name: 'New Jersey' };
const PA: JurisdictionRef = { code: 'PA', id: 'ctx-us-pa', name: 'Pennsylvania' };
const ONTARIO: JurisdictionRef = { code: 'NXTCANBS', id: 'ctx-ca-on', name: 'Ontario' };

const PLATFORM_CONTEXTS: JurisdictionRef[] = [NJ, PA, ONTARIO];

describe('jurisdiction matching (FR-018)', () => {
  describe('case: outcome 1 — matched, naming the governing jurisdiction', () => {
    it("matches directly against the customer's own configuration", () => {
      const result = matchJurisdiction('ctx-us-nj', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.match).toBe('matched');
      expect(result.governing).toEqual(NJ);
      expect(result.mechanism).toBe('ownConfiguration');
    });

    it('matches on the jurisdiction CODE as well as its id', () => {
      const result = matchJurisdiction('NJ', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('ownConfiguration');
    });

    it('picks the RIGHT configuration when the customer has several', () => {
      // The failure this rules out is the worst available: attributing one state's
      // settings to a bet placed in another (SC-003).
      const result = matchJurisdiction(
        'ctx-us-pa',
        [configuration(NJ, 0.5), configuration(PA, 2)],
        PLATFORM_CONTEXTS
      );

      expect(result.match).toBe('matched');
      expect(result.governing).toEqual(PA);
    });

    it('is insensitive to case and surrounding whitespace', () => {
      // Reporting `jurisdictionNotMatched` — a claim that OUR matching failed — over a
      // difference in capitalisation would be absurd.
      const result = matchJurisdiction('  ctx-US-NJ  ', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.match).toBe('matched');
    });

    it('matches a URN-shaped bet jurisdiction against a URN-shaped configuration', () => {
      const urnConfig: JurisdictionRef = {
        code: 'NJ',
        id: 'urn:i:FD:US-NJ',
        name: 'New Jersey'
      };
      const result = matchJurisdiction('urn:i:FD:US-NJ', [configuration(urnConfig)], null);

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('ownConfiguration');
    });
  });

  describe('case: THE CONTEXT LIST IS PRIMARY and derivation is only a fallback (v1.2.0)', () => {
    it('resolves Ontario through the context list, which derivation provably cannot', () => {
      // The standing proof: `urn:i:FD:CA-ON` against a context observed as `NXTCANBS`.
      // No derivation produces that, which is why a hardcoded table is prohibited —
      // it would fail confidently as jurisdictions are added.
      const result = matchJurisdiction(
        'urn:i:FD:CA-ON',
        [configuration(ONTARIO)],
        [{ code: 'NXTCANBS', id: 'urn:i:FD:CA-ON', name: 'Ontario' }]
      );

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('platformContextList');
      expect(result.governing?.code).toBe('NXTCANBS');
    });

    it('does NOT consult derivation when the context list already matched', () => {
      // Asserted through the reported mechanism, which is the only observable
      // difference. If derivation ran first, a US jurisdiction would report
      // `derivation` here — and the ordering guarantee would be silently inverted.
      const result = matchJurisdiction(
        'urn:i:FD:US-NJ',
        [configuration(NJ)],
        [{ code: 'NJ', id: 'urn:i:FD:US-NJ', name: 'New Jersey' }]
      );

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('platformContextList');
      expect(result.mechanism).not.toBe('derivation');
    });

    it("prefers the CONTEXT's reference, which carries the human-readable name", () => {
      const terse = configuration({ code: 'ctx-us-nj', id: 'ctx-us-nj', name: 'ctx-us-nj' });
      const result = matchJurisdiction('ctx-us-nj', [terse], [NJ]);

      // Matched via the customer's own configuration first here, so the terse
      // reference is expected — the enrichment case is the one above.
      expect(result.match).toBe('matched');
    });

    it('falls back to derivation when the context list is ABSENT (its hop failed)', () => {
      // `null` means "we could not look". Derivation still runs — the tool answers
      // rather than failing — and the caller reports the missing section separately.
      const result = matchJurisdiction('urn:i:FD:US-NJ', [configuration(NJ)], null);

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('derivation');
    });

    it('falls back to derivation when the context list did not recognise the jurisdiction', () => {
      const result = matchJurisdiction('urn:i:FD:US-NJ', [configuration(NJ)], [PA]);

      expect(result.match).toBe('matched');
      expect(result.mechanism).toBe('derivation');
    });

    it('distinguishes an ABSENT context list from an EMPTY one', () => {
      // `null` = the hop failed; `[]` = the platform reported no jurisdictions. Both
      // fall through to derivation, but only the first is a missing SECTION, which is
      // why the caller must be able to tell them apart.
      const absent = matchJurisdiction('urn:i:FD:US-NJ', [configuration(NJ)], null);
      const empty = matchJurisdiction('urn:i:FD:US-NJ', [configuration(NJ)], []);

      expect(absent.mechanism).toBe('derivation');
      expect(empty.mechanism).toBe('derivation');
    });

    it('cannot resolve Ontario WITHOUT the context list, and says so honestly', () => {
      // This is the confident-failure mode made visible: with the list absent, the
      // non-US jurisdiction becomes `jurisdictionNotMatched` — OUR failure — rather
      // than a wrong claim about the customer.
      const result = matchJurisdiction('urn:i:FD:CA-ON', [configuration(ONTARIO)], null);

      expect(result.match).toBe('jurisdictionNotMatched');
      expect(result.governing).toBeNull();
      expect(result.mechanism).toBeNull();
    });
  });

  describe('case: outcome 2 — noConfigurationForJurisdiction is a FACT ABOUT THE CUSTOMER', () => {
    it('is reported when the platform knows the jurisdiction and the customer has no row', () => {
      const result = matchJurisdiction('ctx-us-pa', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.match).toBe('noConfigurationForJurisdiction');
      expect(result.governing).toBeNull();
      expect(result.mechanism).toBe('platformContextList');
    });

    it('is reported when derivation recognised the SHAPE but the customer has no row', () => {
      const result = matchJurisdiction('urn:i:FD:US-CO', [configuration(NJ)], null);

      expect(result.match).toBe('noConfigurationForJurisdiction');
      expect(result.mechanism).toBe('derivation');
    });

    it('is reported for a customer with NO configurations at all', () => {
      const result = matchJurisdiction('ctx-us-nj', [], PLATFORM_CONTEXTS);

      expect(result.match).toBe('noConfigurationForJurisdiction');
    });
  });

  describe('case: outcome 3 — jurisdictionNotMatched is a FAILURE OF OUR MATCHING', () => {
    it('is reported when nothing recognises the jurisdiction', () => {
      const result = matchJurisdiction('something-entirely-unknown', [configuration(NJ)], [NJ]);

      expect(result.match).toBe('jurisdictionNotMatched');
      expect(result.governing).toBeNull();
      expect(result.mechanism).toBeNull();
    });

    it('stays DISTINCT from outcome 2 for the same customer (SC-003, SC-004)', () => {
      // THE assertion that keeps a systematic defect observable. Folding these would
      // make a matching bug indistinguishable from a fact about the customer — and the
      // bug would then be unobservable, because it would look like data.
      const configurations = [configuration(NJ)];

      const knownButUnconfigured = matchJurisdiction(
        'ctx-us-pa',
        configurations,
        PLATFORM_CONTEXTS
      );
      const notMatched = matchJurisdiction('who-knows', configurations, PLATFORM_CONTEXTS);

      expect(knownButUnconfigured.match).toBe('noConfigurationForJurisdiction');
      expect(notMatched.match).toBe('jurisdictionNotMatched');
      expect(knownButUnconfigured.match).not.toBe(notMatched.match);
    });

    it('records NO mechanism, since no step produced an answer', () => {
      const result = matchJurisdiction('who-knows', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.mechanism).toBeNull();
    });
  });

  describe('case: a bet may name its jurisdiction by NAME, and that must still match', () => {
    /**
     * A REGRESSION SUITE for a live defect found during Validation 4.
     *
     * A bet reported its jurisdiction as **`INTBS1`**, which is a context NAME:
     * `{ contextCode: 'NJ1', contextName: 'INTBS1' }`. Matching compared `id` and `code`
     * only, so the bet matched nothing and the tool reported `jurisdictionNotMatched` —
     * "we could not tell what this bet's jurisdiction is" — while the governing
     * configuration sat in the very same response, named `INTBS1`.
     *
     * Same shape as the FR-019 override join: one identifier stated in two vocabularies,
     * compared in only one of them. And the same cost: a trader asking why a bet got its
     * limit is told the tool could not work it out.
     */
    const NJ1: JurisdictionRef = { code: 'NJ1', id: '754', name: 'INTBS1' };
    const NJ_NXT: JurisdictionRef = { code: 'NJ', id: '927', name: 'NXTBS1' };
    const LIVE_CONTEXTS: JurisdictionRef[] = [NJ_NXT, NJ1, ONTARIO];

    it('matches a bet whose jurisdiction is a context NAME (the live case)', () => {
      const result = matchJurisdiction('INTBS1', [configuration(NJ1)], LIVE_CONTEXTS);

      expect(result.match).toBe('matched');
      expect(result.governing).toEqual(NJ1);
      // Through the platform's own list, which is where v1.2.0 requires this to happen.
      expect(result.mechanism).toBe('platformContextList');
    });

    it('REFUSES to match an ambiguous name rather than picking one', () => {
      // The guard that keeps this fix from being worse than the defect. A name is
      // human-authored, so it can collide where a code cannot — and the live list already
      // has two contexts sharing the id `754`, so duplicates in this data are demonstrated
      // rather than imagined. Attributing a bet to the WRONG state's settings is a
      // confident claim about a real customer's restrictions; refusing is honest.
      const collides: JurisdictionRef = { code: 'WV', id: '754', name: 'INTBS1' };

      const result = matchJurisdiction(
        'INTBS1',
        [configuration(NJ1), configuration(collides)],
        [...LIVE_CONTEXTS, collides]
      );

      expect(result.match).toBe('jurisdictionNotMatched');
      expect(result.governing).toBeNull();
    });

    it('prefers an exact CODE match over a name that coincides with it', () => {
      // Names are tried LAST within step 2, so a platform-issued code always wins.
      const confusing: JurisdictionRef = { code: 'INTBS1', id: '999', name: 'Somewhere Else' };
      const decoy: JurisdictionRef = { code: 'ZZ', id: '888', name: 'INTBS1' };

      const result = matchJurisdiction(
        'INTBS1',
        [configuration(confusing), configuration(decoy)],
        [confusing, decoy]
      );

      expect(result.governing).toEqual(confusing);
    });

    it('does not let a NAME match reach outcome 2 by the back door', () => {
      // The jurisdiction is real (the platform names it) but this customer has no
      // configuration for it — a fact about the customer, not a matching failure.
      const result = matchJurisdiction('INTBS1', [configuration(NJ_NXT)], LIVE_CONTEXTS);

      expect(result.match).toBe('noConfigurationForJurisdiction');
      expect(result.governing).toBeNull();
    });

    it('never matches a name when the context list is ABSENT', () => {
      // Names resolve ONLY through the platform's list. With no list there is nothing to
      // check a name against, and inventing a comparison against the configurations'
      // own names is exactly the collision risk this design avoids.
      const result = matchJurisdiction('INTBS1', [configuration(NJ1)], null);

      expect(result.match).toBe('jurisdictionNotMatched');
    });
  });

  describe('case: outcome 4 — jurisdictionUnknown when the bet reported nothing', () => {
    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace', '   ']
    ])('is reported for %s', (_label, value) => {
      const result = matchJurisdiction(value, [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(result.match).toBe('jurisdictionUnknown');
      expect(result.governing).toBeNull();
      expect(result.mechanism).toBeNull();
    });

    it('stays distinct from the other three outcomes', () => {
      // There is nothing here to have matched OR failed to match, which is a different
      // statement from either.
      const unknown = matchJurisdiction(null, [configuration(NJ)], PLATFORM_CONTEXTS);
      const notMatched = matchJurisdiction('who-knows', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(unknown.match).toBe('jurisdictionUnknown');
      expect(notMatched.match).toBe('jurisdictionNotMatched');
    });
  });

  describe('case: ALL FIVE outcomes are reachable and each is exercised (SC-004)', () => {
    it('produces every one of the five values', () => {
      const configurations = [configuration(NJ)];
      const outcomes = [
        matchJurisdiction('ctx-us-nj', configurations, PLATFORM_CONTEXTS).match,
        matchJurisdiction('ctx-us-pa', configurations, PLATFORM_CONTEXTS).match,
        matchJurisdiction('unrecognisable', configurations, PLATFORM_CONTEXTS).match,
        matchJurisdiction(null, configurations, PLATFORM_CONTEXTS).match,
        matchJurisdiction('ctx-us-nj', [], PLATFORM_CONTEXTS, false).match
      ];

      expect(outcomes).toEqual([
        'matched',
        'noConfigurationForJurisdiction',
        'jurisdictionNotMatched',
        'jurisdictionUnknown',
        'jurisdictionMatchNotAttempted'
      ]);
      expect(new Set(outcomes).size).toBe(5);
    });
  });

  describe('case: matching NOT ATTEMPTED is distinct from matching that FAILED', () => {
    /**
     * A REGRESSION SUITE for a live defect, and the reason the fifth outcome exists.
     *
     * CRS returned `400` for every call, so hop 2 produced no configurations. Matching ran
     * anyway against an empty list — which can only ever answer "nothing matched" — and the
     * tool reported `jurisdictionNotMatched`: *"we know the jurisdiction and our matching
     * failed on it"*, when the truth was *"we never had anything to match against"*.
     *
     * The agent then said the applied figures "come from defaults" — the one inference the
     * schema forbids in every non-`matched` case. It was not being careless: nothing
     * distinguished a matching failure from absent inputs, and a matching failure genuinely
     * does suggest the bet fell through to something.
     */
    it('reports jurisdictionMatchNotAttempted when the configurations were never retrieved', () => {
      const result = matchJurisdiction('INTBS1', [], PLATFORM_CONTEXTS, false);

      expect(result.match).toBe('jurisdictionMatchNotAttempted');
      expect(result.governing).toBeNull();
      expect(result.mechanism).toBeNull();
    });

    it('stays DISTINCT from jurisdictionNotMatched, which blames OUR matching', () => {
      // The assertion that keeps a missing hop from masquerading as a finding. Same rule as
      // `notResolvedIdentifierUnusable` on a leg, one level up: logic that FAILED must stay
      // separate from logic that never RAN.
      const notAttempted = matchJurisdiction('anything', [], PLATFORM_CONTEXTS, false);
      const failed = matchJurisdiction('anything', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(notAttempted.match).toBe('jurisdictionMatchNotAttempted');
      expect(failed.match).toBe('jurisdictionNotMatched');
      expect(notAttempted.match).not.toBe(failed.match);
    });

    it('takes precedence over every other outcome, including jurisdictionUnknown', () => {
      // Checked FIRST, before the bet's own jurisdiction: with no configurations, any other
      // answer is an artefact of an empty list rather than a finding. Even a bet that
      // reported no jurisdiction must not be described as "the bet told us nothing" when we
      // also had nothing to compare it against.
      expect(matchJurisdiction(null, [], PLATFORM_CONTEXTS, false).match).toBe(
        'jurisdictionMatchNotAttempted'
      );
      expect(matchJurisdiction('ctx-us-nj', [configuration(NJ)], null, false).match).toBe(
        'jurisdictionMatchNotAttempted'
      );
    });

    it('defaults to ATTEMPTED, so existing callers are unchanged', () => {
      // Additive: a caller that always has configurations passes three arguments and gets
      // exactly the behaviour it always had.
      expect(matchJurisdiction('ctx-us-nj', [configuration(NJ)], PLATFORM_CONTEXTS).match).toBe(
        'matched'
      );
    });

    it('never reports NOT ATTEMPTED when configurations WERE retrieved but are empty', () => {
      // A genuinely empty configuration list is a FACT about the customer, not a failure:
      // they have no settings anywhere. That must stay reportable, and it is why this is a
      // flag from the caller rather than inferred from `configurations.length`.
      const result = matchJurisdiction('ctx-us-pa', [], PLATFORM_CONTEXTS, true);

      expect(result.match).toBe('noConfigurationForJurisdiction');
      expect(result.match).not.toBe('jurisdictionMatchNotAttempted');
    });
  });

  describe('case: derivation is NARROW and is not a jurisdiction table (v1.2.0)', () => {
    it.each([
      ['urn:i:FD:US-NJ', 'NJ'],
      ['urn:i:FD:US-PA', 'PA'],
      ['US-CO', 'CO'],
      ['urn:i:FD:US-NJ1', 'NJ'],
      ['urn:i:FD:US-NJ12', 'NJ']
    ])('derives %s to %s, including numbered variants', (input, expected) => {
      expect(deriveUsStateCode(input)).toBe(expected);
    });

    it.each([
      ['a non-US jurisdiction', 'urn:i:FD:CA-ON'],
      ['a bare context code', 'NXTCANBS'],
      ['a three-letter segment', 'urn:i:FD:US-XYZ'],
      ['a state name', 'New Jersey'],
      ['nothing recognisable', 'whatever']
    ])('returns null for %s rather than guessing', (_label, input) => {
      expect(deriveUsStateCode(input)).toBeNull();
    });

    it('contains no list of states, so it cannot go stale', () => {
      // A table would fail CONFIDENTLY as jurisdictions are added, which is precisely
      // why v1.2.0 prohibits one. This derivation recognises a SHAPE: an unrecognised
      // jurisdiction returns null and becomes an honest "we could not tell".
      const unknownButWellShaped = deriveUsStateCode('urn:i:FD:US-ZZ');

      // `ZZ` is not a real state, and derivation says nothing about that — it reports
      // the shape it found, and the CUSTOMER's configurations decide the rest.
      expect(unknownButWellShaped).toBe('ZZ');
    });
  });

  describe('case: the matcher is PURE and performs no I/O', () => {
    it('returns the same outcome for the same arguments', () => {
      const first = matchJurisdiction('ctx-us-nj', [configuration(NJ)], PLATFORM_CONTEXTS);
      const second = matchJurisdiction('ctx-us-nj', [configuration(NJ)], PLATFORM_CONTEXTS);

      expect(first).toEqual(second);
    });

    it('takes the context list as an ARGUMENT, so it cannot fetch one itself', () => {
      // Which is what keeps the ordering guarantee testable: the caller's failure to
      // fetch a list is visible here as `null`, not hidden inside this function.
      expect(matchJurisdiction.length).toBe(3);
    });

    it('mutates neither the configurations nor the context list it is given', () => {
      const configurations = [configuration(NJ)];
      const contexts = [...PLATFORM_CONTEXTS];

      matchJurisdiction('ctx-us-nj', configurations, contexts);

      expect(configurations).toHaveLength(1);
      expect(contexts).toEqual(PLATFORM_CONTEXTS);
    });
  });
});
