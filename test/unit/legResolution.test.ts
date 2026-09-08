import { describe, expect, it } from 'vitest';
import type { EntityIdSource } from '../../src/domains/customer/mapping/betProjection.js';
import {
  hasUnresolvedLegs,
  planEventResolutions,
  resolveLegs,
  type EventResolutions,
  type ResolvedEvent
} from '../../src/domains/customer/legResolution.js';
import type {
  BetLeg,
  CataloguePathNode,
  HierarchyOverride
} from '../../src/domains/customer/schemas.js';

/**
 * Leg resolution (User Story 3).
 *
 * Three properties, each of which would be a wrong answer about a customer's trading
 * restrictions if broken:
 *
 *  1. A distinct event is resolved ONCE (SC-013).
 *  2. Reaching the bound NAMES the unresolved legs (FR-023) rather than truncating.
 *  3. An empty `overridesInScope` is never readable as "unrestricted" — `resolution` is
 *     what distinguishes "no override covers this" from "nothing is known".
 */

function leg(legNumber: number, eventId: string | null, eventName = `Event ${legNumber}`): BetLeg {
  return {
    legNumber,
    sport: { name: 'Football', id: 'sport-1' },
    competition: { name: 'Premier League', id: 'comp-1' },
    event: { name: eventName, id: eventId },
    market: { name: 'Match Winner', id: 'market-1' },
    selection: { name: 'Team A', id: 'selection-1' },
    placedInPlay: false,
    price: { numerator: 2, denominator: 1 },
    result: 'NONE'
  };
}

const SOCCER: CataloguePathNode = {
  level: 'SUPERCLASS',
  id: 'urn:sc:soccer',
  name: 'Soccer'
};
const MATCHES: CataloguePathNode = {
  level: 'SUBCLASS',
  id: 'urn:sub:matches',
  name: '|Football Matches|'
};
const WINNER: CataloguePathNode = {
  level: 'EVENT_TYPE',
  id: 'urn:et:winner',
  name: 'Match Winner'
};
const TENNIS: CataloguePathNode = {
  level: 'SUPERCLASS',
  id: 'urn:sc:tennis',
  name: 'Tennis'
};

const SOCCER_PATH: CataloguePathNode[] = [SOCCER, MATCHES, WINNER];

function override(
  level: HierarchyOverride['level'],
  entityId: string,
  stakeFactor: number | null = 0.25
): HierarchyOverride {
  return { level, entityId, path: [], stakeFactor, liabilityGroup: null };
}

function resolutions(overrides: Partial<EventResolutions> = {}): EventResolutions {
  return {
    resolved: new Map<string, ResolvedEvent>(),
    failed: new Set<string>(),
    notAttempted: new Set<string>(),
    ...overrides
  };
}

const sources = (entries: [number, EntityIdSource][]) => new Map(entries);

describe('leg resolution', () => {
  describe('case: a distinct event is resolved ONCE, however many legs use it (SC-013)', () => {
    it('plans two lookups for a three-leg bet where two legs share one event', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B'), leg(3, 'event-A')];

      const { toResolve, beyondBound } = planEventResolutions(legs, 10);

      expect(toResolve).toEqual(['event-A', 'event-B']);
      expect(beyondBound).toEqual([]);
    });

    it('plans one lookup when every leg is on the same event', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-A'), leg(3, 'event-A'), leg(4, 'event-A')];

      expect(planEventResolutions(legs, 10).toResolve).toEqual(['event-A']);
    });

    it('preserves first-seen order, so lookups are deterministic', () => {
      const legs = [leg(1, 'event-C'), leg(2, 'event-A'), leg(3, 'event-B')];

      expect(planEventResolutions(legs, 10).toResolve).toEqual(['event-C', 'event-A', 'event-B']);
    });

    it('attaches ONE resolved event to BOTH legs that reference it', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-A')];
      const resolved = resolveLegs({
        legs,
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(resolved.map((one) => one.resolution)).toEqual(['resolved', 'resolved']);
      expect(resolved[0]!.cataloguePath).toEqual(SOCCER_PATH);
      expect(resolved[1]!.cataloguePath).toEqual(SOCCER_PATH);
    });
  });

  describe('case: DEDUPE happens BEFORE the bound is applied', () => {
    it('spends one budget unit on a shared event, not two', () => {
      // The only ordering that makes sense: a bound of 2 on a three-leg bet needing
      // two distinct lookups must fit. Applying the bound first would exhaust it.
      const legs = [leg(1, 'event-A'), leg(2, 'event-A'), leg(3, 'event-B')];

      const { toResolve, beyondBound } = planEventResolutions(legs, 2);

      expect(toResolve).toEqual(['event-A', 'event-B']);
      expect(beyondBound).toEqual([]);
    });

    it('spends NO budget on a leg with no usable identifier', () => {
      // It cannot be looked up, so spending a unit on it would deny a resolvable leg
      // its lookup — turning one unusable leg into two unresolved ones.
      const legs = [leg(1, null), leg(2, 'event-A'), leg(3, 'event-B')];

      expect(planEventResolutions(legs, 2).toResolve).toEqual(['event-A', 'event-B']);
    });
  });

  describe('case: the bound is REPORTED, never silently truncating (FR-023)', () => {
    it('places events beyond the bound in beyondBound rather than dropping them', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B'), leg(3, 'event-C')];

      const { toResolve, beyondBound } = planEventResolutions(legs, 2);

      expect(toResolve).toEqual(['event-A', 'event-B']);
      expect(beyondBound).toEqual(['event-C']);
    });

    it('marks the affected leg notAttemptedBoundReached, naming it', () => {
      // Silent truncation would be worse here than usual: a dropped leg reads as a leg
      // with no restrictions.
      const legs = [leg(1, 'event-A'), leg(2, 'event-B')];
      const resolved = resolveLegs({
        legs,
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]]),
          notAttempted: new Set(['event-B'])
        }),
        overrides: [override('SUPERCLASS', 'urn:sc:soccer')]
      });

      expect(resolved[0]!.resolution).toBe('resolved');
      expect(resolved[1]!.resolution).toBe('notAttemptedBoundReached');
      expect(resolved[1]!.legNumber).toBe(2);
    });

    it("keeps the RESOLVED legs' findings when the bound cut off later ones", () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B')];
      const resolved = resolveLegs({
        legs,
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]]),
          notAttempted: new Set(['event-B'])
        }),
        overrides: [override('SUPERCLASS', 'urn:sc:soccer')]
      });

      expect(resolved[0]!.overridesInScope).toHaveLength(1);
      expect(resolved[1]!.overridesInScope).toHaveLength(0);
    });

    it('reports resolvedVia for a bound-reached leg, since its identifier WAS usable', () => {
      // The distinction between "we did not spend a lookup on it" and "it had nothing
      // to look up" — which is exactly what separates this outcome from
      // notResolvedIdentifierUnusable.
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'gbpId']]),
        resolutions: resolutions({ notAttempted: new Set(['event-A']) }),
        overrides: []
      });

      expect(resolved[0]!.resolution).toBe('notAttemptedBoundReached');
      expect(resolved[0]!.resolvedVia).toBe('gbpId');
    });

    it('counts a bound-reached leg as unresolved, so the caller flags the section', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({ notAttempted: new Set(['event-A']) }),
        overrides: []
      });

      expect(hasUnresolvedLegs(resolved)).toBe(true);
    });
  });

  describe('case: all FOUR resolution outcomes are produced and kept distinct', () => {
    it('produces every one of the four values', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B'), leg(3, null), leg(4, 'event-D')];
      const resolved = resolveLegs({
        legs,
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId'],
          [4, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]]),
          failed: new Set(['event-B']),
          notAttempted: new Set(['event-D'])
        }),
        overrides: []
      });

      expect(resolved.map((one) => one.resolution)).toEqual([
        'resolved',
        'notResolvedUpstreamFailure',
        'notResolvedIdentifierUnusable',
        'notAttemptedBoundReached'
      ]);
    });

    it('keeps notResolvedIdentifierUnusable SEPARATE from an upstream failure', () => {
      // THE R9 visibility property. If the assumption about which `entityIds` member is
      // the event id is wrong, EVERY leg lands in `notResolvedIdentifierUnusable` — a
      // systematic defect that is immediately obvious. An `upstream` bucket would hide
      // it among ordinary transient failures.
      const legs = [leg(1, null), leg(2, null), leg(3, null)];
      const resolved = resolveLegs({
        legs,
        eventIdSources: new Map(),
        resolutions: resolutions(),
        overrides: []
      });

      expect(resolved.every((one) => one.resolution === 'notResolvedIdentifierUnusable')).toBe(
        true
      );
      expect(resolved.some((one) => one.resolution === 'notResolvedUpstreamFailure')).toBe(false);
    });

    it('reports resolvedVia as null for an unusable identifier', () => {
      const resolved = resolveLegs({
        legs: [leg(1, null)],
        eventIdSources: new Map(),
        resolutions: resolutions(),
        overrides: []
      });

      expect(resolved[0]!.resolvedVia).toBeNull();
    });

    it('treats an event that is neither resolved nor failed nor deferred as a failure', () => {
      // The caller's bookkeeping is incomplete. Reporting an upstream failure is the
      // honest reading: we do not have the position, and must not imply that no
      // override applies.
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions(),
        overrides: []
      });

      expect(resolved[0]!.resolution).toBe('notResolvedUpstreamFailure');
      expect(resolved[0]!.cataloguePath).toBeNull();
    });
  });

  describe("case: resolvedVia reports which entityIds member worked — R9's closure evidence", () => {
    it('reports rampId when that is what supplied the identifier', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(resolved[0]!.resolvedVia).toBe('rampId');
    });

    it('reports gbpId when the fallback supplied it', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'gbpId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(resolved[0]!.resolvedVia).toBe('gbpId');
    });

    it('is a field LEVEL, never an identifier value, so it carries no personal datum', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(['rampId', 'gbpId', null]).toContain(resolved[0]!.resolvedVia);
      expect(resolved[0]!.resolvedVia).not.toBe('event-A');
    });

    it('reports per leg, so a mixed bet shows which member worked where', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A'), leg(2, 'event-B')],
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'gbpId']
        ]),
        resolutions: resolutions({
          resolved: new Map([
            ['event-A', { cataloguePath: SOCCER_PATH }],
            ['event-B', { cataloguePath: SOCCER_PATH }]
          ])
        }),
        overrides: []
      });

      expect(resolved.map((one) => one.resolvedVia)).toEqual(['rampId', 'gbpId']);
    });
  });

  describe('case: an override covering several legs appears on EACH of them (FR-019)', () => {
    it('duplicates a superclass override onto every soccer leg', () => {
      // Duplicated deliberately. A normalised list plus per-leg references would be
      // smaller and would require the model to perform a join to answer "is this leg
      // restricted?" — and a model doing a join in-context is a model that gets it wrong.
      const soccerOverride = override('SUPERCLASS', 'urn:sc:soccer');
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A'), leg(2, 'event-B')],
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([
            ['event-A', { cataloguePath: SOCCER_PATH }],
            ['event-B', { cataloguePath: SOCCER_PATH }]
          ])
        }),
        overrides: [soccerOverride]
      });

      expect(resolved[0]!.overridesInScope).toEqual([soccerOverride]);
      expect(resolved[1]!.overridesInScope).toEqual([soccerOverride]);
    });

    it("matches an override at ANY level of the leg's path", () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: [
          override('SUPERCLASS', 'urn:sc:soccer'),
          override('SUBCLASS', 'urn:sub:matches'),
          override('EVENT_TYPE', 'urn:et:winner')
        ]
      });

      expect(resolved[0]!.overridesInScope).toHaveLength(3);
    });

    it('does NOT attach an override for a different sport', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: [override('SUPERCLASS', 'urn:sc:tennis')]
      });

      expect(resolved[0]!.overridesInScope).toEqual([]);
    });

    it('requires the LEVEL to agree, not just the identifier', () => {
      // An override whose level disagrees with the node it matched indicates upstream
      // data we do not understand, and silently accepting it would attribute a
      // restriction to a position it may not apply to.
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: [override('EVENT_TYPE', 'urn:sc:soccer')]
      });

      expect(resolved[0]!.overridesInScope).toEqual([]);
    });

    it('attaches only the overrides relevant to EACH leg when they differ', () => {
      const soccerOverride = override('SUPERCLASS', 'urn:sc:soccer');
      const tennisOverride = override('SUPERCLASS', 'urn:sc:tennis');
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A'), leg(2, 'event-B')],
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([
            ['event-A', { cataloguePath: SOCCER_PATH }],
            ['event-B', { cataloguePath: [TENNIS] }]
          ])
        }),
        overrides: [soccerOverride, tennisOverride]
      });

      expect(resolved[0]!.overridesInScope).toEqual([soccerOverride]);
      expect(resolved[1]!.overridesInScope).toEqual([tennisOverride]);
    });
  });

  describe('case: an EMPTY overridesInScope is never readable as "unrestricted"', () => {
    it('is empty on a RESOLVED leg to mean "no override covers this position"', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(resolved[0]!.overridesInScope).toEqual([]);
      // The `resolution` field is what makes this readable as a complete statement.
      expect(resolved[0]!.resolution).toBe('resolved');
      expect(resolved[0]!.cataloguePath).not.toBeNull();
    });

    it('is empty on an UNRESOLVED leg to mean "nothing is known"', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({ failed: new Set(['event-A']) }),
        overrides: [override('SUPERCLASS', 'urn:sc:soccer')]
      });

      expect(resolved[0]!.overridesInScope).toEqual([]);
      // Same empty list, opposite meaning — and `resolution` plus a null path are the
      // two signals that distinguish them.
      expect(resolved[0]!.resolution).toBe('notResolvedUpstreamFailure');
      expect(resolved[0]!.cataloguePath).toBeNull();
    });

    it('always carries a resolution, so the two cases are never ambiguous', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B'), leg(3, null)];
      const resolved = resolveLegs({
        legs,
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]]),
          failed: new Set(['event-B'])
        }),
        overrides: []
      });

      for (const one of resolved) {
        expect(one.resolution).toBeDefined();
        expect(typeof one.resolution).toBe('string');
      }
    });
  });

  describe('hasUnresolvedLegs', () => {
    it('is false when every leg resolved', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]])
        }),
        overrides: []
      });

      expect(hasUnresolvedLegs(resolved)).toBe(false);
    });

    it.each([
      ['an upstream failure', resolutions({ failed: new Set(['event-A']) })],
      ['the bound reached', resolutions({ notAttempted: new Set(['event-A']) })]
    ])('is true for %s', (_label, given) => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A')],
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: given,
        overrides: []
      });

      expect(hasUnresolvedLegs(resolved)).toBe(true);
    });

    it('is true when ONE leg of several is unresolved', () => {
      const resolved = resolveLegs({
        legs: [leg(1, 'event-A'), leg(2, 'event-B')],
        eventIdSources: sources([
          [1, 'rampId'],
          [2, 'rampId']
        ]),
        resolutions: resolutions({
          resolved: new Map([['event-A', { cataloguePath: SOCCER_PATH }]]),
          failed: new Set(['event-B'])
        }),
        overrides: []
      });

      expect(hasUnresolvedLegs(resolved)).toBe(true);
    });

    it('is false for a bet with no legs at all', () => {
      expect(hasUnresolvedLegs([])).toBe(false);
    });
  });

  describe('case: the module is PURE and performs no I/O', () => {
    it('plans the same lookups for the same legs', () => {
      const legs = [leg(1, 'event-A'), leg(2, 'event-B')];

      expect(planEventResolutions(legs, 5)).toEqual(planEventResolutions(legs, 5));
    });

    it('mutates neither the legs nor the resolutions it is given', () => {
      const legs = [leg(1, 'event-A')];
      const resolved = new Map([['event-A', { cataloguePath: SOCCER_PATH }]]);

      resolveLegs({
        legs,
        eventIdSources: sources([[1, 'rampId']]),
        resolutions: resolutions({ resolved }),
        overrides: []
      });

      expect(legs).toHaveLength(1);
      expect(resolved.size).toBe(1);
      expect(SOCCER_PATH).toEqual([SOCCER, MATCHES, WINNER]);
    });
  });
});
