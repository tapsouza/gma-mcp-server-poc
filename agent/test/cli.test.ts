import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../repl/commands.js';
import { createRenderer } from '../repl/render.js';

/**
 * The command-line surface (contracts/cli.md): exit codes, the three commands, and
 * leaving cleanly.
 *
 * The exit-code cases run the BUILT entrypoint as a real process, because that is the only
 * level at which they exist. Two in particular were invisible to every unit test:
 *
 *  - **Ctrl-D must exit.** `readline.question()`'s promise neither resolves nor rejects on
 *    `close`, so an EOF hung the loop forever and the only escape was killing the process
 *    — orphaning the child, the exact failure Story 1 AC-6 forbids. Found by running the
 *    harness, not by reading it.
 *  - **Configuration must fail before the child is spawned** (FR-010, SC-005), which is a
 *    property of process startup ordering.
 *
 * Requires `dist-agent/main.js` and `dist/index.js`; `npm run test:agent` builds both.
 */

const ENTRYPOINT = 'dist-agent/main.js';

const VALID_ENV = {
  // `.invalid` is reserved by RFC 2606 and never resolves. No test here reaches GMA.
  GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
  GMA_DEFAULT_INSTANCES: 'PP,BF',
  OKTA_ISSUER: 'https://example.okta.invalid/oauth2/aus000',
  AWS_REGION: 'us-east-1',
  GMA_USER_TOKEN: 'cli-suite-operator-token-5c8f2a9e',
  LOG_LEVEL: 'error'
} as const;

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the harness with the given input and environment.
 *
 * `HOME` is pointed at a path that does not exist, so no test can read or write the
 * engineer's real `~/.gma-agent/token.json`.
 */
function run(options: {
  input?: string;
  env?: Record<string, string>;
  args?: string[];
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ENTRYPOINT, ...(options.args ?? [])], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: '/nonexistent-home-for-cli-suite',
        ...(options.env ?? {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(options.input ?? '');
  });
}

describe('exit codes (contracts/cli.md)', () => {
  it('exits 78 naming the missing variable, without spawning the child (FR-010, SC-005)', async () => {
    const { code, stdout } = await run({ env: { AWS_REGION: 'us-east-1' } });

    expect(code).toBe(78);
    expect(stdout).toContain('GMA_BASE_URL');
    // `78` deliberately matches the child's own EX_CONFIG (`src/index.ts:31`), so the same
    // class of failure reports the same way whichever process detects it.
    expect(stdout).toContain('Refusing to start');
    // The child never started, so nothing of its output can appear.
    expect(stdout).not.toContain('spawned gma-mcp-server');
  });

  it('exits 64 on an unknown flag', async () => {
    const { code, stdout } = await run({ env: { ...VALID_ENV }, args: ['--bogus'] });

    expect(code).toBe(64);
    expect(stdout).toContain('--verbose');
  });

  it('exits 77 with the administrator ask when no credential is obtainable (FR-022)', async () => {
    const withoutToken = { ...VALID_ENV } as Record<string, string>;
    delete withoutToken.GMA_USER_TOKEN;

    const { code, stdout } = await run({ env: withoutToken });

    expect(code).toBe(77);
    // The full ask, not "client id missing": a vague message turns into a multi-day round
    // trip, and the engineer needs the interim route as much as the request.
    expect(stdout.toLowerCase()).toContain('device authorization');
    expect(stdout).toContain('GMA_USER_TOKEN');
  });

  it('exits 0 on /exit', async () => {
    const { code, stdout } = await run({ env: { ...VALID_ENV }, input: '/exit\n' });

    expect(code).toBe(0);
    expect(stdout).toContain('spawned gma-mcp-server (8 tools)');
  });

  it('exits 0 on Ctrl-D with no /exit', async () => {
    // The regression this file exists for: an EOF used to hang the prompt loop forever.
    const { code } = await run({ env: { ...VALID_ENV }, input: '' });

    expect(code).toBe(0);
  });
});

describe('startup output (Story 1 AC-1)', () => {
  it('reports the credential source and the discovered capability count', async () => {
    const { stdout } = await run({ env: { ...VALID_ENV }, input: '/exit\n' });

    expect(stdout).toContain('✓ signed in');
    expect(stdout).toContain('✓ spawned gma-mcp-server (8 tools)');
  });

  it('never prints the credential itself (FR-014, SC-008)', async () => {
    const { stdout, stderr } = await run({ env: { ...VALID_ENV }, input: '/exit\n' });

    // The identity line describes WHICH credential is in use and how it was obtained,
    // never any part of the credential.
    expect(stdout).not.toContain(VALID_ENV.GMA_USER_TOKEN);
    expect(stderr).not.toContain(VALID_ENV.GMA_USER_TOKEN);
  });

  it('keeps the child’s diagnostics off the terminal by default (Story 2 AC-3)', async () => {
    // At `info` the server logs `server.started`. Buffered, it must not appear — server
    // output interleaved with the prompt would corrupt what the engineer is typing.
    const { stdout } = await run({
      env: { ...VALID_ENV, LOG_LEVEL: 'info' },
      input: '/exit\n'
    });

    expect(stdout).not.toContain('server.started');
  });

  it('echoes them live under --verbose (FR-012, Story 2 AC-4)', async () => {
    const { stdout } = await run({
      env: { ...VALID_ENV, LOG_LEVEL: 'info' },
      input: '/exit\n',
      args: ['--verbose']
    });

    expect(stdout).toContain('server.started');
  });
});

describe('interactive commands (FR-007, FR-035)', () => {
  it('clears the conversation without restarting the child', async () => {
    const { code, stdout } = await run({ env: { ...VALID_ENV }, input: '/clear\n/exit\n' });

    expect(code).toBe(0);
    expect(stdout).toContain('conversation cleared');
    // One spawn line only: `/clear` empties history and leaves the server alone.
    expect(stdout.match(/spawned gma-mcp-server/g)).toHaveLength(1);
  });

  it('lists the commands on /help', async () => {
    const { stdout } = await run({ env: { ...VALID_ENV }, input: '/help\n/exit\n' });

    expect(stdout).toContain('/clear');
    expect(stdout).toContain('/help');
    expect(stdout).toContain('/exit');
  });

  it('reports an unknown command rather than sending it to the model', async () => {
    const { stdout } = await run({ env: { ...VALID_ENV }, input: '/histroy\n/exit\n' });

    // Silently treating a typo as a question would produce a baffling answer — and would
    // spend a model call on it.
    expect(stdout).toContain('Unknown command: /histroy');
  });
});

describe('dispatch — the command seam', () => {
  const render = () => createRenderer(() => {});

  it('treats anything not starting with / as a question', () => {
    expect(dispatch('which leagues are under football?', render())).toEqual({
      kind: 'question',
      text: 'which leagues are under football?'
    });
  });

  it('trims the question', () => {
    expect(dispatch('   hello   ', render())).toEqual({ kind: 'question', text: 'hello' });
  });

  it('ignores a blank line', () => {
    expect(dispatch('   ', render()).kind).toBe('handled');
  });

  it('recognises the three commands, case-insensitively', () => {
    expect(dispatch('/EXIT', render()).kind).toBe('exit');
    expect(dispatch('/Clear', render()).kind).toBe('clear');
    expect(dispatch('/help', render()).kind).toBe('handled');
  });

  it('builds NONE of the FR-035 commands', () => {
    // FR-035 is open and was answered "no further commands" for this feature. Dispatch
    // sits behind this one seam so each remains an independent later addition — and this
    // assertion is what makes adding one a deliberate act rather than a drive-by.
    for (const proposed of ['/history', '/messages', '/call', '/tool', '/login', '/auth']) {
      const outcome = dispatch(proposed, render());
      expect(outcome.kind, `${proposed} must not be implemented`).toBe('handled');
    }
  });
});
