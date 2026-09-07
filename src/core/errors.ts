import { ToolError, type ErrorKind } from './types.js';

/**
 * The SINGLE place that maps an HTTP or transport outcome to a `ToolError`
 * (constitution Principle II: "GMA outcome to MCP outcome mapping is fixed and MUST
 * be implemented in exactly one place").
 *
 * A `ToolError` never carries a `Completeness`, so a failure cannot be dressed as
 * data (FR-010). And no message built here may contain a credential or personal
 * datum (FR-020) — see `safeUpstreamDetail`.
 */

/** Which kind each terminal HTTP status maps to. */
const STATUS_TO_KIND: Readonly<Record<number, ErrorKind>> = Object.freeze({
  400: 'argument',
  401: 'auth',
  404: 'notFound',
  500: 'upstream'
});

/**
 * Only `upstream` is retryable. `auth` needs a human to re-authenticate and
 * `argument` needs the agent to change its arguments — retrying either unchanged
 * just burns a request. `config` is fixed by the operator before startup.
 */
const RETRYABLE: Readonly<Record<ErrorKind, boolean>> = Object.freeze({
  auth: false,
  argument: false,
  notFound: false,
  upstream: true,
  config: false
});

/** Guidance naming who must act, so the agent does not retry what it cannot fix. */
const GUIDANCE: Readonly<Record<ErrorKind, string>> = Object.freeze({
  auth: 'The user must re-authenticate. Do not retry with different credentials, and do not report this as "no results found".',
  argument:
    'Correct the arguments and try again; this does not need the user. If an instance code was rejected, call list_instances for the valid codes.',
  notFound: 'No entity exists with that identifier. Report the absence rather than retrying.',
  upstream:
    'The upstream system failed and returned nothing usable. Retry once, then tell the user it is unavailable.',
  config: 'A deployment configuration value is missing or invalid. Only an operator can fix this.'
});

/**
 * Anything that could carry a credential is discarded here rather than redacted.
 *
 * An allowlist beats a denylist for the same reason the logger uses one (research.md
 * R7): a new leak path cannot appear by being forgotten. GMA error bodies are
 * operational detail we do not need, and a bearer token can appear inside one (an
 * echoed header, a URL with a query token), so no upstream body text is ever
 * interpolated into a tool-visible message.
 */
function safeUpstreamDetail(status: number, operation: string): string {
  return `GMA returned HTTP ${status} for ${operation}.`;
}

/**
 * Map a terminal HTTP status from GMA to a `ToolError`.
 *
 * 200 and 206 are NOT terminal — they carry a `Completeness` and must go to
 * `completeness.fromHttpStatus` instead.
 *
 * @param operation a stable label for the GMA call — the LOGICAL operation id, e.g.
 *   `listInstances`. Never a full URL, which could carry a query-string credential, and
 *   deliberately generation-free: this label reaches agent-visible error text, where
 *   upstream mechanics do not belong (003-FR-012, research.md R7).
 */
export function fromHttpStatus(status: number, operation: string): ToolError {
  if (status === 200 || status === 206) {
    throw new Error(
      `fromHttpStatus received HTTP ${status}, which is a success carrying a completeness ` +
        `verdict and must be mapped by completeness.ts rather than turned into an error`
    );
  }

  const kind = STATUS_TO_KIND[status] ?? 'upstream';
  return new ToolError(
    kind,
    `${safeUpstreamDetail(status, operation)} ${GUIDANCE[kind]}`,
    RETRYABLE[kind]
  );
}

/**
 * A request that aborted with NOTHING usable gathered.
 *
 * A timeout that aborted after some instances had answered is not an error at all —
 * it is `TIMEOUT_PARTIAL` data plus a caveat. FR-010 requires the two never be
 * conflated, which is why the distinction lives in the caller's control flow rather
 * than in a flag on one function.
 */
export function fromTimeoutWithNoData(operation: string, timeoutMs: number): ToolError {
  return new ToolError(
    'upstream',
    `GMA did not respond within ${timeoutMs}ms for ${operation} and no data was gathered. ${GUIDANCE.upstream}`,
    true
  );
}

/** A transport failure with no HTTP response: DNS, connection refused, TLS. */
export function fromTransportFailure(operation: string): ToolError {
  return new ToolError(
    'upstream',
    `Could not reach GMA for ${operation}. ${GUIDANCE.upstream}`,
    true
  );
}

/**
 * An argument the agent supplied that this server rejected locally, before any GMA
 * call. The agent is expected to self-correct (SC-008), so `hint` must say how.
 */
export function argumentError(message: string, hint?: string): ToolError {
  return new ToolError(
    'argument',
    hint === undefined ? `${message} ${GUIDANCE.argument}` : `${message} ${hint}`,
    false
  );
}

/**
 * A capability needs an operation on a generation that does not offer it (003-FR-006).
 *
 * Thrown during startup resolution, so the process refuses to start rather than failing
 * at an agent's first call. The message names all four facts an operator needs — the
 * capability, the operation, the generation that was asked for, and the generations that
 * do offer it — so it can be fixed without reading source. It carries no credential and
 * no personal datum (001-FR-020).
 *
 * This lives in `errors.ts`, not beside the resolver, because this file is the single
 * place `ToolError`s are constructed (Principle II). Putting it in `surface.ts` would
 * erode the architecture assertion that enforces exactly that.
 */
export function unsatisfiableGeneration(
  capability: string,
  operation: string,
  effective: string,
  availableOn: readonly string[]
): ToolError {
  return new ToolError(
    'config',
    `Capability "${capability}" requires operation "${operation}" on generation ` +
      `"${effective}", but that operation exists only on: ${availableOn.join(', ')}. ` +
      `Set GMA_CATALOGUE_GENERATION to a generation that offers it, or pin this ` +
      `operation to one. ${GUIDANCE.config}`,
    false
  );
}

/** A response that parsed but did not match the shape GMA's schema declares. */
export function malformedResponse(operation: string): ToolError {
  return new ToolError(
    'upstream',
    `GMA returned an unreadable response for ${operation}. ${GUIDANCE.upstream}`,
    true
  );
}

/** True when a thrown value is one of ours, so callers need no instanceof chains. */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}
