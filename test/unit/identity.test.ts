import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STDIO_TOKEN_ENV_VAR,
  authorizationHeader,
  extractOperatorToken,
  type OperatorToken
} from '../../src/core/identity.js';
import { ToolError } from '../../src/core/types.js';

const TOKEN_A = 'eyJhbGciOiJSUzI1NiJ9.aaa.signature-a';
const TOKEN_B = 'eyJhbGciOiJSUzI1NiJ9.bbb.signature-b';

describe('operator identity', () => {
  describe('case: identity is read per invocation, never from module state (FR-023a)', () => {
    it('reads the token from the per-request handler argument', () => {
      const token = extractOperatorToken({ authInfo: { token: TOKEN_A } }, {});

      expect(token).toBe(TOKEN_A);
    });

    it('returns each invocation its own token, with no bleed between them', () => {
      const first = extractOperatorToken({ authInfo: { token: TOKEN_A } }, {});
      const second = extractOperatorToken({ authInfo: { token: TOKEN_B } }, {});
      const third = extractOperatorToken({ authInfo: { token: TOKEN_A } }, {});

      expect(first).toBe(TOKEN_A);
      expect(second).toBe(TOKEN_B);
      expect(third).toBe(TOKEN_A);
    });

    it('does not remember a previous invocation once its source is gone', () => {
      extractOperatorToken({ authInfo: { token: TOKEN_A } }, {});

      // If the module had cached anything, this would succeed instead of throwing.
      expect(() => extractOperatorToken(undefined, {})).toThrow(ToolError);
    });

    it('holds no module-level mutable state, verified by reading its own source', () => {
      // A structural assertion, because the failure mode this guards against is a
      // future edit adding a cache — which no behavioural test would catch.
      const source = readFileSync(new URL('../../src/core/identity.ts', import.meta.url), 'utf8');
      const topLevelMutable = source.split('\n').filter((line) => /^(let|var)\s/.test(line.trim()));

      expect(topLevelMutable).toEqual([]);
      expect(source).not.toContain('AsyncLocalStorage');
      expect(source).not.toMatch(/^const cache/m);
    });
  });

  describe('transport identity takes precedence over the environment', () => {
    it('prefers the request-supplied token when both are present', () => {
      const token = extractOperatorToken(
        { authInfo: { token: TOKEN_A } },
        { [STDIO_TOKEN_ENV_VAR]: TOKEN_B }
      );

      expect(token).toBe(TOKEN_A);
    });

    it('falls back to the environment under stdio, where no request carries a bearer', () => {
      const token = extractOperatorToken(undefined, { [STDIO_TOKEN_ENV_VAR]: TOKEN_B });

      expect(token).toBe(TOKEN_B);
    });

    it('re-reads the environment on each call, so a rotated token takes effect immediately', () => {
      const env: NodeJS.ProcessEnv = { [STDIO_TOKEN_ENV_VAR]: TOKEN_A };
      expect(extractOperatorToken(undefined, env)).toBe(TOKEN_A);

      env[STDIO_TOKEN_ENV_VAR] = TOKEN_B;
      expect(extractOperatorToken(undefined, env)).toBe(TOKEN_B);
    });

    it('falls back to the environment when authInfo is present but carries no token', () => {
      const token = extractOperatorToken({ authInfo: {} }, { [STDIO_TOKEN_ENV_VAR]: TOKEN_B });

      expect(token).toBe(TOKEN_B);
    });
  });

  describe('case: absent identity is an auth failure a human can act on (FR-003)', () => {
    it.each([
      ['no extra and no env', undefined, {}],
      ['empty authInfo token', { authInfo: { token: '' } }, {}],
      ['whitespace-only env token', undefined, { [STDIO_TOKEN_ENV_VAR]: '   ' }],
      ['a bare "Bearer" prefix with nothing after it', { authInfo: { token: 'Bearer ' } }, {}]
    ] as const)('refuses with kind auth when there is %s', (_label, extra, env) => {
      try {
        extractOperatorToken(extra, env as NodeJS.ProcessEnv);
        expect.unreachable('must throw when no usable identity accompanies the request');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError).toBeInstanceOf(ToolError);
        expect(toolError.kind).toBe('auth');
        expect(toolError.retryable).toBe(false);
        expect(toolError.message).toContain(STDIO_TOKEN_ENV_VAR);
        expect(toolError.message).toContain('holds no credentials of its own');
      }
    });

    it('never echoes the offending value in the error message (FR-020)', () => {
      try {
        extractOperatorToken({ authInfo: { token: `  ${TOKEN_A} extra  ` } }, {});
        expect.unreachable('must reject a token containing whitespace');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('argument');
        expect(toolError.message).not.toContain(TOKEN_A);
      }
    });
  });

  describe('case: the token is forwarded unaltered (FR-001, Principle I)', () => {
    it('returns the token byte-for-byte, with no re-encoding', () => {
      const awkward = 'eyJ.a-b_c~d.sig+with/chars=';
      expect(extractOperatorToken({ authInfo: { token: awkward } }, {})).toBe(awkward);
    });

    it('trims surrounding whitespace, which is transport noise rather than credential content', () => {
      expect(extractOperatorToken({ authInfo: { token: `\n  ${TOKEN_A}  \t` } }, {})).toBe(TOKEN_A);
    });

    it('strips a duplicated Bearer scheme rather than forwarding a header GMA would 401', () => {
      expect(extractOperatorToken({ authInfo: { token: `Bearer ${TOKEN_A}` } }, {})).toBe(TOKEN_A);
      expect(extractOperatorToken({ authInfo: { token: `bearer ${TOKEN_A}` } }, {})).toBe(TOKEN_A);
    });

    it('builds exactly one Bearer header, adding the scheme and nothing else', () => {
      expect(authorizationHeader(TOKEN_A as OperatorToken)).toBe(`Bearer ${TOKEN_A}`);
    });

    it('does not validate signature, issuer, or expiry — GMA is the single authority', () => {
      // A structurally absurd but non-empty value is accepted here and rejected by
      // GMA as 401. Duplicating GMA's checks would create a second, drifting opinion
      // about who is authorized (constitution Principle I).
      expect(extractOperatorToken({ authInfo: { token: 'not-a-jwt' } }, {})).toBe('not-a-jwt');
    });
  });
});
