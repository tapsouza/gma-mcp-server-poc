import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentConfig, type AgentConfig } from '../config.js';
import {
  EXPIRY_SKEW_MS,
  IssuerMismatchError,
  NoCredentialError,
  resolveCredential,
  type DeviceFlowCollaborators
} from '../auth/resolve.js';
import {
  createFileCredentialStore,
  STORE_FILE_MODE,
  type CredentialStore,
  type StoredCredential
} from '../auth/store.js';
import { createRenderer, registerSecret, resetSecretsForTest } from '../repl/render.js';

/**
 * Suite A — credential precedence (T023, T056-T059; FR-014, FR-015, FR-019, FR-020).
 *
 * Injected clock, injected store, no network. The ladder is pure by construction, which
 * is what makes every rung — including the ones that cannot be provoked against real
 * Okta — assertable here (research.md R10).
 *
 * Must-cover cases:
 *  - `GMA_USER_TOKEN` beats a FRESH cache, with no HTTP call and no cache read
 *  - a fresh matching cache is used, with no HTTP call
 *  - a cache whose issuer differs is REJECTED, not refreshed (FR-019)
 *  - an expired access token with a valid refresh token refreshes
 *  - no env token and no cache reaches the device flow
 *  - the cache file is written `0600`
 *  - no token or refresh token appears in any emitted line
 */

const ISSUER = 'https://example.okta.invalid/oauth2/aus000';
const OTHER_ISSUER = 'https://other.okta.invalid/oauth2/aus999';
const NOW = 1_800_000_000_000;

const ENV_TOKEN = 'env-supplied-token-3f8a2c9d4b';
const CACHED_TOKEN = 'cached-access-token-7c1e5b8a2f';
const CACHED_REFRESH = 'cached-refresh-token-4d9f2a7e3c';
const REFRESHED_TOKEN = 'refreshed-access-token-8b3c7f1d5a';
const DEVICE_TOKEN = 'device-access-token-2e6a9c4b8f';

function config(overrides: Partial<NodeJS.ProcessEnv> = {}): AgentConfig {
  return loadAgentConfig({
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: ISSUER,
    AWS_REGION: 'us-east-1',
    OKTA_CLIENT_ID: 'client-id-0oa000',
    ...overrides
  });
}

function storedCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    access_token: CACHED_TOKEN,
    refresh_token: CACHED_REFRESH,
    // Comfortably beyond the skew margin, so "fresh" means fresh.
    expires_at: NOW + EXPIRY_SKEW_MS + 600_000,
    issuer: ISSUER,
    client_id: 'client-id-0oa000',
    ...overrides
  };
}

/** An in-memory store that records whether it was read at all. */
function memoryStore(initial?: StoredCredential): CredentialStore & {
  reads: number;
  written: StoredCredential | undefined;
} {
  let held = initial;
  const store = {
    reads: 0,
    written: undefined as StoredCredential | undefined,
    path: '/tmp/test/.gma-agent/token.json',
    read(): StoredCredential | undefined {
      store.reads += 1;
      return held;
    },
    write(credential: StoredCredential): void {
      held = credential;
      store.written = credential;
    },
    clear(): void {
      held = undefined;
    }
  };
  return store;
}

function stubDeviceFlow(): DeviceFlowCollaborators & { refreshCalls: number; loginCalls: number } {
  const stub = {
    refreshCalls: 0,
    loginCalls: 0,
    async refresh(refreshToken: string): Promise<StoredCredential> {
      stub.refreshCalls += 1;
      expect(refreshToken).toBe(CACHED_REFRESH);
      return storedCredential({
        access_token: REFRESHED_TOKEN,
        expires_at: NOW + 3_600_000
      });
    },
    async login(): Promise<StoredCredential> {
      stub.loginCalls += 1;
      return storedCredential({ access_token: DEVICE_TOKEN, expires_at: NOW + 3_600_000 });
    }
  };
  return stub;
}

const now = () => NOW;

describe('resolveCredential', () => {
  describe('case: step 1 — a supplied token wins outright (FR-015)', () => {
    it('uses GMA_USER_TOKEN verbatim, with source env', async () => {
      const store = memoryStore(storedCredential());

      const credential = await resolveCredential({
        config: config({ GMA_USER_TOKEN: ENV_TOKEN }),
        now,
        store,
        deviceFlow: stubDeviceFlow()
      });

      expect(credential.accessToken).toBe(ENV_TOKEN);
      expect(credential.source).toBe('env');
    });

    it('beats a FRESH cache, and never reads the cache at all', async () => {
      const store = memoryStore(storedCredential());

      const credential = await resolveCredential({
        config: config({ GMA_USER_TOKEN: ENV_TOKEN }),
        now,
        store,
        deviceFlow: stubDeviceFlow()
      });

      // Short-circuits BEFORE step 2, mirroring `src/core/identity.ts`: supplied
      // identity is the engineer's explicit instruction and must not be second-guessed
      // by something the harness cached earlier.
      expect(credential.accessToken).toBe(ENV_TOKEN);
      expect(store.reads).toBe(0);
    });

    it('makes no HTTP call when a token is supplied', async () => {
      const store = memoryStore(storedCredential());
      const flow = stubDeviceFlow();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await resolveCredential({
        config: config({ GMA_USER_TOKEN: ENV_TOKEN }),
        now,
        store,
        deviceFlow: flow
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(flow.refreshCalls).toBe(0);
      expect(flow.loginCalls).toBe(0);
      fetchSpy.mockRestore();
    });

    it('carries no refresh token, which is why that path cannot recover from expiry', async () => {
      const credential = await resolveCredential({
        config: config({ GMA_USER_TOKEN: ENV_TOKEN }),
        now,
        store: memoryStore(),
        deviceFlow: stubDeviceFlow()
      });

      // `source` is what `main.ts` branches on to give a "supply a new token" message
      // rather than attempting a doomed refresh (Story 5 AC-4).
      expect(credential.refreshToken).toBeUndefined();
      expect(credential.expiresAt).toBeUndefined();
    });
  });

  describe('case: step 2 — a fresh, matching cache is used (FR-015)', () => {
    it('uses it with no HTTP call', async () => {
      const flow = stubDeviceFlow();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const credential = await resolveCredential({
        config: config(),
        now,
        store: memoryStore(storedCredential()),
        deviceFlow: flow
      });

      expect(credential.accessToken).toBe(CACHED_TOKEN);
      expect(credential.source).toBe('cache');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(flow.refreshCalls).toBe(0);
      expect(flow.loginCalls).toBe(0);
      fetchSpy.mockRestore();
    });

    it('treats a credential inside the expiry skew as NOT fresh', async () => {
      // Without the margin, a token expiring in a moment passes the check, reaches a
      // freshly spawned child, and fails on the first call — a recovery cycle on a
      // credential that was never usable.
      const flow = stubDeviceFlow();

      const credential = await resolveCredential({
        config: config(),
        now,
        store: memoryStore(storedCredential({ expires_at: NOW + EXPIRY_SKEW_MS - 1_000 })),
        deviceFlow: flow
      });

      expect(credential.source).toBe('refresh');
      expect(flow.refreshCalls).toBe(1);
    });
  });

  describe('case: a foreign issuer is REJECTED, not refreshed (FR-019, SC-009)', () => {
    it('throws rather than using the credential', async () => {
      const flow = stubDeviceFlow();

      await expect(
        resolveCredential({
          config: config(),
          now,
          store: memoryStore(storedCredential({ issuer: OTHER_ISSUER })),
          deviceFlow: flow
        })
      ).rejects.toThrow(IssuerMismatchError);
    });

    it('neither refreshes nor renews it', async () => {
      const flow = stubDeviceFlow();
      const store = memoryStore(storedCredential({ issuer: OTHER_ISSUER }));

      await resolveCredential({ config: config(), now, store, deviceFlow: flow }).catch(() => {});

      // Its refresh token would mint a token that IS valid — just for another GMA —
      // which this GMA answers 401, which the harness would misread as expiry and loop
      // on. Rejecting up front turns a loop into one message.
      expect(flow.refreshCalls).toBe(0);
      expect(flow.loginCalls).toBe(0);
      expect(store.written).toBeUndefined();
    });

    it('rejects a foreign issuer even when the cache is FRESH', async () => {
      // Freshness is irrelevant: the token is valid, for the wrong environment.
      await expect(
        resolveCredential({
          config: config(),
          now,
          store: memoryStore(
            storedCredential({ issuer: OTHER_ISSUER, expires_at: NOW + 86_400_000 })
          ),
          deviceFlow: stubDeviceFlow()
        })
      ).rejects.toThrow(IssuerMismatchError);
    });

    it('names the mismatch and how to clear it, without echoing the credential', async () => {
      let message = '';
      await resolveCredential({
        config: config(),
        now,
        store: memoryStore(storedCredential({ issuer: OTHER_ISSUER })),
        deviceFlow: stubDeviceFlow()
      }).catch((error: unknown) => {
        message = error instanceof Error ? error.message : '';
      });

      expect(message).toContain(OTHER_ISSUER);
      expect(message).toContain(ISSUER);
      expect(message).not.toContain(CACHED_TOKEN);
      expect(message).not.toContain(CACHED_REFRESH);
    });
  });

  describe('case: step 3 — an expired credential with a refresh token refreshes (FR-015)', () => {
    it('refreshes and reports source refresh', async () => {
      const flow = stubDeviceFlow();
      const store = memoryStore(storedCredential({ expires_at: NOW - 1_000 }));

      const credential = await resolveCredential({
        config: config(),
        now,
        store,
        deviceFlow: flow
      });

      expect(credential.accessToken).toBe(REFRESHED_TOKEN);
      expect(credential.source).toBe('refresh');
      expect(flow.refreshCalls).toBe(1);
      expect(flow.loginCalls).toBe(0);
    });

    it('writes the refreshed credential back to the store', async () => {
      const store = memoryStore(storedCredential({ expires_at: NOW - 1_000 }));

      await resolveCredential({ config: config(), now, store, deviceFlow: stubDeviceFlow() });

      expect(store.written?.access_token).toBe(REFRESHED_TOKEN);
    });

    it('falls through to device login when the expired cache has no refresh token', async () => {
      const flow = stubDeviceFlow();
      const store = memoryStore(
        storedCredential({ expires_at: NOW - 1_000, refresh_token: undefined })
      );

      const credential = await resolveCredential({
        config: config(),
        now,
        store,
        deviceFlow: flow
      });

      expect(credential.source).toBe('device');
      expect(flow.refreshCalls).toBe(0);
      expect(flow.loginCalls).toBe(1);
    });
  });

  describe('case: step 4 — no env token and no cache reaches device login (FR-015)', () => {
    it('invokes the device flow and reports source device', async () => {
      const flow = stubDeviceFlow();
      const store = memoryStore();

      const credential = await resolveCredential({
        config: config(),
        now,
        store,
        deviceFlow: flow
      });

      expect(credential.accessToken).toBe(DEVICE_TOKEN);
      expect(credential.source).toBe('device');
      expect(flow.loginCalls).toBe(1);
      expect(store.written?.access_token).toBe(DEVICE_TOKEN);
    });
  });

  describe('case: no credential obtainable and no device login (FR-022, Story 4 AC-10)', () => {
    it('throws NoCredentialError', async () => {
      await expect(
        resolveCredential({ config: config(), now, store: memoryStore(), deviceFlow: undefined })
      ).rejects.toThrow(NoCredentialError);
    });

    it('states exactly what to request from an Okta administrator', async () => {
      let message = '';
      await resolveCredential({
        config: config(),
        now,
        store: memoryStore(),
        deviceFlow: undefined
      }).catch((error: unknown) => {
        message = error instanceof Error ? error.message : '';
      });

      // Vague guidance turns into a multi-day round trip: the administrator needs the
      // exact grants and authorization server, and the engineer needs a route that
      // works today while they wait.
      const lower = message.toLowerCase();
      expect(lower).toContain('native');
      expect(lower).toContain('device authorization');
      expect(lower).toContain('refresh token');
      expect(lower).toContain('groups');
      expect(message).toContain(ISSUER);
      expect(message).toContain('OKTA_CLIENT_ID');
      // The interim route matters as much as the ask.
      expect(message).toContain('GMA_USER_TOKEN');
    });
  });

  describe('case: an unreadable cache is treated as absent, not fatal (data-model.md §3)', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gma-agent-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('falls through to the device flow when the file does not parse', async () => {
      const store = createFileCredentialStore(dir);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(dir, '.gma-agent'), { recursive: true });
      writeFileSync(store.path, '{ this is not json');

      const flow = stubDeviceFlow();
      const credential = await resolveCredential({
        config: config(),
        now,
        store,
        deviceFlow: flow
      });

      // A corrupt cache must not refuse to start — the ladder falls through.
      expect(credential.source).toBe('device');
    });

    it('falls through when the file parses to the wrong shape', async () => {
      const store = createFileCredentialStore(dir);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(dir, '.gma-agent'), { recursive: true });
      writeFileSync(store.path, JSON.stringify({ hello: 'world' }));

      const credential = await resolveCredential({
        config: config(),
        now,
        store,
        deviceFlow: stubDeviceFlow()
      });

      expect(credential.source).toBe('device');
    });
  });
});

describe('the credential store (FR-020)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gma-agent-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the cache file mode 0600', () => {
    const store = createFileCredentialStore(dir);

    store.write(storedCredential());

    // Asserted, not assumed: the file holds a live credential.
    const mode = statSync(store.path).mode & 0o777;
    expect(mode).toBe(STORE_FILE_MODE);
    expect(mode).toBe(0o600);
  });

  it('round-trips a credential', () => {
    const store = createFileCredentialStore(dir);
    const credential = storedCredential();

    store.write(credential);

    expect(store.read()).toEqual(credential);
  });

  it('leaves no temp file behind after a write', async () => {
    const store = createFileCredentialStore(dir);
    store.write(storedCredential());

    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(dir, '.gma-agent'));

    // The write is atomic — temp file, chmod, rename — so two concurrent sessions
    // cannot leave a half-written file (Edge Cases).
    expect(entries).toEqual(['token.json']);
  });

  it('treats clear as idempotent', () => {
    const store = createFileCredentialStore(dir);

    expect(() => store.clear()).not.toThrow();
    store.write(storedCredential());
    store.clear();
    expect(store.read()).toBeUndefined();
    expect(() => store.clear()).not.toThrow();
  });

  it('lives outside the repository, so FR-020 holds structurally', () => {
    const store = createFileCredentialStore(dir);

    expect(store.path).toContain('.gma-agent');
    expect(store.path).not.toContain('gma-mcp-server-poc/agent');
  });
});

describe('no credential reaches the terminal (FR-014, SC-008)', () => {
  afterEach(() => {
    resetSecretsForTest();
  });

  it('scrubs a registered token from every writer', () => {
    const lines: string[] = [];
    const render = createRenderer((text) => lines.push(text));
    registerSecret(CACHED_TOKEN);
    registerSecret(CACHED_REFRESH);

    // Every writer, including the ones whose input comes from OUTSIDE the harness —
    // the model's prose and the child's stderr are the two that could quote a value
    // back, and the ones an allowlist of line shapes cannot reason about.
    render.status(`token is ${CACHED_TOKEN}`);
    render.notice(`refresh is ${CACHED_REFRESH}`);
    render.failure(`failed with ${CACHED_TOKEN}`);
    render.answerChunk(`the model said ${CACHED_TOKEN}`);
    render.childDiagnostic(`server logged ${CACHED_REFRESH}`);
    render.traceCall('list_instances', { token: CACHED_TOKEN });
    render.traceResult('list_instances', CACHED_TOKEN);
    render.traceCaveat(CACHED_REFRESH);

    const all = lines.join('');
    expect(all).not.toContain(CACHED_TOKEN);
    expect(all).not.toContain(CACHED_REFRESH);
    expect(all).toContain('«redacted»');
  });

  it('does not register a value too short to scrub safely', () => {
    const lines: string[] = [];
    const render = createRenderer((text) => lines.push(text));

    // Scrubbing a two-character string would mangle every line containing it — noise
    // pretending to be safety.
    registerSecret('ab');
    render.notice('about time');

    expect(lines.join('')).toContain('about time');
  });
});
