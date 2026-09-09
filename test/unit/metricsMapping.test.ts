import { describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  hasNoDataSignature,
  hintForErrorCode,
  toMetricsFigures,
  toMetricsRequestBody,
  toProjectedMetrics,
  type UpstreamMetricsResponse
} from '../../src/domains/customer/mapping/metrics.js';

import allZero from '../fixtures/gma/customerMetrics/200-all-zero-no-data.json' with { type: 'json' };
import byBetType from '../fixtures/gma/customerMetrics/200-by-bet-type.json' with { type: 'json' };
import byHierarchy from '../fixtures/gma/customerMetrics/200-by-hierarchy-entity.json' with { type: 'json' };
import byTimeframe from '../fixtures/gma/customerMetrics/200-by-timeframe.json' with { type: 'json' };

/**
 * The metrics mapping (User Story 4).
 *
 * Three properties carry the weight, and each fails SILENTLY if broken:
 *
 *  1. **`EVENT_TYPE` → `EVENTTYPE` in the request body** (research.md R12). A wrong
 *     spelling does not error: the filter is IGNORED, and the caller gets metrics for the
 *     whole catalogue while believing they asked about one competition. That is a number
 *     several times too large presented as an answer.
 *  2. **`vipManager` never leaves the mapper.** It names a member of staff (Principle V),
 *     and the fixtures carry it precisely so its absence is provable rather than assumed.
 *  3. **A missing measure is `null`, never `0`.** "This customer placed no bets" and "we do
 *     not know how many bets this customer placed" are different findings.
 */

const upstream = (raw: unknown) => raw as UpstreamMetricsResponse;

describe('metrics mapping (FR-013, FR-014, R12)', () => {
  describe('case: the request body translates EVENT_TYPE to EVENTTYPE (R12)', () => {
    it('sends EVENTTYPE, which is the only spelling the request body accepts', () => {
      // THE case. `EVENT_TYPE` would be silently ignored upstream, so this is the
      // difference between "metrics for the Premier League" and "metrics for everything".
      const body = toMetricsRequestBody({
        aggregation: 'HIERARCHY_ENTITY',
        hierarchy: { level: 'EVENT_TYPE', catalogueEntityIds: ['3307'] }
      });

      expect(body.hierarchyEntity).toEqual({ EVENTTYPE: ['3307'] });
      expect(JSON.stringify(body)).not.toContain('EVENT_TYPE');
    });

    it('passes SUPERCLASS and SUBCLASS through unchanged, since those two agree', () => {
      // Only the event-type level differs between the two vocabularies. Translating the
      // others too would break the filters that currently work.
      expect(
        toMetricsRequestBody({
          aggregation: 'HIERARCHY_ENTITY',
          hierarchy: { level: 'SUPERCLASS', catalogueEntityIds: ['3'] }
        }).hierarchyEntity
      ).toEqual({ SUPERCLASS: ['3'] });

      expect(
        toMetricsRequestBody({
          aggregation: 'HIERARCHY_ENTITY',
          hierarchy: { level: 'SUBCLASS', catalogueEntityIds: ['7', '8'] }
        }).hierarchyEntity
      ).toEqual({ SUBCLASS: ['7', '8'] });
    });

    it("sends the aggregation as aggregationMode, which is upstream's name for it", () => {
      expect(toMetricsRequestBody({ aggregation: 'BET_TYPE' }).aggregationMode).toBe('BET_TYPE');
    });

    it('always asks for the unfiltered lifetime totals', () => {
      // They are what make a filtered figure interpretable. Without them a model compares
      // a filtered number against nothing and calls the result a trend.
      for (const aggregation of ['BET_TYPE', 'HIERARCHY_ENTITY', 'TIMEFRAME'] as const) {
        expect(toMetricsRequestBody({ aggregation }).calculateUnfilteredLifetimeMetrics).toBe(true);
      }
    });

    it('omits every filter the caller did not supply', () => {
      // An empty array is not the same request as an absent filter: upstream documents
      // "all X are considered if none are specified", so sending `[]` risks asking for
      // nothing at all.
      const body = toMetricsRequestBody({ aggregation: 'BET_TYPE' });

      expect(Object.keys(body).sort()).toEqual([
        'aggregationMode',
        'calculateUnfilteredLifetimeMetrics'
      ]);
    });

    it('maps each supplied filter to its own upstream name', () => {
      const body = toMetricsRequestBody({
        aggregation: 'TIMEFRAME',
        period: '_1_MONTH',
        betTypes: ['SINGLE', 'PARLAY'],
        // Upstream calls placement status `status`, which is easy to mistake for a bet's
        // settlement state — hence the rename at this boundary.
        placementStatus: ['IN_PLAY'],
        jurisdictions: ['NJ', 'PA']
      });

      expect(body).toMatchObject({
        period: '_1_MONTH',
        betTypes: ['SINGLE', 'PARLAY'],
        status: ['IN_PLAY'],
        contexts: ['NJ', 'PA']
      });
    });

    it("COPIES the caller's arrays, so a later mutation cannot change what was sent", () => {
      const betTypes: ('SINGLE' | 'PARLAY')[] = ['SINGLE'];
      const body = toMetricsRequestBody({ aggregation: 'BET_TYPE', betTypes });

      betTypes.push('PARLAY');

      expect(body.betTypes).toEqual(['SINGLE']);
    });
  });

  describe('case: vipManager NEVER leaves the mapper (Principle V)', () => {
    it('is absent from the projection, though the fixture carries it', () => {
      // The fixture holds `vipManager: "A Staff Member"` on every metrics bag, so this
      // asserts an exclusion rather than assuming one.
      expect(JSON.stringify(byBetType)).toContain('vipManager');

      const projected = toProjectedMetrics(upstream(byBetType));

      expect(JSON.stringify(projected)).not.toContain('vipManager');
      expect(JSON.stringify(projected)).not.toContain('A Staff Member');
    });

    it('is absent from every group and both totals, not merely the top level', () => {
      for (const fixture of [byBetType, byHierarchy, byTimeframe]) {
        const projected = toProjectedMetrics(upstream(fixture));
        const serialised = JSON.stringify(projected);

        expect(serialised).not.toContain('vipManager');
        expect(serialised).not.toContain('Staff Member');
      }
    });

    it('drops the promo, device-link, and internal-scoring measures', () => {
      // Not for size: `shortener: 1.2` and `overSelection: 0.4` are not self-describing,
      // so a model shown them would narrate a guess about what they mean.
      const projected = toProjectedMetrics(upstream(byBetType));
      const keys = Object.keys(projected.lifetime ?? {});

      for (const excluded of [
        'promoStake',
        'profitBoostStake',
        'freeBetStake',
        'totalDeviceLinks',
        'restrictedDeviceLinks',
        'promoChaser',
        'shortener',
        'overSelection',
        'mikePriceStake',
        'bnnShrewdStake'
      ]) {
        expect(keys, `${excluded} must not be projected`).not.toContain(excluded);
      }
    });

    it('keeps exactly the fifteen curated measures (data-model.md section 10)', () => {
      const projected = toProjectedMetrics(upstream(byBetType));

      expect(Object.keys(projected.lifetime ?? {}).sort()).toEqual(
        [
          'averageLegPrice',
          'averageLegsPerBet',
          'averageStake',
          'betCount',
          'distinctEvents',
          'expectedMargins',
          'firstBetDate',
          'grossStake',
          'inPlayStake',
          'lastBetDate',
          'nearLimitBet',
          'playerDays',
          'settledStake',
          'tradingMargin',
          'tradingRevenue'
        ].sort()
      );
    });
  });

  describe('case: keyKind DISCRIMINATES, so a bet type cannot be read as a period', () => {
    it('labels a bet-type aggregation as betType', () => {
      const projected = toProjectedMetrics(upstream(byBetType));

      expect(projected.groups).toHaveLength(3);
      expect(projected.groups.map((group) => group.key)).toEqual(['SINGLE', 'PARLAY', 'SGP']);
      for (const group of projected.groups) {
        expect(group.keyKind).toBe('betType');
        expect(group.hierarchyLevel).toBeNull();
      }
    });

    it('labels a timeframe aggregation as period', () => {
      const projected = toProjectedMetrics(upstream(byTimeframe));

      expect(projected.groups.map((group) => group.key)).toEqual([
        '_24_HOURS',
        'LAST_WEEK',
        '_1_MONTH'
      ]);
      for (const group of projected.groups) {
        expect(group.keyKind).toBe('period');
      }
    });

    it('labels a hierarchy aggregation as hierarchyEntity, with its level and name', () => {
      const projected = toProjectedMetrics(upstream(byHierarchy));

      expect(projected.groups).toHaveLength(2);
      expect(projected.groups[0]).toMatchObject({
        key: '3',
        keyKind: 'hierarchyEntity',
        keyName: 'Football',
        hierarchyLevel: 'SUPERCLASS'
      });
      // The RESPONSE states EVENT_TYPE even though the request wanted EVENTTYPE — both
      // spellings of one level, and the projection reports the underscored one because
      // that is what every other tool in this server uses.
      expect(projected.groups[1]).toMatchObject({
        key: '3307',
        keyKind: 'hierarchyEntity',
        keyName: 'Premier League',
        hierarchyLevel: 'EVENT_TYPE'
      });
    });

    it('produces all three discriminator values across the three aggregations', () => {
      const kinds = [byBetType, byTimeframe, byHierarchy].map(
        (fixture) => toProjectedMetrics(upstream(fixture)).groups[0]!.keyKind
      );

      expect(kinds).toEqual(['betType', 'period', 'hierarchyEntity']);
      expect(new Set(kinds).size).toBe(3);
    });

    it('falls back to the entity id rather than inventing a name', () => {
      const projected = toProjectedMetrics(
        upstream({
          aggregatedMetrics: [
            {
              hierarchyEntity: { hierarchyLevel: 'SUBCLASS', hierarchyEntityId: '7' },
              customerMetrics: { betCount: 1 }
            }
          ]
        })
      );

      expect(projected.groups[0]!.keyName).toBe('7');
    });

    it('reports an unrecognised hierarchy level as null rather than passing it through', () => {
      // A model shown a level it does not know would guess where in the catalogue this
      // row sits, and a guess about scope is a wrong answer about coverage.
      const projected = toProjectedMetrics(
        upstream({
          aggregatedMetrics: [
            {
              hierarchyEntity: { hierarchyLevel: 'WHATEVER', hierarchyEntityId: '7' },
              customerMetrics: { betCount: 1 }
            }
          ]
        })
      );

      expect(projected.groups[0]!.hierarchyLevel).toBeNull();
      expect(projected.groups[0]!.keyKind).toBe('hierarchyEntity');
    });

    it('DROPS a row naming none of the three keys, rather than inventing one', () => {
      // A bucket whose identity is unknown cannot be attributed to anything, and showing
      // it with a placeholder key would invite exactly that attribution.
      const projected = toProjectedMetrics(
        upstream({ aggregatedMetrics: [{ customerMetrics: { betCount: 5 } }] })
      );

      expect(projected.groups).toEqual([]);
    });
  });

  describe('case: an absent measure is null, NEVER zero', () => {
    it('reports a missing measure as null', () => {
      const figures = toMetricsFigures({ betCount: 10 });

      expect(figures!.betCount).toBe(10);
      expect(figures!.grossStake).toBeNull();
      expect(figures!.tradingRevenue).toBeNull();
      expect(figures!.firstBetDate).toBeNull();
    });

    it('preserves a genuine ZERO, which is a real finding', () => {
      // A customer with `betCount: 0` placed no bets. One whose count upstream omitted is
      // a customer we know nothing about, and reporting the second as the first invents a
      // finding about a real person.
      const figures = toMetricsFigures({ betCount: 0, grossStake: 0 });

      expect(figures!.betCount).toBe(0);
      expect(figures!.grossStake).toBe(0);
    });

    it('reports an absent SECTION as null rather than a bag of nulls', () => {
      expect(toMetricsFigures(null)).toBeNull();
      expect(toMetricsFigures(undefined)).toBeNull();

      const projected = toProjectedMetrics(upstream({ accountId: 'x' }));
      expect(projected.lifetime).toBeNull();
      expect(projected.filteredTotal).toBeNull();
      expect(projected.groups).toEqual([]);
    });

    it('coerces neither NaN nor a non-numeric value into a measure', () => {
      const figures = toMetricsFigures({
        betCount: Number.NaN,
        grossStake: 'lots' as unknown as number
      });

      expect(figures!.betCount).toBeNull();
      expect(figures!.grossStake).toBeNull();
    });

    it('keeps lifetime and filteredTotal DISTINCT, since they are not comparable', () => {
      // Lifetime is unfiltered and all-time; the filtered total is the answer to the
      // question asked. Conflating them is the misreading the description warns about.
      const projected = toProjectedMetrics(upstream(byBetType));

      expect(projected.lifetime!.betCount).toBe(410);
      expect(projected.filteredTotal!.betCount).toBe(120);
      expect(projected.lifetime!.betCount).not.toBe(projected.filteredTotal!.betCount);
    });

    it('survives a null response without throwing', () => {
      expect(toProjectedMetrics(null)).toEqual({
        lifetime: null,
        filteredTotal: null,
        groups: []
      });
    });
  });

  describe("case: upstream's zero-fill signature is WARNED about, never presented as a fact", () => {
    /**
     * A REGRESSION SUITE for a live defect, and the one on this surface that no fixture
     * could have caught before it was observed.
     *
     * A customer with **3,795 bets** — confirmed through `find_customer_bets` in the same
     * session — returned metrics reading zero on every measure. HTTP 200, no `errors[]`,
     * a body that looks complete. A model shown that states "this customer has never
     * placed a bet": a confidently wrong answer about a real person.
     *
     * The cause is in GMA, and is deliberate on its part.
     * `UnmappedCustomerMetricsResponseGenerator` fabricates rows for buckets the Data API
     * did not return — all three `enrichWith*` methods build
     * `CustomerMetrics.builder().build()`. Lombok leaves Java PRIMITIVES at `0`
     * (`int betCount`, `double grossStake`) and every BOXED member null
     * (`Integer distinctEvents`, both `LocalDate` bet dates), which is the signature this
     * detects. Metrics also come from a separate warehouse than bet records, so the two
     * genuinely can disagree.
     */
    it('attaches the notice for the shape GMA zero-fill produces', () => {
      const projected = toProjectedMetrics(upstream(allZero));

      expect(projected.noDataNotice).toBeDefined();
      // Says what is NOT known, and does not assert a cause — both a reporting gap and
      // genuine inactivity produce this shape, and the tool cannot tell them apart.
      expect(projected.noDataNotice).toContain('NOT evidence');
      expect(projected.noDataNotice).toContain('find_customer_bets');
    });

    it('is ABSENT on a normal answer, so nothing invites narrating its absence', () => {
      // Optional rather than nullable: a `noDataNotice: null` would be a field the model
      // reads and may mention. An absent key is silent.
      expect(toProjectedMetrics(upstream(byBetType))).not.toHaveProperty('noDataNotice');
      expect(toProjectedMetrics(upstream(byTimeframe))).not.toHaveProperty('noDataNotice');
    });

    it('does NOT fire on a single zero measure among real ones', () => {
      // The narrowness that makes the notice worth having. A customer with a real history
      // and one zero measure is not a reporting gap, and a notice there would train the
      // reader to ignore it.
      const projected = toProjectedMetrics(
        upstream({
          lifetimeMetrics: { betCount: 0, grossStake: 500, firstBetDate: '2026-01-01' }
        })
      );

      expect(projected).not.toHaveProperty('noDataNotice');
    });

    it('does NOT fire when a bet date is present, even with every measure zero', () => {
      // A date is proof of activity, so the zero-fill hypothesis is dead — whatever else
      // is wrong, this row was not fabricated by the builder, which leaves both dates null.
      const projected = toProjectedMetrics(
        upstream({ lifetimeMetrics: { betCount: 0, lastBetDate: '2026-09-01' } })
      );

      expect(projected).not.toHaveProperty('noDataNotice');
    });

    it('treats a null measure as zero-or-absent, since the boxed members ARE null', () => {
      // The subtlety: demanding a literal `0` on every measure would miss the signature
      // entirely, because `Integer`/`Double`/`LocalDate` members come back null.
      expect(hasNoDataSignature(toMetricsFigures({ betCount: 0 }))).toBe(true);
      expect(hasNoDataSignature(toMetricsFigures({}))).toBe(true);
    });

    it('reports nothing for an ABSENT section rather than warning about it', () => {
      // No figures is not the same as empty figures. The completeness verdict is what
      // speaks to a section that did not arrive; this notice is about what arrived.
      expect(hasNoDataSignature(null)).toBe(false);
      expect(toProjectedMetrics(upstream({ accountId: 'x' }))).not.toHaveProperty('noDataNotice');
    });

    it('keys on the TOTALS, not on an individual zero-filled group', () => {
      // A zero-filled GROUP is normal and informative — it is how "you asked about this
      // bet type and there was no activity" is reported. Warning on it would fire on most
      // ordinary answers.
      const projected = toProjectedMetrics(
        upstream({
          lifetimeMetrics: { betCount: 410, grossStake: 12500, firstBetDate: '2024-01-01' },
          aggregatedTotalMetrics: { betCount: 120, grossStake: 3000, firstBetDate: '2024-06-01' },
          aggregatedMetrics: [{ betType: 'SINGLE', customerMetrics: { betCount: 0 } }]
        })
      );

      expect(projected).not.toHaveProperty('noDataNotice');
      expect(projected.groups).toHaveLength(1);
      expect(projected.groups[0]!.figures.betCount).toBe(0);
    });

    it('prefers LIFETIME as the signal, falling back to the filtered total', () => {
      // Lifetime is filter-independent, so a customer with any history should have non-zero
      // figures there — the strongest available signal. A filtered total can be legitimately
      // empty (a week with no bets), which is why it is only consulted when lifetime is
      // absent because the caller did not ask for it.
      const lifetimeReal = toProjectedMetrics(
        upstream({
          lifetimeMetrics: { betCount: 410, firstBetDate: '2024-01-01' },
          aggregatedTotalMetrics: { betCount: 0 }
        })
      );
      expect(lifetimeReal).not.toHaveProperty('noDataNotice');

      const lifetimeAbsent = toProjectedMetrics(
        upstream({ aggregatedTotalMetrics: { betCount: 0 } })
      );
      expect(lifetimeAbsent.noDataNotice).toBeDefined();
    });

    it('still returns the figures themselves, rather than withholding them', () => {
      // A notice, not an error. The zeros may be genuine — a brand-new account — and
      // refusing to answer would deny a legitimate question. The caller gets the data
      // plus the caveat and decides.
      const projected = toProjectedMetrics(upstream(allZero));

      expect(projected.lifetime).not.toBeNull();
      expect(projected.lifetime!.betCount).toBe(0);
      expect(projected.groups).toHaveLength(4);
    });

    it('leaves the completeness axes alone — this is not incompleteness', () => {
      // `unavailableComponents` is for a section that could not be RETRIEVED. This section
      // was retrieved; what is uncertain is what it MEANS. Folding an interpretive doubt
      // into the completeness verdict would make `complete: false` mean two things
      // (Principle II's no-merging rule, read one step out).
      const projected = toProjectedMetrics(upstream(allZero));

      expect(projected).not.toHaveProperty('completeness');
      expect(projected).not.toHaveProperty('unavailableComponents');
    });
  });

  describe('case: each 400 errorCode becomes a self-correctable hint (SC-008)', () => {
    it.each([
      ['MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE', /ONE level/i],
      ['TOO_MANY_HIERARCHY_ENTITIES', /fewer|broader/i],
      ['ACCOUNT_IDENTIFIER_MISSING', /accountId/]
    ])('turns %s into guidance saying what to do', (code, expected) => {
      const hint = hintForErrorCode(code);

      expect(hint).not.toBeNull();
      expect(hint).toMatch(expected);
      // Guidance, not a restatement: a code alone leaves the agent to guess the fix.
      expect(hint!.length).toBeGreaterThan(40);
    });

    it('gives each code a DISTINCT hint', () => {
      const hints = [
        'MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE',
        'TOO_MANY_HIERARCHY_ENTITIES',
        'ACCOUNT_IDENTIFIER_MISSING'
      ].map((code) => hintForErrorCode(code));

      expect(new Set(hints).size).toBe(3);
    });

    it('returns null for an unrecognised code rather than inventing guidance', () => {
      // Inventing a fix for a code we do not know would send the agent to correct
      // something that may not be the problem.
      expect(hintForErrorCode('SOMETHING_NEW')).toBeNull();
      expect(hintForErrorCode(undefined)).toBeNull();
      expect(hintForErrorCode(null)).toBeNull();
    });

    it('reads the errorCode off any of the three 400 shapes, and nothing else', () => {
      expect(errorCodeOf({ errorCode: 'TOO_MANY_HIERARCHY_ENTITIES' })).toBe(
        'TOO_MANY_HIERARCHY_ENTITIES'
      );
      // The `CustomerMetricsDataApiResponse` shape has no errorCode — only `reason` and a
      // `message` that must never be surfaced.
      expect(errorCodeOf({ reason: 'CLIENT_ERROR', message: 'account acct-1' })).toBeNull();
      expect(errorCodeOf(null)).toBeNull();
      expect(errorCodeOf('a string')).toBeNull();
      expect(errorCodeOf({ errorCode: '' })).toBeNull();
    });

    it('NEVER includes upstream message text in a hint (Principle V, FR-029)', () => {
      // The upstream `message` carries "the Json response that caused the exception",
      // which can echo the account identifier into a sentence a human reads.
      for (const code of [
        'MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE',
        'TOO_MANY_HIERARCHY_ENTITIES',
        'ACCOUNT_IDENTIFIER_MISSING'
      ]) {
        const hint = hintForErrorCode(code)!;

        // An identifier-shaped VALUE, not the words "account identifier" — which the
        // ACCOUNT_IDENTIFIER_MISSING hint must be able to use to say what went wrong.
        expect(hint).not.toMatch(/\bacct[-_]/i);
        expect(hint).not.toMatch(/\b[a-z]+-\d{3,}\b/i);
        expect(hint).not.toMatch(/\b\d{5,}\b/);
      }
    });
  });

  describe('case: the mapping is PURE', () => {
    it('returns the same projection for the same input', () => {
      expect(toProjectedMetrics(upstream(byBetType))).toEqual(
        toProjectedMetrics(upstream(byBetType))
      );
    });

    it('mutates neither the response it reads nor the request it is given', () => {
      const before = JSON.stringify(byHierarchy);
      toProjectedMetrics(upstream(byHierarchy));

      expect(JSON.stringify(byHierarchy)).toBe(before);
    });
  });
});
