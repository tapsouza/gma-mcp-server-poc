import { describe, expect, it } from 'vitest';
import { argumentError, fromHttpStatus } from '../../src/core/errors.js';
import { complete } from '../../src/core/completeness.js';
import { toErrorResult, toSuccessResult } from '../../src/domains/catalogue/index.js';

/**
 * The MCP result envelope.
 *
 * This is the last place a failure could be dressed as data, so it is asserted
 * directly rather than only through a tool round-trip.
 */

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret.signature';

describe('tool result mapping', () => {
  describe('case: a tool error carries its kind and NO completeness (FR-010)', () => {
    it.each([
      [400, 'argument'],
      [401, 'auth'],
      [404, 'notFound'],
      [500, 'upstream']
    ] as const)('marks HTTP %i as an error tagged %s', (status, kind) => {
      const result = toErrorResult(fromHttpStatus(status, 'listInstances'));

      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toContain(`[${kind}]`);
      // No structuredContent at all: an error must not resemble a successful payload.
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('completeness');
      expect(result._meta).toMatchObject({ kind });
    });

    it('surfaces retryable so an agent does not retry what it cannot fix', () => {
      expect(toErrorResult(fromHttpStatus(401, 'op'))._meta).toMatchObject({ retryable: false });
      expect(toErrorResult(fromHttpStatus(500, 'op'))._meta).toMatchObject({ retryable: true });
    });

    it('passes through a locally-raised argument error with its hint', () => {
      const result = toErrorResult(
        argumentError('Unknown instance code "ZZ".', 'Call list_instances for valid codes.')
      );

      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain('[argument]');
      expect(text).toContain('list_instances');
    });
  });

  describe('case: an unexpected throw is reported without leaking its message (FR-020)', () => {
    it.each([
      ['an Error carrying a token', new Error(`boom ${TOKEN}`)],
      ['a bare string', `failed with ${TOKEN}`],
      ['a plain object', { message: TOKEN }],
      ['null', null],
      ['undefined', undefined]
    ])('reports %s as an opaque upstream error', (_label, thrown) => {
      const result = toErrorResult(thrown);

      expect(result.isError).toBe(true);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(TOKEN);
      expect((result.content as { text: string }[])[0]!.text).toContain('[upstream]');
      expect(result._meta).toMatchObject({ kind: 'upstream', retryable: true });
    });

    it('does not include a stack trace, which could carry request state', () => {
      const error = new Error('boom');
      error.stack = `Error: boom\n  at handler (token=${TOKEN})`;

      expect(JSON.stringify(toErrorResult(error))).not.toContain(TOKEN);
    });
  });

  describe('case: a success result carries the verdict in BOTH representations (FR-005)', () => {
    it('puts the same payload in structuredContent and in the text mirror', () => {
      const payload = { instances: [{ code: 'PP' }], completeness: complete(['urn:i:PP:PP']) };

      const result = toSuccessResult(payload);

      expect(result.structuredContent).toEqual(payload);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(payload)));
    });

    it('cannot present data in one representation while omitting the verdict from the other', () => {
      // Both views are the same object, so a client reading either sees the verdict.
      const payload = { kind: 'none', completeness: complete() };
      const result = toSuccessResult(payload);

      expect(result.structuredContent).toHaveProperty('completeness');
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toHaveProperty(
        'completeness'
      );
    });

    it('is not marked as an error', () => {
      expect(toSuccessResult({ completeness: complete() }).isError).toBeUndefined();
    });
  });
});
