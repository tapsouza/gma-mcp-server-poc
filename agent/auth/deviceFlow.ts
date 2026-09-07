import type { AgentConfig } from '../config.js';
import type { Renderer } from '../repl/render.js';
import type { StoredCredential } from './store.js';

/**
 * OAuth 2.0 Device Authorization Grant, RFC 8628 (FR-017, FR-018, research.md R7).
 *
 * The endpoint PATHS below are protocol constants — identical in every Okta
 * environment. The HOST and authorization-server id come from `OKTA_ISSUER` and are
 * never hardcoded (FR-021). That split is recorded as a deliberate deviation in
 * plan.md's Complexity Tracking: two more environment variables for values that never
 * differ would be configuration noise and a misconfiguration surface where none need
 * exist.
 */

export const DEVICE_AUTHORIZE_PATH = '/v1/device/authorize';
export const TOKEN_PATH = '/v1/token';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** `offline_access` is what yields the refresh token FR-023's recovery depends on. */
export const DEVICE_SCOPE = 'openid profile offline_access';

/** How much to add to the poll interval on `slow_down`, per RFC 8628 §3.5's guidance. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Used when the endpoint omits `interval`, as RFC 8628 §3.5 permits. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Device login failed. Distinct messages per cause — see `pollForToken`. */
export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

/** `OKTA_CLIENT_ID` is validated HERE, lazily, not at startup (FR-016, FR-033). */
export class MissingClientIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingClientIdError';
  }
}

interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

interface TokenSuccess {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
}

export interface DeviceFlowDeps {
  readonly config: AgentConfig;
  readonly render: Renderer;
  /** Injected so suite B needs no network (FR-027). */
  readonly fetchFn?: typeof fetch;
  /** Epoch ms, injected so the `expires_in` deadline needs no waiting. */
  readonly now?: () => number;
  /** Injected so a test does not actually sleep between polls. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Opening the browser is a CONVENIENCE; printing the link is the requirement (FR-017). */
  readonly openBrowser?: ((url: string) => void) | undefined;
}

function issuerUrl(config: AgentConfig, path: string): string {
  return `${config.oktaIssuer.replace(/\/+$/, '')}${path}`;
}

/**
 * The client id, checked at the moment device login is actually reached.
 *
 * Eagerly validating this at startup would break the supplied-token path for everyone
 * until an Okta application exists, defeating FR-033 — which is what keeps Stories 1–3
 * shippable without an administrative request.
 */
function requireClientId(config: AgentConfig): string {
  if (config.oktaClientId === undefined) {
    throw new MissingClientIdError(
      'Interactive device login needs OKTA_CLIENT_ID, which is not set.'
    );
  }
  return config.oktaClientId;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toCredential(
  token: TokenSuccess,
  config: AgentConfig,
  clientId: string,
  nowMs: number
): StoredCredential {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: nowMs + token.expires_in * 1000,
    // Recorded so a later run can reject a cache belonging to another environment
    // (FR-019) — the check that turns a confusing 401 loop into one message.
    issuer: config.oktaIssuer,
    client_id: clientId
  };
}

/**
 * Run the full device authorization grant: request a code, print the link, poll.
 *
 * The engineer types nothing into the terminal after the link appears — that is
 * FR-017's requirement, and the reason this grant was chosen over authorization
 * code + PKCE, which would need a local HTTP listener and a browser redirect.
 */
export async function deviceLogin(deps: DeviceFlowDeps): Promise<StoredCredential> {
  const { config, render } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const clientId = requireClientId(config);

  // --- Step 1: request a device code. ---
  const authorizeResponse = await fetchFn(issuerUrl(config, DEVICE_AUTHORIZE_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE }).toString()
  });

  if (!authorizeResponse.ok) {
    throw new DeviceFlowError(
      `The identity provider refused the device authorization request (HTTP ${authorizeResponse.status}). ` +
        'Confirm OKTA_CLIENT_ID names a native application with the Device Authorization grant ' +
        'enabled on the authorization server OKTA_ISSUER points at.'
    );
  }

  const authorization = (await authorizeResponse.json()) as DeviceAuthorizationResponse;

  // --- Step 2: show the engineer where to go (FR-017, Story 4 AC-1). ---
  render.notice(`To sign in, open: ${authorization.verification_uri}`);
  render.notice(`and enter the code: ${authorization.user_code}`);
  render.notice('Waiting for you to finish in the browser…');

  if (authorization.verification_uri_complete !== undefined) {
    deps.openBrowser?.(authorization.verification_uri_complete);
  }

  // --- Step 3: poll. ---
  return pollForToken({
    config,
    clientId,
    deviceCode: authorization.device_code,
    // A client-side deadline, so a misbehaving endpoint cannot make the harness spin
    // forever regardless of what it keeps returning (FR-018).
    deadlineMs: now() + authorization.expires_in * 1000,
    intervalSeconds: authorization.interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
    fetchFn,
    now,
    sleep
  });
}

interface PollDeps {
  readonly config: AgentConfig;
  readonly clientId: string;
  readonly deviceCode: string;
  readonly deadlineMs: number;
  readonly intervalSeconds: number;
  readonly fetchFn: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The polling state machine (data-model.md's device-flow diagram, FR-018).
 *
 * Every transition is distinct on purpose. `access_denied` and `expired_token` in
 * particular must not be collapsed: one means the engineer refused the request, the
 * other that they were too slow. Reporting either as the other tells them the wrong
 * thing to do next.
 */
async function pollForToken(deps: PollDeps): Promise<StoredCredential> {
  const { config, clientId, deviceCode, deadlineMs, fetchFn, now, sleep } = deps;
  let intervalSeconds = deps.intervalSeconds;

  for (;;) {
    if (now() >= deadlineMs) {
      throw new DeviceFlowError(
        'The sign-in request expired before it was completed. Run the harness again to start a new login.'
      );
    }

    await sleep(intervalSeconds * 1000);

    const response = await fetchFn(issuerUrl(config, TOKEN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode
      }).toString()
    });

    const body = (await response.json()) as Partial<TokenSuccess> & { error?: string };

    if (response.ok && typeof body.access_token === 'string') {
      return toCredential(body as TokenSuccess, config, clientId, now());
    }

    switch (body.error) {
      case 'authorization_pending':
        // The normal case, not an error: the engineer has not finished in the browser.
        continue;

      case 'slow_down':
        // Must INCREASE the interval. Ignoring this risks the identity provider
        // rate-limiting the login, which would look like an unexplained failure.
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;

      case 'access_denied':
        throw new DeviceFlowError(
          'The sign-in request was denied. Run the harness again and approve the request, ' +
            'or ask an administrator whether your account may use this application.'
        );

      case 'expired_token':
        throw new DeviceFlowError(
          'The sign-in code expired before it was used. Run the harness again to start a new login.'
        );

      default:
        throw new DeviceFlowError(
          `The identity provider rejected the sign-in (HTTP ${response.status}${
            body.error === undefined ? '' : `, ${body.error}`
          }).`
        );
    }
  }
}

export interface RefreshDeps {
  readonly config: AgentConfig;
  readonly refreshToken: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Exchange a stored refresh token for a new credential (FR-015 step 3, FR-023).
 *
 * A failure here is terminal for this credential: the caller must tell the engineer to
 * sign in again rather than retrying, because a refresh token that is revoked or expired
 * will not become valid on a second attempt (Story 5 AC-4).
 */
export async function refreshCredential(deps: RefreshDeps): Promise<StoredCredential> {
  const { config, refreshToken } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const clientId = requireClientId(config);

  const response = await fetchFn(issuerUrl(config, TOKEN_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: DEVICE_SCOPE
    }).toString()
  });

  if (!response.ok) {
    throw new DeviceFlowError(
      `Could not renew the stored credential (HTTP ${response.status}). Sign in again.`
    );
  }

  const body = (await response.json()) as Partial<TokenSuccess>;
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new DeviceFlowError('The identity provider returned an unusable renewal response.');
  }

  return toCredential(
    {
      access_token: body.access_token,
      // Okta may or may not rotate the refresh token. Keeping the old one when none
      // comes back is what stops a renewal from silently destroying the ability to
      // renew again.
      refresh_token: body.refresh_token ?? refreshToken,
      expires_in: body.expires_in
    },
    config,
    clientId,
    now()
  );
}
