import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { AgentConfig } from '../config.js';

/**
 * Spawning the catalogue server as a child process (contracts/child-process.md).
 *
 * **The transport comes from `@modelcontextprotocol/sdk`, not from `@ai-sdk/mcp`**
 * (research.md R1). This is not a preference: FR-012 requires the child's stderr be
 * captured and shown when startup fails, and the AI SDK's `StdioMCPTransport` keeps its
 * `ChildProcess` in a private field with no accessor, so a piped stderr stream is
 * unreachable. The MCP SDK's transport exposes a `stderr` getter.
 *
 * The substitution is legal because `@ai-sdk/mcp` accepts a custom transport
 * STRUCTURALLY — `isCustomMcpTransport` checks only for callable `start`, `send`, and
 * `close`, all of which `StdioClientTransport` has.
 */

/** What the server's entrypoint is. Built by `npm run build`, which `npm run agent` runs first. */
export const CHILD_COMMAND = 'node';
export const CHILD_ARGS = ['dist/index.js'] as const;

/**
 * How many of the child's most recent stderr lines to retain.
 *
 * Bounded rather than unbounded because a long `LOG_LEVEL=debug` session would
 * otherwise grow without limit for output nobody reads. Bounded keeps the MOST RECENT
 * lines — which are the ones explaining a failure that just happened (data-model.md §6).
 */
export const STDERR_BUFFER_LINES = 200;

/** A bounded ring buffer of the child's diagnostics. */
export interface StderrBuffer {
  push(line: string): void;
  /** Most recent lines, oldest first. */
  lines(): readonly string[];
}

export function createStderrBuffer(capacity: number = STDERR_BUFFER_LINES): StderrBuffer {
  const buffer: string[] = [];

  return {
    push(line: string): void {
      buffer.push(line);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    },
    lines(): readonly string[] {
      return buffer;
    }
  };
}

/**
 * Build the child's environment as an explicit ALLOWLIST.
 *
 * Never the parent's environment. That is not defensive coding: the transport strips
 * everything except `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` (research.md R4),
 * so these values must be passed deliberately or the child exits `78`.
 *
 * The allowlist is POSITIVE by construction — the child gets what is named here and
 * nothing else — which is why no AWS credential can arrive by being forgotten (FR-011).
 * `agent/test/spawn.test.ts` asserts the child does not receive one.
 *
 * @param accessToken the RESOLVED credential, whatever rung of the ladder produced it
 */
export function buildChildEnv(config: AgentConfig, accessToken: string): Record<string, string> {
  const env: Record<string, string> = {
    GMA_BASE_URL: config.gmaBaseUrl,
    GMA_DEFAULT_INSTANCES: config.defaultInstances,
    OKTA_ISSUER: config.oktaIssuer,
    // The server reads its operator identity from this variable under stdio
    // (`src/core/identity.ts`), which has no HTTP request to carry a bearer.
    GMA_USER_TOKEN: accessToken,
    LOG_LEVEL: config.childLogLevel
  };

  if (config.gmaTimeoutMs !== undefined) env.GMA_TIMEOUT_MS = config.gmaTimeoutMs;
  if (config.gmaMaxCandidates !== undefined) env.GMA_MAX_CANDIDATES = config.gmaMaxCandidates;

  return env;
}

export interface SpawnedChild {
  readonly transport: StdioClientTransport;
  readonly mcpClient: MCPClient;
  readonly stderr: StderrBuffer;
}

export interface SpawnOptions {
  readonly config: AgentConfig;
  readonly accessToken: string;
  /** Called for each stderr line as it arrives — used for `--verbose` (FR-012). */
  readonly onStderrLine?: ((line: string) => void) | undefined;
  /** Where to run the child from. Defaults to the harness's own cwd. */
  readonly cwd?: string | undefined;
}

/**
 * Spawn the server and connect an MCP client to it.
 *
 * Throws when the child cannot be spawned or the handshake fails. The caller is
 * expected to dump `stderr.lines()` and exit `70` — that is where
 * `Refusing to start: Missing required configuration: OKTA_ISSUER` lives (FR-012, SC-006).
 */
export async function spawnChild(options: SpawnOptions): Promise<SpawnedChild> {
  const { config, accessToken, onStderrLine, cwd } = options;
  const stderr = createStderrBuffer();

  const transport = new StdioClientTransport({
    command: CHILD_COMMAND,
    args: [...CHILD_ARGS],
    env: buildChildEnv(config, accessToken),
    // Neither `inherit` nor `ignore` is acceptable: `inherit` lets server logs
    // scribble over the prompt mid-typing, and `ignore` makes the single most likely
    // first failure completely silent (contracts/child-process.md).
    stderr: 'pipe',
    ...(cwd === undefined ? {} : { cwd })
  });

  // Attached BEFORE `start()`, which `createMCPClient` triggers: the MCP SDK returns a
  // PassThrough immediately when `stderr: 'pipe'` is requested, precisely so a caller
  // can subscribe before the process exists and miss nothing.
  const stderrStream = transport.stderr;
  if (stderrStream !== null) {
    let partial = '';
    stderrStream.on('data', (chunk: Buffer | string) => {
      partial += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = partial.split('\n');
      // The final element is an incomplete line; hold it until its newline arrives.
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        stderr.push(line);
        onStderrLine?.(line);
      }
    });
  }

  try {
    const mcpClient = await createMCPClient({
      transport,
      clientName: 'gma-agent-harness',
      version: '0.1.0'
    });

    return { transport, mcpClient, stderr };
  } catch (error) {
    // Give the child's own explanation a moment to arrive on the pipe. Without this,
    // a config failure races the rejection and the buffer is dumped empty — which is
    // exactly the failure FR-012 exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Re-thrown with the buffer attached so the caller need not reach for the transport.
    throw new ChildSpawnError(
      error instanceof Error ? error.message : 'unknown error',
      stderr.lines()
    );
  }
}

/** Spawn or handshake failed. The child's own diagnostics ride along (FR-012). */
export class ChildSpawnError extends Error {
  readonly stderrLines: readonly string[];

  constructor(detail: string, stderrLines: readonly string[]) {
    super(`Could not start the catalogue server: ${detail}`);
    this.name = 'ChildSpawnError';
    this.stderrLines = stderrLines;
  }
}
