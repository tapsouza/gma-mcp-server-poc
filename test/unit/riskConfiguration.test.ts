import { describe, expect, it } from 'vitest';
import {
  toRiskConfigurations,
  unresolvedJurisdiction,
  type CrsAccountRiskSettings
} from '../../src/domains/customer/mapping/riskConfiguration.js';

import crsThree from '../fixtures/gma/crsAccounts/200-three-jurisdictions.json' with { type: 'json' };
import crsEmptyPath from '../fixtures/gma/crsAccounts/200-override-empty-path.json' with { type: 'json' };
import crsNulls from '../fixtures/gma/crsAccounts/200-nulls.json' with { type: 'json' };

/**
 * The CRS mapping (User Story 1).
 *
 * Tested as a pure function rather than through HTTP, because every decision here is
 * one this feature could get *confidently wrong* about a real customer's money:
 * merging jurisdictions, coercing an absent value to zero, or fabricating a catalogue
 * name. None of those would throw — they would produce a plausible wrong answer.
 */

const asSettings = (fixture: unknown) => fixture as CrsAccountRiskSettings;

describe('CRS risk-configuration mapping', () => {
  describe('case: three jurisdictions map to three configurations, nothing merged (FR-006, SC-003)', () => {
    it('returns exactly one configuration per jurisdiction, in upstream order', () => {
      const configurations = toRiskConfigurations(asSettings(crsThree));

      expect(configurations).toHaveLength(3);
      expect(configurations.map((c) => c.jurisdiction.id)).toEqual([
        'ctx-us-nj',
        'ctx-us-pa',
        'ctx-us-co'
      ]);
    });

    it("keeps each jurisdiction's DIFFERENT settings distinct, with nothing averaged", () => {
      // The fixture is built so that a merge would be visible: NJ is restricted
      // (0.5), PA is standard (1.0), CO is loosened (2.0). Any collapse — mean,
      // most-restrictive-wins, first-wins — produces a number true of no
      // jurisdiction the customer actually bets in.
      const [nj, pa, co] = toRiskConfigurations(asSettings(crsThree));

      expect(nj!.stakeFactor).toBe(0.5);
      expect(pa!.stakeFactor).toBe(1.0);
      expect(co!.stakeFactor).toBe(2.0);

      expect(nj!.eligibility).toBe('RESTRICTED');
      expect(pa!.eligibility).toBe('STANDARD');
      expect(co!.eligibility).toBe('UNRESTRICTED');

      // And the arithmetic mean (1.1667) appears nowhere.
      const stakeFactors = [nj!.stakeFactor, pa!.stakeFactor, co!.stakeFactor];
      expect(stakeFactors).toEqual([0.5, 1, 2]);
    });

    it('keeps overrides on the jurisdiction they belong to, never pooled across them', () => {
      const [nj, pa, co] = toRiskConfigurations(asSettings(crsThree));

      expect(nj!.overrides).toHaveLength(4);
      expect(pa!.overrides).toHaveLength(0);
      expect(co!.overrides).toHaveLength(1);
      // Tennis is CO's alone; seeing it under NJ would mean overrides were pooled.
      expect(co!.overrides[0]!.entityId).toBe('urn:sc:tennis');
      expect(nj!.overrides.map((o) => o.entityId)).not.toContain('urn:sc:tennis');
    });

    it('translates every upstream field name at this boundary (Principle IV)', () => {
      const serialised = JSON.stringify(toRiskConfigurations(asSettings(crsThree)));

      for (const upstreamName of [
        'contextId',
        'hierarchyGroups',
        'birDelay',
        'gpEligibility',
        'gmltl',
        'gpPayoutLimitSingles',
        'gpPayoutLimitMultiples',
        'entityType',
        'entityName',
        'displayOrder',
        'colour'
      ]) {
        expect(serialised, `upstream name "${upstreamName}" leaked`).not.toContain(upstreamName);
      }
    });

    it('renames each upstream field to the project vocabulary', () => {
      const [nj] = toRiskConfigurations(asSettings(crsThree));

      expect(nj!.inRunningDelaySeconds).toBe(8);
      expect(nj!.guaranteedMaxLimitToLose).toBe(true);
      expect(nj!.payoutLimitSingles).toBe(10000);
      expect(nj!.payoutLimitMultiples).toBe(25000);
      expect(nj!.maxWinningsCap).toBe(50000);
      expect(nj!.earlySettlementRestricted).toBe(true);
    });

    it('drops the presentation-only liability-group members', () => {
      const [nj] = toRiskConfigurations(asSettings(crsThree));

      expect(nj!.liabilityGroup).toEqual({
        code: 'LG3',
        description: 'Managed Risk',
        interceptValue: 250
      });
      expect(Object.keys(nj!.liabilityGroup!).sort()).toEqual([
        'code',
        'description',
        'interceptValue'
      ]);
    });
  });

  describe('case: staff-authored notes and staff names never survive the mapping (FR-004, Principle V)', () => {
    it('drops customerNotes entirely', () => {
      // FR-004 excludes staff-authored notes about customers from this slice. The
      // upstream response carries a `customerNotes` summary; it stops here.
      const serialised = JSON.stringify(toRiskConfigurations(asSettings(crsThree)));

      expect(serialised).not.toContain('customerNotes');
      expect(serialised).not.toContain('hasNotes');
    });

    it('drops the nickname block, which NAMES MEMBERS OF STAFF', () => {
      // `nickname.creatorName` and `updaterName` are people. Principle V's rule is
      // about customers, but a tool schema is no place for staff names either, and
      // the nickname itself is a customer datum.
      const serialised = JSON.stringify(toRiskConfigurations(asSettings(crsThree)));

      expect(serialised).not.toContain('nickname');
      expect(serialised).not.toContain('creatorName');
      expect(serialised).not.toContain('updaterName');
      expect(serialised).not.toContain('A Staff Member');
      expect(serialised).not.toContain('Another Staff Member');
    });
  });

  describe('case: an override path is BROADEST-FIRST, matching the catalogue domain (FR-007)', () => {
    it('reverses the upstream specific-to-broad ordering for a MARKET_TYPE override', () => {
      // GMA fills `metadata.entities` specific-first. The catalogue domain documents
      // its `ancestors` as "broadest to nearest parent", and a model reading two
      // orderings from one server will get one of them wrong.
      const [nj] = toRiskConfigurations(asSettings(crsThree));
      const marketType = nj!.overrides.find((o) => o.level === 'MARKET_TYPE');

      expect(marketType!.path.map((node) => node.level)).toEqual([
        'SUPERCLASS',
        'SUBCLASS',
        'EVENT_TYPE',
        'MARKET_TYPE'
      ]);
      expect(marketType!.path.map((node) => node.name)).toEqual([
        'Football',
        'Premier League',
        'Match Winner',
        'Correct Score'
      ]);
    });

    it('carries the named path at every level GMA enriches', () => {
      const [nj] = toRiskConfigurations(asSettings(crsThree));

      const byLevel = new Map(nj!.overrides.map((o) => [o.level, o]));
      expect(byLevel.get('SUPERCLASS')!.path.map((n) => n.name)).toEqual(['Football']);
      expect(byLevel.get('SUBCLASS')!.path.map((n) => n.name)).toEqual([
        'Football',
        'Premier League'
      ]);
      expect(byLevel.get('EVENT_TYPE')!.path.map((n) => n.name)).toEqual([
        'Football',
        'Premier League',
        'Match Winner'
      ]);
    });

    it('carries the overriding values, which differ from the jurisdiction defaults', () => {
      const [nj] = toRiskConfigurations(asSettings(crsThree));
      const superclass = nj!.overrides.find((o) => o.level === 'SUPERCLASS');

      expect(nj!.stakeFactor).toBe(0.5);
      expect(superclass!.stakeFactor).toBe(0.25);
      expect(superclass!.liabilityGroup).toEqual({
        code: 'LG5',
        description: 'Tight',
        interceptValue: 100
      });
    });
  });

  describe('case: an EMPTY path keeps entityId and fabricates NO name', () => {
    it('yields an empty path with the identifier intact', () => {
      // `createHierarchyGroupMetadataEntities` returns `List.of()` when the id
      // matches nothing in the catalogue. That is a real state, and inventing a name
      // for it would tell an operator the override applies to something it does not.
      const [nj] = toRiskConfigurations(asSettings(crsEmptyPath));
      const override = nj!.overrides[0]!;

      expect(override.path).toEqual([]);
      expect(override.entityId).toBe('urn:sub:unknown-to-catalogue');
      expect(override.level).toBe('SUBCLASS');
    });

    it('still reports the overriding values, so the override is not silently useless', () => {
      const [nj] = toRiskConfigurations(asSettings(crsEmptyPath));
      const override = nj!.overrides[0]!;

      expect(override.stakeFactor).toBe(0.3);
      expect(override.liabilityGroup?.code).toBe('LG4');
    });
  });

  describe('case: an absent boxed scalar becomes null, NEVER zero', () => {
    it('maps every absent numeric setting to null', () => {
      // The upstream types are boxed (`Float`, `Integer`, `Boolean`), so any of them
      // may be absent. A stake factor of ZERO blocks a customer; an UNSET one does
      // not. `?? 0` anywhere in the mapper would report an unconfigured customer as
      // blocked — a confidently-wrong answer about their money.
      const [nj] = toRiskConfigurations(asSettings(crsNulls));

      expect(nj!.stakeFactor).toBeNull();
      expect(nj!.inRunningDelaySeconds).toBeNull();
      expect(nj!.payoutLimitSingles).toBeNull();
      expect(nj!.payoutLimitMultiples).toBeNull();
      expect(nj!.maxWinningsCap).toBeNull();

      expect(nj!.stakeFactor).not.toBe(0);
      expect(nj!.inRunningDelaySeconds).not.toBe(0);
    });

    it('maps an absent boolean to null rather than false', () => {
      // Same trap, different type: `false` is a decision, `null` is its absence.
      const [nj] = toRiskConfigurations(asSettings(crsNulls));

      expect(nj!.guaranteedMaxLimitToLose).toBeNull();
      expect(nj!.earlySettlementRestricted).toBeNull();
      expect(nj!.guaranteedMaxLimitToLose).not.toBe(false);
    });

    it('maps an absent liability group and eligibility to null', () => {
      const [nj] = toRiskConfigurations(asSettings(crsNulls));

      expect(nj!.liabilityGroup).toBeNull();
      expect(nj!.eligibility).toBeNull();
    });

    it('preserves a genuine ZERO as zero, so the distinction runs both ways', () => {
      const configurations = toRiskConfigurations({
        contexts: [{ contextId: 'ctx-us-nj', stakeFactor: 0, birDelay: 0, gmltl: false }]
      });

      expect(configurations[0]!.stakeFactor).toBe(0);
      expect(configurations[0]!.inRunningDelaySeconds).toBe(0);
      expect(configurations[0]!.guaranteedMaxLimitToLose).toBe(false);
    });

    it('yields an empty override list rather than null when hierarchyGroups is absent', () => {
      const [nj] = toRiskConfigurations(asSettings(crsNulls));

      // An empty array is safe to iterate and reads as "no override"; a null would
      // make every consumer branch, and one of them would forget.
      expect(nj!.overrides).toEqual([]);
    });

    it('rejects a non-finite number rather than passing NaN into the result', () => {
      const configurations = toRiskConfigurations({
        contexts: [{ contextId: 'ctx-us-nj', stakeFactor: Number.NaN }]
      });

      expect(configurations[0]!.stakeFactor).toBeNull();
    });
  });

  describe('case: unusable upstream entries are dropped, never guessed', () => {
    it('drops a context with no identifier', () => {
      const configurations = toRiskConfigurations({
        contexts: [{ stakeFactor: 0.5 }, { contextId: 'ctx-us-nj', stakeFactor: 1 }]
      });

      expect(configurations).toHaveLength(1);
      expect(configurations[0]!.jurisdiction.id).toBe('ctx-us-nj');
    });

    it('drops an override whose level is not one of the four risk levels', () => {
      // A level this server does not understand cannot be matched against a leg's
      // catalogue position, so reporting it would imply a comparison we cannot make.
      const configurations = toRiskConfigurations({
        contexts: [
          {
            contextId: 'ctx-us-nj',
            hierarchyGroups: [
              { entityType: 'SELECTION', entityId: 'urn:sel:1', stakeFactor: 0.1 },
              { entityType: 'SUPERCLASS', entityId: 'urn:sc:football', stakeFactor: 0.2 }
            ]
          }
        ]
      });

      expect(configurations[0]!.overrides).toHaveLength(1);
      expect(configurations[0]!.overrides[0]!.level).toBe('SUPERCLASS');
    });

    it('drops an override with no entity identifier', () => {
      const configurations = toRiskConfigurations({
        contexts: [
          {
            contextId: 'ctx-us-nj',
            hierarchyGroups: [{ entityType: 'SUPERCLASS', stakeFactor: 0.1 }]
          }
        ]
      });

      expect(configurations[0]!.overrides).toEqual([]);
    });

    it('drops a path node with an unrecognised level while keeping the rest of the path', () => {
      const configurations = toRiskConfigurations({
        contexts: [
          {
            contextId: 'ctx-us-nj',
            hierarchyGroups: [
              {
                entityType: 'SUBCLASS',
                entityId: 'urn:sub:pl',
                metadata: {
                  entities: [
                    {
                      entityType: 'SUBCLASS',
                      entityId: 'urn:sub:pl',
                      entityName: 'Premier League'
                    },
                    { entityType: 'MYSTERY', entityId: 'urn:x:1', entityName: 'Unknown' },
                    { entityType: 'SUPERCLASS', entityId: 'urn:sc:f', entityName: 'Football' }
                  ]
                }
              }
            ]
          }
        ]
      });

      expect(configurations[0]!.overrides[0]!.path.map((n) => n.name)).toEqual([
        'Football',
        'Premier League'
      ]);
    });

    it('drops a liability group with no code, since it could never be compared', () => {
      const configurations = toRiskConfigurations({
        contexts: [
          { contextId: 'ctx-us-nj', liabilityGroup: { description: 'Nameless', interceptValue: 1 } }
        ]
      });

      expect(configurations[0]!.liabilityGroup).toBeNull();
    });

    it('falls back to the code when a liability group has no description', () => {
      const configurations = toRiskConfigurations({
        contexts: [{ contextId: 'ctx-us-nj', liabilityGroup: { code: 'LG9' } }]
      });

      expect(configurations[0]!.liabilityGroup).toEqual({
        code: 'LG9',
        description: 'LG9',
        interceptValue: 0
      });
    });

    it('falls back to the entity id when a path node has no name', () => {
      const configurations = toRiskConfigurations({
        contexts: [
          {
            contextId: 'ctx-us-nj',
            hierarchyGroups: [
              {
                entityType: 'SUPERCLASS',
                entityId: 'urn:sc:f',
                metadata: { entities: [{ entityType: 'SUPERCLASS', entityId: 'urn:sc:f' }] }
              }
            ]
          }
        ]
      });

      expect(configurations[0]!.overrides[0]!.path[0]!.name).toBe('urn:sc:f');
    });

    it('returns an empty list for an absent, null, or empty response', () => {
      expect(toRiskConfigurations(null)).toEqual([]);
      expect(toRiskConfigurations(undefined)).toEqual([]);
      expect(toRiskConfigurations({})).toEqual([]);
      expect(toRiskConfigurations({ contexts: [] })).toEqual([]);
    });
  });

  describe('case: jurisdiction enrichment is a parameter, so the mapper stays pure', () => {
    it('falls back to the identifier for code and name when nothing resolves it', () => {
      // Honest rather than pretty: it says "this is the jurisdiction and I have no
      // friendlier name for it" instead of inventing one.
      expect(unresolvedJurisdiction('ctx-us-nj')).toEqual({
        code: 'ctx-us-nj',
        id: 'ctx-us-nj',
        name: 'ctx-us-nj'
      });
    });

    it('uses a supplied resolver when the caller has the platform context list', () => {
      const configurations = toRiskConfigurations(asSettings(crsThree), (contextId) => ({
        code: contextId === 'ctx-us-nj' ? 'NJ' : 'XX',
        id: contextId,
        name: contextId === 'ctx-us-nj' ? 'New Jersey' : 'Unknown'
      }));

      expect(configurations[0]!.jurisdiction).toEqual({
        code: 'NJ',
        id: 'ctx-us-nj',
        name: 'New Jersey'
      });
    });

    it('performs no I/O — it is a function of its arguments alone', () => {
      // Called twice with the same input, it returns the same output, and there is
      // no client parameter through which a hop could be made.
      const first = toRiskConfigurations(asSettings(crsThree));
      const second = toRiskConfigurations(asSettings(crsThree));

      expect(first).toEqual(second);
      expect(toRiskConfigurations.length).toBeLessThanOrEqual(2);
    });
  });
});
