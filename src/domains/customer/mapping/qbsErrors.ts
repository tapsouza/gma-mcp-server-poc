import type { ComponentName } from '../../../core/types.js';
import type { QbsSearchBetsResponse } from './betProjection.js';

/**
 * GraphQL `errors[]` and unpopulated fields → `ComponentName[]` (FR-011, FR-026).
 *
 * ## The defect this file exists to prevent
 *
 * QBS returns HTTP **200** carrying `errors[]` with requested fields left unpopulated,
 * and GMA's own client treats that as usable data (`BetSearchClient.java:52`); the
 * bet-management front-end comments "If error is found, response will still be 200 OK"
 * and returns `data` regardless. A tool that trusted the status line would therefore
 * present a half-populated bet as complete — which the constitution calls
 * "the single worst defect this feature could ship" and Principle II addresses
 * directly: "A success status is not by itself evidence of a complete answer."
 *
 * ## Why the result is `unavailableComponents` and NEVER `failedInstances`
 *
 * This is the distinction the second completeness axis was added for. Every source
 * consulted ANSWERED — QBS returned 200 — so nothing failed to answer. What is missing
 * is a SECTION of the record. Reporting that as a failed instance tells the agent to
 * retry with narrower scoping, a correction that cannot possibly work, so the agent
 * retries indefinitely (FR-026, and Principle II states it in those terms).
 *
 * ## Why two signals rather than one
 *
 * Both are checked, because either alone would be wrong:
 *
 *  - `errors[]` alone: GraphQL error paths are not guaranteed to name every field that
 *    ended up empty, and a partial-failure mode that leaves data absent without an
 *    error entry is exactly the silent case worth catching.
 *  - Unpopulated fields alone: a bet legitimately has no `riskInfo` before it is
 *    priced, so absence is not by itself a failure — it is only evidence of one when
 *    the response also reported an error.
 *
 * So the rule is: an `errors[]` entry naming a section marks that section unavailable;
 * an error with no usable path marks every section whose data is in fact absent. A
 * response with NO errors marks nothing, however sparse it is.
 */

/** A GraphQL error entry, as much of it as this module reads. */
interface GraphQlError {
  readonly message?: unknown;
  readonly path?: readonly unknown[] | null;
}

/**
 * Which section each `path` segment implicates.
 *
 * Keyed by the upstream field name because that is what a GraphQL error path contains.
 * The upstream vocabulary stops here; what leaves this module is a `ComponentName`.
 */
const PATH_SEGMENT_TO_COMPONENT: Readonly<Record<string, ComponentName>> = Object.freeze({
  // The risk figures and the wager are part of the bet record itself.
  riskInfo: 'betDetail',
  wageInfo: 'betDetail',
  numberOfLines: 'betDetail',
  ids: 'betDetail',
  results: 'betDetail',
  searchBets: 'betDetail',
  // A leg's catalogue entities are what the composite needs in order to resolve a
  // leg's position, so their absence is a catalogue-position failure rather than a
  // generic bet-detail one.
  legs: 'legCataloguePositions',
  sport: 'legCataloguePositions',
  competition: 'legCataloguePositions',
  event: 'legCataloguePositions',
  market: 'legCataloguePositions',
  selection: 'legCataloguePositions'
});

/** Segments in specificity order, so `legs/riskInfo` attributes to the more specific one. */
const SPECIFIC_FIRST: readonly string[] = [
  'sport',
  'competition',
  'event',
  'market',
  'selection',
  'legs',
  'riskInfo',
  'wageInfo',
  'numberOfLines',
  'ids',
  'results',
  'searchBets'
];

function isErrorList(errors: unknown): errors is readonly GraphQlError[] {
  return Array.isArray(errors) && errors.length > 0;
}

/** The component a single error's path implicates, or `null` when its path says nothing. */
function componentFromPath(error: GraphQlError): ComponentName | null {
  const segments = (error.path ?? []).filter(
    (segment): segment is string => typeof segment === 'string'
  );

  for (const candidate of SPECIFIC_FIRST) {
    if (segments.includes(candidate)) return PATH_SEGMENT_TO_COMPONENT[candidate] ?? null;
  }

  return null;
}

/**
 * Sections whose data is in fact absent from the response.
 *
 * Consulted only when an error was reported: absence alone is not a failure, since an
 * unpriced bet legitimately has no applied risk figures.
 */
function absentSections(response: QbsSearchBetsResponse): ComponentName[] {
  const searchBets = response.data?.searchBets;
  const absent: ComponentName[] = [];

  // The whole payload is missing: the bet itself could not be retrieved.
  if (searchBets === null || searchBets === undefined) return ['betDetail'];

  const results = searchBets.results ?? [];
  if (results.length === 0) return ['betDetail'];

  for (const bet of results) {
    if (bet === null || bet === undefined) {
      if (!absent.includes('betDetail')) absent.push('betDetail');
      continue;
    }

    // `ids` and `wageInfo` are non-null in the schema, so their absence alongside a
    // reported error is a genuine gap in the bet record.
    if ((bet.ids === null || bet.ids === undefined) && !absent.includes('betDetail')) {
      absent.push('betDetail');
    }
    if ((bet.wageInfo === null || bet.wageInfo === undefined) && !absent.includes('betDetail')) {
      absent.push('betDetail');
    }
    // `legs` is `[Leg!]!` in the schema — non-null. An absent one means enrichment
    // failed, which is what the composite would otherwise silently read as
    // "this bet has no legs".
    if (
      (bet.legs === null || bet.legs === undefined) &&
      !absent.includes('legCataloguePositions')
    ) {
      absent.push('legCataloguePositions');
    }
  }

  return absent;
}

/**
 * Which sections of a QBS response could not be retrieved.
 *
 * Returns an EMPTY array for a healthy response — including a genuinely empty one —
 * so a caller can pass the result straight to `withUnavailableComponents` without
 * branching. That matters: a branch is a place to forget the unhappy path.
 *
 * @param response the parsed `POST /qbs/graphql` body, errors and all
 */
export function unavailableFromQbs(
  response: QbsSearchBetsResponse | null | undefined
): ComponentName[] {
  if (response === null || response === undefined) return ['betDetail'];
  if (!isErrorList(response.errors)) {
    // No reported error. Whatever is absent is absent legitimately, and inventing a
    // caveat here would devalue every genuine one (Principle II).
    return [];
  }

  const components: ComponentName[] = [];
  const add = (component: ComponentName): void => {
    if (!components.includes(component)) components.push(component);
  };

  let sawPathlessError = false;
  for (const error of response.errors) {
    const component = componentFromPath(error);
    if (component === null) sawPathlessError = true;
    else add(component);
  }

  // An error whose path names nothing tells us only that SOMETHING failed, so fall
  // back to what is observably absent rather than guessing a section.
  if (sawPathlessError) {
    for (const component of absentSections(response)) add(component);
    // An error was reported and nothing is observably absent: still say the bet
    // detail is suspect rather than reporting a clean answer, because a 200 with an
    // error is by definition not a complete success.
    if (components.length === 0) add('betDetail');
  }

  return components;
}

/**
 * True when the response reported errors at all.
 *
 * Separate from the component mapping because it answers a different question — "was
 * this a clean 200?" — which a tool may want to log as an outcome without needing to
 * know which section suffered.
 */
export function reportedErrors(response: QbsSearchBetsResponse | null | undefined): boolean {
  return isErrorList(response?.errors);
}
