import type { CustomerRiskConfiguration, JurisdictionRef } from './schemas.js';

/**
 * The four-outcome jurisdiction matcher (FR-018, data-model.md section 8).
 *
 * PURE and I/O-FREE, deliberately. Every decision in this file is one the feature
 * could get *confidently wrong* — matching a bet to the wrong state's settings, or
 * reporting "no configuration exists" when in fact our own matching failed — and none
 * of those would throw. They would produce a plausible answer about a real customer's
 * trading restrictions. So the logic is a function of its arguments and is tested
 * exhaustively as one, rather than through an HTTP round trip.
 *
 * ## The matching order, and why it is not negotiable
 *
 *   1. Exact match against the customer's OWN configurations.
 *   2. Match against the fetched PLATFORM CONTEXT LIST.
 *   3. US-state DERIVATION, as a fallback only.
 *   4. `jurisdictionNotMatched`.
 *
 * Constitution v1.2.0 makes step 2 the PRIMARY mechanism and step 3 "a fallback,
 * never the primary mechanism", and it PROHIBITS a hardcoded jurisdiction table
 * outright: "it would fail *confidently* as jurisdictions are added." Ontario is the
 * standing proof — `urn:i:FD:CA-ON` against a context observed as `NXTCANBS`, which no
 * derivation produces.
 *
 * The failure mode that ordering guards against is subtle and worth naming: if the
 * context list is absent and derivation silently becomes primary, the code compiles,
 * every unit test that hands the matcher a list directly still passes, and the tool
 * answers US bets correctly while being confidently wrong about every non-US one. That
 * is why the composite fetches the list as a mandatory hop and why the absence of a
 * list is REPORTED rather than absorbed.
 *
 * ## Why FOUR outcomes where two would have looked sufficient
 *
 * Rows 2 and 3 look similar and are deliberately distinct:
 *
 *   - `noConfigurationForJurisdiction` is a FACT ABOUT THE CUSTOMER: the jurisdiction
 *     is real and they have no settings row for it.
 *   - `jurisdictionNotMatched` is a FAILURE OF OUR MATCHING: we could not tell what
 *     the bet's jurisdiction is.
 *
 * Folding them would make a systematic matching defect indistinguishable from a fact
 * about the data, and Principle IV requires exactly this separation: "the case where
 * the tool's own matching logic failed, kept separate from the case where the records
 * genuinely contain no applicable entry."
 *
 * ## And why matching is NOT incompleteness (FR-027)
 *
 * A result whose sources all answered fully is `complete: true` even when the
 * jurisdiction is unresolved. Marking it incomplete would train the agent to caveat
 * data that is in fact whole, devaluing every genuine caveat.
 */

/** FR-018's four outcomes, plus the not-attempted case. */
export type JurisdictionMatch =
  /** The bet's jurisdiction matched one of the customer's configurations. */
  | 'matched'
  /** The jurisdiction is known; the customer has no configuration for it. */
  | 'noConfigurationForJurisdiction'
  /** The jurisdiction is known but matched no configuration and no known context. */
  | 'jurisdictionNotMatched'
  /** The bet did not report a jurisdiction at all. */
  | 'jurisdictionUnknown'
  /**
   * Matching was NOT ATTEMPTED, because the configurations could not be retrieved.
   *
   * ## The live defect this outcome exists for
   *
   * When CRS returned `400` for every call, hop 2 produced no configurations. Matching
   * ran anyway, against an empty list — which can only ever answer "nothing matched" —
   * and the tool reported `jurisdictionNotMatched`. That reads as *"we know the bet's
   * jurisdiction and our matching failed on it"*, when the truth was *"we never had
   * anything to match against"*.
   *
   * The agent then did the predictable thing and said the applied figures "come from
   * defaults" — the single inference `jurisdictionMatchOutcomeSchema` forbids in every
   * non-`matched` case. It was not being careless: nothing in the payload distinguished
   * a matching failure from absent inputs, and a matching failure genuinely does suggest
   * the bet fell through to something.
   *
   * So this is the same rule as `notResolvedIdentifierUnusable` on a leg, one level up:
   * **the case where our logic failed must stay separate from the case where our logic
   * never ran.** Folding them lets a missing section masquerade as a finding.
   */
  | 'jurisdictionMatchNotAttempted';

/** How the match was reached, for the caller to report. A mechanism, never a value. */
export type MatchMechanism = 'ownConfiguration' | 'platformContextList' | 'derivation' | null;

export interface JurisdictionMatchOutcome {
  readonly match: JurisdictionMatch;
  /** The governing jurisdiction, present ONLY when `match` is `matched`. */
  readonly governing: JurisdictionRef | null;
  /**
   * Which step produced the answer. `null` when nothing matched.
   *
   * Reported because it is the difference between "the context list did its job" and
   * "we fell back to derivation and got lucky" — and because if this ever reads
   * `derivation` for every bet, the context hop is failing silently.
   */
  readonly mechanism: MatchMechanism;
}

/**
 * Normalise an identifier for comparison.
 *
 * Case and surrounding whitespace are not meaningful in either vocabulary, and
 * treating them as meaningful would produce a `jurisdictionNotMatched` — a claim that
 * OUR matching failed — over a difference in capitalisation.
 */
function normalise(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The trailing segment of a URN-shaped identifier.
 *
 * `urn:i:FD:US-NJ` → `US-NJ`. Used for comparison only; nothing is derived from it
 * beyond the US-state fallback below.
 */
function lastSegment(value: string): string {
  const segments = normalise(value).split(':');
  return segments[segments.length - 1] ?? '';
}

/**
 * DERIVE a two-letter US state code from a catalogue jurisdiction identifier.
 *
 * `urn:i:FD:US-NJ` → `NJ`, and `urn:i:FD:US-NJ1` → `NJ` because numbered variants
 * exist. This is the FALLBACK ONLY (constitution v1.2.0), and it is deliberately
 * NARROW: it recognises the `US-XX` shape and nothing else.
 *
 * What it is not: a jurisdiction TABLE. It contains no list of states, no mapping of
 * names to codes, and no special cases — so it cannot go stale as jurisdictions are
 * added, which is precisely why a table is prohibited. A jurisdiction it does not
 * recognise returns `null` and becomes `jurisdictionNotMatched`, which is an honest
 * "we could not tell" rather than a confident wrong answer.
 */
export function deriveUsStateCode(jurisdiction: string): string | null {
  const segment = lastSegment(jurisdiction);
  const match = /^US-([A-Z]{2})\d*$/.exec(segment);
  return match === null ? null : (match[1] as string);
}

/** Does this configuration's jurisdiction correspond to the given identifier? */
function corresponds(configuration: CustomerRiskConfiguration, candidate: string): boolean {
  const target = normalise(candidate);
  const { id, code } = configuration.jurisdiction;

  return (
    normalise(id) === target ||
    normalise(code) === target ||
    lastSegment(id) === target ||
    lastSegment(id) === lastSegment(candidate)
  );
}

/**
 * The one context whose NAME is the given value, or `null` when zero or several match.
 *
 * ## The live defect this exists for
 *
 * A bet reported its jurisdiction as **`INTBS1`** — which is a context *name*, not a code
 * (`{ contextCode: 'NJ1', contextName: 'INTBS1' }`). `corresponds` compares `id` and
 * `code` only, so the bet matched nothing and the tool answered
 * `jurisdictionNotMatched` — "we could not tell what this bet's jurisdiction is" — for a
 * bet whose governing configuration was present in the very same response, named
 * `INTBS1`.
 *
 * Same shape as the FR-019 override join: **one identifier stated in two vocabularies,
 * compared in only one of them.** And the cost is the same — a trader asking "why did
 * this bet get this limit?" is told the tool could not work it out, while the answer sits
 * unmatched beside it.
 *
 * ## Why names are matched HERE and not in `corresponds`
 *
 * Two reasons, and both are about not trading one wrong answer for a worse one.
 *
 * A code is issued by the platform; a **name is human-authored**, so it can collide where
 * a code would not. Matching a name inside `corresponds` would let any two identically
 * named jurisdictions be interchanged, and attributing a bet to the WRONG state's
 * settings is worse than reporting no match — it is a confident claim about a real
 * customer's restrictions.
 *
 * So a name is only ever resolved through the platform's own list, and only when
 * **exactly one** context bears it. That ambiguity guard is not hypothetical: the live
 * list holds 35 contexts and two of them already share the id `754` (`NJ1` and `WV`), so
 * duplicate human-authored values in this data are demonstrated rather than imagined. On
 * a tie this returns `null` and the outcome stays `jurisdictionNotMatched` — an honest
 * "we could not tell", which is what the outcome means.
 *
 * Names are also matched LAST within step 2, after id and code, so an exact code match
 * always wins over a name that happens to coincide with it.
 */
function uniqueContextByName(
  platformContexts: readonly JurisdictionRef[],
  betJurisdiction: string
): JurisdictionRef | null {
  const target = normalise(betJurisdiction);
  const named = platformContexts.filter((candidate) => normalise(candidate.name) === target);

  // Exactly one, or nothing. Picking the first of several would be the auto-pick
  // Principle IV prohibits, applied to a customer's trading restrictions.
  return named.length === 1 ? (named[0] as JurisdictionRef) : null;
}

/**
 * Match a bet's jurisdiction to one of the customer's configurations.
 *
 * @param betJurisdiction what the BET reported about itself — `instance` on the QBS
 *   projection, or `catalogueInstanceId`. `null` when the bet reported nothing.
 * @param configurations every configuration the customer has. Returned by the caller
 *   in FULL regardless of outcome (FR-018), so this function needs only to identify
 *   which one governs.
 * @param platformContexts the fetched jurisdiction context list, or `null` when that
 *   hop FAILED. `null` is meaningfully different from `[]`: the first means we could
 *   not look, the second means the platform reported no jurisdictions. Both fall
 *   through to derivation, but only the first is worth reporting as a missing section.
 * @param configurationsRetrieved whether the configurations were actually FETCHED.
 *   `false` means hop 2 failed, and matching is not attempted at all — see
 *   `jurisdictionMatchNotAttempted`. Defaults to `true` so callers that always have
 *   configurations are unchanged.
 */
export function matchJurisdiction(
  betJurisdiction: string | null,
  configurations: readonly CustomerRiskConfiguration[],
  platformContexts: readonly JurisdictionRef[] | null,
  configurationsRetrieved = true
): JurisdictionMatchOutcome {
  // Checked FIRST, before the bet's own jurisdiction. With no configurations there is
  // nothing to match against whatever the bet said, so every other outcome would be an
  // artefact of an empty list rather than a finding — and `jurisdictionNotMatched` in
  // particular would blame our matching for a hop that never answered.
  if (!configurationsRetrieved) {
    return { match: 'jurisdictionMatchNotAttempted', governing: null, mechanism: null };
  }

  // The bet told us nothing. Distinct from every other outcome, because there is
  // nothing here to have matched or failed to match.
  if (betJurisdiction === null || betJurisdiction.trim().length === 0) {
    return { match: 'jurisdictionUnknown', governing: null, mechanism: null };
  }

  // Step 1 — the customer's OWN configurations. Cheapest and most direct: if the bet's
  // jurisdiction is one the customer has settings for, no lookup is needed.
  const direct = configurations.find((configuration) =>
    corresponds(configuration, betJurisdiction)
  );
  if (direct !== undefined) {
    return {
      match: 'matched',
      governing: direct.jurisdiction,
      mechanism: 'ownConfiguration'
    };
  }

  // Step 2 — the PLATFORM CONTEXT LIST, which v1.2.0 makes the primary mechanism.
  // This is what resolves the cases derivation provably cannot: a context whose code
  // bears no relation to the catalogue jurisdiction identifier.
  if (platformContexts !== null) {
    const context =
      platformContexts.find(
        (candidate) =>
          normalise(candidate.id) === normalise(betJurisdiction) ||
          normalise(candidate.code) === normalise(betJurisdiction) ||
          lastSegment(betJurisdiction) === normalise(candidate.code) ||
          lastSegment(betJurisdiction) === lastSegment(candidate.id)
      ) ??
      // A bet may identify its jurisdiction by NAME (live: `INTBS1`). Tried last, so an
      // id or code match always wins, and only when the name is unambiguous.
      uniqueContextByName(platformContexts, betJurisdiction) ??
      undefined;

    if (context !== undefined) {
      const viaContext = configurations.find((configuration) =>
        corresponds(configuration, context.code)
      );
      if (viaContext !== undefined) {
        return {
          match: 'matched',
          // The CONTEXT's reference wins: it carries the human-readable name, which
          // the configuration's own reference may lack.
          governing: context,
          mechanism: 'platformContextList'
        };
      }

      // The jurisdiction is REAL — the platform knows it — and the customer has no
      // configuration for it. That is a fact about the customer, and it is exactly
      // why this outcome is separate from `jurisdictionNotMatched`.
      return {
        match: 'noConfigurationForJurisdiction',
        governing: null,
        mechanism: 'platformContextList'
      };
    }
  }

  // Step 3 — US-state derivation, the FALLBACK. Reached when the context list is
  // absent (its hop failed) or did not recognise the jurisdiction.
  const derived = deriveUsStateCode(betJurisdiction);
  if (derived !== null) {
    const viaDerivation = configurations.find((configuration) =>
      corresponds(configuration, derived)
    );
    if (viaDerivation !== undefined) {
      return {
        match: 'matched',
        governing: viaDerivation.jurisdiction,
        mechanism: 'derivation'
      };
    }

    // Derivation recognised the SHAPE — this is a US state — so the jurisdiction is
    // real and the customer simply has no configuration for it.
    return {
      match: 'noConfigurationForJurisdiction',
      governing: null,
      mechanism: 'derivation'
    };
  }

  // Step 4 — nothing matched. OUR matching failed, and saying so is the whole point:
  // reporting this as `noConfigurationForJurisdiction` would state a fact about the
  // customer that we have not established, and would hide a systematic defect.
  return { match: 'jurisdictionNotMatched', governing: null, mechanism: null };
}
