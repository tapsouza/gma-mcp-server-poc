import { SpanStatusCode, trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import {
  LOG_FIELD_ALLOWLIST,
  createLogger,
  levelForOutcome,
  setSpanAttributes,
  traceparent,
  withSpan,
  type LogFields
} from '../../src/core/telemetry.js';

/** A realistic bearer token — the exact value that must appear nowhere. */
const TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9.eyJzdWIiOiJqYW5lLmRvZUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJl';

/** Collect emitted lines instead of writing to stderr. */
function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

/**
 * Values a caller might plausibly try to log, each of which would be a credential or
 * PII leak. The allowlist must swallow all of them.
 */
const FORBIDDEN_FIELDS: Record<string, unknown> = {
  Authorization: `Bearer ${TOKEN}`,
  authorization: `Bearer ${TOKEN}`,
  token: TOKEN,
  accessToken: TOKEN,
  bearer: TOKEN,
  headers: { Authorization: `Bearer ${TOKEN}`, 'x-request-id': 'abc' },
  requestBody: { name: 'Premier League', token: TOKEN },
  user: 'jane.doe@example.com',
  email: 'jane.doe@example.com',
  instances: ['PP', 'BF'],
  candidates: [{ id: 'urn:et:1', name: 'Winner' }],
  url: `https://gma.invalid/v5/instances?access_token=${TOKEN}`,
  message: 'GMA rejected token eyJhbGciOi...',
  stack: 'Error: boom\n  at handler'
};

describe('telemetry logger', () => {
  describe('case: an unlisted key emits neither the key nor its value (FR-020, SC-006)', () => {
    it.each(Object.entries(FORBIDDEN_FIELDS))('drops %s entirely', (key, value) => {
      const { lines, sink } = capture();
      const logger = createLogger('debug', sink);

      logger.info({ tool: 'list_instances', [key]: value } as LogFields);

      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Assert on the emitted KEYS, not on the raw substring: a value like
      // "list_instances" legitimately contains the forbidden key name "instances".
      expect(Object.keys(parsed)).not.toContain(key);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('jane.doe@example.com');
      // The allowlisted field alongside it still gets through.
      expect(parsed).toMatchObject({ tool: 'list_instances' });
    });

    it('drops every forbidden field at once while keeping the allowlisted ones', () => {
      const { lines, sink } = capture();
      const logger = createLogger('debug', sink);

      logger.warn({
        ...FORBIDDEN_FIELDS,
        tool: 'find_catalogue_entity',
        operation: 'POST /v5/searchByName',
        outcome: 'PARTIAL',
        latencyMs: 42
      } as LogFields);

      const parsed = JSON.parse(lines[0]!);

      expect(Object.keys(parsed).sort()).toEqual([
        'latencyMs',
        'level',
        'operation',
        'outcome',
        'tool',
        'ts'
      ]);
      expect(lines[0]).not.toContain(TOKEN);
    });

    it('drops an object or array even when its KEY is allowlisted', () => {
      // The path a raw response body or header bag would take. `operation` is
      // allowlisted, but a nested object under it must still not be emitted.
      const { lines, sink } = capture();
      const logger = createLogger('debug', sink);

      logger.info({
        tool: 'list_instances',
        operation: { url: `https://gma.invalid?token=${TOKEN}` }
      } as unknown as LogFields);

      expect(lines[0]).not.toContain(TOKEN);
      expect(JSON.parse(lines[0]!)).not.toHaveProperty('operation');
    });

    it('never logs at all when only forbidden fields are supplied', () => {
      const { lines, sink } = capture();
      const logger = createLogger('debug', sink);

      logger.info(FORBIDDEN_FIELDS as LogFields);

      const parsed = JSON.parse(lines[0]!);
      expect(Object.keys(parsed).sort()).toEqual(['level', 'ts']);
    });
  });

  describe('the allowlist is the mechanism, not vigilance', () => {
    it('carries only the fields constitution Principle V permits', () => {
      expect([...LOG_FIELD_ALLOWLIST].sort()).toEqual([
        'aggregateOutcome',
        'errorKind',
        'event',
        'failedInstanceCount',
        'hop',
        'instanceCount',
        'latencyMs',
        'matchCount',
        'operation',
        'outcome',
        'path',
        'resolution',
        'retryable',
        'status',
        'tool'
      ]);
    });

    it('includes no field whose name suggests a credential, an identity, or a payload', () => {
      for (const field of LOG_FIELD_ALLOWLIST) {
        expect(field.toLowerCase()).not.toMatch(
          /token|auth|credential|secret|password|bearer|header|body|user|email|url/
        );
      }
    });
  });

  describe('emitted lines', () => {
    it('emits one JSON object per line with a timestamp and level', () => {
      const { lines, sink } = capture();
      createLogger('info', sink).info({ tool: 'list_instances', latencyMs: 12 });

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.level).toBe('info');
      expect(typeof parsed.ts).toBe('string');
      expect(lines[0]).not.toContain('\n');
    });

    it('honours the configured level threshold', () => {
      const { lines, sink } = capture();
      const logger = createLogger('warn', sink);

      logger.debug({ tool: 'a' });
      logger.info({ tool: 'b' });
      logger.warn({ tool: 'c' });
      logger.error({ tool: 'd' });

      expect(lines.map((l) => JSON.parse(l).tool)).toEqual(['c', 'd']);
    });

    it('emits everything at debug level', () => {
      const { lines, sink } = capture();
      const logger = createLogger('debug', sink);

      logger.debug({ tool: 'a' });
      logger.error({ tool: 'b' });

      expect(lines).toHaveLength(2);
    });

    it('omits an undefined value rather than emitting a null field', () => {
      const { lines, sink } = capture();
      createLogger('info', sink).info({ tool: 'list_instances', matchCount: undefined });

      expect(JSON.parse(lines[0]!)).not.toHaveProperty('matchCount');
    });

    it('defaults to stderr, so a log line cannot corrupt the stdio JSON-RPC stream', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      createLogger('info').info({ tool: 'list_instances' });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stdout).not.toHaveBeenCalled();

      stderr.mockRestore();
      stdout.mockRestore();
    });
  });

  describe('case: span attributes go through the same allowlist (SC-006)', () => {
    it('sets only allowlisted attributes on a span', () => {
      const setAttributes = vi.fn();
      const span = { setAttributes } as unknown as Parameters<typeof setSpanAttributes>[0];

      setSpanAttributes(span, {
        tool: 'list_instances',
        outcome: 'COMPLETE',
        ...FORBIDDEN_FIELDS
      } as LogFields);

      expect(setAttributes).toHaveBeenCalledWith({ tool: 'list_instances', outcome: 'COMPLETE' });
      expect(JSON.stringify(setAttributes.mock.calls)).not.toContain(TOKEN);
    });

    it('records only the error kind on a failing span, never its message', async () => {
      // A real span recorder, so this asserts what actually reaches the exporter
      // rather than asserting on arrays nothing populates.
      const attributes: Record<string, unknown>[] = [];
      const statuses: unknown[] = [];
      const span = {
        setAttributes: (attrs: Record<string, unknown>) => attributes.push(attrs),
        setStatus: (status: unknown) => statuses.push(status),
        end: () => {},
        spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 })
      };

      const restore = vi.spyOn(trace, 'getTracer').mockReturnValue({
        startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never
      } as never);

      await expect(
        withSpan(
          'gma.call',
          { tool: 'list_instances', operation: 'GET /v5/instances' },
          async () => {
            throw Object.assign(new Error(`GMA rejected ${TOKEN}`), { kind: 'auth' });
          }
        )
      ).rejects.toThrow();

      const flattened = JSON.stringify(attributes);
      expect(flattened).not.toContain(TOKEN);
      expect(flattened).not.toContain('GMA rejected');
      // The kind is recorded, because that is what an alert keys on.
      expect(attributes).toContainEqual({ errorKind: 'auth' });
      expect(statuses).toContainEqual({ code: SpanStatusCode.ERROR });

      restore.mockRestore();
    });

    it('marks a successful span OK and records no error kind', async () => {
      const attributes: Record<string, unknown>[] = [];
      const statuses: unknown[] = [];
      const span = {
        setAttributes: (attrs: Record<string, unknown>) => attributes.push(attrs),
        setStatus: (status: unknown) => statuses.push(status),
        end: () => {},
        spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 })
      };

      const restore = vi.spyOn(trace, 'getTracer').mockReturnValue({
        startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never
      } as never);

      await expect(
        withSpan('gma.call', { tool: 'list_instances' }, async () => 'ok')
      ).resolves.toBe('ok');

      expect(statuses).toContainEqual({ code: SpanStatusCode.OK });
      expect(JSON.stringify(attributes)).not.toContain('errorKind');

      restore.mockRestore();
    });

    it('records "unknown" for a thrown value that carries no kind', async () => {
      const attributes: Record<string, unknown>[] = [];
      const span = {
        setAttributes: (attrs: Record<string, unknown>) => attributes.push(attrs),
        setStatus: () => {},
        end: () => {},
        spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 })
      };

      const restore = vi.spyOn(trace, 'getTracer').mockReturnValue({
        startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never
      } as never);

      await expect(
        withSpan('gma.call', { tool: 't' }, async () => {
          throw 'a bare string';
        })
      ).rejects.toBe('a bare string');

      expect(attributes).toContainEqual({ errorKind: 'unknown' });

      restore.mockRestore();
    });

    it('returns the callback result and rethrows the original error unchanged', async () => {
      await expect(withSpan('ok', { tool: 't' }, async () => 7)).resolves.toBe(7);

      const boom = new Error('boom');
      await expect(
        withSpan('bad', { tool: 't' }, async () => {
          throw boom;
        })
      ).rejects.toBe(boom);
    });

    it('handles a thrown non-object without crashing the span helper', async () => {
      await expect(
        withSpan('bad', { tool: 't' }, async () => {
          throw 'a string';
        })
      ).rejects.toBe('a string');
    });
  });

  describe('traceparent', () => {
    it('returns null when no span is recording, rather than a malformed header', () => {
      // With no OTel SDK registered there is no active span; emitting a fabricated
      // traceparent would corrupt a downstream trace.
      expect(traceparent()).toBeNull();
    });
  });

  describe('levelForOutcome', () => {
    it('logs a complete outcome at info and every incomplete one at warn', () => {
      expect(levelForOutcome('COMPLETE')).toBe('info');
      expect(levelForOutcome('PARTIAL')).toBe('warn');
      expect(levelForOutcome('TOO_BROAD')).toBe('warn');
      expect(levelForOutcome('TIMEOUT_PARTIAL')).toBe('warn');
    });
  });
});
