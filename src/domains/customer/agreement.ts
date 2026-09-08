import type { AppliedRiskFigures, CustomerRiskConfiguration } from './schemas.js';

/**
 * The three-valued agreement verdict (FR-020, data-model.md section 9).
 *
 * PURE. Places one CONFIGURED value beside its APPLIED counterpart and says whether
 * they agree. What it deliberately does NOT do is explain how the applied value was
 * reached: that formula lives in GMA's downstream pricing and risk engine and is not
 * exposed to this system (FR-017). Applied and configured sit side by side; the causal
 * step is the human's.
 *
 * ## `notComparable` is the DEFAULT, not an error path
 *
 * It is emitted whenever ANY of three conditions holds — a whitelist of comparability
 * rather than a blacklist of problems:
 *
 *   1. The governing configuration is unresolved (the jurisdiction did not match).
 *   2. Either value is absent.
 *   3. The bet has more than one leg and the applied value is bet-level (FR-021).
 *
 * Condition 3 is the one an implementation is most tempted to skip. A three-leg parlay
 * has ONE set of applied figures and THREE legs' worth of configured settings, so
 * "consistent" would be a claim about an attribution nobody can make. Reporting
 * `differs` would be worse still: it would suggest a discrepancy where there is only
 * an unanswerable question.
 *
 * ## Both values are ALWAYS present in the payload
 *
 * Even when `notComparable`. That is what makes R14's unverified assumption safe: QBS
 * sends `riskInfo.liabilityGroup` as a bare string and nothing says whether it
 * corresponds to a configured group's `code` or its `description`. So the comparison
 * tries `description`, then `code`, and when neither matches it reports `differs` WITH
 * BOTH STRINGS VISIBLE — an operator can then see what was compared and judge for
 * themselves, rather than being told a wrong answer confidently.
 */

/** Which fields are comparable at all. Deliberately short — see FR-017. */
export type ComparableField = 'stakeFactor' | 'liabilityGroup';

export type Verdict = 'consistent' | 'differs' | 'notComparable';

export interface AgreementVerdict {
  readonly field: ComparableField;
  readonly verdict: Verdict;
  readonly configuredValue: string | number | null;
  readonly appliedValue: string | number | null;
  /** Why the comparison could not be made. Present IFF `notComparable`. */
  readonly reason: string | null;
}

/** The three reasons a comparison cannot be made, as prose an agent can relay. */
const REASONS = Object.freeze({
  unresolvedJurisdiction:
    'The governing configuration could not be identified, so there is no configured value to compare against.',
  valueAbsent: 'One of the two values is not present, so there is nothing to compare.',
  betLevelMultiLeg:
    "The applied figures are bet-level and this bet has more than one leg, so they cannot be attributed to any single leg's configured settings."
});

function notComparable(
  field: ComparableField,
  configuredValue: string | number | null,
  appliedValue: string | number | null,
  reason: string
): AgreementVerdict {
  // Both values are carried even here, deliberately: an operator seeing
  // `notComparable` with the two values in front of them can judge for themselves,
  // which is the guard that makes an unverified assumption safe.
  return { field, verdict: 'notComparable', configuredValue, appliedValue, reason };
}

/**
 * Compare the stake factor.
 *
 * A numeric comparison, so no R14-style ambiguity arises — but note that `0` is a
 * legitimate configured value and `null` is not. `configured === null` means unset,
 * which is not comparable; `configured === 0` means blocked, which is.
 */
function compareStakeFactor(configured: number | null, applied: number | null): AgreementVerdict {
  if (configured === null || applied === null) {
    return notComparable('stakeFactor', configured, applied, REASONS.valueAbsent);
  }

  return {
    field: 'stakeFactor',
    verdict: configured === applied ? 'consistent' : 'differs',
    configuredValue: configured,
    appliedValue: applied,
    reason: null
  };
}

/**
 * Compare the liability group — where R14's unverified assumption lives.
 *
 * QBS sends a bare `String`; CRS holds a structured group with both a `code` and a
 * `description`. Nothing in either schema says which member the string is. So: try
 * `description` first (the observed shape), then `code`, and report `differs` with both
 * values visible when neither matches.
 *
 * The comparison is case- and whitespace-insensitive, because a difference in
 * capitalisation between two systems' representations of the same group is not a risk
 * discrepancy and reporting it as one would cry wolf.
 */
function compareLiabilityGroup(
  configured: CustomerRiskConfiguration['liabilityGroup'],
  applied: string | null
): AgreementVerdict {
  if (configured === null || applied === null) {
    return notComparable(
      'liabilityGroup',
      configured?.description ?? null,
      applied,
      REASONS.valueAbsent
    );
  }

  const normalise = (value: string): string => value.trim().toUpperCase();
  const appliedNormalised = normalise(applied);
  const matches =
    appliedNormalised === normalise(configured.description) ||
    appliedNormalised === normalise(configured.code);

  return {
    field: 'liabilityGroup',
    verdict: matches ? 'consistent' : 'differs',
    // The DESCRIPTION is shown as the configured value because it is the human-readable
    // one an operator recognises; the code is in the configuration itself, which the
    // result also carries in full.
    configuredValue: configured.description,
    appliedValue: applied,
    reason: null
  };
}

export interface AgreementInput {
  /** The governing configuration, or `null` when the jurisdiction did not match. */
  readonly governingConfiguration: CustomerRiskConfiguration | null;
  /** The bet's applied figures, or `null` when they were not retrieved. */
  readonly appliedRisk: AppliedRiskFigures | null;
  /** How many legs the bet has. More than one makes every verdict notComparable. */
  readonly legCount: number;
}

/**
 * Produce a verdict for every comparable field.
 *
 * ALWAYS returns one entry per field, never a filtered list. An absent verdict would
 * leave the agent to infer why, and inference is what this function exists to replace.
 */
export function assessAgreement(input: AgreementInput): AgreementVerdict[] {
  const { governingConfiguration, appliedRisk, legCount } = input;

  const configuredStakeFactor = governingConfiguration?.stakeFactor ?? null;
  const configuredLiabilityGroup = governingConfiguration?.liabilityGroup ?? null;
  const appliedStakeFactor = appliedRisk?.stakeFactor ?? null;
  const appliedLiabilityGroup = appliedRisk?.liabilityGroup ?? null;

  // Condition 1 — no governing configuration, so there is nothing to compare against.
  // Checked FIRST: without it, a null configured value would be reported as
  // `valueAbsent`, which describes the wrong problem.
  if (governingConfiguration === null) {
    return [
      notComparable('stakeFactor', null, appliedStakeFactor, REASONS.unresolvedJurisdiction),
      notComparable('liabilityGroup', null, appliedLiabilityGroup, REASONS.unresolvedJurisdiction)
    ];
  }

  // Condition 3 — a multi-leg bet's applied figures are bet-level (FR-021). Checked
  // before the value comparison, because a coincidental match on a parlay is still not
  // an attribution anyone can make.
  if (legCount > 1) {
    return [
      notComparable(
        'stakeFactor',
        configuredStakeFactor,
        appliedStakeFactor,
        REASONS.betLevelMultiLeg
      ),
      notComparable(
        'liabilityGroup',
        configuredLiabilityGroup?.description ?? null,
        appliedLiabilityGroup,
        REASONS.betLevelMultiLeg
      )
    ];
  }

  // Condition 2 is handled inside each comparison, since it is per-field.
  return [
    compareStakeFactor(configuredStakeFactor, appliedStakeFactor),
    compareLiabilityGroup(configuredLiabilityGroup, appliedLiabilityGroup)
  ];
}
