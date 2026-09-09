import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../core/config.js';
import { isToolError } from '../../core/errors.js';
import type { GmaClient } from '../../core/gmaClient.js';
import { extractOperatorToken, type RequestIdentitySource } from '../../core/identity.js';
import type { Logger } from '../../core/telemetry.js';
import {
  findCatalogueEntityInputSchema,
  findCatalogueEntityOutputSchema,
  getCatalogueEntityInputSchema,
  getCatalogueEntityOutputSchema,
  getEventInputSchema,
  getEventOutputSchema,
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
import { GET_EVENT_DESCRIPTION, getEvent } from './tools/getEvent.js';
import { LIST_INSTANCES_DESCRIPTION, listInstances } from './tools/listInstances.js';

/**
 * The catalogue domain (constitution Principle III).
 *
 * This domain owns its schemas, its traversal, and its tools. It imports from `core/`
 * and never from another domain — a lint rule fails the build otherwise, so the
 * boundary is a mechanism rather than a convention.
 */

export interface DomainDeps {
  readonly config: Config;
  readonly client: GmaClient;
  readonly logger: Logger;
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
  const { client, config, logger } = deps;

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
        const result = await listInstances(client, token);

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
        const payload = await findCatalogueEntity(client, config, token, {
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
        const result = await getCatalogueEntity(client, config, token, {
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

  server.registerTool(
    'get_event',
    {
      title: 'Get a sporting event by id',
      description: GET_EVENT_DESCRIPTION,
      inputSchema: getEventInputSchema,
      outputSchema: getEventOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await getEvent(client, config, token, {
          id: args.id,
          instances: args.instances
        });

        logger.info({
          tool: 'get_event',
          aggregateOutcome: result.completeness.outcome,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({ event: result.event, completeness: result.completeness });
      } catch (error) {
        logger.error({
          tool: 'get_event',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );
}
