import type { GmaClient } from '../../core/gmaClient.js';
import type { OperatorToken } from '../../core/identity.js';
import { complete } from '../../core/completeness.js';
import type { Completeness } from '../../core/types.js';
import type { Ancestor, CatalogueEntity } from './schemas.js';

/**
 * One-level child resolution (FR-025).
 *
 * ONE level, never deeper. That is the shallowest depth that still exercises
 * multi-hop completeness aggregation — the correctness behaviour this slice exists to
 * prove — while keeping too-broad and partial-failure exposure bounded. Going one
 * step further, to `/v5/eventTypes/{id}/events`, would reach GMA's 200-event cap and
 * make the common path fragile (research.md R2).
 */

/** GMA path templates. Never interpolated into a log field (Principle V). */
const SUBCLASS_EVENT_TYPES = '/v5/subclasses/{id}/eventTypes';
const SUPERCLASS = '/v5/superclasses/{id}';

/**
 * The subset of a child-listing response this module reads.
 *
 * `entities` — NOT `eventTypes` — is the key a subclass's event-type listing arrives
 * under. Both generations declare that operation's `200` as `EntitiesResponse`, which
 * is `{ entities: Entity[] }`, and GMA's own delegate
 * (`SearchCatalogueApiDelegateImpl.searchEventTypesByInstancesAndSubclassId`) builds
 * exactly that. Reading `eventTypes` here made every matched subclass report an empty
 * `children` list under a fully-successful completeness verdict — the confidently-wrong
 * answer Principle II exists to prevent (research.md R8 defect 1).
 */
interface ChildrenResponse {
  readonly entities?: readonly { id?: string | null; name?: string | null }[] | null;
  readonly superclass?: {
    readonly subclasses?: readonly { id?: string | null; name?: string | null }[] | null;
  } | null;
  readonly subclasses?: readonly { id?: string | null; name?: string | null }[] | null;
}

export interface TraversalResult {
  readonly children: CatalogueEntity[];
  /**
   * This hop's verdict. `COMPLETE` with no instances when no hop was made, which is
   * the neutral element for aggregation — an event type has no children in scope, and
   * "no second hop" must not look like a failure.
   */
  readonly completeness: Completeness;
}

function toChildren(
  raw: readonly { id?: string | null; name?: string | null }[] | null | undefined,
  type: CatalogueEntity['type'],
  ancestors: readonly Ancestor[]
): CatalogueEntity[] {
  return (raw ?? [])
    .filter((child) => typeof child?.id === 'string' && child.id.length > 0)
    .map((child) => ({
      id: child.id as string,
      name: child.name ?? (child.id as string),
      type,
      // A child's ancestry is its parent's ancestry plus its parent, so an agent can
      // present a child with the same distinguishing detail as a search candidate.
      ancestors: [...ancestors]
    }));
}

/**
 * Fetch the matched entity's immediate children.
 *
 * - matched `subclass` -> `GET /v5/subclasses/{id}/eventTypes`
 * - matched `superclass` -> `GET /v5/superclasses/{id}` (children arrive inline)
 * - matched `eventType` -> NO second hop; its children would be events (out of scope)
 *
 * @param token THIS invocation's token, threaded explicitly (FR-023a)
 */
export async function fetchChildren(
  client: GmaClient,
  token: OperatorToken,
  entity: CatalogueEntity,
  instances: readonly string[]
): Promise<TraversalResult> {
  const parentAncestry: Ancestor[] = [
    ...entity.ancestors,
    { id: entity.id, name: entity.name, type: entity.type }
  ];

  if (entity.type === 'eventType') {
    // No hop at all. A neutral COMPLETE verdict, so aggregation is unaffected: the
    // absence of children here is a fact about scope, not an incomplete answer.
    return { children: [], completeness: complete() };
  }

  if (entity.type === 'subclass') {
    const result = await client.get<ChildrenResponse>(
      `/v5/subclasses/${encodeURIComponent(entity.id)}/eventTypes`,
      { token, instances, tool: 'find_catalogue_entity', hop: 2 }
    );

    return {
      children: toChildren(result.data?.entities, 'eventType', parentAncestry),
      completeness: result.completeness
    };
  }

  const result = await client.get<ChildrenResponse>(
    `/v5/superclasses/${encodeURIComponent(entity.id)}`,
    { token, instances, tool: 'find_catalogue_entity', hop: 2 }
  );

  // GMA nests the subclasses under the superclass on this operation; accept the flat
  // shape too rather than returning "no children" if the envelope differs.
  const raw = result.data?.superclass?.subclasses ?? result.data?.subclasses;

  return {
    children: toChildren(raw, 'subclass', parentAncestry),
    completeness: result.completeness
  };
}

/** Exported for the traversal test, so the path templates are asserted, not guessed. */
export const TRAVERSAL_PATHS = Object.freeze({
  subclassEventTypes: SUBCLASS_EVENT_TYPES,
  superclass: SUPERCLASS
});
