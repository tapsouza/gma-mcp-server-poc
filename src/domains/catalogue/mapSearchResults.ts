import type { Ancestor, CatalogueEntity, EntityType } from './schemas.js';

/**
 * Mapping `POST /v5/searchByName` results to candidates (research.md R3).
 *
 * A `SearchByNameResult` is a HIERARCHY TRIPLE, not a flat entity:
 * `{ superclass?, subclass?, eventType? }`. The most specific populated field is the
 * entity that matched; the rest are its ancestors.
 *
 * Preserving that chain is not cosmetic. FR-014 requires "distinguishing detail" per
 * candidate, and the ancestor path IS that detail: three event types all named
 * "Winner" are separable only by whether they sit under Football/Premier League,
 * Rugby/Six Nations, or Tennis/Wimbledon. Flattening to `{id, name}` would discard
 * exactly what a human needs in order to choose.
 */

/** One `{ id, name }` node as GMA returns it. */
interface UpstreamEntity {
  readonly id?: string | null;
  readonly name?: string | null;
}

/** One search result triple. */
export interface SearchByNameResult {
  readonly superclass?: UpstreamEntity | null;
  readonly subclass?: UpstreamEntity | null;
  readonly eventType?: UpstreamEntity | null;
}

export interface SearchByNameResponse {
  readonly results?: readonly SearchByNameResult[] | null;
}

/** Broadest to narrowest — the containment chain, which fixes ancestor order. */
const HIERARCHY: readonly { field: keyof SearchByNameResult; type: EntityType }[] = [
  { field: 'superclass', type: 'superclass' },
  { field: 'subclass', type: 'subclass' },
  { field: 'eventType', type: 'eventType' }
];

/** A node is usable only if it has an id; a nameless one falls back to its id. */
function toNode(raw: UpstreamEntity | null | undefined): { id: string; name: string } | null {
  const id = raw?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, name: raw?.name ?? id };
}

/**
 * Convert one triple into a `CatalogueEntity`.
 *
 * `type` is derived from the most specific populated field, and `ancestors` from the
 * broader ones in containment order. Returns `null` when the triple is entirely
 * empty — better to drop an unusable result than to synthesise an entity with no id
 * that an agent would then try to fetch.
 */
export function toCatalogueEntity(result: SearchByNameResult): CatalogueEntity | null {
  const populated = HIERARCHY.map(({ field, type }) => ({
    type,
    node: toNode(result[field])
  })).filter(
    (entry): entry is { type: EntityType; node: { id: string; name: string } } =>
      entry.node !== null
  );

  if (populated.length === 0) return null;

  // The last populated level is the match; everything broader is an ancestor.
  const matched = populated[populated.length - 1]!;
  const ancestors: Ancestor[] = populated.slice(0, -1).map((entry) => ({
    id: entry.node.id,
    name: entry.node.name,
    type: entry.type
  }));

  return {
    id: matched.node.id,
    name: matched.node.name,
    type: matched.type,
    ancestors
  };
}

/**
 * Convert a whole response into candidates.
 *
 * Deduplicates by id, since the same entity can be reported by more than one brand
 * instance: an agent presenting the same entity three times reads as three plausible
 * answers when there is only one.
 */
export function mapSearchResults(response: SearchByNameResponse | null): CatalogueEntity[] {
  const results = response?.results ?? [];
  const byId = new Map<string, CatalogueEntity>();

  for (const result of results) {
    const entity = toCatalogueEntity(result);
    if (entity === null) continue;
    if (!byId.has(entity.id)) byId.set(entity.id, entity);
  }

  return [...byId.values()];
}
