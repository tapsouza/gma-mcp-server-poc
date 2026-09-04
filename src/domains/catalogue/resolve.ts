import type { Completeness } from '../../core/types.js';
import type { CatalogueEntity } from './schemas.js';

/**
 * Name resolution (FR-014, FR-015, research.md R2).
 *
 * The type below is the requirement. `ResolutionOutcome` is a DISCRIMINATED UNION, so
 * "resolved and candidates both populated" is not a state this code can produce — it
 * is unrepresentable, rather than prevented by a runtime check someone could forget.
 *
 * Traversal is the tool's job; judgment belongs to the model and the human. Auto-
 * picking from more than one plausible match is therefore impossible by construction.
 */

export type ResolutionOutcome =
  /** Exactly one match: resolved, and traversed one level (FR-013, FR-025). */
  | {
      readonly kind: 'resolved';
      readonly entity: CatalogueEntity;
      readonly children: CatalogueEntity[];
    }
  /** More than one match: ALL candidates, none chosen (FR-014). */
  | { readonly kind: 'candidates'; readonly candidates: CatalogueEntity[] }
  /** Zero matches. NOT an error and NOT a caveat (FR-010, Story 2 scenario 3). */
  | { readonly kind: 'none' }
  /** More matches than are useful: no resolution plus a narrowing hint (FR-015). */
  | {
      readonly kind: 'tooBroad';
      readonly matchCount: number;
      readonly narrowBy: readonly string[];
    };

/**
 * What to narrow by when a query is too broad.
 *
 * Named fields rather than a vague "be more specific", because FR-015 requires "an
 * explicit statement of which field to narrow by".
 */
export const NARROW_BY: readonly string[] = Object.freeze(['a more specific name', 'instances']);

/**
 * Decide the resolution outcome from match cardinality.
 *
 * Too-broad is derived HERE, from the result count, because v5 reports no
 * `TOO_MANY_EVENTS` (research.md R2). Client derivation is deterministic and testable
 * and does not depend on an upstream flag that cannot be provoked.
 *
 * The order of these branches matters: too-broad is checked BEFORE the multi-match
 * candidate list, so an unusably long candidate list is never returned as though a
 * human could pick from it.
 */
export function resolveByCardinality(
  matches: readonly CatalogueEntity[],
  maxCandidates: number
): { readonly outcome: ResolutionOutcome; readonly needsTraversal: CatalogueEntity | null } {
  if (matches.length === 0) {
    return { outcome: { kind: 'none' }, needsTraversal: null };
  }

  if (matches.length > maxCandidates) {
    return {
      outcome: { kind: 'tooBroad', matchCount: matches.length, narrowBy: NARROW_BY },
      needsTraversal: null
    };
  }

  if (matches.length === 1) {
    const entity = matches[0]!;
    // `children` is filled by the caller after the traversal hop. It is returned empty
    // here rather than optional, so a caller cannot forget to look for it.
    return {
      outcome: { kind: 'resolved', entity, children: [] },
      needsTraversal: entity
    };
  }

  // More than one plausible answer. Every candidate is returned WITH its ancestor
  // chain, and none is marked resolved. There is deliberately no code path that
  // selects one — not a heuristic, not a "best match", not a first-wins.
  return { outcome: { kind: 'candidates', candidates: [...matches] }, needsTraversal: null };
}

/** Attach the children fetched for a resolved entity. */
export function withChildren(
  outcome: ResolutionOutcome,
  children: CatalogueEntity[]
): ResolutionOutcome {
  if (outcome.kind !== 'resolved') return outcome;
  return { kind: 'resolved', entity: outcome.entity, children };
}

/** Flatten an outcome into the tool's output payload, adding the mandatory verdict. */
export function toToolPayload(
  outcome: ResolutionOutcome,
  completeness: Completeness
): Record<string, unknown> {
  switch (outcome.kind) {
    case 'resolved':
      return {
        kind: 'resolved',
        entity: outcome.entity,
        children: outcome.children,
        completeness
      };
    case 'candidates':
      return { kind: 'candidates', candidates: outcome.candidates, completeness };
    case 'none':
      return { kind: 'none', completeness };
    case 'tooBroad':
      return {
        kind: 'tooBroad',
        matchCount: outcome.matchCount,
        narrowBy: outcome.narrowBy,
        completeness
      };
  }
}
