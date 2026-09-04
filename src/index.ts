#!/usr/bin/env node
import { loadConfig } from './core/config.js';
import { createLogger } from './core/telemetry.js';
import { isToolError } from './core/errors.js';
import { buildServer } from './server/register.js';
import { startStdio } from './server/stdio.js';

/**
 * Entrypoint.
 *
 * Order is load-bearing: configuration is validated BEFORE the transport is
 * connected, so a misconfigured deployment refuses to start rather than starting and
 * failing at the first request (FR-019, SC-007).
 */
async function main(): Promise<void> {
  // Throws a `config` ToolError naming the offending variable. Nothing is served
  // until this returns.
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const server = buildServer({ config, logger });
  await startStdio(server);

  logger.info({ event: 'server.started' });
}

main().catch((error: unknown) => {
  // stderr, not stdout: stdout is the JSON-RPC stream.
  if (isToolError(error) && error.kind === 'config') {
    process.stderr.write(`Refusing to start: ${error.message}\n`);
    process.exit(78); // EX_CONFIG — a configuration error, not a crash.
  }

  process.stderr.write(
    `Failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`
  );
  process.exit(1);
});
