import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../core/config.js';
import { createGmaClient, type GmaClient } from '../core/gmaClient.js';
import { createLogger, type Logger } from '../core/telemetry.js';
import { registerCatalogueDomain } from '../domains/catalogue/index.js';
import { health } from './health.js';

/**
 * Transport-agnostic tool registration (FR-023b, SC-010).
 *
 * Nothing in this file — or in any tool it registers — knows how a request arrived.
 * That is the whole point: adding Streamable HTTP later means writing a new
 * transport entrypoint that calls `buildServer` and mounting it at
 * `/mcp/catalogue`. No tool definition changes, and no change to how identity
 * reaches a tool.
 */

export const SERVER_NAME = 'gma-mcp-server';
export const SERVER_VERSION = '0.1.0';

export interface BuildServerDeps {
  readonly config: Config;
  /** Injectable so tests can drive the server against a mocked GMA. */
  readonly client?: GmaClient;
  readonly logger?: Logger;
}

/**
 * Build an MCP server with every domain's tools registered.
 *
 * The `core` client and logger are constructed ONCE and shared, while identity stays
 * per-invocation: the client takes the token as a call argument, so one shared client
 * serving many operators cannot leak one operator's credential into another's request
 * (FR-023a, proven by `test/integration/identityIsolation.test.ts`).
 */
export function buildServer({ config, client, logger }: BuildServerDeps): McpServer {
  const log = logger ?? createLogger(config.logLevel);
  const gmaClient = client ?? createGmaClient({ config, logger: log });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for querying the GMA betting catalogue. Every result carries a "completeness" ' +
        'field: when "complete" is false, the answer was assembled from only some brand ' +
        'instances, and you MUST relay the "caveat" text to the user rather than presenting ' +
        'the data as the whole answer.'
    }
  );

  // The health signal (FR-021), exposed as a resource rather than a tool: it is for
  // automated monitoring, not for the model, and it answers with no caller identity.
  server.registerResource(
    'healthcheck',
    'health://gma-mcp-server',
    {
      title: 'Health check',
      description: 'Liveness signal for automated monitoring. Requires no caller identity.',
      mimeType: 'application/json'
    },
    () => ({
      contents: [
        {
          uri: 'health://gma-mcp-server',
          mimeType: 'application/json',
          text: JSON.stringify(health(SERVER_NAME, SERVER_VERSION))
        }
      ]
    })
  );

  // Each domain registers its own tools. Adding a domain is additive — a new folder
  // and one more call here, with no rewrite of an existing domain (Principle III).
  registerCatalogueDomain(server, { config, client: gmaClient, logger: log });

  return server;
}
