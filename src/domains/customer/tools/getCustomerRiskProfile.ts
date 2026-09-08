import { argumentError } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import type { Completeness } from '../../../core/types.js';
import type { CustomerRiskConfiguration, JurisdictionRef } from '../schemas.js';
import { toRiskConfigurations, type CrsAccountRiskSettings } from '../mapping/riskConfiguration.js';

/**
 * `get_customer_risk_profile` — User Story 1 (P1), FR-005 to FR-007.
 *
 * ONE hop. No catalogue calls: GMA already enriches every override with its full named
 * ancestor chain, and Principle IV forbids duplicating resolution GMA has done
 * (research.md R3).
 *
 * ## The honesty rule specific to this tool
 *
 * CRS publishes NO partial-failure signal — `/crs/**` is a raw forwarding proxy that
 * appears in no OpenAPI spec (research.md R2). Constitution Principle II is explicit
 * about what that means: "Where a surface publishes no partial-failure signal at all …
 * a tool MUST NOT invent one." So this tool returns a COMPLETE answer or a TOOL ERROR,
 * and never synthesises a partial verdict. The composite is where a CRS failure becomes
 * `unavailableComponents: ['customerRiskConfiguration']`, because there it is one
 * section of a larger answer; here it is the whole answer.
 *
 * ## Privacy
 *
 * The account identifier is in the request path, which makes it a PII leak the moment
 * it reaches a log line or an error message. Two defences, both required:
 *
 *  - `pathTemplate` is passed, so neither the logged `path` nor the `operation` label
 *    interpolated into a tool-visible message carries the value (research.md R13).
 *  - Local validation NEVER echoes the rejected value (FR-030).
 */

/** The path template — the only form of this path that may reach a log or a message. */
export const GET_CUSTOMER_RISK_PROFILE_TEMPLATE = '/crs/accounts/{accountId}';

/**
 * The description the model sees, from contracts/tools.md section 2.
 *
 * Two instructions here are load-bearing rather than decorative. "Never summarise
 * across jurisdictions" is the FR-006 rule expressed where it actually takes effect —
 * an agent that averages three states' stake factors produces a number that is true of
 * no jurisdiction the customer bets in. And the caveat-relaying sentence is mandatory
 * for every tool (FR-009), asserted by the protocol smoke test.
 */
export const GET_CUSTOMER_RISK_PROFILE_DESCRIPTION =
  "Returns a customer's risk configuration for EVERY jurisdiction they have one in — each with " +
  'its own stake factor, liability group, in-running delay, payout limits, winnings cap, ' +
  'eligibility, and hierarchy-level overrides. There is no single global configuration: a ' +
  'customer may be restricted in one state and unrestricted in another, so NEVER summarise, ' +
  'average, or collapse across jurisdictions — report each one separately. Each override lists ' +
  'the named catalogue path it applies to, so you do not need a second lookup. A null value ' +
  'means unset, which is NOT the same as zero. If the result is incomplete, relay the caveat ' +
  'verbatim rather than presenting the configurations as the whole picture.';

export interface GetCustomerRiskProfileArgs {
  readonly accountId: string;
}

export interface GetCustomerRiskProfileResult {
  readonly accountId: string;
  readonly jurisdictionConfigurations: CustomerRiskConfiguration[];
  readonly completeness: Completeness;
}

/**
 * Validate an account identifier's SHAPE locally, without echoing it.
 *
 * The message describes the expected form and names no value — FR-030, and the reason
 * is not squeamishness: an error message goes to the model's context and then usually
 * into a user-visible reply, so echoing the identifier publishes it twice over.
 *
 * The shape check is deliberately loose. This server does not own the account
 * identifier format, and a strict pattern would reject valid accounts confidently,
 * which is worse than forwarding a doubtful one and letting CRS answer `404`. What it
 * does catch is the shape that would corrupt the request itself.
 */
function validateAccountId(accountId: string): string {
  const trimmed = accountId.trim();

  if (trimmed.length === 0) {
    throw argumentError(
      'An account identifier is required.',
      'Supply the customer account identifier as a non-empty value.'
    );
  }

  // A path separator or whitespace would change which upstream resource is addressed,
  // and `/crs/**` is a catch-all proxy — so this is a read-only guard, not a nicety.
  if (/[\s/?#]/.test(trimmed)) {
    throw argumentError(
      'The account identifier is not in the expected form: it must be a single value with no whitespace, slashes, or URL punctuation.',
      'Correct the identifier and try again. The value you supplied is not repeated here because account identifiers are personal data.'
    );
  }

  return trimmed;
}

/**
 * Fetch a customer's risk configuration, one entry per jurisdiction.
 *
 * @param client the shared core GMA client
 * @param token THIS invocation's operator token — an explicit parameter, never read
 *   from state (FR-023a)
 * @param resolveJurisdiction optional enrichment for jurisdiction code and name. The
 *   composite passes its fetched context list; this tool alone does not fetch one,
 *   because a second hop that can fail is a poor trade for a prettier label.
 */
export async function getCustomerRiskProfile(
  client: GmaClient,
  token: OperatorToken,
  args: GetCustomerRiskProfileArgs,
  resolveJurisdiction?: (contextId: string) => JurisdictionRef
): Promise<GetCustomerRiskProfileResult> {
  const accountId = validateAccountId(args.accountId);

  const result = await client.get<CrsAccountRiskSettings>(
    `/crs/accounts/${encodeURIComponent(accountId)}`,
    {
      token,
      // WITHOUT this, a 404 would produce "GMA returned HTTP 404 for GET
      // /crs/accounts/12345" in a message the agent relays to a human.
      pathTemplate: GET_CUSTOMER_RISK_PROFILE_TEMPLATE,
      tool: 'get_customer_risk_profile',
      hop: 1
    }
  );

  const jurisdictionConfigurations = toRiskConfigurations(result.data, resolveJurisdiction);

  // `completeness` is passed through untouched. This tool never softens it and never
  // manufactures one: CRS declares no partial-failure contract, so the only honest
  // verdicts are the client's `complete` or a thrown `ToolError` (research.md R2).
  return {
    accountId,
    jurisdictionConfigurations,
    completeness: result.completeness
  };
}
