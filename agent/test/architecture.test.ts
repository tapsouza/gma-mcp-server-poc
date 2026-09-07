import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture assertions for the harness (T019, T046).
 *
 * Modelled on `test/unit/architecture.test.ts`, and for the same reason: these guard a
 * CLASS of regression no behavioural test would catch. Two properties in particular
 * would fail silently — a credential printed from a file that bypasses the render
 * chokepoint, and a system prompt that grows until it coaches the model.
 *
 * Note this suite asserts the harness's OWN invariants. It deliberately does not
 * re-assert the server's; `src/` has its own suite, unchanged by this feature.
 */

const AGENT = new URL('../', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const files = walk(AGENT).map((path) => ({
  path: path.slice(AGENT.length),
  source: readFileSync(path, 'utf8')
}));

/** Production files only — a test may legitimately import from anywhere and log freely. */
const sourceFiles = files.filter(({ path }) => !path.startsWith('test/'));

describe('harness architecture invariants', () => {
  it('has source files to inspect', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  describe('case: the harness is a client, not part of the server (Principle III)', () => {
    it('imports nothing from src/', () => {
      const offenders = files
        .filter(({ source }) => /from\s+'[^']*(\.\.\/)+src\//.test(source))
        .map((f) => f.path);

      // The harness reaches the server ONLY as an MCP client over stdio. An import
      // would couple it to internals the server is free to change, and would let a
      // `src/` refactor break a development tool that is meant to observe from outside.
      expect(offenders).toEqual([]);
    });
  });

  describe('case: every terminal write goes through the redaction chokepoint (FR-014, SC-008)', () => {
    it('calls console.* nowhere outside render.ts', () => {
      const offenders = sourceFiles
        .filter(({ path }) => path !== 'repl/render.ts')
        .filter(({ source }) => /\bconsole\.(log|info|warn|error|debug)\b/.test(source))
        .map((f) => f.path);

      expect(offenders).toEqual([]);
    });

    it('touches process.stdout nowhere outside render.ts', () => {
      const offenders = sourceFiles
        .filter(({ path }) => path !== 'repl/render.ts')
        .filter(({ source }) => source.includes('process.stdout'))
        .map((f) => f.path);

      // One chokepoint is what makes "zero credential material in any output, on any
      // failure path" provable. Scattered writes make it unprovable.
      expect(offenders).toEqual([]);
    });

    it('routes even failure paths through render.ts, never process.stderr directly', () => {
      const offenders = sourceFiles
        .filter(({ path }) => path !== 'repl/render.ts')
        .filter(({ source }) => source.includes('process.stderr.write'))
        .map((f) => f.path);

      expect(offenders).toEqual([]);
    });
  });

  describe('case: no operational host is hardcoded (Principle V, FR-021)', () => {
    it('contains no absolute http(s) host literal', () => {
      for (const { path, source } of sourceFiles) {
        // The Okta endpoint PATHS (`/v1/device/authorize`, `/v1/token`) are RFC 8628
        // protocol constants and are allowed; a HOST never is. Both come from
        // OKTA_ISSUER at runtime (plan.md Complexity Tracking).
        expect(source.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [], path).toEqual([]);
      }
    });

    it('names no real identity-provider host', () => {
      for (const { path, source } of sourceFiles) {
        expect(source, path).not.toContain('flutteruki.okta.com');
        expect(source, path).not.toContain('fanduel.okta.com');
      }
    });
  });

  describe('case: the system prompt does not coach the model (FR-008, Story 3 AC-3)', () => {
    const prompt = files.find(({ path }) => path === 'prompt.ts');

    it('exists as its own file', () => {
      expect(prompt).toBeDefined();
    });

    it('restates neither the caveat-relaying nor the non-selection rule', () => {
      // Read from the exported prompt STRING, not the whole file: the file's own
      // comments explain at length why this restriction exists, and must be allowed to
      // say the words the prompt itself may not.
      const match = /export const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join/.exec(prompt!.source);
      expect(match, 'SYSTEM_PROMPT must be a joined string array').toBeDefined();
      const promptText = match![1]!.toLowerCase();

      // Coaching the model would silently turn SC-002 and SC-003 into measurements of
      // this prompt rather than of the server's tool descriptions — a false pass, since
      // a third-party agent never reads this file.
      for (const forbidden of [
        'caveat',
        'completeness',
        'incomplete',
        'relay',
        'candidate',
        'ambiguous',
        'do not choose',
        'ask which',
        'failed instance'
      ]) {
        expect(promptText, `prompt must not mention "${forbidden}"`).not.toContain(forbidden);
      }
    });

    it('stays short enough that coaching could not hide in it', () => {
      // A size bound is crude, but it is the property that actually matters: FR-008 is
      // violated by ACCUMULATION, one reasonable-looking line at a time, and a review
      // that sees only a diff will wave each one through.
      const match = /export const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join/.exec(prompt!.source);
      expect(match![1]!.length).toBeLessThan(1200);
    });
  });

  describe('case: no AWS credential can reach the child (FR-011)', () => {
    it('never names an AWS credential variable in the spawn path', () => {
      const spawn = files.find(({ path }) => path === 'mcp/spawn.ts');
      expect(spawn).toBeDefined();

      // The allowlist is positive by construction: the child's env is built by naming
      // what it gets, so a credential cannot arrive by being forgotten. Seeing an AWS
      // credential name in this file at all would mean someone started reasoning about
      // exclusion instead, which is the shape that leaks.
      for (const forbidden of ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN']) {
        expect(spawn!.source, `spawn.ts must not reference ${forbidden}`).not.toContain(forbidden);
      }
    });
  });
});
