import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import { urnToCode } from '../../../core/instances.js';
import type { Completeness } from '../../../core/types.js';
import type { BrandInstance } from '../schemas.js';

/**
 * `list_instances` — User Story 1 (P1), FR-011.
 *
 * The thinnest tool that still exercises the entire pipeline: identity forwarded,
 * upstream envelope parsed, completeness produced. It also removes the agent's need
 * to guess brand codes, which is what makes the other two tools usable rather than
 * trial-and-error (FR-017, SC-005).
 */

export const LIST_INSTANCES_OPERATION = '/v5/instances';

/**
 * The description the model sees, from contracts/tools.md section 1.
 *
 * The caveat-relaying instruction is mandatory (FR-009) — an agent that receives a
 * partial list and reports it as the whole list is the failure mode Principle II
 * exists to prevent, and the tool description is where that is prevented.
 */
export const LIST_INSTANCES_DESCRIPTION =
  'Lists the brand instances (e.g. PP, BF) that catalogue queries can be scoped to. ' +
  'Call this first if you need to narrow a query by brand, rather than guessing instance codes. ' +
  'If the result reports failed instances, relay that caveat to the user — the list may be incomplete.';

/** The subset of `GET /v5/instances` this tool reads. */
interface InstancesResponse {
  readonly instances?: readonly { id?: string | null; name?: string | null }[] | null;
  readonly successfulConfigSources?: readonly string[] | null;
}

export interface ListInstancesResult {
  readonly instances: BrandInstance[];
  readonly completeness: Completeness;
}

/**
 * Fetch the brand instances.
 *
 * @param client the shared core GMA client
 * @param token THIS invocation's operator token — an explicit parameter, never read
 *   from state (FR-023a)
 */
export async function listInstances(
  client: GmaClient,
  token: OperatorToken
): Promise<ListInstancesResult> {
  const result = await client.get<InstancesResponse>(LIST_INSTANCES_OPERATION, {
    token,
    tool: 'list_instances',
    hop: 1
  });

  const raw = result.data?.instances ?? [];

  const instances: BrandInstance[] = raw
    .filter((instance) => typeof instance?.id === 'string' && instance.id.length > 0)
    .map((instance) => {
      const id = instance.id as string;
      return {
        // Translate the upstream URN into the short code a person actually says.
        // GMA's URN vocabulary stops here (Principle IV).
        code: urnToCode(id),
        id,
        name: instance.name ?? urnToCode(id)
      };
    });

  // `completeness` is passed through untouched: it is the client's verdict, and this
  // tool has no grounds to soften it. A single-hop tool needs no aggregation.
  return { instances, completeness: result.completeness };
}
