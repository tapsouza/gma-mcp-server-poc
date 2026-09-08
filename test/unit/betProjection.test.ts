import { describe, expect, it } from 'vitest';
import {
  toProjectedBet,
  toProjectedBets,
  totalMatched,
  type QbsBet,
  type QbsSearchBetsResponse
} from '../../src/domains/customer/mapping/betProjection.js';

import qbsSingle from '../fixtures/gma/qbsSearchBets/200-single-bet.json' with { type: 'json' };
import qbsMultiLeg from '../fixtures/gma/qbsSearchBets/200-multi-leg-bet.json' with { type: 'json' };
import qbsWithErrors from '../fixtures/gma/qbsSearchBets/200-success-with-errors.json' with { type: 'json' };
import qbsOverLimit from '../fixtures/gma/qbsSearchBets/200-over-limit.json' with { type: 'json' };

/**
 * The bet projection (User Story 2).
 *
 * Two properties carry most of the weight here: the projection keeps EXACTLY the
 * curated field set and nothing else (FR-009, and FR-004 for notes specifically), and
 * it records which `entityIds` member supplied each leg's event identifier so R9's
 * assumption is reportable rather than invisible.
 */

const asResponse = (fixture: unknown) => fixture as QbsSearchBetsResponse;

describe('QBS bet projection', () => {
  describe('case: the projection keeps exactly the curated field set (FR-009)', () => {
    it('returns the documented top-level fields and no others', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      expect(Object.keys(projected!.bet).sort()).toEqual([
        'accountId',
        'appliedRisk',
        'betId',
        'betType',
        'catalogueInstanceId',
        'jurisdiction',
        'legCount',
        'legs',
        'placedAt',
        'receiptId',
        'status',
        'wager'
      ]);
    });

    it('translates every upstream field name at this boundary (Principle IV)', () => {
      // Asserted against the KEY SET rather than the serialised text, because some
      // renamed fields legitimately contain an upstream name as a substring:
      // `maxValue` → `maxValuePercent` is the rename working, not a leak.
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      const keys = new Set<string>();
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collect);
        } else if (typeof value === 'object' && value !== null) {
          for (const [key, nested] of Object.entries(value)) {
            keys.add(key);
            collect(nested);
          }
        }
      };
      collect(projected!.bet);

      for (const upstreamName of [
        'riskInfo',
        'wageInfo',
        'entityIds',
        'numberOfLines',
        'betReceiptId',
        'placementDate',
        'legPrice',
        'maxValue',
        'cumulativeMax',
        'overlayMax',
        'rampId',
        'gbpId',
        'instance',
        'productId'
      ]) {
        expect([...keys], `upstream name "${upstreamName}" leaked as a key`).not.toContain(
          upstreamName
        );
      }
    });

    it('renames the percentage figures so their unit is visible', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      expect(projected!.bet.appliedRisk).toEqual({
        stakeFactor: 0.25,
        liabilityGroup: 'Tight',
        maxBet: 500,
        maxValuePercent: 40,
        cumulativeMaxPercent: 60,
        overlayMaxPercent: 15
      });
    });

    it('exposes the curated wager amounts only', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      expect(Object.keys(projected!.bet.wager).sort()).toEqual([
        'currency',
        'potentialPayout',
        'refunds',
        'stake',
        'winnings'
      ]);
    });

    it('keeps productId OUT of the projection — it is an upstream mechanic, not a risk fact', () => {
      const serialised = JSON.stringify(toProjectedBets(asResponse(qbsSingle)));

      expect(serialised).not.toContain('productId');
      expect(serialised).not.toContain('prod-sb');
    });

    it('translates the single-letter leg result into something a model can read', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      // Upstream sends `W`. A model shown `"W"` would guess, and a guess about
      // whether a leg won is a guess about whether a customer was paid.
      expect(projected!.bet.legs[0]!.result).toBe('WIN');
    });

    it.each([
      ['N', 'NONE'],
      ['W', 'WIN'],
      ['P', 'PLACE'],
      ['L', 'LOSE'],
      ['V', 'VOID']
    ])('translates leg result %s to %s', (upstream, expected) => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1, result: upstream }]
      } as QbsBet);

      expect(projected!.bet.legs[0]!.result).toBe(expected);
    });

    it('maps an UNRECOGNISED leg result to null rather than passing it through raw', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1, result: 'Q' }]
      } as QbsBet);

      expect(projected!.bet.legs[0]!.result).toBeNull();
    });

    it('keeps each leg to the curated field set', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      expect(Object.keys(projected!.bet.legs[0]!).sort()).toEqual([
        'competition',
        'event',
        'legNumber',
        'market',
        'placedInPlay',
        'price',
        'result',
        'selection',
        'sport'
      ]);
    });
  });

  describe('case: NO returned bet carries a staff-authored note (FR-004)', () => {
    it('exposes no note field, because the document never requests one', () => {
      // Enforced by the fixed document rather than by filtering here, which is
      // categorically stronger: the data never enters this process, so no later
      // mapping bug can leak it.
      const serialised = JSON.stringify(toProjectedBets(asResponse(qbsSingle)));

      for (const noteField of [
        'betNotesDetails',
        'distinguishedBetNote',
        'betNote',
        'notes',
        'comment'
      ]) {
        expect(serialised).not.toContain(noteField);
      }
    });

    it('exposes no settlement operator name or comment either (Principle V)', () => {
      // `settlementDetails.settleBy` is a person's username and `comment` is their
      // free-text remark. Neither is requested.
      const serialised = JSON.stringify(toProjectedBets(asResponse(qbsSingle)));

      expect(serialised).not.toContain('settleBy');
      expect(serialised).not.toContain('settlementDetails');
      expect(serialised).not.toContain('unsettleBy');
    });

    it('drops a note field even if upstream sent one unasked', () => {
      // Belt and braces: the projection is a whitelist, so an upstream that started
      // returning notes without being asked would still not surface them.
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        betNotesDetails: { distinguishedBetNote: { id: 'n1', text: 'a staff remark' } }
      } as unknown as QbsBet);

      expect(JSON.stringify(projected!.bet)).not.toContain('staff remark');
      expect(JSON.stringify(projected!.bet)).not.toContain('betNotesDetails');
    });
  });

  describe('case: R9 — which entityIds member supplied the event id is RECORDED', () => {
    it('records rampId when it is present, since that is the observed bridge', () => {
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      expect(projected!.eventIdSources.get(1)).toBe('rampId');
      expect(projected!.bet.legs[0]!.event.id).toBe('9201');
    });

    it('falls back to gbpId and records THAT instead', () => {
      // The fallback exists because R9 is unverified: `gbpId` is the more suggestive
      // name while the front-end uses `rampId`, and no source reconciles them.
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [
          {
            legNumber: 1,
            event: { name: 'E', entityIds: { gbpId: 'gbp-event-1' } }
          }
        ]
      } as QbsBet);

      expect(projected!.eventIdSources.get(1)).toBe('gbpId');
      expect(projected!.bet.legs[0]!.event.id).toBe('gbp-event-1');
    });

    it('records NOTHING when a leg carries no usable identifier at all', () => {
      // Which is what the composite reports as `notResolvedIdentifierUnusable` —
      // kept distinct from an upstream failure precisely so a wrong R9 assumption is
      // immediately visible rather than hidden in a generic error bucket.
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1, event: { name: 'E', entityIds: {} } }]
      } as QbsBet);

      expect(projected!.eventIdSources.has(1)).toBe(false);
      expect(projected!.bet.legs[0]!.event.id).toBeNull();
    });

    it('records a source per leg, keyed by legNumber', () => {
      const [projected] = toProjectedBets(asResponse(qbsMultiLeg));

      expect(projected!.bet.legs).toHaveLength(3);
      expect(projected!.eventIdSources.get(1)).toBe('rampId');
      expect(projected!.eventIdSources.get(2)).toBe('rampId');
      expect(projected!.eventIdSources.get(3)).toBe('rampId');
    });

    it('reports the source as a FIELD LEVEL, never as an identifier value', () => {
      // `'rampId'` is the name of a member, so it carries no customer datum and needs
      // no telemetry allowlist entry (data-model.md section 7).
      const [projected] = toProjectedBets(asResponse(qbsSingle));

      for (const source of projected!.eventIdSources.values()) {
        expect(['rampId', 'gbpId']).toContain(source);
      }
    });
  });

  describe('case: a multi-leg bet keeps every leg, and two legs may share one event (SC-013)', () => {
    it('projects all three legs', () => {
      const [projected] = toProjectedBets(asResponse(qbsMultiLeg));

      expect(projected!.bet.legs.map((leg) => leg.legNumber)).toEqual([1, 2, 3]);
      expect(projected!.bet.legCount).toBe(3);
    });

    it('has legs 1 and 3 pointing at the SAME event, so dedupe is testable downstream', () => {
      const [projected] = toProjectedBets(asResponse(qbsMultiLeg));
      const eventIds = projected!.bet.legs.map((leg) => leg.event.id);

      expect(eventIds).toEqual(['9201', '9202', '9201']);
      expect(new Set(eventIds).size).toBe(2);
    });

    it("keeps each leg's own market and selection distinct", () => {
      const [projected] = toProjectedBets(asResponse(qbsMultiLeg));

      expect(projected!.bet.legs[0]!.market?.name).toBe('Match Winner');
      expect(projected!.bet.legs[2]!.market?.name).toBe('Total Goals');
    });
  });

  describe('case: absent values become null rather than a coerced default', () => {
    it('maps an absent risk section to null, not to an object of zeroes', () => {
      // An object of zeroes would read as "the applied stake factor was 0", which
      // says a bet was blocked when in fact the figures are simply unavailable.
      const projected = toProjectedBet({ ids: { betId: 'b1' } } as QbsBet);

      expect(projected!.bet.appliedRisk).toBeNull();
    });

    it('maps absent individual risk figures to null while keeping the section', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        riskInfo: { stakeFactor: 0.5 }
      } as QbsBet);

      expect(projected!.bet.appliedRisk).toEqual({
        stakeFactor: 0.5,
        liabilityGroup: null,
        maxBet: null,
        maxValuePercent: null,
        cumulativeMaxPercent: null,
        overlayMaxPercent: null
      });
    });

    it('preserves a genuine zero stake factor as zero', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        riskInfo: { stakeFactor: 0 }
      } as QbsBet);

      expect(projected!.bet.appliedRisk!.stakeFactor).toBe(0);
    });

    it('maps an absent price to null rather than a half-populated fraction', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1, legPrice: { numerator: 5 } }]
      } as QbsBet);

      expect(projected!.bet.legs[0]!.price).toBeNull();
    });

    it('maps an absent placedInPlay to null, not false', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1 }]
      } as QbsBet);

      expect(projected!.bet.legs[0]!.placedInPlay).toBeNull();
    });

    it('maps an absent market or selection to null rather than a placeholder', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1, event: { name: 'E', entityIds: { rampId: '1' } } }]
      } as QbsBet);

      expect(projected!.bet.legs[0]!.market).toBeNull();
      expect(projected!.bet.legs[0]!.selection).toBeNull();
    });
  });

  describe('case: a success-carrying-errors response is projected without inventing data', () => {
    it('keeps the bet identifiers that DID arrive', () => {
      const [projected] = toProjectedBets(asResponse(qbsWithErrors));

      expect(projected!.bet.betId).toBe('bet-000222');
      expect(projected!.bet.receiptId).toBe('R-000222');
    });

    it('reports appliedRisk as null rather than fabricating figures', () => {
      const [projected] = toProjectedBets(asResponse(qbsWithErrors));

      expect(projected!.bet.appliedRisk).toBeNull();
    });

    it('reports NO legs rather than inventing them, while keeping the true leg COUNT', () => {
      // `legs` came back null but `numberOfLines.total` is 3. Reporting `legCount: 0`
      // would tell the agent the bet had no legs, which is a different and false
      // claim from "the legs could not be retrieved".
      const [projected] = toProjectedBets(asResponse(qbsWithErrors));

      expect(projected!.bet.legs).toEqual([]);
      expect(projected!.bet.legCount).toBe(3);
    });
  });

  describe('case: ordering is most-recent-first as a safeguard (FR-010, research.md R6)', () => {
    it('sorts by placement date descending after retrieval', () => {
      // The request already asks for PLACEMENT_DATE DESC. Sorting again costs nothing
      // and means an upstream that silently ignored the sort cannot make the tool's
      // ordering claim false.
      const projected = toProjectedBets(asResponse(qbsOverLimit));
      const dates = projected.map((p) => p.bet.placedAt);

      expect(dates).toEqual([...dates].sort().reverse());
      expect(dates[0]).toBe('2026-09-25T10:00:00.000Z');
    });

    it('re-sorts a deliberately out-of-order upstream response', () => {
      const projected = toProjectedBets({
        data: {
          searchBets: {
            results: [
              { ids: { betId: 'old' }, placementDate: '2026-01-01T00:00:00.000Z' },
              { ids: { betId: 'new' }, placementDate: '2026-09-01T00:00:00.000Z' }
            ]
          }
        }
      });

      expect(projected.map((p) => p.bet.betId)).toEqual(['new', 'old']);
    });
  });

  describe('case: unusable upstream entries are dropped, never guessed', () => {
    it('drops a bet with no identifier, since nothing could be done with it', () => {
      const projected = toProjectedBets({
        data: {
          searchBets: {
            results: [{ status: 'ACTIVE' }, { ids: { betId: 'b1' }, status: 'SETTLED' }]
          }
        }
      });

      expect(projected).toHaveLength(1);
      expect(projected[0]!.bet.betId).toBe('b1');
    });

    it('drops a null entry in the results array', () => {
      const projected = toProjectedBets({
        data: { searchBets: { results: [null, { ids: { betId: 'b1' } }] } }
      });

      expect(projected).toHaveLength(1);
    });

    it('returns an empty array for an absent, null, or empty response', () => {
      expect(toProjectedBets(null)).toEqual([]);
      expect(toProjectedBets(undefined)).toEqual([]);
      expect(toProjectedBets({})).toEqual([]);
      expect(toProjectedBets({ data: { searchBets: { results: [] } } })).toEqual([]);
    });

    it('falls back to the leg position when legNumber is absent', () => {
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ event: { name: 'E' } }, { event: { name: 'F' } }]
      } as QbsBet);

      expect(projected!.bet.legs.map((leg) => leg.legNumber)).toEqual([1, 2]);
    });

    it('reports an absent required entity as "unknown" with a null id, keeping the leg', () => {
      // A leg whose event is missing is still a leg the customer placed, and dropping
      // it would understate the bet. The composite's `resolution` field is what tells
      // the agent the leg cannot be matched.
      const projected = toProjectedBet({
        ids: { betId: 'b1' },
        legs: [{ legNumber: 1 }]
      } as QbsBet);

      expect(projected!.bet.legs).toHaveLength(1);
      expect(projected!.bet.legs[0]!.event).toEqual({ name: 'unknown', id: null });
    });

    it('returns null for a bet with no identifier at all', () => {
      expect(toProjectedBet(null)).toBeNull();
      expect(toProjectedBet(undefined)).toBeNull();
      expect(toProjectedBet({} as QbsBet)).toBeNull();
    });
  });

  describe('totalMatched', () => {
    it('reads the upstream total, which may exceed what was returned', () => {
      expect(totalMatched(asResponse(qbsOverLimit))).toBe(137);
      expect(totalMatched(asResponse(qbsSingle))).toBe(1);
    });

    it('returns null when upstream reported no count', () => {
      expect(totalMatched({})).toBeNull();
      expect(totalMatched({ data: { searchBets: { results: [] } } })).toBeNull();
    });
  });
});
