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

    it('keeps completeness construction in exactly one module (Principle II)', () => {
      // Every verdict must come from core/completeness.ts, so there is one place where
      // `complete` is decided and one place to review when it changes.
      const constructors = files.filter(({ source }) => /complete:\s*(true|false)/.test(source));

      expect(constructors.map((f) => f.path)).toEqual(['core/completeness.ts']);
    });

    it('keeps HTTP-status-to-error mapping in exactly one module (Principle II)', () => {
      const mappers = files.filter(
        ({ path, source }) =>
          path !== 'core/errors.ts' && /kind:\s*'(auth|notFound|argument)'/.test(source)
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
