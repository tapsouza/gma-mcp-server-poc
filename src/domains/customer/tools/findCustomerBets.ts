import { withUnavailableComponents } from '../../../core/completeness.js';
import { argumentError } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import type { Completeness } from '../../../core/types.js';
import {
  FIRST_PAGE,
  PLACEMENT_DATE_DESC,
  QBS_GRAPHQL_PATH,
  SEARCH_BETS_DOCUMENT,
  SEARCH_BETS_OPERATION_NAME
} from '../gql/searchBets.js';
import {
  toProjectedBets,
  totalMatched,
  type ProjectedBet,
  type QbsSearchBetsResponse
} from '../mapping/betProjection.js';
import { unavailableFromQbs } from '../mapping/qbsErrors.js';
import type { Bet } from '../schemas.js';

/**
 * `find_customer_bets` — User Story 2 (P2), FR-008 to FR-012.
 *
 * ONE hop: `POST /qbs/graphql` with the FIXED `searchBets` document.
 *
 * ## Read-only by construction (FR-024, FR-025)
 *
 * The document is a constant with no interpolation, the path is a literal, and caller
 * values reach `variables.input.ids` only. That is the whole guard, and it has to be
 * structural: QBS declares mutations (`deleteBetNote`), the proxy takes its path from
 * the caller, and every read here is a POST — so nothing about HOW the request is made
 * distinguishes it from a write (Principle IV).
 *
 * ## No `?instance=`, ever
 *
 * Constitution v1.2.0: the parameter "MUST NOT be sent while multi-instance routing is
 * disabled, and an instance MUST NOT be exposed as a tool argument in any case — it is
 * a routing concern, not a scoping vocabulary". So it is absent from the input schema
 * AND absent from the request. `test/unit/readOnly.test.ts` asserts both.
 *
 * ## A 200 is not evidence of a complete answer
 *
 * This surface returns HTTP 200 carrying GraphQL `errors[]` with fields unpopulated.
 * The body is inspected and the affected sections named through
 * `unavailableComponents` — never through `failedInstances`, which would tell the agent
 * to retry with scoping that cannot help (FR-011, FR-026).
 */

/**
 * The ordering caveat, stated UNCONDITIONALLY (FR-010).
 *
 * ## Why it also forbids reasoning from ABSENCE
 *
 * The first wording warned only about recency, and an agent relayed the true half —
 * "most recent first" — while dropping the rest. It then used a 20-bet first page to
 * answer a question about RESTRICTION: one soccer bet was present, so it concluded the
 * customer "is not restricted on soccer".
 *
 * That is a different error from mis-describing recency, and a worse one. A page of bets
 * cannot support a claim about what a customer MAY do: the bets that would disprove it are
 * exactly the ones a first page omits, and a restriction added after these bets were placed
 * is invisible here. Restrictions live in the configuration, which
 * `get_customer_risk_profile` returns — so the caveat now names that tool rather than
 * leaving the agent to reason from what it happens to see.
 */
export const ORDERING_CAVEAT =
  'These are the first bets of the upstream result set, most recent first. This may not be the ' +
  'globally most recent set of bets for this customer — relay that to the user rather than ' +
  'describing these as their latest activity. Draw NO conclusion from what is absent: this is ' +
  'one page, so a sport or bet type missing here may simply be further down, and a bet being ' +
  'present does NOT show the customer is permitted or unrestricted on it. Questions about ' +
  'restrictions are answered by get_customer_risk_profile, never by bet history.';

/**
 * The description the model sees, from contracts/tools.md section 3.
 *
 * The ordering-caveat instruction doubles as FR-009's caveat-relaying requirement,
 * which the protocol smoke test asserts of every tool.
 */
export const FIND_CUSTOMER_BETS_DESCRIPTION =
  "Finds a customer's bets by account identifier, bet identifier, or the bet receipt identifier a " +
  'customer quotes — supply EXACTLY ONE of the three. Returns a risk-shaped view per bet: ' +
  'identifiers, placement time, status, type, jurisdiction, the APPLIED risk figures, wager ' +
  'amounts, and per leg the selection, market, event, competition and sport. Always relay the ' +
  'orderingCaveat. "kind": "none" means nothing matched — report that and do not retry. This tool ' +
  'does NOT explain how any risk figure was derived, and a leg here carries no risk-side ' +
  'catalogue position: use get_bet_risk_context for that.';

export interface FindCustomerBetsArgs {
  readonly accountId?: string | undefined;
  readonly betId?: string | undefined;
  readonly receiptId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FindCustomerBetsResult {
  readonly kind: 'bets' | 'none';
  readonly bets?: Bet[];
  readonly totalMatched?: number;
  readonly orderingCaveat: string;
  readonly limitReached: boolean;
  readonly completeness: Completeness;
}

/** The identifier the caller chose, in the upstream `ids` shape. */
export interface ResolvedIdentifier {
  readonly kind: 'accountId' | 'betId' | 'receiptId';
  readonly value: string;
}

/**
 * Enforce EXACTLY ONE identifier (FR-008, SC-008).
 *
 * Both failure messages name all three choices so the agent can self-correct without
 * the user, and NEITHER echoes a supplied value — all three are personal data
 * (FR-030).
 */
export function resolveIdentifier(args: FindCustomerBetsArgs): ResolvedIdentifier {
  const supplied: ResolvedIdentifier[] = [];
  if (typeof args.accountId === 'string' && args.accountId.trim().length > 0) {
    supplied.push({ kind: 'accountId', value: args.accountId.trim() });
  }
  if (typeof args.betId === 'string' && args.betId.trim().length > 0) {
    supplied.push({ kind: 'betId', value: args.betId.trim() });
  }
  if (typeof args.receiptId === 'string' && args.receiptId.trim().length > 0) {
    supplied.push({ kind: 'receiptId', value: args.receiptId.trim() });
  }

  if (supplied.length === 0) {
    throw argumentError(
      'Exactly one identifier is required, and none was supplied.',
      "Supply exactly one of accountId, betId, or receiptId — accountId for all of a customer's bets, betId for one internal identifier, or receiptId for the reference a customer quotes."
    );
  }

  if (supplied.length > 1) {
    throw argumentError(
      `Exactly one identifier is required, but ${supplied.length} were supplied: ${supplied
        .map((one) => one.kind)
        .join(', ')}.`,
      'Choose one of accountId, betId, or receiptId and omit the others. The values are not repeated here because customer identifiers are personal data.'
    );
  }

  return supplied[0] as ResolvedIdentifier;
}

/**
 * Find a customer's bets.
 *
 * @param client the shared core GMA client
 * @param maxBets the configured cap. From `Config`, never a caller argument beyond the
 *   `limit` narrowing below — a caller may ask for FEWER, never more (Principle V)
 * @param token THIS invocation's operator token — an explicit parameter (FR-023a)
 */
export async function findCustomerBets(
  client: GmaClient,
  maxBets: number,
  token: OperatorToken,
  args: FindCustomerBetsArgs
): Promise<FindCustomerBetsResult> {
  const identifier = resolveIdentifier(args);

  // A caller may narrow the cap but never widen it. Clamping silently would be
  // truncation, which Principle V prohibits — so the clamp is reported below.
  const requested = args.limit ?? maxBets;
  const effectiveLimit = Math.min(requested, maxBets);

  const result = await client.post<QbsSearchBetsResponse>(
    // A LITERAL. No caller value reaches this path, which is what makes the catch-all
    // proxy unreachable with a caller-chosen target (FR-025).
    QBS_GRAPHQL_PATH,
    {
      query: SEARCH_BETS_DOCUMENT,
      operationName: SEARCH_BETS_OPERATION_NAME,
      variables: {
        // Caller values land HERE and nowhere else.
        input: { ids: { [identifier.kind]: [identifier.value] } },
        params: {
          // ZERO-based. `1` would silently ask for the second page and return an empty
          // result set for a bet that exists — see `FIRST_PAGE` for the evidence.
          pageNumber: FIRST_PAGE,
          itemsPerPage: effectiveLimit,
          // Requested upstream rather than only sorted afterwards (research.md R6).
          sort: PLACEMENT_DATE_DESC
        }
      }
    },
    {
      token,
      pathTemplate: QBS_GRAPHQL_PATH,
      tool: 'find_customer_bets',
      hop: 1
    }
  );

  const projected: ProjectedBet[] = toProjectedBets(result.data);
  const bets = projected.map(({ bet }) => bet);
  const upstreamTotal = totalMatched(result.data);

  // Inspect the BODY, not the status. A 200 with `errors[]` is not a complete answer,
  // and this is the assertion the whole feature is most at risk of getting wrong.
  const unavailable = unavailableFromQbs(result.data);
  const completeness = withUnavailableComponents(result.completeness, unavailable);

  // The cap was reached if we filled it, or if upstream says more exist than we hold.
  const limitReached =
    bets.length >= effectiveLimit &&
    (upstreamTotal === null ? bets.length >= effectiveLimit : upstreamTotal > bets.length);

  if (bets.length === 0) {
    // Nothing matched. NOT an error and NOT a caveat (FR-012): the question was
    // answered, and the answer is "no bets". Treating it as either would make the
    // agent either retry or hedge a fact.
    return {
      kind: 'none',
      orderingCaveat: ORDERING_CAVEAT,
      limitReached: false,
      completeness,
      ...(upstreamTotal === null ? {} : { totalMatched: upstreamTotal })
    };
  }

  return {
    kind: 'bets',
    bets,
    orderingCaveat: ORDERING_CAVEAT,
    limitReached,
    completeness,
    ...(upstreamTotal === null ? {} : { totalMatched: upstreamTotal })
  };
}
