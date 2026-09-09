// `.env` is loaded by `node --env-file-if-exists=.env` in the `agent` npm script, NOT by
// this file (contracts/config.md). Two reasons, both discovered by running it:
//
//  1. **A body statement cannot come first.** ESM `import` declarations are hoisted, so
//     the in-code `loadEnvFile` call this file used to open with still ran AFTER
//     `./repl/loop.js` — and therefore after `@ai-sdk/amazon-bedrock` — was evaluated.
//     The ordering this file used to claim to guarantee was never achieved. The flag is
//     applied by the runtime before any module is evaluated, so it genuinely holds.
//  2. **In-code loading leaks the repository's `.env` into tests.** `agent/test/cli.test.ts`
//     spawns this entrypoint with a deliberately minimal environment to assert the
//     fail-fast exit codes (FR-010, SC-005). `loadEnvFile` does not overwrite variables
//     that are already set, but it does FILL IN the ones the test omitted — so a
//     developer machine with a working `.env` turned both of those tests green by
//     supplying exactly the values the test had removed. Requiring an explicit flag makes
//     the isolation structural: a spawn that does not ask for `.env` cannot receive it.
//
// The flag preserves the previous precedence exactly: a variable already present in the
// real environment wins over the file, and a missing `.env` is not an error. A missing
// REQUIRED value is reported by `loadAgentConfig` below, naming the variable.

import { createInterface } from 'node:readline/promises';
import { AgentConfigError, loadAgentConfig, type AgentConfig } from './config.js';
import { refreshCredential, deviceLogin, MissingClientIdError } from './auth/deviceFlow.js';
import {
  IssuerMismatchError,
  NoCredentialError,
  noCredentialGuidance,
  resolveCredential,
  type DeviceFlowCollaborators,
  type OperatorCredential
} from './auth/resolve.js';
import { createFileCredentialStore, type CredentialStore } from './auth/store.js';
import { openSession, type ChildSession } from './mcp/session.js';
import { ChildSpawnError } from './mcp/spawn.js';
import { dispatch } from './repl/commands.js';
import { runTurnWithRecovery, type Conversation } from './repl/loop.js';
import { createRenderer, terminalInput, terminalOutput, type Renderer } from './repl/render.js';

/**
 * The harness entrypoint (contracts/cli.md).
 *
 * Order is load-bearing and mirrors `src/index.ts`'s own reasoning: configuration is
 * validated BEFORE the child is spawned, so a misconfigured setup refuses to start
 * rather than starting and failing at the first request (FR-010, SC-005). It matters
 * more here than there, because the child's own complaint arrives on a stderr pipe
 * nobody is reading yet.
 */

/** Exit codes, per contracts/cli.md. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
/** `78` deliberately matches the child's own `EX_CONFIG` (`src/index.ts:31`). */
export const EXIT_CONFIG = 78;
export const EXIT_NO_CREDENTIAL = 77;
export const EXIT_CHILD_FAILED = 70;

interface ParsedArgs {
  readonly verbose: boolean;
  readonly unknown: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const unknown: string[] = [];
  let verbose = false;

  for (const arg of argv) {
    if (arg === '--verbose') verbose = true;
    else unknown.push(arg);
  }

  return { verbose, unknown };
}

/** Describe WHICH credential is in use and how it was obtained — never the credential. */
function describeCredential(credential: OperatorCredential): string {
  switch (credential.source) {
    case 'env':
      return 'signed in with the token supplied in GMA_USER_TOKEN';
    case 'cache':
      return 'signed in with the stored credential';
    case 'refresh':
      return 'signed in with a renewed stored credential';
    case 'device':
      return 'signed in via device login';
  }
}

/**
 * The device-flow collaborators, or `undefined` when device login is unavailable.
 *
 * Returning `undefined` rather than a stub that throws is what makes the ladder produce
 * the FR-022 administrator message instead of an opaque failure: `resolveCredential`
 * branches on availability, not on catching an error.
 */
function deviceFlowFor(config: AgentConfig, render: Renderer): DeviceFlowCollaborators | undefined {
  if (config.oktaClientId === undefined) return undefined;

  return {
    refresh: (refreshToken) => refreshCredential({ config, refreshToken }),
    login: () => deviceLogin({ config, render })
  };
}

async function main(): Promise<number> {
  const render = createRenderer();
  const { verbose, unknown } = parseArgs(process.argv.slice(2));

  if (unknown.length > 0) {
    render.failure(`Unknown argument: ${unknown[0]}. The only flag is --verbose.`);
    return EXIT_USAGE;
  }

  // --- Validate configuration. Nothing is spawned until this returns (FR-010). ---
  let config: AgentConfig;
  try {
    config = loadAgentConfig(process.env, { verbose });
  } catch (error) {
    if (error instanceof AgentConfigError) {
      render.failure(`Refusing to start: ${error.message}`);
      return EXIT_CONFIG;
    }
    throw error;
  }

  // --- Resolve the credential. ---
  const store: CredentialStore = createFileCredentialStore();
  let credential: OperatorCredential;
  try {
    credential = await resolveCredential({
      config,
      now: Date.now,
      store,
      deviceFlow: deviceFlowFor(config, render)
    });
  } catch (error) {
    if (error instanceof MissingClientIdError) {
      // Reached device login without an Okta application. The full administrator ask
      // rather than "client id missing", so the engineer can act today (FR-022).
      render.failure(noCredentialGuidance(config.oktaIssuer));
      return EXIT_NO_CREDENTIAL;
    }
    if (error instanceof NoCredentialError || error instanceof IssuerMismatchError) {
      render.failure(error.message);
      return EXIT_NO_CREDENTIAL;
    }
    throw error;
  }

  // --- Spawn the child and discover its capabilities. ---
  let session: ChildSession;
  let childExited = false;
  try {
    session = await openSession({
      config,
      credential,
      // Buffered by default so server output cannot corrupt the prompt mid-typing
      // (FR-012, Story 2 AC-3); echoed live only under `--verbose`.
      onStderrLine: verbose ? (line) => render.childDiagnostic(line) : undefined,
      onExit: () => {
        childExited = true;
        render.failure(
          'The catalogue server exited. No further questions can be answered — leave with /exit and start again.'
        );
      }
    });
  } catch (error) {
    if (error instanceof ChildSpawnError) {
      render.failure(error.message);
      // The child's own explanation — this is where
      // `Refusing to start: Missing required configuration: OKTA_ISSUER` lives
      // (FR-012, SC-006).
      for (const line of error.stderrLines) render.childDiagnostic(line);
      return EXIT_CHILD_FAILED;
    }
    throw error;
  }

  const toolNames = Object.keys(session.tools);
  render.status(describeCredential(credential));
  render.status(`spawned gma-mcp-server (${toolNames.length} tools)`);

  // --- The prompt loop. ---
  const conversation: Conversation = [];
  const readline = createInterface({ input: terminalInput, output: terminalOutput });
  let interrupt: AbortController | undefined;

  /**
   * Ctrl-D — end of input — resolves to `undefined`, which exits (contracts/cli.md).
   *
   * `readline.question()` alone does NOT do this: on `close` its promise neither resolves
   * nor rejects, so the loop hangs forever and the engineer's only way out is killing the
   * process — leaving the child orphaned, the exact failure Story 1 AC-6 forbids. Racing
   * the question against the `close` event is what makes EOF a real exit path.
   */
  let closed = false;
  readline.once('close', () => {
    closed = true;
  });

  const readLine = async (): Promise<string | undefined> => {
    if (closed) return undefined;
    return Promise.race([
      readline.question('> ').catch(() => undefined),
      new Promise<undefined>((resolve) => readline.once('close', () => resolve(undefined)))
    ]);
  };

  // Ctrl-C stops the answer in progress and returns to the prompt. It does NOT exit the
  // harness and does NOT touch the child, which stays healthy (Edge Cases) — leaving is
  // `/exit` or Ctrl-D.
  readline.on('SIGINT', () => {
    if (interrupt !== undefined) {
      interrupt.abort();
      return;
    }
    render.notice('(interrupted — /exit or Ctrl-D to leave)');
    readline.prompt();
  });

  try {
    for (;;) {
      const line = await readLine();
      if (line === undefined) break;

      const outcome = dispatch(line, render);
      if (outcome.kind === 'exit') break;
      if (outcome.kind === 'handled') continue;
      if (outcome.kind === 'clear') {
        conversation.length = 0;
        render.notice('conversation cleared');
        continue;
      }

      if (childExited || session.hasExited()) {
        render.failure(
          'The catalogue server is no longer running. Leave with /exit and start again.'
        );
        continue;
      }

      conversation.push({ role: 'user', content: outcome.text });

      interrupt = new AbortController();
      let turn;
      try {
        // Recovery lives in `loop.ts` rather than here, so the at-most-one-retry rule
        // (FR-023, Story 5 AC-5) is assertable by `agent/test/recovery.test.ts` without a
        // real identity provider. This function only supplies the collaborators.
        turn = await runTurnWithRecovery({
          config,
          tools: session.tools,
          render,
          conversation,
          signal: interrupt.signal,
          recovery: {
            renew: async () => {
              const recovered = await recoverCredential({ config, credential, store, render });
              if (recovered === undefined) return undefined;
              credential = recovered;
              return credential.accessToken;
            },
            respawn: (accessToken) => session.respawn(accessToken),
            // Re-read AFTER the respawn: the new child is a new server instance, and
            // reusing the old tool set would be exactly the drift FR-003 forbids.
            toolsAfterRespawn: () => session.tools
          }
        });
      } catch (error) {
        reportTurnFailure(error, config, render);
        // The conversation is deliberately NOT discarded, so the engineer may retry
        // (Edge Cases). The unanswered user message is dropped, though, since leaving it
        // would make the next turn look like a reply to it.
        conversation.pop();
        continue;
      } finally {
        interrupt = undefined;
      }

      if (turn.aborted) {
        conversation.pop();
        render.notice('(interrupted)');
      }
    }
  } finally {
    readline.close();
    // No orphan process (Story 1 AC-6).
    await session.close();
  }

  return EXIT_OK;
}

interface RecoverDeps {
  readonly config: AgentConfig;
  readonly credential: OperatorCredential;
  readonly store: CredentialStore;
  readonly render: Renderer;
}

/**
 * Renew an expired credential, or explain why it cannot be renewed.
 *
 * `runTurnWithRecovery` has already announced the authentication failure, so this says
 * only what is specific to renewing — recovery is narrated, never silent (FR-023,
 * Story 5 AC-3), but not narrated twice.
 */
async function recoverCredential(deps: RecoverDeps): Promise<OperatorCredential | undefined> {
  const { config, credential, store, render } = deps;

  // A `source: 'env'` credential carries no refresh token, so attempting a refresh is
  // doomed rather than merely unlikely (Story 5 AC-4). Say what to do instead.
  if (credential.source === 'env' || credential.refreshToken === undefined) {
    render.failure(
      'The credential in use cannot be renewed automatically — it was supplied directly ' +
        'and carries no refresh token. Set GMA_USER_TOKEN to a new token and restart the harness, ' +
        'or unset it to sign in interactively.'
    );
    return undefined;
  }

  try {
    const refreshed = await refreshCredential({ config, refreshToken: credential.refreshToken });
    store.write(refreshed);
    return {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: refreshed.expires_at,
      issuer: refreshed.issuer,
      source: 'refresh'
    };
  } catch (error) {
    // Terminal: a revoked or expired refresh token will not become valid on a retry.
    render.failure(
      `Could not renew the credential: ${error instanceof Error ? error.message : 'unknown error'}. ` +
        'Sign in again — delete the stored credential if it keeps failing.'
    );
    return undefined;
  }
}

/**
 * Report a turn that failed before producing an answer.
 *
 * An unusable model is a CONFIGURATION problem and must name `AGENT_MODEL_ID`
 * (Edge Cases, SC-014): Bedrock model access is granted per AWS account, so the default
 * is a starting guess and a `403` is fixed by setting a variable, not by changing code.
 */
function reportTurnFailure(error: unknown, config: AgentConfig, render: Renderer): void {
  const message = error instanceof Error ? error.message : 'unknown error';
  const lower = message.toLowerCase();

  const looksLikeModelAccess =
    lower.includes('accessdenied') ||
    lower.includes('access denied') ||
    lower.includes('not authorized') ||
    lower.includes('403') ||
    lower.includes("don't have access") ||
    lower.includes('validationexception') ||
    lower.includes('could not resolve model') ||
    lower.includes('invalid model');

  if (looksLikeModelAccess) {
    render.failure(
      `The configured model could not be used: ${message}\n` +
        `This is a configuration problem, not a failure of the catalogue server. ` +
        `AGENT_MODEL_ID is currently "${config.modelId}" — set it to a model this AWS account ` +
        `can invoke in ${config.awsRegion}, then run the harness again.`
    );
    return;
  }

  const looksLikeAwsAuth = lower.includes('aws_access_key_id') || lower.includes('sigv4');
  if (looksLikeAwsAuth) {
    render.failure(
      `The model service rejected the AWS credentials: ${message}\n` +
        'Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if using SSO).'
    );
    return;
  }

  // Unreachable or rate-limited: the conversation is kept, so a retry costs nothing but
  // the retyped question (Edge Cases).
  render.failure(`The model service failed: ${message}\nThe conversation is intact — try again.`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A last-resort handler. Everything expected is already handled above with a
    // specific exit code, so reaching here is a genuine defect — and even then the
    // message goes through the renderer, so a credential cannot leak on the way out
    // (FR-014, SC-008).
    createRenderer().failure(
      `Unexpected failure: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    process.exitCode = 1;
  });
