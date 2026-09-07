import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../core/config.js';
import { isToolError } from '../../core/errors.js';
import type { GmaClient } from '../../core/gmaClient.js';
import { extractOperatorToken, type RequestIdentitySource } from '../../core/identity.js';
import type { CatalogueOperation, OperationPins, ResolvedOperation } from '../../core/surface.js';
import type { Logger } from '../../core/telemetry.js';
import {
  findCatalogueEntityInputSchema,
  findCatalogueEntityOutputSchema,
  getCatalogueEntityInputSchema,
  getCatalogueEntityOutputSchema,
  listInstancesOutputSchema
} from './schemas.js';
import {
  FIND_CATALOGUE_ENTITY_DESCRIPTION,
  findCatalogueEntity
} from './tools/findCatalogueEntity.js';
import {
  GET_CATALOGUE_ENTITY_DESCRIPTION,
  getCatalogueEntity
} from './tools/getCatalogueEntity.js';
import { LIST_INSTANCES_DESCRIPTION, listInstances } from './tools/listInstances.js';

/**
 * The catalogue domain (constitution Principle III).
 *
 * This domain owns its schemas, its traversal, and its tools. It imports from `core/`
 * and never from another domain — a lint rule fails the build otherwise, so the
 * boundary is a mechanism rather than a convention.
 */

/**
 * The upstream operations this domain uses (contracts §3).
 *
 * The domain declares WHICH operations it needs; `core/surface.ts` owns which generations
 * offer each and what their paths are. That split is what lets a domain own its
 * declarations without `core/` ever importing a domain (Principle III) — the two meet in
 * `server/register.ts`, the one layer permitted to see both.
 */
export const CATALOGUE_OPERATIONS = [
  'listInstances',
  'searchByName',
  'getSuperclass',
  'getSubclass',
  'getEventType',
  'subclassEventTypes'
] as const satisfies readonly CatalogueOperation[];

/**
 * Per-operation generation requirements for this domain.
 *
 * This pin encodes an **upstream fact, not a preference**: v4 has no by-name search of
 * any kind — zero occurrences in its spec, verified 2026-09-07 (research.md R1) — so the
 * search hop must be served by v5 whatever the deployment default is.
 *
 * It is per OPERATION rather than per capability precisely so `find_catalogue_entity` can
 * search on v5 while listing children on the v4 default, within one tool call and one
 * aggregated completeness verdict. A capability-wide pin would drag the child listing onto
 * v5 too and quietly defeat this feature for the tool that matters most (research.md R5).
 *
 * Deleting this line makes the process refuse to start on a v4 default, naming the
 * capability and the operation. That is 003-FR-006 having teeth rather than being a
 * comment — and if upstream ever adds by-name search to v4, deleting this line is the
 * whole migration.
 */
export const CATALOGUE_PINS: OperationPins = Object.freeze({
  searchByName: 'v5'
});

/** The handles a startup resolution hands this domain, one per declared operation. */
export type CatalogueHandles = Readonly<
  Record<(typeof CATALOGUE_OPERATIONS)[number], ResolvedOperation>
>;

export interface DomainDeps {
  readonly config: Config;
  readonly client: GmaClient;
  readonly logger: Logger;
  /**
   * Pre-resolved operation handles. A tool receives these and therefore cannot name a
   * path, name a generation, or choose either — the capability is simply absent from its
   * vocabulary, which is stronger than a rule saying it must not (003-FR-003, FR-012).
   */
  readonly operations: CatalogueHandles;
}

/**
 * Turn a thrown `ToolError` into an MCP tool error.
 *
 * A tool error carries NO completeness — a failure must never be readable as data
 * (FR-010) — and its `kind` is surfaced so the agent can tell "you must fix your
 * arguments" from "your user must re-authenticate" (FR-003, SC-008).
 */
export function toErrorResult(error: unknown): CallToolResult {
  if (isToolError(error)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `[${error.kind}] ${error.message}` }],
      // Deliberately no `structuredContent`: an MCP error result must not resemble a
      // successful payload, and it must never carry a completeness verdict.
      _meta: { kind: error.kind, retryable: error.retryable }
    };
  }

  // An unexpected throw. The message is not surfaced: it has not been vetted for
  // credentials, and FR-020 admits no exception for unexpected paths.
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: '[upstream] An unexpected internal error occurred. The request was not completed.'
      }
    ],
    _meta: { kind: 'upstream', retryable: true }
  };
}

/** Wrap a successful payload as an MCP result carrying both structured and text content. */
export function toSuccessResult(payload: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: payload,
    // The text mirror exists for clients that do not read structuredContent. It is
    // the same object, so the completeness verdict cannot be present in one
    // representation and absent from the other.
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

/** Register every catalogue tool on the given server. */
export function registerCatalogueDomain(server: McpServer, deps: DomainDeps): void {
  const { client, config, logger, operations } = deps;

  server.registerTool(
    'list_instances',
    {
      title: 'List brand instances',
      description: LIST_INSTANCES_DESCRIPTION,
      outputSchema: listInstancesOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (extra) => {
      const startedAt = Date.now();
      try {
        // Identity is extracted from THIS request and threaded as a value. No
        // module-level token, no singleton, no async-local storage (FR-023a).
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await listInstances(client, operations.listInstances, token);

        logger.info({
          tool: 'list_instances',
          aggregateOutcome: result.completeness.outcome,
          instanceCount: result.instances.length,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({
          instances: result.instances,
          completeness: result.completeness
        });
      } catch (error) {
        logger.error({
          tool: 'list_instances',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'find_catalogue_entity',
    {
      title: 'Find a catalogue entity by name',
      description: FIND_CATALOGUE_ENTITY_DESCRIPTION,
      inputSchema: findCatalogueEntityInputSchema,
      outputSchema: findCatalogueEntityOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const payload = await findCatalogueEntity(client, config, operations, token, {
          name: args.name,
          instances: args.instances
        });

        const completeness = payload.completeness as { outcome: string };
        logger.info({
          tool: 'find_catalogue_entity',
          resolution: payload.kind as string,
          matchCount: typeof payload.matchCount === 'number' ? payload.matchCount : undefined,
          aggregateOutcome: completeness.outcome,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult(payload);
      } catch (error) {
        logger.error({
          tool: 'find_catalogue_entity',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'get_catalogue_entity',
    {
      title: 'Get a catalogue entity by id',
      description: GET_CATALOGUE_ENTITY_DESCRIPTION,
      inputSchema: getCatalogueEntityInputSchema,
      outputSchema: getCatalogueEntityOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await getCatalogueEntity(client, config, operations, token, {
          type: args.type,
          id: args.id,
          instances: args.instances
        });

        logger.info({
          tool: 'get_catalogue_entity',
          aggregateOutcome: result.completeness.outcome,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({ entity: result.entity, completeness: result.completeness });
      } catch (error) {
        logger.error({
          tool: 'get_catalogue_entity',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );
}
