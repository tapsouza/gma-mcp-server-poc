/**
 * The FIXED `searchBets` GraphQL document (FR-024, research.md R4).
 *
 * ## Why this is a string constant and not a builder
 *
 * `POST /qbs/{pathToQbs}` takes both the path AND the query from its caller, and the
 * QBS schema declares mutations — `createBetNote`, `deleteBetNote`, `pinBetNote`,
 * `unpinBetNote`. So the upstream surface would accept a write if one were sent.
 * Constitution Principle IV is explicit that the guard must therefore be structural
 * and that "the request mechanics MUST NOT be relied on as the guard, because a read
 * operation may be issued the same way a write would be" — which is exactly the case
 * here: every read in this domain is a POST.
 *
 * The guarantee is: this document is a compile-time constant with NO interpolation of
 * any kind. Caller values reach `variables` only. `test/unit/readOnly.test.ts` asserts
 * that structurally over the whole domain, so it is a mechanism rather than a promise.
 *
 * ## Why the projection is small
 *
 * The document GMA itself packages requests ~200 fields. This selects the subset a risk
 * question needs (FR-009). Two omissions are requirements rather than curation:
 *
 *  - **`betNotesDetails` is absent entirely.** FR-004 excludes staff-authored notes
 *    about customers, and enforcing that by not ASKING for them is categorically
 *    stronger than filtering after retrieval: the data never enters this process, so
 *    no later mapping bug can leak it.
 *  - **`settlementDetails` / `unsettlementDetails` are absent.** Both carry `settleBy`
 *    and `comment` — an operator's username and their free-text remark. Principle V
 *    keeps people's names out of tool output.
 *
 * `searchBets` is also the only NON-deprecated search entry point: `searchByBetId`,
 * `searchByBetReceipt`, `searchByAccountId` and `searchByBetAndProductId` all carry
 * `@deprecated(reason: "Deprecated in favor of searchBets")` in the QBS schema, and
 * FR-015 forbids building on a deprecated operation where a current variant exists.
 */

/** The upstream path. A literal, never assembled from a caller value. */
export const QBS_GRAPHQL_PATH = '/qbs/graphql';

/** The operation name, sent alongside the document as QBS's request shape expects. */
export const SEARCH_BETS_OPERATION_NAME = 'SearchBets';

/**
 * The document.
 *
 * Note `legs { ... }` selects `sport`, `competition`, `event`, `market` and
 * `selection` with their `entityIds`. The `entityIds` are needed for one reason only:
 * resolving a leg's event to its RISK-side catalogue position, which is the composite's
 * whole purpose (research.md R5). A leg carries no risk-side level of its own.
 */
export const SEARCH_BETS_DOCUMENT = `query ${SEARCH_BETS_OPERATION_NAME}($input: BetSearchInput!, $params: RequestParameters!) {
  searchBets(input: $input, params: $params) {
    pageInfo {
      count
      pages
    }
    results {
      ids {
        betId
        betReceiptId
        accountId
      }
      status
      placementDate
      betType
      instance
      catalogueInstanceId
      productId
      numberOfLines {
        total
      }
      riskInfo {
        stakeFactor
        maxBet
        maxValue
        cumulativeMax
        overlayMax
        liabilityGroup
      }
      wageInfo {
        currency
        stake
        potentialPayout
        winnings
        refunds
      }
      legs {
        legNumber
        placedInPlay
        result
        legPrice {
          numerator
          denominator
        }
        sport {
          name
          entityIds {
            rampId
            gbpId
          }
        }
        competition {
          name
          entityIds {
            rampId
            gbpId
          }
        }
        event {
          name
          entityIds {
            rampId
            gbpId
          }
        }
        market {
          name
          entityIds {
            rampId
            gbpId
          }
        }
        selection {
          name
          entityIds {
            rampId
            gbpId
          }
        }
      }
    }
  }
}`;

/**
 * The sort QBS accepts, verified in the schema's `RequestParameters` and matching the
 * bet-management front-end's own default (research.md R6).
 *
 * This retires one of the spec's three UNVERIFIED assumptions. The spec assumed
 * "nothing in the upstream interface exposes a sort option"; `input RequestParameters
 * { pageNumber, itemsPerPage, sort }` and `enum SortField { PLACEMENT_DATE, … }` say
 * otherwise. FR-010's caveat therefore narrows from "ordering is unknown" to the
 * still-true "this is the first page, not necessarily the global maximum".
 */
export const PLACEMENT_DATE_DESC = Object.freeze({
  field: 'PLACEMENT_DATE',
  order: 'DESC'
});

/**
 * The number of the FIRST page. QBS's `pageNumber` is **ZERO-BASED**.
 *
 * ## Why this is a named constant and not a literal `0`
 *
 * The schema does not say which convention it uses — `pageNumber: Int!` is documented only
 * as "The number of the page requested" — so this was originally assumed to be one-based,
 * and the assumption was WRONG. Two independent sources settle it:
 *
 *  - The bet-management front-end holds a one-based `index` in its own state
 *    (`paginationV2.ts:29` — `{ index: 1, size: 25 }`) and converts on the way out:
 *    `fetchSearchBets(input, pageInfo.index - 1, pageInfo.size)`
 *    (`useDynamicQuery.ts:91`). Its observed wire request for page one is `pageNumber: 0`.
 *  - GMA's own bet export starts at `private int pageNumber = 0`
 *    (`BetExportProgress.java:8`) and increments only after a page returns.
 *
 * ## Why getting this wrong is invisible
 *
 * Sending `1` asks for the SECOND page. For a single-bet lookup that is one page long, the
 * response is a clean HTTP 200 with `pageInfo.count: 0` and no `errors[]` — indistinguishable
 * from "this bet does not exist". So a tool reports an honest "no match" for a bet that is
 * sitting right there in the UI, and nothing anywhere signals a defect. It is the same
 * failure shape as this feature's other identifier bugs: not an error, just a confident
 * wrong answer.
 *
 * A caution for anyone changing this: a fixture cannot catch it. `msw` returns whatever the
 * handler is given regardless of `pageNumber`, so every offline test passes either way. Only
 * a live call can tell, which is why the value is pinned here with its provenance rather
 * than spelled inline at two call sites.
 */
export const FIRST_PAGE = 0;
