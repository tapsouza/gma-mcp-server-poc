import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { LogLevel } from './config.js';
import type { Outcome } from './types.js';

/**
 * Observability (FR-020, constitution Principle V, research.md R7).
 *
 * The design decision that matters here is an ALLOWLIST rather than a redaction
 * denylist. A denylist leaks the moment someone adds a field and forgets to redact
 * it; an allowlist cannot, because an unlisted field is never emitted at all. That
 * is what makes SC-006 ("zero credentials in logs") provable rather than
 * aspirational — and it is why `emit` below discards unknown keys silently instead
 * of trying to sanitise them.
 */

/**
 * The COMPLETE set of fields that may ever be logged or set as a span attribute.
 *
 * Adding a field here is a deliberate act with a reviewer attached. Nothing outside
 * this list reaches a log line, a span, or an alert.
 *
 * Drawn from constitution Principle V: "Logs carry tool name, GMA operation/path,
 * per-hop upstream outcome, resolution outcome, and latency."
 */
export const LOG_FIELD_ALLOWLIST = Object.freeze([
  /** Which curated tool ran, e.g. `find_catalogue_entity`. */
  'tool',
  /** The GMA operation label, e.g. `GET /v5/instances`. A label, never a full URL. */
  'operation',
  /** The GMA path template, e.g. `/v5/subclasses/{id}/eventTypes`. Never interpolated ids. */
  'path',
  /** HTTP status of one hop. */
  'status',
  /** This hop's completeness outcome. */
  'outcome',
  /** The aggregated outcome across all hops of a tool call. */
  'aggregateOutcome',
  /** How a name resolved: `resolved` | `candidates` | `none` | `tooBroad`. */
  'resolution',
  /** How many candidates a search matched — a count, never the candidates. */
  'matchCount',
  /** Number of brand instances the call was scoped to — a count, never the codes. */
  'instanceCount',
  /** How many instances failed on this hop. */
  'failedInstanceCount',
  /** Which hop of a multi-hop tool this is. */
  'hop',
  /** Elapsed milliseconds. */
  'latencyMs',
  /** `ErrorKind` when a call ended in a ToolError. */
  'errorKind',
  /** Whether the error was retryable. */
  'retryable',
  /** A short human-readable event name. */
  'event'
] as const);

export type LogField = (typeof LOG_FIELD_ALLOWLIST)[number];

/** What a caller may pass. Unlisted keys are structurally rejected AND dropped at runtime. */
export type LogFields = Partial<Record<LogField, string | number | boolean | undefined>>;

const ALLOWED = new Set<string>(LOG_FIELD_ALLOWLIST);

const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

/**
 * Keep only allowlisted keys with a primitive, non-empty value.
 *
 * Objects and arrays are dropped wholesale: a nested object is exactly how a header
 * bag or a raw response body — either of which may contain a token — would sneak in.
 */
function allowlist(fields: LogFields): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    safe[key] = value;
  }

  return safe;
}

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

/** Where a line goes. Injectable so tests capture output without patching globals. */
export type LogSink = (line: string) => void;

/**
 * Structured JSON logger.
 *
 * Writes to stderr by default: stdout is the stdio transport's JSON-RPC channel, and
 * a log line written there would corrupt the protocol stream.
 */
export function createLogger(level: LogLevel = 'info', sink: LogSink = defaultSink): Logger {
  const threshold = LEVEL_SEVERITY[level];

  const emit = (lineLevel: LogLevel, fields: LogFields): void => {
    if (LEVEL_SEVERITY[lineLevel] < threshold) return;

    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: lineLevel,
        ...allowlist(fields)
      })
    );
  };

  return {
    debug: (fields) => emit('debug', fields),
    info: (fields) => emit('info', fields),
    warn: (fields) => emit('warn', fields),
    error: (fields) => emit('error', fields)
  };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

const TRACER_NAME = 'gma-mcp-server';

/** The tracer for this service. */
export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Set span attributes through the SAME allowlist as logs.
 *
 * A span attribute is as much an egress path as a log line, so SC-006 has to hold
 * for both. Routing them through one function is what keeps that true.
 */
export function setSpanAttributes(span: Span, fields: LogFields): void {
  span.setAttributes(allowlist(fields) as Attributes);
}

/**
 * Run `fn` inside a span, recording the outcome.
 *
 * Only the error's `kind` is recorded, never its message: a message could in
 * principle carry detail we have not vetted, and the kind is what an alert keys on.
 */
export async function withSpan<T>(
  name: string,
  fields: LogFields,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    setSpanAttributes(span, fields);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const kind =
        typeof error === 'object' && error !== null && 'kind' in error
          ? String((error as { kind: unknown }).kind)
          : 'unknown';
      setSpanAttributes(span, { errorKind: kind });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The W3C `traceparent` header value for the active span, or `null` when no span is
 * recording.
 *
 * Emitting this costs nothing and lets GMA's existing pipeline continue the trace
 * with no GMA change (Principle V). Note it does NOT guarantee end-to-end
 * correlation today: GMA's `management.tracing.enabled` is false outside dev
 * (research.md R7), so this is correct-but-not-yet-useful, which is why nothing in
 * this slice depends on it.
 */
export function traceparent(): string | null {
  const span = trace.getActiveSpan();
  if (span === undefined) return null;

  const context = span.spanContext();
  if (context.traceId === '' || context.spanId === '') return null;

  const flags = (context.traceFlags & 0x1) === 0x1 ? '01' : '00';
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/** Map an `Outcome` to the log level it deserves: incompleteness is a warning. */
export function levelForOutcome(outcome: Outcome): 'info' | 'warn' {
  return outcome === 'COMPLETE' ? 'info' : 'warn';
}
