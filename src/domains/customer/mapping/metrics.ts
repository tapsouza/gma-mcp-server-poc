import type {
  Aggregation,
  BetTypeValue,
  HierarchyFilter,
  MetricsFigures,
  MetricsGroup,
  Period,
  PlacementStatus
} from '../schemas.js';

/**
 * `POST /accounts/{accountId}/metrics` — request building and response projection
 * (User Story 4, FR-013 to FR-015, research.md R12).
 *
 * The client boundary for the metrics vocabulary. Three things stop here, and each would be
 * a wrong answer if it did not:
 *
 *  1. **`EVENT_TYPE` → `EVENTTYPE`.** The REQUEST body accepts `SUPERCLASS`, `SUBCLASS` and
 *     `EVENTTYPE`; the RESPONSE states `EVENT_TYPE`. Two spellings of one level, and the
 *     LLM-facing schema uses the underscored form everywhere because that is what every
 *     other tool in this server uses. Sending the wrong one does not error — the filter is
 *     simply ignored, and the caller gets metrics for the whole catalogue while believing
 *     they asked about one competition.
 *  2. **`vipManager` never leaves this module.** It names a member of staff (Principle V).
 *  3. **The ~20 promo, device-link and internal-scoring measures are dropped.** Not for
 *     size: they are not self-describing, so a model shown `shortener: 1.2` or
 *     `overSelection: 0.4` would narrate a guess about what it means.
 */

/** The upstream request-body spelling of each filterable level (R12). */
const REQUEST_LEVEL: Readonly<Record<HierarchyFilter['level'], string>> = Object.freeze({
  SUPERCLASS: 'SUPERCLASS',
  SUBCLASS: 'SUBCLASS',
  // The whole of R12, in one line.
  EVENT_TYPE: 'EVENTTYPE'
});

export interface MetricsRequest {
  readonly aggregation: Aggregation;
  readonly period?: Period | undefined;
  readonly betTypes?: readonly BetTypeValue[] | undefined;
  readonly placementStatus?: readonly PlacementStatus[] | undefined;
  readonly jurisdictions?: readonly string[] | undefined;
  readonly hierarchy?: HierarchyFilter | undefined;
}

/**
 * Build the upstream request body.
 *
 * `calculateUnfilteredLifetimeMetrics` is always `true`: the lifetime totals are what make a
 * filtered figure interpretable, and asking for them costs nothing. Omitting them would
 * leave a model comparing a filtered number against nothing.
 */
export function toMetricsRequestBody(request: MetricsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    aggregationMode: request.aggregation,
    calculateUnfilteredLifetimeMetrics: true
  };

  if (request.period !== undefined) body.period = request.period;
  if (request.betTypes !== undefined) body.betTypes = [...request.betTypes];
  if (request.placementStatus !== undefined) body.status = [...request.placementStatus];
  if (request.jurisdictions !== undefined) body.contexts = [...request.jurisdictions];
  if (request.hierarchy !== undefined) {
    body.hierarchyEntity = {
      [REQUEST_LEVEL[request.hierarchy.level]]: [...request.hierarchy.catalogueEntityIds]
    };
  }

  return body;
}

/** The upstream response shape. Upstream vocabulary, translated below. */
export interface UpstreamMetricsResponse {
  readonly accountId?: string | null;
  readonly lifetimeMetrics?: UpstreamMetrics | null;
  readonly aggregatedTotalMetrics?: UpstreamMetrics | null;
  readonly aggregatedMetrics?: readonly (UpstreamMetricsGroup | null)[] | null;
}

/**
 * The measures this projection reads.
 *
 * Every other member of the upstream bag — `vipManager`, `promoStake`, `shortener`,
 * `totalDeviceLinks` and the rest — is deliberately absent from this type, so a future
 * edit that wants one has to add it here and be reviewed.
 */
interface UpstreamMetrics {
  readonly betCount?: number | null;
  readonly grossStake?: number | null;
  readonly settledStake?: number | null;
  readonly averageStake?: number | null;
  readonly tradingRevenue?: number | null;
  readonly tradingMargin?: number | null;
  readonly expectedMargins?: number | null;
  readonly inPlayStake?: number | null;
  readonly averageLegsPerBet?: number | null;
  readonly averageLegPrice?: number | null;
  readonly distinctEvents?: number | null;
  readonly playerDays?: number | null;
  readonly nearLimitBet?: number | null;
  readonly firstBetDate?: string | null;
  readonly lastBetDate?: string | null;
}

interface UpstreamMetricsGroup {
  readonly betType?: string | null;
  readonly period?: string | null;
  readonly hierarchyEntity?: {
    readonly hierarchyLevel?: string | null;
    readonly hierarchyEntityId?: string | null;
    readonly hierarchyEntityName?: string | null;
  } | null;
  readonly customerMetrics?: UpstreamMetrics | null;
}

const HIERARCHY_LEVELS = ['SUPERCLASS', 'SUBCLASS', 'EVENT_TYPE', 'MARKET_TYPE'] as const;

/**
 * A number, or `null` — never a coerced zero.
 *
 * `0` and "not reported" are different facts. A customer with `betCount: 0` placed no bets;
 * one whose `betCount` upstream omitted is a customer we know nothing about, and reporting
 * the second as the first invents a finding.
 */
function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Project the curated subset, or `null` when the whole section is absent. */
export function toMetricsFigures(raw: UpstreamMetrics | null | undefined): MetricsFigures | null {
  if (raw === null || raw === undefined) return null;

  return {
    betCount: numberOrNull(raw.betCount),
    grossStake: numberOrNull(raw.grossStake),
    settledStake: numberOrNull(raw.settledStake),
    averageStake: numberOrNull(raw.averageStake),
    tradingRevenue: numberOrNull(raw.tradingRevenue),
    tradingMargin: numberOrNull(raw.tradingMargin),
    expectedMargins: numberOrNull(raw.expectedMargins),
    inPlayStake: numberOrNull(raw.inPlayStake),
    averageLegsPerBet: numberOrNull(raw.averageLegsPerBet),
    averageLegPrice: numberOrNull(raw.averageLegPrice),
    distinctEvents: numberOrNull(raw.distinctEvents),
    playerDays: numberOrNull(raw.playerDays),
    nearLimitBet: numberOrNull(raw.nearLimitBet),
    firstBetDate: stringOrNull(raw.firstBetDate),
    lastBetDate: stringOrNull(raw.lastBetDate)
  };
}

/**
 * Project one aggregation row, discriminated by which key upstream populated.
 *
 * A row naming none of the three is DROPPED rather than given a placeholder key: a bucket
 * whose identity is unknown cannot be attributed to anything, and showing it with an
 * invented key would invite exactly that attribution.
 */
function toGroup(raw: UpstreamMetricsGroup | null | undefined): MetricsGroup | null {
  if (raw === null || raw === undefined) return null;

  const figures = toMetricsFigures(raw.customerMetrics);
  if (figures === null) return null;

  const betType = stringOrNull(raw.betType);
  if (betType !== null) {
    return { key: betType, keyKind: 'betType', keyName: null, hierarchyLevel: null, figures };
  }

  const period = stringOrNull(raw.period);
  if (period !== null) {
    return { key: period, keyKind: 'period', keyName: null, hierarchyLevel: null, figures };
  }

  const entityId = stringOrNull(raw.hierarchyEntity?.hierarchyEntityId);
  if (entityId !== null) {
    const level = raw.hierarchyEntity?.hierarchyLevel;
    return {
      key: entityId,
      keyKind: 'hierarchyEntity',
      // Falls back to the id: a terse correct value beats an invented name.
      keyName: stringOrNull(raw.hierarchyEntity?.hierarchyEntityName) ?? entityId,
      hierarchyLevel: HIERARCHY_LEVELS.find((candidate) => candidate === level) ?? null,
      figures
    };
  }

  return null;
}

export interface ProjectedMetrics {
  readonly lifetime: MetricsFigures | null;
  readonly filteredTotal: MetricsFigures | null;
  readonly groups: MetricsGroup[];
  /**
   * Present when the figures carry GMA's zero-fill signature — see `noDataNotice`.
   *
   * Absent (rather than `null`) on a normal answer, so a reader of the payload sees no
   * field at all when there is nothing to warn about.
   */
  readonly noDataNotice?: string;
}

/**
 * The sentence attached when every figure is zero-or-absent.
 *
 * Deliberately says what is NOT known rather than asserting a cause. Both readings are
 * live and this tool cannot tell them apart, so naming one would be a guess.
 *
 * ## Why it forbids the diagnosis outright
 *
 * The first wording said a reporting gap and genuine inactivity "look identical here" and
 * left it there. An agent relayed that faithfully, then — seeing 23,038 bets from
 * `find_customer_bets` — resolved the ambiguity anyway: *"the metrics service simply has no
 * data for them yet. This is likely a reporting lag."*
 *
 * Reasonable-sounding, unfounded, and possibly wrong: an account with tens of thousands of
 * bets and ZERO warehouse rows looks less like lag than like a warehouse never populated
 * for this environment. Naming "lag" as a candidate is what invited the pick, so the notice
 * now states the ambiguity and prohibits resolving it, rather than listing causes and
 * hoping the reader abstains.
 */
export const NO_DATA_NOTICE =
  'Upstream reported no metrics data for this customer. This is NOT evidence the customer ' +
  'has not bet: the metrics service zero-fills periods and buckets it has no data for, so a ' +
  'reporting gap and genuine inactivity look identical here. Betting metrics come from a ' +
  'separate reporting warehouse than bet records, and the two can disagree. Say that the ' +
  'figures are unavailable, and use find_customer_bets to establish whether bets exist. Do ' +
  'NOT explain WHY the figures are missing — not as a reporting lag, not as data yet to ' +
  'arrive, not as a warehouse problem. Nothing here indicates the cause, and a plausible ' +
  'explanation offered to a user reads as a finding. Report that the figures are unavailable ' +
  'and stop there.';

/**
 * True when the figures are all zero-or-absent — GMA's zero-fill signature.
 *
 * ## The live finding this exists for
 *
 * A customer with **3,795 bets** returned metrics reading zero on every measure. Nothing
 * in the response said so: HTTP 200, no `errors[]`, a complete-looking body. A model shown
 * that will state "this customer has never placed a bet", which is a confidently wrong
 * answer about a real person — the exact failure mode Principle II exists to prevent.
 *
 * ## Why the signature is `zeros AND absent dates`, not zeros alone
 *
 * GMA fabricates rows for buckets the Data API did not return, via
 * `CustomerMetrics.builder().build()` (`UnmappedCustomerMetricsResponseGenerator`, all
 * three `enrichWith*` methods). That leaves Java PRIMITIVE members at their default `0`
 * — `int betCount`, `double grossStake`, `double tradingRevenue` — while every BOXED
 * member stays null: `Integer distinctEvents`, `Integer playerDays`, `Double inPlayStake`,
 * and both `LocalDate` bet dates.
 *
 * So the fabricated row has a shape a real row cannot have. A customer who genuinely
 * placed no bets also has no bet dates, which is why dates alone are not the test; and a
 * customer with real activity has a non-zero measure somewhere. Requiring BOTH keeps the
 * notice off a row that merely has a zero in it.
 *
 * ## Why a notice rather than an error, and why not `unavailableComponents`
 *
 * The figures may be genuinely zero — a brand-new account. Erroring would refuse to answer
 * a legitimate question. And `unavailableComponents` is for a section this tool could not
 * retrieve; the section WAS retrieved, and what is uncertain is what it means. Overloading
 * the completeness axes with an interpretive doubt would make `complete: false` mean two
 * different things (Principle II forbids merging the axes; this is the same rule read one
 * step out).
 */
export function hasNoDataSignature(figures: MetricsFigures | null): boolean {
  if (figures === null) return false;

  // A real bet has a date. Both absent is necessary but NOT sufficient — a genuinely
  // inactive customer looks the same here, which is why the zero check follows.
  if (figures.firstBetDate !== null || figures.lastBetDate !== null) return false;

  const measures = [
    figures.betCount,
    figures.grossStake,
    figures.settledStake,
    figures.averageStake,
    figures.tradingRevenue,
    figures.tradingMargin,
    figures.expectedMargins,
    figures.inPlayStake,
    figures.averageLegsPerBet,
    figures.averageLegPrice,
    figures.distinctEvents,
    figures.playerDays,
    figures.nearLimitBet
  ];

  // `null` counts as zero-or-absent: the boxed members are exactly what the zero-fill
  // leaves null, so demanding a literal 0 everywhere would miss the signature entirely.
  return measures.every((measure) => measure === null || measure === 0);
}

/** Project the whole response into the curated shape. Pure. */
export function toProjectedMetrics(
  response: UpstreamMetricsResponse | null | undefined
): ProjectedMetrics {
  const lifetime = toMetricsFigures(response?.lifetimeMetrics);
  const filteredTotal = toMetricsFigures(response?.aggregatedTotalMetrics);
  const groups = (response?.aggregatedMetrics ?? []).flatMap((raw) => {
    const group = toGroup(raw);
    return group === null ? [] : [group];
  });

  // Keyed on the TOTALS, not on the groups. An individual zero-filled group is normal and
  // informative — it is how "you asked about this bet type and there was no activity" is
  // reported. It is the totals reading empty that means the figures cannot be trusted as
  // a statement about the customer.
  //
  // `lifetime` is checked when present because it is the filter-independent measure: a
  // customer with any history at all should have non-zero lifetime figures, so a zero-fill
  // signature there is the strongest available signal. When it is absent — the caller did
  // not ask for it — the filtered total is the fallback.
  const suspect =
    lifetime !== null ? hasNoDataSignature(lifetime) : hasNoDataSignature(filteredTotal);

  return {
    lifetime,
    filteredTotal,
    groups,
    ...(suspect ? { noDataNotice: NO_DATA_NOTICE } : {})
  };
}

/**
 * The `400` error codes, each mapped to a hint that says how to fix the request.
 *
 * SC-008 wants a self-correctable error, and a code alone is not one: an agent shown
 * `TOO_MANY_HIERARCHY_ENTITIES` has to guess what "too many" is and what to do instead.
 *
 * The upstream `message` is deliberately NOT part of any of these. On the
 * `CustomerMetricsDataApiResponse` shape it carries "the Json response that caused the
 * exception", which can echo the account identifier into a sentence a human reads
 * (Principle V, FR-029).
 */
const ERROR_HINTS: Readonly<Record<string, string>> = Object.freeze({
  MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE:
    'Entities from several catalogue levels cannot be combined in one request. Choose ONE level and ask again — or make one call per level.',
  TOO_MANY_HIERARCHY_ENTITIES:
    'Too many catalogue entities for a single request. Ask for fewer, or aggregate at a broader level (a SUPERCLASS instead of many EVENT_TYPEs).',
  ACCOUNT_IDENTIFIER_MISSING:
    'The account identifier did not reach the metrics service. Check that accountId was supplied and is not blank.'
});

/**
 * A self-correctable hint for an upstream `400`, or `null` when the code is unrecognised.
 *
 * `null` rather than a generic sentence: inventing guidance for a code we do not know would
 * send the agent to correct something that may not be the problem.
 */
export function hintForErrorCode(errorCode: string | null | undefined): string | null {
  if (typeof errorCode !== 'string') return null;
  return ERROR_HINTS[errorCode] ?? null;
}

/** The `errorCode` on a `400` body, whichever of the three shapes it is. */
export function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && code.length > 0 ? code : null;
}
