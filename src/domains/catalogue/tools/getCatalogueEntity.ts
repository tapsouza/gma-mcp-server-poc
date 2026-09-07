import type { Config } from '../../../core/config.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import { resolveInstances } from '../../../core/instances.js';
import type { CatalogueOperation, ResolvedOperation } from '../../../core/surface.js';
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

/**
 * Which logical operation serves each supported type.
 *
 * A map of OPERATION IDS, not paths: `core/surface.ts` owns the path for each, per
 * generation. This is the whole `PATH_BY_TYPE` map that used to live here, minus the
 * only part of it that could be wrong twice (003-FR-003).
 */
const OPERATION_BY_TYPE = Object.freeze({
  superclass: 'getSuperclass',
  subclass: 'getSubclass',
  eventType: 'getEventType'
}) satisfies Readonly<Record<EntityType, CatalogueOperation>>;

/** The handles this tool needs: one entity-get operation per supported type. */
export type GetCatalogueEntityHandles = Readonly<
  Record<(typeof OPERATION_BY_TYPE)[EntityType], ResolvedOperation>
>;

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

/**
 * One entity, with its ancestry as the FLAT SCALARS GMA actually returns.
 *
 * Both generations declare ancestry this way: `Subclass` carries
 * `superclassId` / `superclassName`; `EventType` adds `subclassId` / `subclassName`.
 * Neither schema nests a `superclass` or `subclass` object, and GMA's domain records
 * (`gbp.gma.domain.catalogue.Subclass`, `.EventType`) carry exactly these flat fields.
 *
 * Walking nested parent objects here made `ancestors` always `[]`, silently removing
 * the very field the schema describes as how two same-named entities are told apart
 * (research.md R8 defect 2, 001-FR-014).
 */
interface UpstreamNode {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly superclassId?: string | null;
  readonly superclassName?: string | null;
  readonly subclassId?: string | null;
  readonly subclassName?: string | null;
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

/** An ancestry id is usable only if it is a non-blank string — see `collectAncestors`. */
function usableId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive the ancestor chain from the flat scalars GMA returns (data-model.md §8).
 *
 * Built broadest-first — superclass, then subclass — which is the order a human reads
 * a path in, and the order the `ancestors` contract already promised. No reversal is
 * needed: unlike a nested walk, the scalars are read in the order they are emitted.
 *
 * A superclass has no parent, so its chain is empty.
 *
 * A missing or blank scalar yields a SHORTER chain rather than a fabricated entry. An
 * invented ancestor id is worse than a shorter path, because an agent may then try to
 * fetch it and get a `notFound` for an entity that never existed.
 */
function collectAncestors(node: UpstreamNode, type: EntityType): Ancestor[] {
  const chain: Ancestor[] = [];

  if (type === 'superclass') return chain;

  const superclassId = usableId(node.superclassId);
  if (superclassId !== null) {
    chain.push({
      id: superclassId,
      name: usableId(node.superclassName) ?? superclassId,
      type: 'superclass'
    });
  }

  if (type === 'eventType') {
    const subclassId = usableId(node.subclassId);
    if (subclassId !== null) {
      chain.push({
        id: subclassId,
        name: usableId(node.subclassName) ?? subclassId,
        type: 'subclass'
      });
    }
  }

  return chain;
}

/**
 * Retrieve an entity by type and id.
 *
 * @param token THIS invocation's operator token, threaded explicitly (FR-023a)
 */
export async function getCatalogueEntity(
  client: GmaClient,
  config: Config,
  operations: GetCatalogueEntityHandles,
  token: OperatorToken,
  args: GetCatalogueEntityArgs
): Promise<GetCatalogueEntityResult> {
  const instances = resolveInstances(args.instances, config);
  const operation = operations[OPERATION_BY_TYPE[args.type]];

  // The id is interpolated and percent-encoded by the client, beside the path templates.
  // A 404 becomes a `notFound` ToolError there, never an empty success (FR-010).
  const result = await client.call<EntityResponse>(operation, { id: args.id }, undefined, {
    token,
    instances,
    tool: 'get_catalogue_entity',
    hop: 1
  });

  const node = result.data?.[args.type];

  if (node === null || node === undefined || typeof node.id !== 'string') {
    // A 200 whose body does not carry the entity. Reporting this as an empty success
    // would be the "confidently wrong" failure Principle II exists to prevent.
    //
    // The label is the LOGICAL operation id, so agent-visible error text reads
    // `getSubclass` rather than a versioned upstream path (003-FR-012, research.md R7).
    throw malformedResponse(operation.operation);
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
