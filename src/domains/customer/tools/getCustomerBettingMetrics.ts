import { argumentError } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import type { Completeness } from '../../../core/types.js';
import {
  errorCodeOf,
  hintForErrorCode,
  toMetricsRequestBody,
  toProjectedMetrics,
  type UpstreamMetricsResponse
} from '../mapping/metrics.js';
import type { Aggregation, MetricsFigures, MetricsGroup } from '../schemas.js';
import type { GetCustomerBettingMetricsArgs } from '../schemas.js';

/**
 * `get_customer_betting_metrics` — User Story 4 (P4), FR-013 to FR-015.
 *
 * One hop: `POST /accounts/{accountId}/metrics`.
 *
 * ## Why the POST and not the GET
 *
 * The `GET` variant is `deprecated: true` in `customer-metrics.yaml` and is "retained for
 * backward compatibility only" (FR-015). Both accept the same filters; only the `POST`
 * carries them in a body, which also keeps the account identifier and the filter set out of
 * a URL that would otherwise reach a log or a proxy access line.
 *
 * ## Two arguments this tool refuses to guess
 *
 *  1. **`aggregation` has no default** (FR-014, SC-008). The three modes answer three
 *     different questions — how a customer bets by bet type, by sport, or over time — so
 *     picking one silently would produce a confident answer to a question nobody asked. An
 *     absent value is an `argument` error NAMING all three.
 *  2. **A jurisdiction code is validated, never silently dropped** (FR-013). Upstream
 *     ignores a code it does not recognise and returns metrics for every jurisdiction, so
 *     an unchecked typo becomes "this customer bets far more than you thought" rather than
 *     an error. Validation points at `list_jurisdiction_contexts`, which exists precisely
 *     so codes are looked up rather than guessed (Principle V).
 */

/** The path template — never the interpolated path (research.md R13, Principle V). */
export const CUSTOMER_METRICS_TEMPLATE = '/accounts/{accountId}/metrics';

/** The three aggregations, named in the error when one is missing. */
const AGGREGATIONS: readonly Aggregation[] = ['BET_TYPE', 'HIERARCHY_ENTITY', 'TIMEFRAME'];

/**
 * The description the model sees, from contracts/tools.md section 5.
 *
 * Three of its instructions prevent three specific wrong answers: the lifetime-versus-filtered
 * warning prevents comparing an all-time total against a one-week row and calling it a
 * trend, the null instruction prevents reading "not reported" as zero, and the
 * separate-source sentence prevents a metrics answer being cited as evidence about a
 * customer's BETS. The last one is live-evidenced: a customer with 3,795 bets returned
 * all-zero metrics, and metrics come from a reporting warehouse
 * (`data-api…fddata-dev.net`) that is not the system bet records live in.
 */
export const GET_CUSTOMER_BETTING_METRICS_DESCRIPTION =
  "Returns a customer's betting metrics, grouped by an aggregation YOU MUST CHOOSE: BET_TYPE, " +
  'HIERARCHY_ENTITY (by sport or competition), or TIMEFRAME. There is NO default — if the user ' +
  'has not said which they want, ask. Optional filters narrow the set; get jurisdiction codes from ' +
  'list_jurisdiction_contexts rather than guessing them. `lifetime` is UNFILTERED and covers all ' +
  'time, so never compare it against a filtered row and call the difference a trend — compare ' +
  'against `filteredTotal`. A null measure means upstream did not report it, NOT zero. These ' +
  'figures come from a separate reporting warehouse than bet records, so they can lag or ' +
  'disagree with find_customer_bets — never conclude a customer has not bet from zero metrics; ' +
  'check find_customer_bets. If noDataNotice is present, relay it. If the result is incomplete, ' +
  'relay the caveat verbatim.';

export interface GetCustomerBettingMetricsResult {
  readonly accountId: string;
  readonly aggregation: Aggregation;
  readonly lifetime: MetricsFigures | null;
  readonly filteredTotal: MetricsFigures | null;
  readonly groups: MetricsGroup[];
  /**
   * A warning that the figures carry upstream's zero-fill signature, when they do.
   *
   * Optional rather than nullable: a normal answer has no such field at all, so nothing
   * invites the model to narrate the absence of a warning.
   */
  readonly noDataNotice?: string;
  readonly completeness: Completeness;
}

export interface GetCustomerBettingMetricsDeps {
  readonly client: GmaClient;
  /**
   * The jurisdiction codes this deployment's platform recognises, or `null` when they could
   * not be looked up.
   *
   * `null` means "we could not check", and an unchecked filter is forwarded rather than
   * rejected: refusing a code we merely failed to verify would deny a valid request. A
   * WRONG code then produces unfiltered metrics, which is why the check exists whenever it
   * can be made.
   */
  readonly knownJurisdictions: readonly string[] | null;
}

/**
 * Validate the account identifier without ever echoing it.
 *
 * The same rule the other customer tools apply: a value carrying a path separator or
 * whitespace would build a URL other than the one intended, and repeating the value back
 * would put a customer identifier in a message a model relays (FR-029, FR-030).
 */
function validateAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed.length === 0) {
    throw argumentError(
      'An account identifier is required.',
      'Supply the account identifier the customer is known by.'
    );
  }
  if (/[\s/?#]/.test(trimmed)) {
    throw argumentError(
      'The account identifier contains characters that are not valid in one.',
      'Supply the identifier alone, with no spaces, slashes, or URL punctuation. The value is not repeated here because account identifiers are personal data.'
    );
  }
  return trimmed;
}

/** Require the aggregation, and NAME the three choices when it is absent (FR-014, SC-008). */
function requireAggregation(aggregation: Aggregation | undefined): Aggregation {
  if (aggregation === undefined) {
    throw argumentError(
      'An aggregation is required, and there is no default.',
      `Choose one of ${AGGREGATIONS.join(', ')} — they answer different questions, so this server will not pick one for you. Ask the user which grouping they want.`
    );
  }
  if (!AGGREGATIONS.includes(aggregation)) {
    throw argumentError(
      'That aggregation is not one this server supports.',
      `Choose one of ${AGGREGATIONS.join(', ')}.`
    );
  }
  return aggregation;
}

/**
 * Reject a jurisdiction code the platform does not recognise (FR-013).
 *
 * The unrecognised code IS echoed here, and that is deliberate: a jurisdiction code is a
 * platform-wide scoping value like an instance name, not a datum about any customer, so
 * naming it is what makes the error self-correctable. Nothing about the customer appears.
 */
function validateJurisdictions(
  jurisdictions: readonly string[] | undefined,
  known: readonly string[] | null
): void {
  if (jurisdictions === undefined || known === null) return;

  const recognised = new Set(known.map((code) => code.trim().toUpperCase()));
  const unknown = jurisdictions.filter((code) => !recognised.has(code.trim().toUpperCase()));

  if (unknown.length > 0) {
    throw argumentError(
      `These jurisdiction codes are not ones this platform recognises: ${unknown.join(', ')}.`,
      'Call list_jurisdiction_contexts for the exact codes. They are NOT derivable from a state name — most are two letters, but not all. This is rejected rather than ignored because upstream would silently return metrics for EVERY jurisdiction.'
    );
  }
}

/**
 * Fetch a customer's betting metrics.
 *
 * @param token THIS invocation's operator token — an explicit parameter (FR-023a)
 */
export async function getCustomerBettingMetrics(
  deps: GetCustomerBettingMetricsDeps,
  token: OperatorToken,
  args: GetCustomerBettingMetricsArgs
): Promise<GetCustomerBettingMetricsResult> {
  const accountId = validateAccountId(args.accountId ?? '');
  const aggregation = requireAggregation(args.aggregation);
  validateJurisdictions(args.jurisdictions, deps.knownJurisdictions);

  const result = await deps.client.post<UpstreamMetricsResponse>(
    `/accounts/${encodeURIComponent(accountId)}/metrics`,
    toMetricsRequestBody({
      aggregation,
      period: args.period,
      betTypes: args.betTypes,
      placementStatus: args.placementStatus,
      jurisdictions: args.jurisdictions,
      hierarchy: args.hierarchy
    }),
    {
      token,
      pathTemplate: CUSTOMER_METRICS_TEMPLATE,
      tool: 'get_customer_betting_metrics',
      hop: 1,
      // Turn a machine-readable `400` code into guidance the agent can act on (SC-008).
      // Only OUR sentence is appended — the upstream `message` can echo the account
      // identifier and never reaches a tool-visible string (Principle V, FR-029).
      errorHint: (body) => hintForErrorCode(errorCodeOf(body))
    }
  );

  const projected = toProjectedMetrics(result.data);

  return {
    accountId,
    // Echoed back so the answer states its own shape and cannot be misread as another
    // grouping (data-model.md section 10).
    aggregation,
    lifetime: projected.lifetime,
    filteredTotal: projected.filteredTotal,
    groups: projected.groups,
    // Spread so the key is ABSENT on a normal answer rather than present-and-undefined.
    // Deliberately NOT folded into `completeness`: this is an interpretive doubt about
    // what the retrieved data means, not a report that something could not be retrieved,
    // and merging the two would make `complete: false` mean two different things.
    ...(projected.noDataNotice === undefined ? {} : { noDataNotice: projected.noDataNotice }),
    // The client's verdict, passed through untouched — a single-hop tool has nothing to
    // aggregate and no grounds to soften it.
    completeness: result.completeness
  };
}
