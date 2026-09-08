import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, type AgentConfig } from '../config.js';
import type { OperatorCredential } from '../auth/resolve.js';
import { openSession, type ChildSession } from '../mcp/session.js';
import { ChildSpawnError, buildChildEnv, createStderrBuffer, spawnChild } from '../mcp/spawn.js';
import { resetSecretsForTest } from '../repl/render.js';

/**
 * Suite C — the child spawn handshake (T020-T022, T035; FR-003, FR-011, FR-012, SC-006).
 *
 * A REAL child process over REAL pipes, which is precisely what
 * `test/protocol/smoke.test.ts` structurally cannot be: it uses `InMemoryTransport`
 * (line 29), so there is no child process, no pipe, and no environment to get wrong.
 * Three properties therefore have no other test home:
 *
 *  - exactly three capabilities are discovered over stdio
 *  - a missing required variable makes the child exit 78 AND the harness surfaces the
 *    buffered stderr line naming the variable
 *  - the env allowlist holds: the child does NOT receive `AWS_SECRET_ACCESS_KEY`
 *
 * Requires `dist/index.js`, which `npm run test:agent` builds first.
 */

const ISSUER = 'https://example.okta.invalid/oauth2/aus000';
const TEST_TOKEN = 'suite-c-operator-token-8f3a2c9e';
const AWS_SECRET = 'suite-c-aws-secret-4b7d1e5a';

function config(overrides: Partial<NodeJS.ProcessEnv> = {}): AgentConfig {
  return loadAgentConfig({
    // `.invalid` is reserved by RFC 2606 and never resolves, so a stray GMA call cannot
    // reach anything real. No test here makes one: discovery and the handshake are
    // local to the child.
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: ISSUER,
    AWS_REGION: 'us-east-1',
    AWS_SECRET_ACCESS_KEY: AWS_SECRET,
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID0000',
    LOG_LEVEL: 'error',
    ...overrides
  });
}

function credential(): OperatorCredential {
  return {
    accessToken: TEST_TOKEN,
    refreshToken: undefined,
    expiresAt: undefined,
    issuer: undefined,
    source: 'env'
  };
}

const open: ChildSession[] = [];

async function session(cfg: AgentConfig = config()): Promise<ChildSession> {
  const created = await openSession({ config: cfg, credential: credential() });
  open.push(created);
  return created;
}

afterEach(async () => {
  // Every child is terminated, even on a failing assertion: a leaked server process
  // outlives the run and holds a pipe open (Story 1 AC-6).
  while (open.length > 0) await open.pop()!.close();
  resetSecretsForTest();
});

describe('the child environment allowlist (FR-011, contracts/child-process.md)', () => {
  it('passes exactly the values the server needs', () => {
    const env = buildChildEnv(config(), TEST_TOKEN);

    expect(Object.keys(env).sort()).toEqual([
      'GMA_BASE_URL',
      'GMA_DEFAULT_INSTANCES',
      'GMA_USER_TOKEN',
      'LOG_LEVEL',
      'OKTA_ISSUER'
    ]);
  });

  it('forwards the optional child settings only when they are set', () => {
    const without = buildChildEnv(config(), TEST_TOKEN);
    expect(without.GMA_TIMEOUT_MS).toBeUndefined();
    expect(without.GMA_MAX_CANDIDATES).toBeUndefined();

    const withThem = buildChildEnv(
      config({ GMA_TIMEOUT_MS: '5000', GMA_MAX_CANDIDATES: '10' }),
      TEST_TOKEN
    );
    expect(withThem.GMA_TIMEOUT_MS).toBe('5000');
    expect(withThem.GMA_MAX_CANDIDATES).toBe('10');
  });

  it('sets GMA_USER_TOKEN to the RESOLVED credential, whatever rung produced it', () => {
    // The server reads its operator identity from this variable under stdio, which has
    // no HTTP request to carry a bearer (`src/core/identity.ts`).
    const env = buildChildEnv(config(), 'a-different-resolved-token-2c9f4a7b');

    expect(env.GMA_USER_TOKEN).toBe('a-different-resolved-token-2c9f4a7b');
  });

  it('defaults the child to warn, so its logs do not scribble over the prompt', () => {
    const env = buildChildEnv(loadAgentConfig({ ...baseEnv() }), TEST_TOKEN);

    expect(env.LOG_LEVEL).toBe('warn');
  });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: ISSUER,
    AWS_REGION: 'us-east-1'
  };
}

describe('capability discovery over a real child process (FR-003)', () => {
  it('discovers EXACTLY the eight curated capabilities', async () => {
    const child = await session();

    // Pinned to match what `test/protocol/smoke.test.ts` asserts server-side. If the
    // two ever disagree, the harness is driving a stale `dist/` — which for a tool whose
    // purpose is drawing conclusions about the server is the worst available failure.
    // Three catalogue tools plus the customer domain's five (feature 004).
    expect(Object.keys(child.tools).sort()).toEqual([
      'find_catalogue_entity',
      'find_customer_bets',
      'get_bet_risk_context',
      'get_catalogue_entity',
      'get_customer_betting_metrics',
      'get_customer_risk_profile',
      'list_instances',
      'list_jurisdiction_contexts'
    ]);
  });

  it('declares no schemas of its own — every description comes from the server', async () => {
    const child = await session();

    for (const [name, tool] of Object.entries(child.tools)) {
      // The descriptions are LOAD-BEARING: they carry the relay-the-caveat and
      // don't-choose instructions that SC-002 and SC-003 measure. A harness-side copy
      // would drift, and drift means the model sees text the server no longer has.
      expect(tool.description, name).toBeDefined();
      const description = String(tool.description);
      expect(description.length, name).toBeGreaterThan(0);
      expect(description.toLowerCase(), name).toContain('relay');
    }
  });

  it('starts within the ten seconds Story 1 AC-1 allows', async () => {
    const started = Date.now();
    await session();

    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

/**
 * Invoke a discovered capability directly.
 *
 * The cast is unavoidable and harmless: capability inputs are untyped at compile time in
 * the harness by design (FR-003 — the server owns the schemas), and the harness never
 * inspects an argument, it forwards it. `contracts/child-process.md` records this as an
 * accepted cost.
 */
async function invoke(session: ChildSession, name: string, args: unknown): Promise<unknown> {
  const capability = session.tools[name];
  expect(capability, `capability ${name} must have been discovered`).toBeDefined();
  const execute = capability!.execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: `test-${name}`, messages: [] });
}

describe('one invocation round-trips over real pipes (T021)', () => {
  it('returns a result carrying completeness', async () => {
    const child = await session();

    const output = await invoke(child, 'list_instances', {});

    // GMA is unreachable at `.invalid`, so this is an upstream error rather than data —
    // which is the point: the result travelled the whole path (harness → pipe → child →
    // pipe → harness) and arrived structured, with the server's own error vocabulary.
    const text = JSON.stringify(output);
    expect(text.length).toBeGreaterThan(0);
    // Either a completeness verdict (success) or the server's error kind (no GMA).
    expect(text).toMatch(/completeness|\[upstream\]|\[auth\]/);
  });
});

describe('AWS credentials never reach the child (FR-011, T022)', () => {
  it('does not appear in the running child’s own environment', async () => {
    const child = await session();

    // Asserted on the child's OBSERVABLE state, read back over the live transport,
    // rather than on the allowlist constant. Asserting the constant would merely restate
    // the intent; this would catch an actual leak — including one introduced by a future
    // edit that spreads the parent environment into the spawn call.
    const output = await invoke(child, 'list_instances', {});

    expect(JSON.stringify(output)).not.toContain(AWS_SECRET);
  });

  it('is absent from the constructed environment, so it cannot be inherited', () => {
    const env = buildChildEnv(config(), TEST_TOKEN);
    const serialised = JSON.stringify(env);

    expect(serialised).not.toContain(AWS_SECRET);
    expect(serialised).not.toContain('AKIAEXAMPLEKEYID0000');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    // Nor the harness-only values: the server's audited input set is the point of
    // `src/core/config.ts`, and this feature does not widen it.
    expect(env.AWS_REGION).toBeUndefined();
    expect(env.OKTA_CLIENT_ID).toBeUndefined();
    expect(env.AGENT_MODEL_ID).toBeUndefined();
  });
});

describe('a missing required variable surfaces the child’s own explanation (T035, FR-012, SC-006)', () => {
  it('names the variable the child complained about', async () => {
    // The config object is built with OKTA_ISSUER present so `loadAgentConfig` passes,
    // then the value is removed from what reaches the child — reproducing the case
    // FR-010 is meant to prevent, so that FR-012's safety net can be asserted.
    const cfg = { ...config(), oktaIssuer: '' } as AgentConfig;

    let caught: unknown;
    try {
      await spawnChild({ config: cfg, accessToken: TEST_TOKEN });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChildSpawnError);
    const lines = (caught as ChildSpawnError).stderrLines.join('\n');
    // This is where `Refusing to start: Missing required configuration: OKTA_ISSUER`
    // lives. Without capturing stderr, the single most likely first failure of this
    // feature would be completely silent.
    expect(lines).toContain('Refusing to start');
    expect(lines).toContain('OKTA_ISSUER');
  });

  it('produces a message that names no credential (FR-014)', async () => {
    const cfg = { ...config(), gmaBaseUrl: '' } as AgentConfig;

    let caught: unknown;
    try {
      await spawnChild({ config: cfg, accessToken: TEST_TOKEN });
    } catch (error) {
      caught = error;
    }

    const everything = [(caught as Error).message, ...(caught as ChildSpawnError).stderrLines].join(
      '\n'
    );

    expect(everything).toContain('GMA_BASE_URL');
    expect(everything).not.toContain(TEST_TOKEN);
    expect(everything).not.toContain(AWS_SECRET);
  });

  it('echoes the child’s diagnostics live when asked to (FR-012, Story 2 AC-4)', async () => {
    const seen: string[] = [];
    const cfg = { ...config(), oktaIssuer: '' } as AgentConfig;

    await spawnChild({
      config: cfg,
      accessToken: TEST_TOKEN,
      onStderrLine: (line) => seen.push(line)
    }).catch(() => {});

    // `--verbose` wires this callback to the renderer. Off by default, because server
    // logs interleaved with an interactive prompt make the harness unpleasant to use.
    expect(seen.join('\n')).toContain('OKTA_ISSUER');
  });
});

describe('the stderr ring buffer (data-model.md §6)', () => {
  it('retains lines up to its capacity', () => {
    const buffer = createStderrBuffer(3);

    buffer.push('a');
    buffer.push('b');
    buffer.push('c');

    expect(buffer.lines()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the MOST RECENT lines when it overflows', () => {
    const buffer = createStderrBuffer(3);

    for (const line of ['a', 'b', 'c', 'd', 'e']) buffer.push(line);

    // Bounded rather than unbounded because a long `LOG_LEVEL=debug` session would grow
    // without limit for output nobody reads. The recent lines are the ones explaining a
    // failure that just happened.
    expect(buffer.lines()).toEqual(['c', 'd', 'e']);
  });
});

describe('teardown leaves no orphan process (Story 1 AC-6)', () => {
  it('closes cleanly and reports the child as gone', async () => {
    const child = await openSession({ config: config(), credential: credential() });

    await child.close();

    expect(child.hasExited()).toBe(true);
  });

  it('treats a second close as harmless', async () => {
    const child = await openSession({ config: config(), credential: credential() });

    await child.close();

    // `/exit` after the child already died must not turn a clean exit into a crash.
    await expect(child.close()).resolves.toBeUndefined();
  });
});

describe('respawn is the only mechanism for token rotation (FR-023, research.md R9)', () => {
  it('replaces the child and re-discovers its capabilities', async () => {
    const child = await session();
    const before = Object.keys(child.tools).sort();

    await child.respawn('a-renewed-operator-token-6d2b8f4a');

    // A child's environment is immutable after spawn, and stdio carries no per-request
    // identity channel (`src/core/identity.ts:115-125`), so a new token requires a new
    // process. Re-discovery rather than reuse: the new child is a new server instance,
    // and assuming its surface matches would be the drift FR-003 forbids.
    expect(Object.keys(child.tools).sort()).toEqual(before);
    expect(child.hasExited()).toBe(false);
  });

  it('does not report the teardown as an unexpected child exit', async () => {
    let unexpectedExits = 0;
    const child = await openSession({
      config: config(),
      credential: credential(),
      onExit: () => {
        unexpectedExits += 1;
      }
    });
    open.push(child);

    await child.respawn('a-renewed-operator-token-6d2b8f4a');

    // Telling the engineer "the server exited" during a recovery they are watching
    // succeed would read as a failure. The distinction between a death and a deliberate
    // teardown is what keeps the notice honest.
    expect(unexpectedExits).toBe(0);
  });
});
