import type { AppliedRiskFigures, Bet, BetLeg, NamedEntity, WagerAmounts } from '../schemas.js';

/**
 * QBS `Bet` → the curated risk projection (data-model.md section 6).
 *
 * The client boundary for QBS vocabulary: `riskInfo`, `wageInfo`, `numberOfLines`,
 * `entityIds`, `betReceiptId` and the single-letter `LegResult` codes all stop here
 * (constitution Principle IV).
 *
 * ## R9 lives in this file
 *
 * A leg's catalogue entity carries `{ sportexId, rampId, openbetId, gbpId }`, and
 * `GET /v5/events/{id}` wants one specific form. WHICH member is the right one is an
 * UNVERIFIED assumption: the bet-management front-end uses `rampId`
 * (`linkManager.ts:51`), `gbpId` is the more suggestive name, and no source reconciles
 * them (research.md R9).
 *
 * So this mapper tries `rampId`, then `gbpId`, and RECORDS WHICH ONE IT USED. That
 * record is what the composite reports as `resolvedVia`, satisfying Principle IV's rule
 * that a load-bearing unverified assumption must be stated in the tool's result rather
 * than buried. If the assumption is wrong, every leg fails to resolve visibly instead of
 * one succeeding by luck.
 */

/** Which `entityIds` member supplied a leg's identifier. A field LEVEL, never a value. */
export type EntityIdSource = 'rampId' | 'gbpId';

/**
 * The v5 event URN prefix, from the only observed bridge (R9).
 *
 * `gbpbmui-tool/src/constants/urnPrefixes.ts:2` — `URN_PREFIXES.EVENT` — applied to a
 * leg's `rampId` at `linkManager.ts:88`.
 */
const EVENT_URN_PREFIX = 'urn:sbk:pc:e:gpd:';

/**
 * A leg's event identifier in the form `GET /v5/events/{id}` expects.
 *
 * R9's assumption is `rampId` **prefixed**, not the bare value: the front-end reads
 * `event.entityIds.rampId` (`linkManager.ts:51`) and then prefixes it
 * (`:88`). Sending the bare `9201` would 404 every leg — and because an unresolvable leg
 * is reported as `notResolvedIdentifierUnusable`, the symptom would look exactly like R9
 * being wrong rather than like this transformation being missing. That is the confident
 * failure this function exists to prevent.
 *
 * Idempotent: a value already in URN form is returned unchanged, so an upstream that
 * starts sending URNs does not break the hop.
 */
export function toEventLookupId(eventId: string): string {
  return eventId.startsWith('urn:') ? eventId : `${EVENT_URN_PREFIX}${eventId}`;
}

/** The subset of `POST /qbs/graphql`'s `Bet` this mapper reads. Upstream vocabulary. */
export interface QbsSearchBetsResponse {
  readonly data?: {
    readonly searchBets?: {
      readonly pageInfo?: { readonly count?: number | null; readonly pages?: number | null } | null;
      readonly results?: readonly (QbsBet | null)[] | null;
    } | null;
  } | null;
  /** GraphQL errors alongside a 200. Parsed by `qbsErrors.ts`, not here. */
  readonly errors?: readonly unknown[] | null;
}

interface QbsEntityIds {
  readonly rampId?: string | null;
  readonly gbpId?: string | null;
}

interface QbsCatalogEntity {
  readonly name?: string | null;
  readonly entityIds?: QbsEntityIds | null;
}

interface QbsLeg {
  readonly legNumber?: number | null;
  readonly sport?: QbsCatalogEntity | null;
  readonly competition?: QbsCatalogEntity | null;
  readonly event?: QbsCatalogEntity | null;
  readonly market?: QbsCatalogEntity | null;
  readonly selection?: QbsCatalogEntity | null;
  readonly placedInPlay?: boolean | null;
  readonly legPrice?: {
    readonly numerator?: number | null;
    readonly denominator?: number | null;
  } | null;
  readonly result?: string | null;
}

export interface QbsBet {
  readonly ids?: {
    readonly betId?: string | null;
    readonly betReceiptId?: string | null;
    readonly accountId?: string | null;
  } | null;
  readonly status?: string | null;
  readonly placementDate?: string | null;
  readonly betType?: string | null;
  readonly instance?: string | null;
  readonly catalogueInstanceId?: string | null;
  readonly productId?: string | null;
  readonly numberOfLines?: { readonly total?: number | null } | null;
  readonly riskInfo?: {
    readonly stakeFactor?: number | null;
    readonly maxBet?: number | null;
    readonly maxValue?: number | null;
    readonly cumulativeMax?: number | null;
    readonly overlayMax?: number | null;
    readonly liabilityGroup?: string | null;
  } | null;
  readonly wageInfo?: {
    readonly currency?: string | null;
    readonly stake?: number | null;
    readonly potentialPayout?: number | null;
    readonly winnings?: number | null;
    readonly refunds?: number | null;
  } | null;
  readonly legs?: readonly (QbsLeg | null)[] | null;
}

/**
 * A bet plus the per-leg record of which identifier member worked.
 *
 * The projection is what a tool returns; the sources are what the composite needs in
 * order to report `resolvedVia`. They are separate because `resolvedVia` belongs on a
 * RESOLVED LEG, which only the composite produces — `find_customer_bets` has no
 * resolution step and so must not imply one.
 */
export interface ProjectedBet {
  readonly bet: Bet;
  /** Keyed by `legNumber`: which member supplied that leg's EVENT identifier. */
  readonly eventIdSources: ReadonlyMap<number, EntityIdSource>;
}

/** The single-letter upstream leg results, translated for a model. */
const LEG_RESULTS: Readonly<Record<string, BetLeg['result']>> = Object.freeze({
  N: 'NONE',
  W: 'WIN',
  P: 'PLACE',
  L: 'LOSE',
  V: 'VOID'
});

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pick a leg entity's identifier, trying `rampId` then `gbpId` (R9).
 *
 * Returns the source alongside the value so the caller can report which one worked.
 * `null` for both means the leg carries nothing usable, which the composite reports as
 * `notResolvedIdentifierUnusable` — kept DISTINCT from an upstream failure precisely so
 * that a wrong R9 assumption is immediately visible rather than hidden in a generic
 * error bucket.
 */
function pickIdentifier(entity: QbsCatalogEntity | null | undefined): {
  id: string | null;
  source: EntityIdSource | null;
} {
  const rampId = stringOrNull(entity?.entityIds?.rampId);
  if (rampId !== null) return { id: rampId, source: 'rampId' };

  const gbpId = stringOrNull(entity?.entityIds?.gbpId);
  if (gbpId !== null) return { id: gbpId, source: 'gbpId' };

  return { id: null, source: null };
}

/** A named entity, or `null` when upstream sent nothing for this level. */
function toNamedEntity(entity: QbsCatalogEntity | null | undefined): NamedEntity | null {
  if (entity === null || entity === undefined) return null;

  const { id } = pickIdentifier(entity);
  const name = stringOrNull(entity.name);
  if (name === null && id === null) return null;

  return { name: name ?? (id as string), id };
}

/** A required named entity — an absent one becomes a placeholder rather than dropping the leg. */
function toRequiredNamedEntity(entity: QbsCatalogEntity | null | undefined): NamedEntity {
  // A leg whose sport or event is missing is still a leg the operator placed, and
  // dropping it would understate the bet. `name: 'unknown'` with a null id says
  // exactly what is true, and the composite's `resolution` field is what tells the
  // agent the leg cannot be matched to an override.
  return toNamedEntity(entity) ?? { name: 'unknown', id: null };
}

function toWager(raw: QbsBet['wageInfo']): WagerAmounts {
  return {
    // Stake is non-null in the schema, but this surface can return a 200 with fields
    // unpopulated (research.md R1), so a missing stake becomes 0 rather than NaN —
    // and the accompanying `errors[]` is what marks the result incomplete.
    stake: numberOrNull(raw?.stake) ?? 0,
    currency: stringOrNull(raw?.currency) ?? 'unknown',
    potentialPayout: numberOrNull(raw?.potentialPayout),
    winnings: numberOrNull(raw?.winnings),
    refunds: numberOrNull(raw?.refunds)
  };
}

/** The applied figures, or `null` when the whole section is absent. */
function toAppliedRisk(raw: QbsBet['riskInfo']): AppliedRiskFigures | null {
  if (raw === null || raw === undefined) return null;

  return {
    stakeFactor: numberOrNull(raw.stakeFactor),
    liabilityGroup: stringOrNull(raw.liabilityGroup),
    maxBet: numberOrNull(raw.maxBet),
    // Renamed at this boundary: upstream `maxValue`/`cumulativeMax`/`overlayMax` are
    // percentages, and the names do not say so.
    maxValuePercent: numberOrNull(raw.maxValue),
    cumulativeMaxPercent: numberOrNull(raw.cumulativeMax),
    overlayMaxPercent: numberOrNull(raw.overlayMax)
  };
}

function toLeg(raw: QbsLeg, index: number): { leg: BetLeg; eventIdSource: EntityIdSource | null } {
  const numerator = numberOrNull(raw.legPrice?.numerator);
  const denominator = numberOrNull(raw.legPrice?.denominator);
  const { source: eventIdSource } = pickIdentifier(raw.event);

  return {
    leg: {
      // Falls back to position: a leg with no number is still at a known place in the
      // bet, and the composite keys `resolvedVia` by this value.
      legNumber: numberOrNull(raw.legNumber) ?? index + 1,
      sport: toRequiredNamedEntity(raw.sport),
      competition: toRequiredNamedEntity(raw.competition),
      event: toRequiredNamedEntity(raw.event),
      market: toNamedEntity(raw.market),
      selection: toNamedEntity(raw.selection),
      placedInPlay: typeof raw.placedInPlay === 'boolean' ? raw.placedInPlay : null,
      price: numerator === null || denominator === null ? null : { numerator, denominator },
      // An unrecognised code becomes null rather than being passed through raw: a
      // model shown `"Q"` would guess, and a guess about a bet's result is a wrong
      // answer about whether a customer was paid.
      result:
        raw.result === null || raw.result === undefined ? null : (LEG_RESULTS[raw.result] ?? null)
    },
    eventIdSource
  };
}

/** Map one upstream bet to the curated projection, or `null` when it has no identifier. */
export function toProjectedBet(raw: QbsBet | null | undefined): ProjectedBet | null {
  const betId = stringOrNull(raw?.ids?.betId);
  if (raw === null || raw === undefined || betId === null) return null;

  const legs = (raw.legs ?? []).flatMap((leg, index) => (leg === null ? [] : [toLeg(leg, index)]));

  const eventIdSources = new Map<number, EntityIdSource>();
  for (const { leg, eventIdSource } of legs) {
    if (eventIdSource !== null) eventIdSources.set(leg.legNumber, eventIdSource);
  }

  return {
    bet: {
      betId,
      receiptId: stringOrNull(raw.ids?.betReceiptId),
      accountId: stringOrNull(raw.ids?.accountId) ?? 'unknown',
      placedAt: stringOrNull(raw.placementDate) ?? 'unknown',
      status: stringOrNull(raw.status) ?? 'unknown',
      betType: stringOrNull(raw.betType) ?? 'unknown',
      jurisdiction: stringOrNull(raw.instance),
      catalogueInstanceId: stringOrNull(raw.catalogueInstanceId),
      // Prefer upstream's own count, since `legs` may be unpopulated on a
      // success-carrying-errors response while `numberOfLines` survives — reporting
      // `legCount: 0` there would tell the agent the bet had no legs.
      legCount: numberOrNull(raw.numberOfLines?.total) ?? legs.length,
      appliedRisk: toAppliedRisk(raw.riskInfo),
      wager: toWager(raw.wageInfo),
      legs: legs.map(({ leg }) => leg)
    },
    eventIdSources
  };
}

/**
 * Map a whole `searchBets` response to projections, most recent first.
 *
 * The sort is a BELT-AND-BRACES safeguard, not the primary mechanism: the request
 * already asks for `PLACEMENT_DATE DESC` (research.md R6). Sorting again costs nothing
 * and means an upstream that silently ignored the sort cannot make the tool's ordering
 * claim false.
 */
export function toProjectedBets(
  response: QbsSearchBetsResponse | null | undefined
): ProjectedBet[] {
  const results = response?.data?.searchBets?.results ?? [];

  return results
    .flatMap((raw) => {
      const projected = toProjectedBet(raw);
      return projected === null ? [] : [projected];
    })
    .sort((a, b) => b.bet.placedAt.localeCompare(a.bet.placedAt));
}

/** Upstream's total match count, when it reported one. */
export function totalMatched(response: QbsSearchBetsResponse | null | undefined): number | null {
  return numberOrNull(response?.data?.searchBets?.pageInfo?.count);
}
