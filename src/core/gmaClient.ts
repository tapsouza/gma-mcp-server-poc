import type { Config } from './config.js';
import { fromHttpStatus as completenessFromStatus, type GmaEnvelope } from './completeness.js';
import {
  fromHttpStatus as errorFromStatus,
  fromTimeoutWithNoData,
  fromTransportFailure,
  malformedResponse
} from './errors.js';
import { authorizationHeader, type OperatorToken } from './identity.js';
import { interpolatePath, type ResolvedOperation } from './surface.js';
import { createLogger, levelForOutcome, traceparent, type Logger } from './telemetry.js';
import type { GmaResult } from './types.js';

/**
 * The GMA HTTP client (FR-001, FR-003, constitution Principles I, II and V).
 *
 * Four things this file guarantees, each of them load-bearing:
 *
 *  1. The operator's token is an explicit PARAMETER on every call and is forwarded
 *     unaltered. Nothing here reads it from state, so two concurrent callers cannot
 *     bleed into one another (FR-023a).
 *  2. Only 200 and 206 return data, and they return it wrapped in a `GmaResult`
 *     carrying a `Completeness`. Every other status becomes a `ToolError` with no
 *     completeness at all, so a failure cannot be dressed as data (FR-010).
 *  3. Operational values (base URL, timeout) come from `Config`, never from a caller
 *     argument (FR-018).
 *  4. A caller supplies a `ResolvedOperation` handle and path parameters — never a path
 *     string. The generation was decided once at startup, so no call site can name one,
 *     and there is no per-call routing decision to get wrong (003-FR-003).
 */

/** Per-call options. The token is required and explicit — never ambient. */
export interface GmaCallOptions {
  /** The operator's bearer, forwarded unaltered. */
  readonly token: OperatorToken;
  /** Instance URNs to scope the query to, already resolved by `instances.ts`. */
  readonly instances?: readonly string[] | undefined;
  /** Caller's cancellation signal, composed with the configured timeout. */
  readonly signal?: AbortSignal | undefined;
  /** Which hop of a multi-hop tool this is, for logging only. */
  readonly hop?: number | undefined;
  /** The tool on whose behalf this call is made, for logging only. */
  readonly tool?: string | undefined;
}

/** Injectable so tests can drive the client without a live socket. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GmaClientDeps {
  readonly config: Config;
  readonly fetchImpl?: FetchLike;
  readonly logger?: Logger;
}

/** Values interpolated into a handle's path template, percent-encoded by the client. */
export type PathParams = Readonly<Record<string, string>>;

export interface GmaClient {
  /**
   * Call the operation this handle resolves to.
   *
   * The handle carries the method, so there is no separate `get`/`post` pair: the
   * operation's shape is the table's business, not the caller's.
   */
  call<T>(
    operation: ResolvedOperation,
    params: PathParams,
    body: unknown,
    options: GmaCallOptions
  ): Promise<GmaResult<T>>;
}

/**
 * The instance parameter name, used in both the query string and the request body.
 *
 * Where it goes is decided by the handle's `instancesIn`, not by this file guessing from
 * the method: GET operations take `instancesList` as a QUERY PARAMETER while
 * `POST /v5/searchByName` takes it in the REQUEST BODY (research.md R1). That asymmetry
 * is upstream's, and it now lives in the operation table where it is visible and
 * testable, rather than as an implicit method-based rule here.
 */
const INSTANCES_PARAM = 'instancesList';

export function createGmaClient({ config, fetchImpl, logger }: GmaClientDeps): GmaClient {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const log = logger ?? createLogger(config.logLevel);

  async function call<T>(
    resolved: ResolvedOperation,
    params: PathParams,
    body: unknown,
    options: GmaCallOptions
  ): Promise<GmaResult<T>> {
    const { method, generation, pathTemplate } = resolved;

    // The LOGICAL operation id, e.g. `getEventType` — not `GET /v5/eventTypes/{id}`.
    // A generation-bearing label would split every metric series in two the moment the
    // generation changed, defeating the point of making it configurable (research.md R7).
    // It also keeps upstream mechanics out of agent-visible error text (003-FR-012).
    const operation = resolved.operation;

    // Interpolated and percent-encoded in `surface.ts`, beside the templates. GMA ids are
    // URNs full of colons, and this encoding was previously repeated in two tool modules.
    const path = interpolatePath(pathTemplate, params);
    const url = new URL(`${config.gmaBaseUrl}${path}`);

    if (resolved.instancesIn === 'query' && options.instances !== undefined) {
      for (const instance of options.instances) {
        url.searchParams.append(INSTANCES_PARAM, instance);
      }
    }

    // The request body for a POST that scopes by instance in the body rather than the
    // query string. Built here so a tool never has to know which of the two it is.
    const requestBody =
      resolved.instancesIn === 'body' && options.instances !== undefined
        ? { ...(body as Record<string, unknown>), [INSTANCES_PARAM]: options.instances }
        : body;

    const headers: Record<string, string> = {
      // Forwarded UNALTERED. This server mints, exchanges, and caches nothing.
      Authorization: authorizationHeader(options.token),
      Accept: 'application/json'
    };

    // Emitted so GMA's existing pipeline can continue the trace with no GMA change.
    const parent = traceparent();
    if (parent !== null) headers.traceparent = parent;

    if (method === 'POST') headers['Content-Type'] = 'application/json';

    // The configured timeout, composed with any caller signal, so a client-side
    // abort and a tool-level cancellation both work.
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

    const startedAt = Date.now();
    let response: Response;

    try {
      response = await doFetch(url.toString(), {
        method,
        headers,
        signal,
        ...(method === 'POST' ? { body: JSON.stringify(requestBody ?? {}) } : {})
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const aborted =
        signal.aborted ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name?: unknown }).name === 'AbortError') ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name?: unknown }).name === 'TimeoutError');

      log.error({
        tool: options.tool,
        operation,
        generation,
        path: pathTemplate,
        hop: options.hop,
        latencyMs,
        errorKind: 'upstream',
        retryable: true,
        event: aborted ? 'gma.timeout' : 'gma.transport_failure'
      });

      // This hop produced NOTHING, so it is always an error here. The FR-010
      // distinction — timeout with partial data vs timeout with none — is decided by
      // the CALLER, which is the only layer that knows whether an earlier hop
      // already gathered usable data. A multi-hop tool catches this and downgrades
      // it to a TIMEOUT_PARTIAL caveat; a single-hop tool lets it propagate.
      throw aborted
        ? fromTimeoutWithNoData(operation, config.requestTimeoutMs)
        : fromTransportFailure(operation);
    }

    const latencyMs = Date.now() - startedAt;
    const status = response.status;

    if (status !== 200 && status !== 206) {
      const toolError = errorFromStatus(status, operation);
      log.error({
        tool: options.tool,
        operation,
        generation,
        path: pathTemplate,
        hop: options.hop,
        status,
        latencyMs,
        errorKind: toolError.kind,
        retryable: toolError.retryable,
        event: 'gma.error'
      });
      throw toolError;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      log.error({
        tool: options.tool,
        operation,
        generation,
        path: pathTemplate,
        hop: options.hop,
        status,
        latencyMs,
        errorKind: 'upstream',
        event: 'gma.unreadable_body'
      });
      throw malformedResponse(operation);
    }

    const envelope = (parsed ?? {}) as GmaEnvelope;
    const completeness = completenessFromStatus(status, envelope);

    log[levelForOutcome(completeness.outcome)]({
      tool: options.tool,
      operation,
      generation,
      path: pathTemplate,
      hop: options.hop,
      status,
      outcome: completeness.outcome,
      instanceCount: options.instances?.length,
      failedInstanceCount: completeness.failedInstances.length,
      latencyMs,
      event: 'gma.call'
    });

    return { data: parsed as T, completeness };
  }

  return { call };
}
