import type { Config } from '../../../core/config.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import { resolveInstances } from '../../../core/instances.js';
import type { Completeness } from '../../../core/types.js';
import { malformedResponse } from '../../../core/errors.js';
import type { Ancestor, CatalogueEntity, EntityType } from '../schemas.js';

/**
 * `get_catalogue_entity` — User Story 3 (P3), FR-016.
 *
 * Closes the loop from Story 2: when a human picks from a candidate list, this is how
 * the agent acts on that choice.
 *
 * An unsupported `type` never reaches here — the zod enum in `schemas.ts` rejects it
 * during input validation, before any GMA call is made (SC-008).
 */

/** Which v5 path serves each supported type. */
const PATH_BY_TYPE: Readonly<Record<EntityType, string>> = Object.freeze({
  superclass: '/v5/superclasses',
  subclass: '/v5/subclasses',
  eventType: '/v5/eventTypes'
});

/**
 * The description the model sees, from contracts/tools.md section 3.
 *
 * It points the agent at `find_catalogue_entity` for name-based lookup, so an agent
 * holding only a name does not fabricate an id.
 */
export const GET_CATALOGUE_ENTITY_DESCRIPTION =
  "Retrieves a catalogue entity's details by its type and id — use when you already have an id, " +
  'e.g. one the user chose from a candidate list. To find an entity by name instead, use ' +
  'find_catalogue_entity. Relay any data-completeness caveat to the user.';

/** One `{ id, name }` node plus whatever parent GMA nests inside it. */
interface UpstreamNode {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly superclass?: UpstreamNode | null;
  readonly subclass?: UpstreamNode | null;
}

/** The response shape, keyed by the type requested. */
interface EntityResponse {
  readonly superclass?: UpstreamNode | null;
  readonly subclass?: UpstreamNode | null;
  readonly eventType?: UpstreamNode | null;
}

export interface GetCatalogueEntityArgs {
  readonly type: EntityType;
  readonly id: string;
  readonly instances?: readonly string[] | undefined;
}

export interface GetCatalogueEntityResult {
  readonly entity: CatalogueEntity;
  readonly completeness: Completeness;
}

/**
 * Walk the nested parents GMA returns into a flat ancestor chain.
 *
 * The nesting is narrowest-outward (`eventType.subclass.superclass`), while
 * `ancestors` is broadest-first — the order a human reads a path in — so the collected
 * chain is reversed.
 */
function collectAncestors(node: UpstreamNode, type: EntityType): Ancestor[] {
  const chain: Ancestor[] = [];

  if (type === 'eventType' && node.subclass) {
    const subclass = node.subclass;
    if (typeof subclass.id === 'string') {
      chain.push({ id: subclass.id, name: subclass.name ?? subclass.id, type: 'subclass' });
      const superclass = subclass.superclass;
      if (superclass && typeof superclass.id === 'string') {
        chain.push({
          id: superclass.id,
          name: superclass.name ?? superclass.id,
          type: 'superclass'
        });
      }
    }
    return chain.reverse();
  }

  if (type === 'subclass' && node.superclass) {
    const superclass = node.superclass;
    if (typeof superclass.id === 'string') {
      chain.push({ id: superclass.id, name: superclass.name ?? superclass.id, type: 'superclass' });
    }
  }

  return chain.reverse();
}

/**
 * Retrieve an entity by type and id.
 *
 * @param token THIS invocation's operator token, threaded explicitly (FR-023a)
 */
export async function getCatalogueEntity(
  client: GmaClient,
  config: Config,
  token: OperatorToken,
  args: GetCatalogueEntityArgs
): Promise<GetCatalogueEntityResult> {
  const instances = resolveInstances(args.instances, config);
  const path = `${PATH_BY_TYPE[args.type]}/${encodeURIComponent(args.id)}`;

  // A 404 becomes a `notFound` ToolError in the client, never an empty success (FR-010).
  const result = await client.get<EntityResponse>(path, {
    token,
    instances,
    tool: 'get_catalogue_entity',
    hop: 1
  });

  const node = result.data?.[args.type];

  if (node === null || node === undefined || typeof node.id !== 'string') {
    // A 200 whose body does not carry the entity. Reporting this as an empty success
    // would be the "confidently wrong" failure Principle II exists to prevent.
    throw malformedResponse(`GET ${PATH_BY_TYPE[args.type]}/{id}`);
  }

  return {
    entity: {
      id: node.id,
      name: node.name ?? node.id,
      type: args.type,
      ancestors: collectAncestors(node, args.type)
    },
    completeness: result.completeness
  };
}
