import type { AppliedRiskFigures, Bet, BetLeg, NamedEntity, WagerAmounts } from '../schemas.js';

/**
 * QBS `Bet` → the curated risk projection (data-model.md section 6).
 *
 * The client boundary for QBS vocabulary: `riskInfo`, `wageInfo`, `numberOfLines`,
 * `entityIds`, `betReceiptId` and the single-letter `LegResult` codes all stop here
 * (constitution Principle IV).
 *
 * ## R9 — CLOSED, and closed AGAINST the original assumption
 *
 * A leg's catalogue entity carries `{ sportexId, rampId, openbetId, gbpId }`, and
 * `GET /v5/events/{id}` wants a full GBP URN. R9 assumed the bridge was `rampId` with a
 * hardcoded `urn:sbk:pc:e:gpd:` prefix, on the evidence of the bet-management front-end
 * (`linkManager.ts:51` + `:88`). **That was wrong**, and GMA's own code says so.
 *
 * GMA performs this exact join in `Rule4EnrichmentService:121`:
 *
 * ```java
 * GbpId.fromSourceId(gbpIdOf(leg.getEvent()), "e").toLongUrn()
 * ```
 *
 * where `gbpIdOf` reads **`entityIds.gbpId`** (`:128`) — not `rampId`. And
 * `GbpId.fromSourceId` (`GbpId.java:17`) requires the value to be `source:sourceId`,
 * splitting on `:` and throwing if it is not exactly two parts. The URN is then assembled
 * as `urn:sbk:pc:{level}:{source}:{sourceId}`.
 *
 * So `gpd` is **not a constant** — it is the `source` segment, and it comes from the data.
 * Hardcoding it invents a namespace for every bet whose source differs. Every gbpId seen
 * live so far happens to carry `gpd`, which is exactly why the hardcoding survived: it is
 * indistinguishable from correct until a bet arrives with another source, and then it
 * fabricates an id nobody issued rather than failing.
 *
 * ## Two bet stacks, and why `isOb` is NOT consulted here
 *
 * There are two: **steel-thread** bets (processed internally, ids shaped `urn:sbk:bet:…`)
 * and **OpenBet** bets (numeric ids). QBS distinguishes them with `isOb` — *"if bet is
 * from Openbet or not"*.
 *
 * Legs on **both** stacks carry a namespaced `gbpId`. Verified live across ten legs:
 * `gpd:14643022` on an OpenBet bet, and `gpd:40646467` plus eight more on a steel-thread
 * ninefold. The stack therefore does NOT determine the identifier shape, and `isOb` is
 * deliberately not used to decide whether a lookup is worth attempting: the UI's own
 * fixtures contain `isOb: true` bets whose events carry good gbpIds
 * (`gbpbmui-tool/src/utils/mockedData.ts` — `PARIS ST-G V DORTMUND`, `gbpId: '162079'`),
 * so skipping on `isOb` would deny a lookup to legs that can resolve.
 *
 * What IS true of the OpenBet event observed live: `GET /v5/events/{id}` answers **400**
 * for it, and the GMA UI gets the same 400 for the same event — so that event is absent
 * from the catalogue PCSS serves. That is upstream's answer to a well-formed request, and
 * it surfaces as `notResolvedUpstreamFailure`, not as an identifier problem.
 *
 * The lesson recorded for the next reader: a passing result does not confirm a mechanism
 * unless the alternative would have failed — and its converse, that a failing result does
 * not convict the request until you have checked whether the same request fails elsewhere.
 */

/** Which `entityIds` member supplied a leg's identifier. A field LEVEL, never a value. */
export type EntityIdSource = 'rampId' | 'gbpId';

/**
 * The catalogue level segment for an event, matching GMA's `EVENT_LEVEL`
 * (`Rule4EnrichmentService:41` — `"e"`).
 */
const EVENT_LEVEL = 'e';

/**
 * A leg's event identifier as a full GBP long URN, or `null` when one cannot be built.
 *
 * Mirrors `GbpId.fromSourceId(...).toLongUrn()`: a `gbpId` of `gpd:14643022` becomes
 * `urn:sbk:pc:e:gpd:14643022`. The `source` is READ FROM THE VALUE and never assumed —
 * that assumption is what broke this before.
 *
 * Returns `null` rather than guessing when the value is not `source:sourceId`, because a
 * bare number carries no namespace and any URN built from one would be a fabrication.
 * GMA does the same: `Rule4EnrichmentService:114` skips the leg outright when the `gbpId`
 * is blank rather than substituting anything. A `null` here surfaces as
 * `notResolvedIdentifierUnusable` — an honest "this leg's position is unknown", which is
 * categorically better than a confident lookup of an id nobody issued.
 *
 * That null path is a GUARD, not the common path: every gbpId observed live is namespaced.
 * The UI's fixtures do state bare ones, so if such a value ever arrives the honest answer
 * is this null and the fix belongs upstream or in a verified source lookup — not in a
 * prefix guessed here.
 *
 * Idempotent for a value already in long-URN form, so an upstream that starts sending
 * assembled URNs does not break the hop.
 */
export function toEventLookupId(eventId: string): string | null {
  // Already a long URN: `urn:sbk:pc:e:gpd:14643022` is six colon-separated parts, the
  // shape `GbpId.fromLongUrn` accepts.
  if (eventId.startsWith('urn:')) {
    return eventId.split(':').length === 6 ? eventId : null;
  }

  // `source:sourceId`, the shape `GbpId.fromSourceId` requires.
  const parts = eventId.split(':');
  if (parts.length !== 2) return null;

  const [source, sourceId] = parts as [string, string];
  if (source.length === 0 || sourceId.length === 0) return null;

  return `urn:sbk:pc:${EVENT_LEVEL}:${source}:${sourceId}`;
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
 * Pick a leg entity's identifier, preferring **`gbpId`** (R9, closed).
 *
 * `gbpId` first, because it is the member GMA's own join uses and the only one that
 * carries its `source` namespace — `rampId` is a bare number, so any URN built from it
 * requires INVENTING the source, which is precisely the defect this ordering corrects.
 *
 * `rampId` remains a fallback so a leg that carries only that value still gets a
 * displayable identifier. It will not produce a usable event lookup (`toEventLookupId`
 * returns `null` for a value with no `source:` segment), and that is the honest outcome:
 * the leg is reported `notResolvedIdentifierUnusable` rather than looked up under a
 * fabricated namespace.
 *
 * The source is returned alongside so the composite can report `resolvedVia` — which is
 * now genuinely diagnostic. `gbpId` means the canonical path worked; `rampId` on an
 * unresolved leg means this leg carried no namespaced identifier at all.
 */
function pickIdentifier(entity: QbsCatalogEntity | null | undefined): {
  id: string | null;
  source: EntityIdSource | null;
} {
  const gbpId = stringOrNull(entity?.entityIds?.gbpId);
  if (gbpId !== null) return { id: gbpId, source: 'gbpId' };

  const rampId = stringOrNull(entity?.entityIds?.rampId);
  if (rampId !== null) return { id: rampId, source: 'rampId' };

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
