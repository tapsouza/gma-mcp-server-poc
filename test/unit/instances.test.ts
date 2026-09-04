import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { codeToUrn, isInstanceUrn, resolveInstances, urnToCode } from '../../src/core/instances.js';
import { ToolError } from '../../src/core/types.js';

const config: Config = Object.freeze({
  gmaBaseUrl: 'https://gma.example-nonprod.invalid',
  defaultInstances: Object.freeze(['PP', 'BF']),
  oktaIssuer: 'https://example.okta.invalid/oauth2/aus0',
  requestTimeoutMs: 30_000,
  maxCandidates: 25,
  logLevel: 'info'
});

describe('brand instance resolution', () => {
  describe('code to URN mapping (data-model.md section 3)', () => {
    it('builds the URN shape GMA expects from a short code', () => {
      expect(codeToUrn('PP')).toBe('urn:i:PP:PP');
      expect(codeToUrn('BF')).toBe('urn:i:BF:BF');
    });

    it('upper-cases a lower-case code, so an agent need not know the casing', () => {
      expect(codeToUrn('pp')).toBe('urn:i:PP:PP');
      expect(codeToUrn('sbg')).toBe('urn:i:SBG:SBG');
    });

    it('recovers the short code from a URN', () => {
      expect(urnToCode('urn:i:PP:PP')).toBe('PP');
      expect(urnToCode('urn:i:SBG:SBG')).toBe('SBG');
    });

    it('returns an unrecognised value unchanged rather than mangling it', () => {
      expect(urnToCode('something-else')).toBe('something-else');
      expect(urnToCode('')).toBe('');
    });

    it('round-trips a code through URN and back', () => {
      for (const code of ['PP', 'BF', 'SBG']) {
        expect(urnToCode(codeToUrn(code))).toBe(code);
      }
    });

    it('recognises an instance URN', () => {
      expect(isInstanceUrn('urn:i:PP:PP')).toBe(true);
      expect(isInstanceUrn('PP')).toBe(false);
      expect(isInstanceUrn('urn:sc:football')).toBe(false);
    });
  });

  describe('case: omitted instances fall back to the configured default (FR-017)', () => {
    it('uses the configured default set when the argument is absent', () => {
      expect(resolveInstances(undefined, config)).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
    });

    it('does not require the agent to know what the default is', () => {
      // Proven by the default being absent from the call: the agent passes nothing.
      const resolved = resolveInstances(undefined, config);
      expect(resolved).toHaveLength(config.defaultInstances.length);
    });
  });

  describe('explicit narrowing is honoured exactly', () => {
    it('maps supplied short codes to URNs', () => {
      expect(resolveInstances(['PP'], config)).toEqual(['urn:i:PP:PP']);
    });

    it('passes a supplied URN through, since an agent may echo an id it was given', () => {
      expect(resolveInstances(['urn:i:BF:BF'], config)).toEqual(['urn:i:BF:BF']);
    });

    it('accepts a mixture of codes and URNs', () => {
      expect(resolveInstances(['PP', 'urn:i:BF:BF'], config)).toEqual([
        'urn:i:PP:PP',
        'urn:i:BF:BF'
      ]);
    });

    it('trims surrounding whitespace on a supplied code', () => {
      expect(resolveInstances([' PP ', '\tBF\n'], config)).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
    });

    it('deduplicates a code supplied twice, including via both spellings', () => {
      expect(resolveInstances(['PP', 'pp', 'urn:i:PP:PP'], config)).toEqual(['urn:i:PP:PP']);
    });

    it('narrows to fewer instances than the default rather than widening', () => {
      const resolved = resolveInstances(['PP'], config);
      expect(resolved).toEqual(['urn:i:PP:PP']);
      expect(resolved).not.toContain('urn:i:BF:BF');
    });
  });

  describe('case: unknown instance code is an argument error naming list_instances (FR-017, SC-008)', () => {
    it.each([
      ['a value with a separator', 'PP-BF'],
      ['a sentence', 'Paddy Power'],
      ['a malformed URN', 'urn:i:PP'],
      ['a URL', 'https://gma.invalid'],
      ['an empty string', ''],
      ['whitespace only', '   ']
    ])('rejects %s, pointing the agent at list_instances', (_label, value) => {
      try {
        resolveInstances([value], config);
        expect.unreachable('must reject an unrecognised instance value');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError).toBeInstanceOf(ToolError);
        expect(toolError.kind).toBe('argument');
        expect(toolError.retryable).toBe(false);
        expect(toolError.message).toContain('list_instances');
      }
    });

    it('names every rejected value, so one correction fixes the whole call', () => {
      try {
        resolveInstances(['PP', 'ZZ-1', 'Paddy Power'], config);
        expect.unreachable('must reject the unrecognised values');
      } catch (error) {
        const message = (error as ToolError).message;
        expect(message).toContain('ZZ-1');
        expect(message).toContain('Paddy Power');
      }
    });

    it('reports an empty entry legibly rather than as an empty pair of quotes', () => {
      try {
        resolveInstances([''], config);
        expect.unreachable('must reject an empty instance value');
      } catch (error) {
        expect((error as ToolError).message).toContain('(empty)');
      }
    });

    it('accepts a code GMA may not know, since only GMA can adjudicate that', () => {
      // Shape validation only. A well-formed but non-existent code reaches GMA and
      // comes back as a 400, which maps to the same `argument` kind — this module
      // must not maintain its own drifting list of valid brands.
      expect(resolveInstances(['ZZ'], config)).toEqual(['urn:i:ZZ:ZZ']);
    });
  });

  describe('case: contradictory narrowing is an error, not a silent full-scope query', () => {
    it('rejects an explicitly empty list rather than substituting the default set', () => {
      try {
        resolveInstances([], config);
        expect.unreachable('must reject an explicitly empty instances list');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('argument');
        expect(toolError.message).toContain('empty');
        expect(toolError.message).toContain('Omit instances entirely');
      }
    });

    it('never widens the query when narrowing was requested but unusable', () => {
      // The failure mode this prevents: an empty list quietly becoming "all
      // instances", which is a wider query than the operator asked for.
      expect(() => resolveInstances([], config)).toThrow(ToolError);
    });
  });
});
