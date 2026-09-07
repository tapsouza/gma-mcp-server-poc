import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadAgentConfig, type AgentConfig } from '../config.js';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DeviceFlowError,
  MissingClientIdError,
  SLOW_DOWN_INCREMENT_SECONDS,
  deviceLogin,
  refreshCredential
} from '../auth/deviceFlow.js';
import { createRenderer, type Renderer } from '../repl/render.js';

/**
 * Suite B — the device authorization polling state machine (T051-T055; FR-017, FR-018).
 *
 * These states are the reason this suite exists: `slow_down`, `access_denied`, and
 * `expired_token` **cannot be provoked on demand against real Okta** — the same argument
 * the constitution makes for GMA fixtures. Driving them through `msw` is the only way to
 * assert the harness handles each distinctly.
 *
 * Time is injected on two axes so nothing waits: `now` for the `expires_in` deadline and
 * `sleep` for the poll interval. `sleep` also RECORDS what it was asked to wait, which is
 * how the interval assertions are made without measuring wall-clock time.
 */

const ISSUER = 'https://example.okta.invalid/oauth2/aus000';
const CLIENT_ID = 'client-id-0oa000';
const DEVICE_AUTHORIZE = `${ISSUER}/v1/device/authorize`;
const TOKEN = `${ISSUER}/v1/token`;

const ACCESS_TOKEN = 'device-flow-access-token-9c4e2a7f';
const REFRESH_TOKEN = 'device-flow-refresh-token-3b8d5f1a';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function config(overrides: Partial<NodeJS.ProcessEnv> = {}): AgentConfig {
  return loadAgentConfig({
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: ISSUER,
    AWS_REGION: 'us-east-1',
    OKTA_CLIENT_ID: CLIENT_ID,
    ...overrides
  });
}

interface Harness {
  readonly render: Renderer;
  readonly lines: string[];
  /** Every value `sleep` was asked to wait, in milliseconds and in order. */
  readonly sleeps: number[];
  readonly sleep: (ms: number) => Promise<void>;
  /** A clock that advances by exactly what `sleep` was asked to wait. */
  readonly now: () => number;
}

const START = 1_800_000_000_000;

function harness(): Harness {
  const lines: string[] = [];
  const sleeps: number[] = [];
  let clock = START;

  return {
    lines,
    render: createRenderer((text) => lines.push(text)),
    sleeps,
    // Advancing the clock by the slept amount is what lets the `expires_in` deadline be
    // reached deterministically, without any real waiting.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock
  };
}

function authorizeHandler(overrides: Record<string, unknown> = {}) {
  return http.post(DEVICE_AUTHORIZE, () =>
    HttpResponse.json({
      device_code: 'device-code-abc',
      user_code: 'WDJB-MJHT',
      verification_uri: `${ISSUER}/activate`,
      verification_uri_complete: `${ISSUER}/activate?user_code=WDJB-MJHT`,
      expires_in: 600,
      interval: 5,
      ...overrides
    })
  );
}

/** A token endpoint that answers with a scripted sequence, one response per poll. */
function scriptedTokenHandler(script: { status?: number; body: Record<string, unknown> }[]) {
  let call = 0;
  return http.post(TOKEN, () => {
    const step = script[Math.min(call, script.length - 1)]!;
    call += 1;
    return HttpResponse.json(step.body, { status: step.status ?? 400 });
  });
}

const SUCCESS_BODY = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 3600
};

describe('deviceLogin', () => {
  describe('case: authorization_pending is the normal path, not an error (FR-018)', () => {
    it('polls through three pending responses and then succeeds', async () => {
      const h = harness();
      server.use(
        authorizeHandler(),
        scriptedTokenHandler([
          { body: { error: 'authorization_pending' } },
          { body: { error: 'authorization_pending' } },
          { body: { error: 'authorization_pending' } },
          { status: 200, body: SUCCESS_BODY }
        ])
      );

      const credential = await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep
      });

      expect(credential.access_token).toBe(ACCESS_TOKEN);
      expect(credential.refresh_token).toBe(REFRESH_TOKEN);
      expect(h.sleeps).toHaveLength(4);
    });

    it('respects the interval the endpoint returned', async () => {
      const h = harness();
      server.use(
        authorizeHandler({ interval: 7 }),
        scriptedTokenHandler([
          { body: { error: 'authorization_pending' } },
          { status: 200, body: SUCCESS_BODY }
        ])
      );

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      expect(h.sleeps).toEqual([7_000, 7_000]);
    });

    it('falls back to the default interval when the endpoint omits it', async () => {
      const h = harness();
      server.use(
        authorizeHandler({ interval: undefined }),
        scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }])
      );

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      // RFC 8628 §3.5 permits omitting `interval`; polling as fast as possible would
      // invite rate-limiting.
      expect(h.sleeps).toEqual([DEFAULT_POLL_INTERVAL_SECONDS * 1_000]);
    });
  });

  describe('case: slow_down must INCREASE the interval (FR-018)', () => {
    it('adds to the interval rather than continuing at the old rate', async () => {
      const h = harness();
      server.use(
        authorizeHandler({ interval: 5 }),
        scriptedTokenHandler([
          { body: { error: 'slow_down' } },
          { body: { error: 'authorization_pending' } },
          { status: 200, body: SUCCESS_BODY }
        ])
      );

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      // Ignoring `slow_down` risks the identity provider rate-limiting the login, which
      // would surface as an unexplained failure rather than as the throttle it is.
      expect(h.sleeps[0]).toBe(5_000);
      expect(h.sleeps[1]).toBe((5 + SLOW_DOWN_INCREMENT_SECONDS) * 1_000);
      expect(h.sleeps[2]).toBe((5 + SLOW_DOWN_INCREMENT_SECONDS) * 1_000);
    });

    it('increases cumulatively across repeated slow_down responses', async () => {
      const h = harness();
      server.use(
        authorizeHandler({ interval: 5 }),
        scriptedTokenHandler([
          { body: { error: 'slow_down' } },
          { body: { error: 'slow_down' } },
          { status: 200, body: SUCCESS_BODY }
        ])
      );

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      expect(h.sleeps[2]).toBe((5 + 2 * SLOW_DOWN_INCREMENT_SECONDS) * 1_000);
    });
  });

  describe('case: access_denied and expired_token are DISTINCT outcomes (FR-018)', () => {
    it('reports access_denied as a refusal', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ body: { error: 'access_denied' } }]));

      await expect(
        deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep })
      ).rejects.toThrow(/denied/i);
    });

    it('reports expired_token as needing a fresh login', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ body: { error: 'expired_token' } }]));

      await expect(
        deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep })
      ).rejects.toThrow(/expired/i);
    });

    it('does not collapse the two into one message', async () => {
      const denied = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ body: { error: 'access_denied' } }]));
      const deniedMessage = await deviceLogin({
        config: config(),
        render: denied.render,
        now: denied.now,
        sleep: denied.sleep
      }).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : '')
      );

      server.resetHandlers();
      const expired = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ body: { error: 'expired_token' } }]));
      const expiredMessage = await deviceLogin({
        config: config(),
        render: expired.render,
        now: expired.now,
        sleep: expired.sleep
      }).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : '')
      );

      // Collapsing them tells the engineer the wrong thing to do next: one means their
      // account was refused, the other that they were simply too slow.
      expect(deniedMessage).not.toBe(expiredMessage);
      expect(deniedMessage.length).toBeGreaterThan(0);
      expect(expiredMessage.length).toBeGreaterThan(0);
    });
  });

  describe('case: polling stops at expires_in regardless of the endpoint (FR-018)', () => {
    it('gives up at the deadline instead of spinning forever', async () => {
      const h = harness();
      server.use(
        // 30 seconds at a 5-second interval: six polls, then the deadline.
        authorizeHandler({ expires_in: 30, interval: 5 }),
        // An endpoint that answers `authorization_pending` forever.
        scriptedTokenHandler([{ body: { error: 'authorization_pending' } }])
      );

      await expect(
        deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep })
      ).rejects.toThrow(DeviceFlowError);

      // The deadline is CLIENT-side, so a misbehaving endpoint cannot keep the harness
      // polling indefinitely by never returning a terminal state.
      expect(h.sleeps.length).toBeLessThanOrEqual(7);
      expect(h.now()).toBeGreaterThanOrEqual(START + 30_000);
    });
  });

  describe('case: the link and the code are shown (Story 4 AC-1, FR-017)', () => {
    it('prints verification_uri and user_code', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      const output = h.lines.join('');
      expect(output).toContain(`${ISSUER}/activate`);
      expect(output).toContain('WDJB-MJHT');
    });

    it('never prints the resulting token', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      await deviceLogin({ config: config(), render: h.render, now: h.now, sleep: h.sleep });

      const output = h.lines.join('');
      expect(output).not.toContain(ACCESS_TOKEN);
      expect(output).not.toContain(REFRESH_TOKEN);
    });

    it('opens the browser at verification_uri_complete when it can', async () => {
      const h = harness();
      const opened: string[] = [];
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep,
        openBrowser: (url) => opened.push(url)
      });

      // Printing the link is the REQUIREMENT; opening it is a convenience (FR-017).
      expect(opened).toEqual([`${ISSUER}/activate?user_code=WDJB-MJHT`]);
    });

    it('succeeds without a browser opener at all', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      const credential = await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep
      });

      expect(credential.access_token).toBe(ACCESS_TOKEN);
    });
  });

  describe('case: the credential records where it came from (FR-019)', () => {
    it('stamps the configured issuer and client id', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      const credential = await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep
      });

      // Without the issuer stamp, a later run cannot reject a cache belonging to another
      // environment — which is the check that turns a confusing 401 loop into one message.
      expect(credential.issuer).toBe(ISSUER);
      expect(credential.client_id).toBe(CLIENT_ID);
    });

    it('converts expires_in to an absolute expires_at', async () => {
      const h = harness();
      server.use(authorizeHandler(), scriptedTokenHandler([{ status: 200, body: SUCCESS_BODY }]));

      const credential = await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep
      });

      // A relative lifetime is useless to a later process; an absolute instant is
      // comparable against an injected clock.
      expect(credential.expires_at).toBe(h.now() + 3_600_000);
    });
  });

  describe('case: OKTA_CLIENT_ID is validated lazily, here (FR-016, FR-022, FR-033)', () => {
    it('throws MissingClientIdError only once device login is reached', async () => {
      const h = harness();
      const withoutClientId = config({ OKTA_CLIENT_ID: undefined });

      // No handler is registered: the failure must happen BEFORE any HTTP call, which
      // msw's `onUnhandledRequest: 'error'` would otherwise report.
      await expect(
        deviceLogin({ config: withoutClientId, render: h.render, now: h.now, sleep: h.sleep })
      ).rejects.toThrow(MissingClientIdError);
    });
  });

  describe('case: a refusing authorization endpoint is explained (Edge Cases)', () => {
    it('names the likely misconfiguration rather than the raw status alone', async () => {
      const h = harness();
      server.use(http.post(DEVICE_AUTHORIZE, () => HttpResponse.json({}, { status: 400 })));

      const message = await deviceLogin({
        config: config(),
        render: h.render,
        now: h.now,
        sleep: h.sleep
      }).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : '')
      );

      expect(message).toContain('OKTA_CLIENT_ID');
      expect(message).toContain('Device Authorization');
    });
  });
});

describe('refreshCredential', () => {
  it('exchanges a refresh token for a new credential', async () => {
    server.use(
      http.post(TOKEN, () =>
        HttpResponse.json({
          access_token: 'renewed-access-token-5f2c8a1e',
          refresh_token: 'renewed-refresh-token-7a3d9b4c',
          expires_in: 3600
        })
      )
    );

    const credential = await refreshCredential({
      config: config(),
      refreshToken: REFRESH_TOKEN,
      now: () => START
    });

    expect(credential.access_token).toBe('renewed-access-token-5f2c8a1e');
    expect(credential.refresh_token).toBe('renewed-refresh-token-7a3d9b4c');
    expect(credential.expires_at).toBe(START + 3_600_000);
  });

  it('keeps the old refresh token when the provider does not rotate it', async () => {
    server.use(
      http.post(TOKEN, () =>
        HttpResponse.json({ access_token: 'renewed-only-access-4b8e2f6a', expires_in: 3600 })
      )
    );

    const credential = await refreshCredential({
      config: config(),
      refreshToken: REFRESH_TOKEN,
      now: () => START
    });

    // Discarding it would silently destroy the ability to renew again — the session
    // would survive one expiry and then fail on the next for no visible reason.
    expect(credential.refresh_token).toBe(REFRESH_TOKEN);
  });

  it('reports a rejected renewal as terminal, telling the engineer to sign in again', async () => {
    server.use(
      http.post(TOKEN, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }))
    );

    // A revoked or expired refresh token will not become valid on a retry, so the
    // message must direct the engineer to act rather than suggest waiting.
    await expect(
      refreshCredential({ config: config(), refreshToken: REFRESH_TOKEN, now: () => START })
    ).rejects.toThrow(/sign in again/i);
  });

  it('rejects an unusable renewal response rather than storing a broken credential', async () => {
    server.use(http.post(TOKEN, () => HttpResponse.json({ token_type: 'Bearer' })));

    await expect(
      refreshCredential({ config: config(), refreshToken: REFRESH_TOKEN, now: () => START })
    ).rejects.toThrow(DeviceFlowError);
  });

  it('needs OKTA_CLIENT_ID, and says so before any HTTP call', async () => {
    // No handler registered — reaching the network would fail the test.
    await expect(
      refreshCredential({
        config: config({ OKTA_CLIENT_ID: undefined }),
        refreshToken: REFRESH_TOKEN,
        now: () => START
      })
    ).rejects.toThrow(MissingClientIdError);
  });
});
