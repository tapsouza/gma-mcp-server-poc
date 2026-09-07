import type { ToolSet } from 'ai';
import type { AgentConfig } from '../config.js';
import type { OperatorCredential } from '../auth/resolve.js';
import { registerSecret } from '../repl/render.js';
import { spawnChild, type SpawnedChild } from './spawn.js';

/**
 * The child session's lifecycle: spawn, teardown, and — the interesting one — respawn
 * with a new credential (data-model.md §6, FR-023).
 *
 * **Respawn is the ONLY mechanism for token rotation**, not a design preference. Two
 * facts leave no alternative:
 *
 * 1. A child process's environment is immutable after spawn.
 * 2. stdio carries no per-request identity channel — `src/core/identity.ts:115-125`
 *    reads `extra?.authInfo?.token` first, and `authInfo` is populated only when the
 *    transport performed OAuth, which stdio never does. That file says so outright:
 *    stdio "has no HTTP request to carry a bearer".
 *
 * So the only way to give the server a new token is to give it a new process. The
 * conversation survives because it is held by the REPL, not by the child (FR-006).
 */

/** How the harness learns the child is gone, so it can stop accepting unanswerable input. */
export type ChildExitListener = (info: { code: number | null; signal: string | null }) => void;

export interface ChildSession {
  /** The discovered capability set. Re-discovered after every respawn (FR-003). */
  readonly tools: ToolSet;
  /** The child's most recent diagnostics, for a failure message (FR-012). */
  stderrLines(): readonly string[];
  /** True once the child has exited, whether or not we asked it to. */
  hasExited(): boolean;
  /**
   * Replace the child with one holding a new credential, and re-discover its
   * capabilities. Prints nothing — the caller narrates, because recovery must never be
   * silent (FR-023, Story 5 AC-3) and the caller owns the renderer.
   */
  respawn(accessToken: string): Promise<void>;
  /** Terminate the child and close the client. Must leave no orphan (Story 1 AC-6). */
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  readonly config: AgentConfig;
  readonly credential: OperatorCredential;
  /** Called for each stderr line as it arrives, when `--verbose` is on (FR-012). */
  readonly onStderrLine?: ((line: string) => void) | undefined;
  /** Called when the child exits unexpectedly (Edge Cases). */
  readonly onExit?: ChildExitListener | undefined;
}

/**
 * Spawn the child, discover its capabilities, and return a session that owns both.
 *
 * Capability discovery is `await mcpClient.tools()` — the harness declares NO schemas.
 * The server is the single source of truth for names, arguments, and descriptions
 * (FR-003), because a second copy would drift, and drift means the model sees a
 * description the server no longer has.
 */
export async function openSession(options: OpenSessionOptions): Promise<ChildSession> {
  const { config, credential, onStderrLine, onExit } = options;

  // Registered before the child exists, so no line printed from this point on can
  // contain the credential verbatim (FR-014).
  registerSecret(credential.accessToken);

  let child = await spawnChild({
    config,
    accessToken: credential.accessToken,
    onStderrLine
  });
  let tools = (await child.mcpClient.tools()) as ToolSet;
  let exited = false;
  let closing = false;

  const watchExit = (current: SpawnedChild): void => {
    // `onclose` fires for a child that died on its own AND for one we closed. The
    // distinction matters: telling the engineer "the server exited" as they type
    // `/exit` would be noise, and a respawn's teardown would report a false failure.
    current.transport.onclose = () => {
      if (closing) return;
      exited = true;
      onExit?.({ code: null, signal: null });
    };
  };
  watchExit(child);

  return {
    get tools() {
      return tools;
    },

    stderrLines: () => child.stderr.lines(),

    hasExited: () => exited,

    async respawn(accessToken: string): Promise<void> {
      registerSecret(accessToken);

      // Tear down first. Two children holding the same stdio pair is not a state worth
      // reasoning about, and an orphaned process outlives the session (Story 1 AC-6).
      closing = true;
      try {
        await child.mcpClient.close();
      } catch {
        // A child that is already gone is the case we are recovering from.
      }
      closing = false;

      child = await spawnChild({ config, accessToken, onStderrLine });
      // Re-discovered rather than reused: the new child is a new server instance, and
      // assuming its surface matches would be exactly the drift FR-003 forbids.
      tools = (await child.mcpClient.tools()) as ToolSet;
      exited = false;
      watchExit(child);
    },

    async close(): Promise<void> {
      closing = true;
      try {
        await child.mcpClient.close();
      } catch {
        // Closing an already-dead child is not a failure worth reporting on exit.
      }
      exited = true;
    }
  };
}
