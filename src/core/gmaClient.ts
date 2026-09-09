import type { Config } from './config.js';
import { fromHttpStatus as completenessFromStatus, type GmaEnvelope } from './completeness.js';
import {
  fromHttpStatus as errorFromStatus,
  fromTimeoutWithNoData,
  fromTransportFailure,
  malformedResponse
} from './errors.js';
import { authorizationHeader, type OperatorToken } from './identity.js';
import { createLogger, levelForOutcome, traceparent, type Logger } from './telemetry.js';
import { ToolError, type GmaResult } from './types.js';

/**
 * The GMA HTTP client (FR-001, FR-003, constitution Principles I, II and V).
 *
 * Three things this file guarantees, each of them load-bearing:
 *
 *  1. The operator's token is an explicit PARAMETER on every call and is forwarded
 *     unaltered. Nothing here reads it from state, so two concurrent callers cannot
 *     bleed into one another (FR-023a).
 *  2. Only 200 and 206 return data, and they return it wrapped in a `GmaResult`
 *     carrying a `Completeness`. Every other status becomes a `ToolError` with no
 *     completeness at all, so a failure cannot be dressed as data (FR-010).
 *  3. Operational values (base URL, timeout) come from `Config`, never from a caller
 *     argument (FR-018).
 */

/** Per-call options. The token is required and explicit — never ambient. */
export interface GmaCallOptions {
  /** The operator's bearer, forwarded unaltered. */
  readonly token: OperatorToken;
  /**
   * The UNINTERPOLATED path, e.g. `/crs/accounts/{accountId}`. Defaults to `path`.
   *
   * This is the only thing that ever reaches a log line, a span attribute, or a
   * tool-visible error message — never `path` itself (constitution Principle V,
   * research.md R13). For `/v5/superclasses/{urn}` the distinction is cosmetic; for
   * `/crs/accounts/{accountId}` the interpolated path IS a personal datum, and the
   * account identifier is the join key to a named person's bets and finances.
   *
   * Defaulting to `path` is what keeps this additive: every catalogue call omits it
   * and its log lines stay byte-identical.
   */
  readonly pathTemplate?: string | undefined;
  /** Instance URNs to scope the query to, already resolved by `instances.ts`. */
  readonly instances?: readonly string[] | undefined;
  /**
   * The QUERY PARAMETER NAME the target operation declares for its instance list.
   *
   * The v5 surface is NOT uniform about this: most operations declare
   * `instancesList`, but `GET /v5/events/{id}` declares `sources` — verified in
   * `api_catalogue.yaml`, whose `getEventById` references `sourcesParam` while
   * `searchMarketByInstancesAndEventId` on the adjacent path references
   * `instancesList`. The constitution records the rule directly: "Per-operation
   * parameter names MUST NOT be assumed uniform … a client MUST carry the name per
   * call rather than hardcoding one globally."
   *
   * Defaults to `instancesList`, so every existing catalogue call is unchanged.
   * Sending the wrong name would not error — the parameter would simply be IGNORED,
   * and the call would silently fan out across every instance instead of the one
   * asked for. That is the confident-failure shape this option exists to prevent.
   */
  readonly instancesParam?: 'instancesList' | 'sources' | undefined;
  /**
   * Read a failure response's body and hand it to this function, so the caller can turn
   * a machine-readable error CODE into self-correctable guidance (SC-008).
   *
   * Off by default, and deliberately narrow. Two rules it exists to respect at once:
   *
   *  - The upstream `message` MUST NOT reach a tool-visible string. On the metrics
   *    surface it carries "the Json response that caused the exception", which can echo
   *    an account identifier (Principle V, FR-029). So this hands the caller the parsed
   *    body and takes back only a hint the CALLER composed — never upstream prose.
   *  - The returned hint is appended to the error the status already produced; it does
   *    not replace the error, change its `kind`, or make it retryable. A `400` remains a
   *    non-retryable `argument` failure whichever code it carried.
   *
   * A body that will not parse, or a function that returns `null`, leaves the error
   * exactly as it would have been.
   */
  readonly errorHint?: ((body: unknown) => string | null) | undefined;
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

export interface GmaClient {
  get<T>(path: string, options: GmaCallOptions): Promise<GmaResult<T>>;
  post<T>(path: string, body: unknown, options: GmaCallOptions): Promise<GmaResult<T>>;
}

/**
 * The DEFAULT instance query parameter for GET operations.
 *
 * Note the asymmetry research.md R3 records: GET operations take `instancesList` as a
 * QUERY PARAMETER, while `POST /v5/searchByName` takes it in the REQUEST BODY. Both
 * are handled, and the difference is confined to this file.
 *
 * And note the second asymmetry, which R3 did not record: `GET /v5/events/{id}`
 * declares the parameter as `sources`, not `instancesList`. That is why the name is
 * overridable per call via `instancesParam` rather than fixed here.
 */
const DEFAULT_INSTANCES_PARAM = 'instancesList';

/**
 * A stable operation label for logs and errors — never a URL, which could carry a
 * token, and never an INTERPOLATED path, which for a customer surface would carry an
 * account identifier.
 *
 * This takes the TEMPLATE, not the path. That matters twice over: `operation` is
 * separately allowlisted in `telemetry.ts`, AND it is interpolated into tool-visible
 * messages by `errors.ts`'s `safeUpstreamDetail` — so a `404` on
 * `/crs/accounts/{accountId}` built from the real path would read "GMA returned HTTP
 * 404 for GET /crs/accounts/12345", leaking the identifier to the model and the user
 * (Principle V, FR-029, FR-030).
 */
function operationLabel(method: string, pathTemplate: string): string {
  return `${method} ${pathTemplate}`;
}

export function createGmaClient({ config, fetchImpl, logger }: GmaClientDeps): GmaClient {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const log = logger ?? createLogger(config.logLevel);

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: GmaCallOptions
  ): Promise<GmaResult<T>> {
    // Defaults to `path`, so a catalogue call that passes no template behaves exactly
    // as it did before. `path` itself never reaches a log line or a message below.
    const pathTemplate = options.pathTemplate ?? path;
    const operation = operationLabel(method, pathTemplate);
    const url = new URL(`${config.gmaBaseUrl}${path}`);

    if (method === 'GET' && options.instances !== undefined) {
      const parameterName = options.instancesParam ?? DEFAULT_INSTANCES_PARAM;
      for (const instance of options.instances) {
        url.searchParams.append(parameterName, instance);
      }
    }

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
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
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
        // The TEMPLATE, never the interpolated path (research.md R13).
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
      // The hint about instance codes is attached only when this call actually SENT an
      // instance list — the client knows, and `errors.ts` cannot. A CRS call carries
      // none, so a `400` there no longer advises the agent to check a code it never
      // supplied (which live sent it off blaming a valid account identifier instead).
      const baseError = errorFromStatus(status, operation, options.instances !== undefined);

      // An opt-in, caller-composed hint. The body is read only when a caller asked for
      // it, and only the caller's own sentence is appended — never upstream text.
      let toolError = baseError;
      if (options.errorHint !== undefined) {
        let hint: string | null;
        try {
          hint = options.errorHint(await response.json());
        } catch {
          // An unparseable body is not a second failure: the status already said what
          // went wrong, and the error stands exactly as it would have without this.
          hint = null;
        }
        if (hint !== null) {
          toolError = new ToolError(
            baseError.kind,
            `${baseError.message} ${hint}`,
            baseError.retryable
          );
        }
      }

      log.error({
        tool: options.tool,
        operation,
        // The TEMPLATE, never the interpolated path (research.md R13).
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
        // The TEMPLATE, never the interpolated path (research.md R13).
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
      // The TEMPLATE, never the interpolated path (research.md R13).
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

  return {
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, body, options) => call('POST', path, body, options)
  };
}
