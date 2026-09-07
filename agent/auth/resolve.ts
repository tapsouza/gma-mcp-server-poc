import type { AgentConfig } from '../config.js';
import type { CredentialStore, StoredCredential } from './store.js';

/**
 * The credential precedence ladder (FR-015, data-model.md §2).
 *
 * Pure by construction: the clock, `fetch`, and the store are all INJECTED, which is
 * what lets suite A exercise every rung with no network, no waiting, and no real Okta
 * (FR-027).
 */

export type CredentialSource = 'env' | 'cache' | 'refresh' | 'device';

export interface OperatorCredential {
  /** Never logged, never rendered, never echoed (FR-014). */
  readonly accessToken: string;
  /** Absent on the supplied-token path — which is why that path cannot recover. */
  readonly refreshToken: string | undefined;
  /** Epoch ms. Unknown on the supplied-token path. */
  readonly expiresAt: number | undefined;
  readonly issuer: string | undefined;
  /**
   * Which rung produced it. NOT decoration: it determines what the harness can do on
   * expiry. Only `cache`, `refresh`, and `device` carry a refresh token, so only they
   * can drive FR-023's recovery. A `source: 'env'` credential that expires mid-session
   * gets a clear "supply a new token" message rather than a doomed refresh attempt.
   */
  readonly source: CredentialSource;
}

/** No credential could be obtained. Exits `77` (contracts/cli.md). */
export class NoCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCredentialError';
  }
}

/** A cached credential belongs to a different GMA environment (FR-019). Exits `77`. */
export class IssuerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssuerMismatchError';
  }
}

/**
 * What to tell an engineer who has no credential and no Okta application (FR-022,
 * Story 4 AC-10).
 *
 * Stated in full rather than as "ask your administrator", because a vague message
 * turns into a multi-day round trip: the administrator needs to know exactly which
 * grants and which authorization server, and the engineer needs a route that works
 * today while they wait.
 */
export function noCredentialGuidance(oktaIssuer: string): string {
  return [
    'No credential could be obtained, and interactive device login is unavailable.',
    '',
    'To enable device login, ask an Okta administrator for an application configured as:',
    '  • a NATIVE application (public client, no client secret)',
    '  • with the Device Authorization grant AND the Refresh Token grant enabled',
    `  • registered on the SAME custom authorization server as OKTA_ISSUER (${oktaIssuer})`,
    '  • covered by an access policy that permits the device authorization grant',
    '  • issuing a token that carries the `groups` claim, which GMA authorises against',
    'Then set OKTA_CLIENT_ID to that application’s client id.',
    '',
    'In the meantime, set GMA_USER_TOKEN to a valid access token for this environment',
    'and the harness will use it directly — no Okta application is needed for that path.'
  ].join('\n');
}

/**
 * A credential is treated as expired slightly BEFORE its stated expiry.
 *
 * Without this margin a token that expires in 900ms passes the check, is handed to a
 * freshly spawned child, and fails on the first call — producing a confusing recovery
 * cycle on a credential that was never usable.
 */
export const EXPIRY_SKEW_MS = 60_000;

export function isFresh(credential: StoredCredential, nowMs: number): boolean {
  return credential.expires_at - EXPIRY_SKEW_MS > nowMs;
}

/**
 * The device-flow collaborators, injected so step 4 is testable without a browser.
 *
 * Declared as an interface rather than imported concretely so `resolveCredential`
 * stays pure and the suite can drive every rung with a stub.
 */
export interface DeviceFlowCollaborators {
  /** Exchange a stored refresh token for a new credential (FR-015 step 3). */
  refresh(refreshToken: string): Promise<StoredCredential>;
  /** Run the full device authorization grant (FR-015 step 4). */
  login(): Promise<StoredCredential>;
}

export interface ResolveCredentialDeps {
  readonly config: AgentConfig;
  /** Epoch ms. Injected so expiry needs no waiting (data-model.md §3). */
  readonly now: () => number;
  readonly store: CredentialStore;
  /**
   * Absent when device login is unavailable — which is the case that must produce the
   * FR-022 message rather than a crash.
   */
  readonly deviceFlow?: DeviceFlowCollaborators | undefined;
}

function fromStored(credential: StoredCredential, source: CredentialSource): OperatorCredential {
  return {
    accessToken: credential.access_token,
    refreshToken: credential.refresh_token,
    expiresAt: credential.expires_at,
    issuer: credential.issuer,
    source
  };
}

/**
 * Resolve the engineer's credential, by strict precedence.
 *
 * ```
 * 1. GMA_USER_TOKEN present         → use verbatim, source 'env'.  No HTTP call. No cache read.
 * 2. cache valid AND issuer matches → use, source 'cache'.         No HTTP call.
 * 3. cache has refreshToken         → refresh, source 'refresh'.   Writes cache.
 * 4. otherwise                      → device flow, source 'device'. Writes cache.
 * ```
 *
 * Step 1 short-circuits before step 2 is even READ: an env-supplied token wins over a
 * fresher cache, mirroring `src/core/identity.ts`, where transport-supplied identity
 * outranks the environment. Supplied identity is the engineer's explicit instruction
 * and must not be second-guessed by something the harness cached earlier.
 */
export async function resolveCredential(deps: ResolveCredentialDeps): Promise<OperatorCredential> {
  const { config, now, store, deviceFlow } = deps;

  // --- Step 1: an explicitly supplied token wins outright (FR-015). ---
  // Deliberately before any cache read: no HTTP call, no file access.
  if (config.suppliedToken !== undefined) {
    return {
      accessToken: config.suppliedToken,
      refreshToken: undefined,
      expiresAt: undefined,
      issuer: undefined,
      source: 'env'
    };
  }

  const cached = store.read();

  if (cached !== undefined) {
    // A cache minted by a DIFFERENT environment's Okta is rejected, not refreshed
    // (FR-019). Its refresh token would mint a token that is genuinely valid — just
    // for another GMA — which this GMA answers with 401, which the harness would
    // misread as expiry and loop on. Rejecting here turns a loop into one message.
    if (cached.issuer !== config.oktaIssuer) {
      throw new IssuerMismatchError(
        'The cached credential was issued by a different environment and cannot be used here. ' +
          `It names issuer ${cached.issuer}, but this harness is configured against ` +
          `${config.oktaIssuer}. A token is valid against exactly one GMA environment. ` +
          `Delete ${store.path} and sign in again, or set GMA_USER_TOKEN for this environment.`
      );
    }

    // --- Step 2: a fresh, matching cache is used as-is. No HTTP call. ---
    if (isFresh(cached, now())) {
      return fromStored(cached, 'cache');
    }

    // --- Step 3: expired, but refreshable. ---
    if (cached.refresh_token !== undefined && deviceFlow !== undefined) {
      const refreshed = await deviceFlow.refresh(cached.refresh_token);
      store.write(refreshed);
      return fromStored(refreshed, 'refresh');
    }
  }

  // --- Step 4: interactive device login. ---
  if (deviceFlow === undefined) {
    throw new NoCredentialError(noCredentialGuidance(config.oktaIssuer));
  }

  const logged = await deviceFlow.login();
  store.write(logged);
  return fromStored(logged, 'device');
}
