import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture assertions (T050, FR-002, FR-018, FR-023a, Principle III).
 *
 * These guard against a whole CLASS of regression that no behavioural test would
 * catch: a future edit that introduces a cached token, a hardcoded host, or a
 * cross-boundary import. The properties are structural, so they are asserted
 * structurally — by reading the source.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const files = walk(SRC).map((path) => ({
  path: path.slice(SRC.length),
  source: readFileSync(path, 'utf8')
}));

/**
 * Source with comments removed.
 *
 * Used only by the assertions that look for CODE shapes. These modules explain their own
 * invariants at length — a doc comment saying a result is `complete: true` even when a
 * jurisdiction is unresolved is documentation OF the rule, not a second place the verdict
 * is constructed. Matching it would push an author to delete the rationale to satisfy the
 * guard, which is the wrong trade: the prose is why the next reader gets it right.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * A module DECIDING completeness: `complete:` set to a boolean literal.
 *
 * Deliberately narrow. Declaring the field — `readonly complete: boolean` in the type,
 * `complete: z.boolean()` in a schema — is not deciding its value, and a shorthand
 * (`{ complete, outcome }`) is a value derived elsewhere. Only a literal asserts a verdict
 * the module has not earned, which is the thing Principle II confines to one place.
 */
const VERDICT_LITERAL = /complete:\s*(true|false)\b/;

describe('architecture invariants', () => {
  it('has source files to inspect', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  describe('case: no ambient identity or configuration state (FR-002, FR-023a)', () => {
    it('declares no module-level mutable binding anywhere', () => {
      const offenders = files.flatMap(({ path, source }) =>
        source
          .split('\n')
          .map((line, i) => ({ line, number: i + 1 }))
          // A top-level `let`/`var` is the shape a token or config cache takes.
          .filter(({ line }) => /^(let|var)\s/.test(line))
          .map(({ number }) => `${path}:${number}`)
      );

      expect(offenders).toEqual([]);
    });

    it('uses no async-local storage or global object to carry a request scope', () => {
      for (const { path, source } of files) {
        expect(source, path).not.toContain('AsyncLocalStorage');
        expect(source, path).not.toContain('globalThis.');
      }
    });

    it('reads process.env in exactly two places, both as an injectable default', () => {
      const readers = files.filter(({ source }) => source.includes('process.env'));

      // config.ts (startup) and identity.ts (per-invocation stdio fallback). Any third
      // reader means an operational value is being picked up somewhere unaudited.
      expect(readers.map((r) => r.path).sort()).toEqual(['core/config.ts', 'core/identity.ts']);

      for (const { path, source } of readers) {
        // `= process.env` as a parameter default, never a bare module-level read.
        expect(source, path).toMatch(/env: NodeJS\.ProcessEnv = process\.env/);
      }
    });

    it('never stores the token on an object or in a closure outside its call', () => {
      for (const { path, source } of files) {
        expect(source, path).not.toMatch(/this\.token\s*=/);
        expect(source, path).not.toMatch(/^\s*(cachedToken|currentToken|lastToken)/m);
      }
    });
  });

  describe('case: no operational value is hardcoded (FR-018, FR-024b)', () => {
    it('contains no hardcoded GMA or OKTA host', () => {
      for (const { path, source } of files) {
        // Both real-world values the design documents warn about, plus any bare host.
        expect(source, path).not.toContain('flutteruki.okta.com');
        expect(source, path).not.toContain('fanduel.okta.com');
        expect(
          source.match(/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [],
          path
        ).toEqual([]);
      }
    });

    it('defines the default timeout and candidate cap only in config.ts', () => {
      const withDefaults = files.filter(
        ({ source }) => source.includes('30_000') || source.includes('30000')
      );

      expect(withDefaults.map((f) => f.path)).toEqual(['core/config.ts']);
    });
  });

  describe('case: module boundaries hold (Principle III)', () => {
    it('has no core file importing from domains', () => {
      const offenders = files
        .filter(({ path }) => path.startsWith('core/'))
        .filter(({ source }) => /from\s+'[^']*domains\//.test(source))
        .map((f) => f.path);

      expect(offenders).toEqual([]);
    });

    it('has no domain importing from another domain', () => {
      const domainFiles = files.filter(({ path }) => path.startsWith('domains/'));

      for (const { path, source } of domainFiles) {
        const ownDomain = path.split('/')[1];
        const crossDomain = [...source.matchAll(/from\s+'[^']*domains\/([^/']+)\//g)]
          .map((match) => match[1])
          .filter((other) => other !== ownDomain);

        expect(crossDomain, path).toEqual([]);
      }
    });

    it('lets no module outside core/completeness.ts decide `complete` (Principle II)', () => {
      // The invariant: one place decides whether a result is complete, so there is one
      // place to review when the rule changes. Asserted as an ABSENCE elsewhere rather
      // than a presence in the owning module — `completeness.ts` derives the value and
      // passes it by shorthand, and a guard keyed to one spelling of the assignment
      // stops describing the rule the moment that module is refactored.
      //
      // Comments are stripped: these modules explain their own invariants, and prose
      // documenting the rule is not a second implementation of it. Matching prose would
      // push an author to delete the rationale to satisfy the guard.
      const offenders = files
        .filter(({ path }) => path !== 'core/completeness.ts')
        .filter(({ source }) => VERDICT_LITERAL.test(stripComments(source)))
        .map((f) => f.path);

      expect(offenders).toEqual([]);
    });

    it('guards the guard: it catches a real verdict and ignores mere declarations', () => {
      // Without this, a bug in `stripComments` — or a pattern drawn too wide or too
      // narrow — would silently disarm the assertion above, and nobody would learn until
      // a second module started deciding completeness.
      expect(VERDICT_LITERAL.test(stripComments('const v = { complete: true };'))).toBe(true);
      expect(VERDICT_LITERAL.test(stripComments('return { complete: false };'))).toBe(true);

      // Declaring the FIELD is not deciding its value: a type and a schema must both be
      // able to name it, and only `completeness.ts` may state a literal.
      expect(VERDICT_LITERAL.test(stripComments('readonly complete: boolean;'))).toBe(false);
      expect(VERDICT_LITERAL.test(stripComments('complete: z.boolean()'))).toBe(false);
      expect(VERDICT_LITERAL.test(stripComments('return { complete, outcome };'))).toBe(false);
      expect(VERDICT_LITERAL.test(stripComments('// complete: true'))).toBe(false);
      expect(VERDICT_LITERAL.test(stripComments('/** complete: false */'))).toBe(false);
    });

    it('keeps HTTP-status-to-error mapping in exactly one module (Principle II)', () => {
      // `forbidden` is included deliberately: it is the newest kind and the one a
      // domain is most tempted to construct itself, because a 403 arrives inside a
      // GraphQL body on one of this project's surfaces. Only core/errors.ts may
      // decide that a status means "permission absent, do not retry".
      const mappers = files.filter(
        ({ path, source }) =>
          path !== 'core/errors.ts' && /kind:\s*'(auth|forbidden|notFound|argument)'/.test(source)
      );

      expect(mappers.map((f) => f.path)).toEqual([]);
    });
  });

  describe('case: no credential can reach a log (FR-020)', () => {
    it('never logs an Authorization header or a token field', () => {
      for (const { path, source } of files) {
        expect(source, path).not.toMatch(/log(ger)?\.\w+\([^)]*[Tt]oken/);
        expect(source, path).not.toMatch(/log(ger)?\.\w+\([^)]*[Aa]uthorization/);
      }
    });

    it('uses console nowhere, so every line goes through the allowlist logger', () => {
      for (const { path, source } of files) {
        expect(source, path).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
      }
    });

    it('writes to stdout only from the entrypoint, never as a log line', () => {
      const stdoutWriters = files.filter(({ source }) => source.includes('process.stdout'));

      // stdout belongs to the stdio JSON-RPC stream; a stray write corrupts it.
      expect(stdoutWriters.map((f) => f.path)).toEqual([]);
    });
  });
});
