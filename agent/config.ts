/**
 * Harness configuration (data-model.md §1, contracts/config.md).
 *
 * Validated ONCE, before the child is spawned (FR-010). A missing or invalid value
 * stops the harness with a message naming that value, and the child is never started
 * (SC-005) — which matters because the child's own complaint arrives on a stderr pipe
 * nobody is reading yet.
 */

/** The child's log level. Mirrors `src/core/config.ts`'s `LogLevel` without importing it. */
export type ChildLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly ChildLogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * `us.anthropic.claude-sonnet-5` is a STARTING GUESS, not a known-good value
 * (research.md R3): Bedrock model access is granted per AWS account, so a `403` here
 * is a configuration fix via `AGENT_MODEL_ID`, never a code change (FR-009, SC-014).
 */
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-5';

/**
 * The child defaults to `warn`, not the server's own `info` (contracts/config.md §6).
 * At `info` the server's log lines scribble over the prompt mid-typing. Still
 * configurable via `LOG_LEVEL` (FR-013).
 */
export const DEFAULT_CHILD_LOG_LEVEL: ChildLogLevel = 'warn';

export interface AgentConfig {
  /** Forwarded to the child. */
  readonly gmaBaseUrl: string;
  /** Forwarded to the child, as the original comma-separated string. */
  readonly defaultInstances: string;
  /** Forwarded to the child, and checked against a cached credential's issuer (FR-019). */
  readonly oktaIssuer: string;
  /**
   * Read but NOT validated here — checked lazily, only when the credential ladder
   * actually reaches device login (FR-016, FR-033). Validating it eagerly would break
   * the supplied-token path for everyone until an Okta application exists.
   */
  readonly oktaClientId: string | undefined;
  readonly modelId: string;
  /** Read by the harness for the Bedrock provider. NEVER forwarded to the child. */
  readonly awsRegion: string;
  /** `GMA_USER_TOKEN`, when the engineer supplied one. Wins outright (FR-015 step 1). */
  readonly suppliedToken: string | undefined;
  readonly childLogLevel: ChildLogLevel;
  /** Optional child settings, forwarded only when set. */
  readonly gmaTimeoutMs: string | undefined;
  readonly gmaMaxCandidates: string | undefined;
  readonly verbose: boolean;
}

/**
 * DELIBERATELY ABSENT from `AgentConfig`: AWS credentials.
 *
 * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` are read by
 * the Bedrock provider straight from `process.env` and never enter this object. The
 * absence IS the mechanism: a value that is not in the config cannot be forwarded to
 * the child by a future edit that spreads the config into the child's environment
 * (FR-011). `agent/test/spawn.test.ts` asserts the child never receives them.
 */

/** A configuration problem. Carries no credential material, on any path (FR-014). */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** An absolute http(s) URL, matching `src/core/config.ts`'s rule for the same values. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function requireVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = present(env[name]);
  if (value === undefined) {
    throw new AgentConfigError(
      `Missing required configuration: ${name}. Set it in .env (see .env.example). ` +
        `The harness refuses to start rather than spawning a server against an unknown target.`
    );
  }
  return value;
}

function requireUrlVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireVar(env, name);
  if (!isAbsoluteHttpUrl(value)) {
    throw new AgentConfigError(`Invalid configuration: ${name} must be an absolute http(s) URL.`);
  }
  return value;
}

export interface LoadAgentConfigOptions {
  readonly verbose?: boolean;
}

/**
 * Read and validate the harness's configuration.
 *
 * **Validation ordering is load-bearing** (data-model.md §1): the three values the
 * CHILD requires are checked first, because a failure there is the most likely first
 * experience of this feature and must produce the clearest message. `AWS_REGION`
 * follows, then the optionals with defaults.
 *
 * @param env the process environment, injected so the suite needs no global mutation
 * @throws AgentConfigError naming the specific offending variable (FR-010, SC-005)
 */
export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadAgentConfigOptions = {}
): AgentConfig {
  // --- 1. The three the child cannot start without. ---
  const gmaBaseUrl = requireUrlVar(env, 'GMA_BASE_URL');

  const defaultInstances = requireVar(env, 'GMA_DEFAULT_INSTANCES');
  const codes = defaultInstances
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  if (codes.length === 0) {
    throw new AgentConfigError(
      'Invalid configuration: GMA_DEFAULT_INSTANCES must list at least one instance code.'
    );
  }

  const oktaIssuer = requireUrlVar(env, 'OKTA_ISSUER');

  // --- 2. The harness's own required value. ---
  const awsRegion = requireVar(env, 'AWS_REGION');

  // --- 3. Optionals with defaults. ---
  const modelId = present(env.AGENT_MODEL_ID) ?? DEFAULT_MODEL_ID;

  const rawLogLevel = present(env.LOG_LEVEL);
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(rawLogLevel as ChildLogLevel)) {
    throw new AgentConfigError(
      `Invalid configuration: LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`
    );
  }
  const childLogLevel = (rawLogLevel as ChildLogLevel | undefined) ?? DEFAULT_CHILD_LOG_LEVEL;

  return Object.freeze({
    gmaBaseUrl,
    defaultInstances,
    oktaIssuer,
    // Read, never validated here — see the field's doc comment (FR-016, FR-033).
    oktaClientId: present(env.OKTA_CLIENT_ID),
    modelId,
    awsRegion,
    suppliedToken: present(env.GMA_USER_TOKEN),
    childLogLevel,
    gmaTimeoutMs: present(env.GMA_TIMEOUT_MS),
    gmaMaxCandidates: present(env.GMA_MAX_CANDIDATES),
    verbose: options.verbose ?? false
  });
}
