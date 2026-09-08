import { describe, expect, it } from 'vitest';
import { assessAgreement } from '../../src/domains/customer/agreement.js';
import type {
  AppliedRiskFigures,
  CustomerRiskConfiguration,
  LiabilityGroupRef
} from '../../src/domains/customer/schemas.js';

/**
 * The agreement verdict (User Story 3).
 *
 * Three properties, in order of how badly getting them wrong would matter:
 *
 *  1. **Both values are ALWAYS present**, even when `notComparable`. This is the guard
 *     that makes R14's unverified assumption safe — a description-vs-code mismatch
 *     shows both strings rather than being silently wrong.
 *  2. **`notComparable` is emitted for EACH of its three triggers separately** (FR-020),
 *     with a reason that says which.
 *  3. **A multi-leg bet is never comparable at all** (FR-021), because its applied
 *     figures belong to the whole bet and no per-leg setting can be said to have
 *     produced them.
 */

function liabilityGroup(
  code: string,
  description: string,
  interceptValue = 100
): LiabilityGroupRef {
  return { code, description, interceptValue };
}

function configuration(
  overrides: Partial<CustomerRiskConfiguration> = {}
): CustomerRiskConfiguration {
  return {
    jurisdiction: { code: 'NJ', id: 'ctx-us-nj', name: 'New Jersey' },
    stakeFactor: 0.5,
    inRunningDelaySeconds: null,
    liabilityGroup: liabilityGroup('LG3', 'Managed Risk'),
    eligibility: null,
    payoutLimitSingles: null,
    payoutLimitMultiples: null,
    maxWinningsCap: null,
    guaranteedMaxLimitToLose: null,
    earlySettlementRestricted: null,
    overrides: [],
    ...overrides
  };
}

function applied(overrides: Partial<AppliedRiskFigures> = {}): AppliedRiskFigures {
  return {
    stakeFactor: 0.5,
    liabilityGroup: 'Managed Risk',
    maxBet: 500,
    maxValuePercent: null,
    cumulativeMaxPercent: null,
    overlayMaxPercent: null,
    ...overrides
  };
}

describe('agreement verdicts (FR-020)', () => {
  describe('case: consistent — the configured and applied values agree', () => {
    it('reports consistent for a matching stake factor', () => {
      const [stakeFactor] = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied(),
        legCount: 1
      });

      expect(stakeFactor!.field).toBe('stakeFactor');
      expect(stakeFactor!.verdict).toBe('consistent');
      expect(stakeFactor!.configuredValue).toBe(0.5);
      expect(stakeFactor!.appliedValue).toBe(0.5);
      expect(stakeFactor!.reason).toBeNull();
    });

    it('reports consistent when the applied liability group matches the DESCRIPTION (R14)', () => {
      const [, group] = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied({ liabilityGroup: 'Managed Risk' }),
        legCount: 1
      });

      expect(group!.verdict).toBe('consistent');
      expect(group!.configuredValue).toBe('Managed Risk');
      expect(group!.appliedValue).toBe('Managed Risk');
    });

    it('reports consistent when it matches the CODE instead — the R14 fallback', () => {
      // QBS sends a bare string and nothing says whether it is the code or the
      // description. Trying both is what keeps an unexpected shape from reading as a
      // discrepancy.
      const [, group] = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied({ liabilityGroup: 'LG3' }),
        legCount: 1
      });

      expect(group!.verdict).toBe('consistent');
    });

    it('is insensitive to case and whitespace, so representation is not a discrepancy', () => {
      const [, group] = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied({ liabilityGroup: '  managed risk  ' }),
        legCount: 1
      });

      expect(group!.verdict).toBe('consistent');
    });

    it('treats a configured ZERO stake factor as comparable, and matching', () => {
      // `0` blocks a customer and is a real setting; only `null` is unset.
      const [stakeFactor] = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: 0 }),
        appliedRisk: applied({ stakeFactor: 0 }),
        legCount: 1
      });

      expect(stakeFactor!.verdict).toBe('consistent');
      expect(stakeFactor!.configuredValue).toBe(0);
    });
  });

  describe('case: differs — with BOTH values present, and no explanation offered', () => {
    it('reports differs for a mismatched stake factor, showing both', () => {
      const [stakeFactor] = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: 0.5 }),
        appliedRisk: applied({ stakeFactor: 0.25 }),
        legCount: 1
      });

      expect(stakeFactor!.verdict).toBe('differs');
      expect(stakeFactor!.configuredValue).toBe(0.5);
      expect(stakeFactor!.appliedValue).toBe(0.25);
      expect(stakeFactor!.reason).toBeNull();
    });

    it('offers NO explanation of why they differ (FR-017)', () => {
      // The derivation of an applied figure is not available to this system. The two
      // values sit side by side; the causal step is the human's.
      const verdicts = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: 0.5 }),
        appliedRisk: applied({ stakeFactor: 0.25 }),
        legCount: 1
      });

      for (const verdict of verdicts) {
        expect(JSON.stringify(verdict)).not.toMatch(/because|caused|derived|calculat/i);
      }
    });

    it('is the R14 GUARD: a description-vs-code mismatch shows both strings', () => {
      // The point of the three-valued verdict. If the applied string turns out to be
      // neither the description nor the code, an operator sees exactly what was
      // compared instead of being told a confident wrong answer.
      const [, group] = assessAgreement({
        governingConfiguration: configuration({
          liabilityGroup: liabilityGroup('LG3', 'Managed Risk')
        }),
        appliedRisk: applied({ liabilityGroup: 'Something Unexpected' }),
        legCount: 1
      });

      expect(group!.verdict).toBe('differs');
      expect(group!.configuredValue).toBe('Managed Risk');
      expect(group!.appliedValue).toBe('Something Unexpected');
      // Both visible, so the mismatch is judgeable rather than silently wrong.
      expect(group!.configuredValue).not.toBe(group!.appliedValue);
    });
  });

  describe('case: trigger 1 — the governing configuration is unresolved (FR-020)', () => {
    it('reports notComparable for both fields, naming the unresolved jurisdiction', () => {
      const verdicts = assessAgreement({
        governingConfiguration: null,
        appliedRisk: applied(),
        legCount: 1
      });

      expect(verdicts).toHaveLength(2);
      for (const verdict of verdicts) {
        expect(verdict.verdict).toBe('notComparable');
        expect(verdict.reason).toMatch(/could not be identified/i);
      }
    });

    it('still shows the APPLIED value, which is known', () => {
      // Half the comparison exists, and hiding it would lose information the operator
      // has every right to see.
      const verdicts = assessAgreement({
        governingConfiguration: null,
        appliedRisk: applied({ stakeFactor: 0.25, liabilityGroup: 'Tight' }),
        legCount: 1
      });

      expect(verdicts[0]!.appliedValue).toBe(0.25);
      expect(verdicts[0]!.configuredValue).toBeNull();
      expect(verdicts[1]!.appliedValue).toBe('Tight');
    });

    it('is checked BEFORE the value comparison, so the reason describes the right problem', () => {
      // Without this ordering, a null configured value would be reported as
      // `valueAbsent`, which points the operator at the wrong thing entirely.
      const verdicts = assessAgreement({
        governingConfiguration: null,
        appliedRisk: applied(),
        legCount: 1
      });

      expect(verdicts[0]!.reason).not.toMatch(/not present/i);
      expect(verdicts[0]!.reason).toMatch(/governing configuration/i);
    });
  });

  describe('case: trigger 2 — either value is absent (FR-020)', () => {
    it('reports notComparable when the CONFIGURED stake factor is unset', () => {
      const [stakeFactor] = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: null }),
        appliedRisk: applied(),
        legCount: 1
      });

      expect(stakeFactor!.verdict).toBe('notComparable');
      expect(stakeFactor!.reason).toMatch(/not present/i);
      expect(stakeFactor!.configuredValue).toBeNull();
      expect(stakeFactor!.appliedValue).toBe(0.5);
    });

    it('reports notComparable when the APPLIED stake factor is absent', () => {
      const [stakeFactor] = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied({ stakeFactor: null }),
        legCount: 1
      });

      expect(stakeFactor!.verdict).toBe('notComparable');
      expect(stakeFactor!.configuredValue).toBe(0.5);
      expect(stakeFactor!.appliedValue).toBeNull();
    });

    it('reports notComparable when the whole applied section is missing', () => {
      const verdicts = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: null,
        legCount: 1
      });

      for (const verdict of verdicts) {
        expect(verdict.verdict).toBe('notComparable');
        expect(verdict.reason).toMatch(/not present/i);
      }
    });

    it('reports notComparable when the configured liability group is unset', () => {
      const [, group] = assessAgreement({
        governingConfiguration: configuration({ liabilityGroup: null }),
        appliedRisk: applied(),
        legCount: 1
      });

      expect(group!.verdict).toBe('notComparable');
      expect(group!.configuredValue).toBeNull();
      expect(group!.appliedValue).toBe('Managed Risk');
    });

    it('assesses each field INDEPENDENTLY, so one absence does not hide the other', () => {
      const [stakeFactor, group] = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: null }),
        appliedRisk: applied(),
        legCount: 1
      });

      expect(stakeFactor!.verdict).toBe('notComparable');
      // The liability group IS comparable, and reporting it as notComparable too
      // would lose a genuine finding.
      expect(group!.verdict).toBe('consistent');
    });
  });

  describe('case: trigger 3 — a multi-leg bet with bet-level figures (FR-021, SC-006)', () => {
    it('reports notComparable for EVERY field on a multi-leg bet', () => {
      // A three-leg parlay has ONE set of applied figures and three legs' worth of
      // configured settings. "Consistent" would assert an attribution nobody can make.
      const verdicts = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied(),
        legCount: 3
      });

      expect(verdicts).toHaveLength(2);
      for (const verdict of verdicts) {
        expect(verdict.verdict).toBe('notComparable');
        expect(verdict.reason).toMatch(/bet-level/i);
        expect(verdict.reason).toMatch(/more than one leg/i);
      }
    });

    it('does so even when the values would have MATCHED exactly', () => {
      // The strongest form of the rule: a coincidental match on a parlay is still not
      // an attribution, and reporting `consistent` would invite exactly the causal
      // claim FR-021 exists to prevent.
      const verdicts = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: 0.5 }),
        appliedRisk: applied({ stakeFactor: 0.5, liabilityGroup: 'Managed Risk' }),
        legCount: 2
      });

      for (const verdict of verdicts) {
        expect(verdict.verdict).toBe('notComparable');
        expect(verdict.verdict).not.toBe('consistent');
      }
    });

    it('still shows BOTH values, so the operator can judge for themselves', () => {
      const verdicts = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: 0.5 }),
        appliedRisk: applied({ stakeFactor: 0.25, liabilityGroup: 'Tight' }),
        legCount: 2
      });

      expect(verdicts[0]!.configuredValue).toBe(0.5);
      expect(verdicts[0]!.appliedValue).toBe(0.25);
      expect(verdicts[1]!.configuredValue).toBe('Managed Risk');
      expect(verdicts[1]!.appliedValue).toBe('Tight');
    });

    it('compares normally for a SINGLE-leg bet', () => {
      const verdicts = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied(),
        legCount: 1
      });

      expect(verdicts.every((verdict) => verdict.verdict === 'consistent')).toBe(true);
    });
  });

  describe('case: each notComparable trigger produces a DISTINCT reason (FR-020)', () => {
    it('gives three different reasons for the three triggers', () => {
      const unresolved = assessAgreement({
        governingConfiguration: null,
        appliedRisk: applied(),
        legCount: 1
      })[0]!.reason;

      const absent = assessAgreement({
        governingConfiguration: configuration({ stakeFactor: null }),
        appliedRisk: applied(),
        legCount: 1
      })[0]!.reason;

      const multiLeg = assessAgreement({
        governingConfiguration: configuration(),
        appliedRisk: applied(),
        legCount: 2
      })[0]!.reason;

      expect(new Set([unresolved, absent, multiLeg]).size).toBe(3);
      // Each reason has to be actionable prose, not a code the agent must decode.
      for (const reason of [unresolved, absent, multiLeg]) {
        expect(reason!.length).toBeGreaterThan(20);
      }
    });
  });

  describe('case: the shape of the result is invariant', () => {
    it('ALWAYS returns one verdict per comparable field, never a filtered list', () => {
      // An absent verdict would leave the agent to infer why, and inference is what
      // this function exists to replace.
      for (const input of [
        { governingConfiguration: configuration(), appliedRisk: applied(), legCount: 1 },
        { governingConfiguration: null, appliedRisk: applied(), legCount: 1 },
        { governingConfiguration: configuration(), appliedRisk: null, legCount: 1 },
        { governingConfiguration: configuration(), appliedRisk: applied(), legCount: 5 }
      ]) {
        const verdicts = assessAgreement(input);

        expect(verdicts).toHaveLength(2);
        expect(verdicts.map((verdict) => verdict.field)).toEqual(['stakeFactor', 'liabilityGroup']);
      }
    });

    it('sets reason iff the verdict is notComparable', () => {
      for (const input of [
        { governingConfiguration: configuration(), appliedRisk: applied(), legCount: 1 },
        { governingConfiguration: null, appliedRisk: applied(), legCount: 1 },
        { governingConfiguration: configuration(), appliedRisk: applied(), legCount: 3 }
      ]) {
        for (const verdict of assessAgreement(input)) {
          expect(verdict.reason === null).toBe(verdict.verdict !== 'notComparable');
        }
      }
    });

    it('is PURE — same arguments, same verdicts', () => {
      const input = {
        governingConfiguration: configuration(),
        appliedRisk: applied(),
        legCount: 1
      };

      expect(assessAgreement(input)).toEqual(assessAgreement(input));
    });
  });
});
