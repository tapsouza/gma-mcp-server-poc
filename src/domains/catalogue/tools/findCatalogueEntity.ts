import { aggregate, fromTimeoutWithPartialData, fromTooBroad } from '../../../core/completeness.js';
import type { Config } from '../../../core/config.js';
import { isToolError } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import { resolveInstances } from '../../../core/instances.js';
import type { ResolvedOperation } from '../../../core/surface.js';
import type { Completeness } from '../../../core/types.js';
import { mapSearchResults, type SearchByNameResponse } from '../mapSearchResults.js';
import { resolveByCardinality, toToolPayload, withChildren } from '../resolve.js';
import { fetchChildren, type TraversalHandles } from '../traversal.js';

/**
 * `find_catalogue_entity` — User Story 2 (P2). The hero tool.
 *
 * Two hops maximum:
 *   1. the by-name search. Its `instancesList` goes in the REQUEST BODY, unlike the GET
 *      operations which take it as a query parameter — an upstream asymmetry now carried
 *      by the operation table rather than by this tool (001 research.md R3).
 *   2. Only on exactly one match, one level of children (FR-025).
 *
 * **This tool spans two upstream generations on a default deployment**, and does so
 * without knowing it: the search is served by v5 because that is the only generation
 * offering a by-name search at all, while the child hop follows the v4 default. Both
 * arrive as pre-resolved handles, so nothing here chooses or can observe a generation.
 *
 * Completeness is aggregated across BOTH hops regardless of which generation served
 * each, so a 206 on either marks the whole result incomplete (FR-008, SC-011,
 * 003-FR-009, FR-018). The generation boundary is not a boundary for the verdict.
 */

/** The handles this tool needs: the search, plus everything traversal needs. */
export type FindCatalogueEntityHandles = TraversalHandles &
  Readonly<Record<'searchByName', ResolvedOperation>>;

/**
 * The description the model sees, from contracts/tools.md section 2.
 *
 * The instruction not to pick from several matches is here as well as in the type
 * system: the type makes auto-picking impossible for THIS server, and the description
 * stops the agent doing it downstream, in its own reasoning.
 */
export const FIND_CATALOGUE_ENTITY_DESCRIPTION =
  'Finds a catalogue entity (superclass, subclass, or event type) by a partial, case-insensitive ' +
  'name, and returns it with its immediate children. If several entities match, returns ALL of ' +
  'them as candidates without choosing — present the candidates to the user and ask which they ' +
  'mean; do not pick one yourself. If the query is too broad, returns guidance on how to narrow ' +
  'it. Always relay any data-completeness caveat to the user.';

export interface FindCatalogueEntityArgs {
  readonly name: string;
  readonly instances?: readonly string[] | undefined;
}

/**
 * Search by name and resolve.
 *
 * @param token THIS invocation's operator token, threaded explicitly (FR-023a)
 */
export async function findCatalogueEntity(
  client: GmaClient,
  config: Config,
  operations: FindCatalogueEntityHandles,
  token: OperatorToken,
  args: FindCatalogueEntityArgs
): Promise<Record<string, unknown>> {
  // Throws an `argument` ToolError naming `list_instances` for an unknown code, before
  // any GMA call is made (FR-017, SC-008).
  const instances = resolveInstances(args.instances, config);

  // `instances` reaches the request body because this handle declares
  // `instancesIn: 'body'`; the client places it. So narrowing behaves identically here
  // and on the query-parameter operations (003-FR-011).
  const searchResult = await client.call<SearchByNameResponse>(
    operations.searchByName,
    {},
    { name: args.name },
    { token, instances, tool: 'find_catalogue_entity', hop: 1 }
  );

  const hops: Completeness[] = [searchResult.completeness];
  const matches = mapSearchResults(searchResult.data);
  const { outcome, needsTraversal } = resolveByCardinality(matches, config.maxCandidates);

  // Too-broad is incomplete even though every instance answered: no entity was
  // resolved, so the answer is not the whole answer (FR-015).
  if (outcome.kind === 'tooBroad') {
    return toToolPayload(outcome, fromTooBroad(aggregate(hops)));
  }

  if (needsTraversal === null) {
    return toToolPayload(outcome, aggregate(hops));
  }

  // Hop 2. A failure here is NOT fatal to the whole call: hop 1 already produced a
  // usable resolved entity, so FR-010's distinction applies — a timeout with partial
  // data is a caveat, not an error. Only the caller has the context to make that
  // call, which is why the client throws and this layer decides.
  try {
    const traversal = await fetchChildren(client, operations, token, needsTraversal, instances);
    hops.push(traversal.completeness);

    return toToolPayload(withChildren(outcome, traversal.children), aggregate(hops));
  } catch (error) {
    if (isToolError(error) && error.kind === 'auth') {
      // An expired identity must reach the human as an auth failure, never be
      // softened into "here is the entity, minus its children" (FR-003).
      throw error;
    }

    // The entity IS the answer to "find X"; its children are enrichment. Returning
    // the entity with an explicit incompleteness verdict is strictly more useful than
    // discarding it — provided the verdict is unmissable, which is what makes this
    // safe rather than a silent downgrade.
    hops.push(
      fromTimeoutWithPartialData(
        searchResult.completeness.successfulInstances,
        searchResult.completeness.failedInstances,
        searchResult.completeness.errors
      )
    );

    return toToolPayload(withChildren(outcome, []), aggregate(hops));
  }
}
