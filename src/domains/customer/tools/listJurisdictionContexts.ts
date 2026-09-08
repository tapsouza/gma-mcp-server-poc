import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import type { Completeness } from '../../../core/types.js';
import type { JurisdictionRef } from '../schemas.js';

/**
 * `list_jurisdiction_contexts` — the customer domain's scoping-discovery tool.
 *
 * This tool exists because constitution Principle V requires one: "A discovery tool
 * MUST exist for any scoping vocabulary an agent is expected to supply, so codes are
 * looked up rather than guessed." `get_customer_betting_metrics` takes jurisdiction
 * codes as a filter, and those codes are provably not derivable — `NJ` and `PA` are
 * two-letter, but Ontario's is `NXTCANBS` against a catalogue jurisdiction of
 * `urn:i:FD:CA-ON`. A hardcoded table is PROHIBITED by constitution v1.2.0 for the
 * reason that matters most: it would fail *confidently* as jurisdictions are added.
 *
 * It is also the composite's third hop (`get_bet_risk_context`), where the same list
 * is the PRIMARY jurisdiction-matching mechanism and derivation is only a fallback.
 * That is why this lives in the foundational phase rather than inside a story: two
 * capabilities consume it and neither owns it.
 *
 * This is the customer domain's analogue of the catalogue's `list_instances`, and the
 * shapes are deliberately parallel so both read the same way to a model.
 */

/** The registered operation, and its own log/error template (they are identical here). */
export const LIST_JURISDICTION_CONTEXTS_OPERATION = '/crs/contexts';

/**
 * The description the model sees, from contracts/tools.md section 1.
 *
 * The caveat-relaying instruction is mandatory for every tool (FR-009), and
 * `test/protocol/smoke.test.ts` asserts the word "relay" appears in every
 * description. The final sentence carries the honesty property specific to a
 * discovery tool: an incomplete list is not evidence that the missing jurisdiction
 * does not exist, and an agent that concludes otherwise would tell an operator a
 * jurisdiction is unsupported when it merely was not returned.
 */
export const LIST_JURISDICTION_CONTEXTS_DESCRIPTION =
  'Lists the jurisdictions (US states and territories) that customer risk settings and betting ' +
  'metrics can be scoped to. Call this before passing any jurisdictions filter — the codes are ' +
  'NOT derivable from a state name. Most are two-letter (NJ, PA) but not all. ' +
  'If the result is incomplete, relay the caveat to the user: a jurisdiction missing from this ' +
  'list is not evidence that it does not exist.';

/**
 * The subset of `GET /crs/contexts` this tool reads.
 *
 * Note the shape: a BARE ARRAY, not an object with a `contexts` key. Verified against
 * `@flutter-global/gma-client`, whose `fetchCrsContexts` is typed
 * `Promise<ContextEntity[]>` and returns the body unwrapped. This is upstream
 * vocabulary and it stops at this file.
 */
type CrsContextsResponse = readonly {
  readonly contextId?: string | null;
  readonly contextCode?: string | null;
  readonly contextName?: string | null;
}[];

export interface ListJurisdictionContextsResult {
  readonly jurisdictions: JurisdictionRef[];
  readonly completeness: Completeness;
}

/**
 * Fetch the platform's jurisdiction contexts.
 *
 * @param client the shared core GMA client
 * @param token THIS invocation's operator token — an explicit parameter, never read
 *   from state (FR-023a)
 */
export async function listJurisdictionContexts(
  client: GmaClient,
  token: OperatorToken
): Promise<ListJurisdictionContextsResult> {
  const result = await client.get<CrsContextsResponse>(LIST_JURISDICTION_CONTEXTS_OPERATION, {
    token,
    // Identical to the path here, and passed explicitly anyway: every customer-domain
    // call states its template, so a later edit that adds a path parameter cannot
    // silently start logging an interpolated value (research.md R13).
    pathTemplate: LIST_JURISDICTION_CONTEXTS_OPERATION,
    tool: 'list_jurisdiction_contexts',
    hop: 1
  });

  // A defensive `Array.isArray`: this surface is a raw forwarding proxy with no
  // declared contract, so its body shape is not schema-guaranteed the way v5's is.
  const raw: CrsContextsResponse = Array.isArray(result.data) ? result.data : [];

  const jurisdictions: JurisdictionRef[] = raw
    // A context with no code is unusable as a filter value, and inventing one would
    // hand the agent a code that cannot work. Drop it rather than fabricate.
    .filter((context) => typeof context?.contextCode === 'string' && context.contextCode.length > 0)
    .map((context) => {
      const code = context.contextCode as string;
      return {
        // Upstream `contextCode`/`contextId`/`contextName` vocabulary is translated
        // HERE and goes no further (Principle IV).
        code,
        id: context.contextId ?? code,
        // Falls back to the code rather than to a fabricated pretty name: a wrong
        // human-readable name is worse than a terse correct one.
        name: context.contextName ?? code
      };
    });

  // `completeness` is passed through untouched: it is the client's verdict and this
  // tool has no grounds to soften it. A single-hop tool needs no aggregation.
  return { jurisdictions, completeness: result.completeness };
}
