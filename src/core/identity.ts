import { argumentError } from './errors.js';
import { ToolError } from './types.js';

/**
 * Per-invocation identity (FR-002, FR-023a, constitution Principle I).
 *
 * There is deliberately NO module-level variable, NO singleton, and NO
 * async-local storage in this file. The operator's token is extracted from the
 * per-request handler argument and returned as a VALUE that callers must thread
 * explicitly into the GMA client.
 *
 * That is the whole design: with a single local operator it would be natural to
 * hold one credential for the process lifetime, and that becomes a cross-user
 * data-leak the moment two concurrent remote callers exist. Making the token an
 * explicit parameter means the remote transport is additive rather than a
 * cross-cutting refactor whose failure mode is one operator seeing another's data.
 */

/**
 * An operator's bearer token, forwarded to GMA unaltered.
 *
 * A branded type rather than a bare `string`, so a caller cannot pass any old
 * string where a credential is expected — or, more importantly, accidentally pass a
 * token where a log field or an entity id is expected.
 *
 * It is never persisted, cached, exchanged, or logged (FR-002, FR-020).
 */
export type OperatorToken = string & { readonly __brand: 'OperatorToken' };

/**
 * The shape this module reads from the MCP SDK's per-request `extra` argument.
 *
 * Declared structurally rather than importing the SDK's `RequestHandlerExtra`, so
 * `core` stays free of transport concerns: the same extraction works under stdio
 * and Streamable HTTP, which is what makes FR-023b hold.
 */
export interface RequestIdentitySource {
  /** Populated by the SDK when the transport performed OAuth resource-server auth. */
  readonly authInfo?: { readonly token?: string } | undefined;
}

/**
 * Where a token may be read from in the local stdio slice.
 *
 * stdio has no HTTP request to carry a bearer, so the constitution permits taking
 * it from the local environment — explicitly "for development only" (Principle I).
 * It is read at EXTRACTION time, per invocation, and never captured at startup, so
 * a token rotated mid-session takes effect on the next call.
 */
export const STDIO_TOKEN_ENV_VAR = 'GMA_USER_TOKEN';

/** A token is required on every invocation; absence is an auth failure, not a default. */
function missingTokenError(): ToolError {
  return new ToolError(
    'auth',
    'No operator identity accompanied this request. ' +
      `Under stdio, set ${STDIO_TOKEN_ENV_VAR} to a valid OKTA access token for the ` +
      'GMA environment this server is configured against. The user must authenticate; ' +
      'this server holds no credentials of its own.',
    false
  );
}

/**
 * Reject a token whose shape means it cannot be a bearer credential.
 *
 * Deliberately shallow: this server does NOT validate signatures, issuers, expiry,
 * or claims. GMA does that, and duplicating it here would create a second, drifting
 * opinion about who is authorized. This catches only an obviously unusable value —
 * empty, or a leftover `Bearer ` prefix — so the request fails here rather than as
 * a confusing 401 later.
 */
function normaliseToken(raw: string): OperatorToken {
  const trimmed = raw.trim();

  if (trimmed.length === 0) throw missingTokenError();

  // A caller that passes the whole header value is a common slip. Strip the scheme
  // rather than forwarding a double-prefixed header, which GMA would reject as 401
  // and which would look like an expired credential to the user.
  //
  // The scheme word alone must also be rejected: `'Bearer '` trims to `'Bearer'`,
  // which no longer matches a `scheme + whitespace` pattern, so matching the word
  // on its own is what stops the literal string "Bearer" being sent as a token.
  const withoutScheme = trimmed.replace(/^bearer(\s+|$)/i, '');

  if (withoutScheme.length === 0) throw missingTokenError();

  if (/\s/.test(withoutScheme)) {
    // Never echo the value — the message must stay credential-free (FR-020).
    throw argumentError(
      'The supplied operator identity contains whitespace and is not a usable bearer token.',
      'Supply the access token only, with no surrounding quotes or header name.'
    );
  }

  return withoutScheme as OperatorToken;
}

/**
 * Extract the operator's token for THIS invocation.
 *
 * Order matters: transport-supplied identity wins over the environment, so when the
 * HTTP transport is added its per-request bearer takes precedence with no change
 * here and no change to any tool.
 *
 * @param extra the MCP SDK's per-request handler argument
 * @param env the process environment, injectable so tests need no global mutation
 * @throws ToolError of kind `auth` when no identity accompanies the request
 */
export function extractOperatorToken(
  extra: RequestIdentitySource | undefined,
  env: NodeJS.ProcessEnv = process.env
): OperatorToken {
  const fromTransport = extra?.authInfo?.token;
  if (typeof fromTransport === 'string' && fromTransport.trim().length > 0) {
    return normaliseToken(fromTransport);
  }

  const fromEnv = env[STDIO_TOKEN_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return normaliseToken(fromEnv);
  }

  throw missingTokenError();
}

/**
 * The `Authorization` header value for a GMA call.
 *
 * The token is forwarded UNALTERED (constitution Principle I): this adds the scheme
 * and nothing else — no re-signing, no exchange, no substitution.
 */
export function authorizationHeader(token: OperatorToken): string {
  return `Bearer ${token}`;
}
