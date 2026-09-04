import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * stdio transport wiring (FR-023).
 *
 * Development and local use only, per constitution Principle I. It is deliberately
 * thin: everything that matters — tools, schemas, identity threading — lives in
 * `register.ts` and the domains, so a Streamable HTTP entrypoint added later is a
 * sibling of this file rather than a rewrite (FR-023b).
 *
 * Note that stdout belongs to the JSON-RPC stream. All logging goes to stderr (see
 * `core/telemetry.ts`), because a stray log line on stdout corrupts the protocol.
 */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
