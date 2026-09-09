import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The read-only gate (BLOCKING — SC-010, FR-024, FR-025, Principle IV).
 *
 * ## Why this is a STRUCTURAL assertion over source text
 *
 * Constitution Principle IV: "A tool declared read-only MUST be read-only **by
 * construction**, not by convention … These MUST be enforced by an automated
 * assertion, not by review alone." And the reason it cannot be a behavioural test:
 *
 *  - `POST /qbs/{pathToQbs}` takes BOTH the path and the query from its caller, and the
 *    QBS schema declares `createBetNote`, `deleteBetNote`, `pinBetNote`,
 *    `unpinBetNote`.
 *  - `/crs/**` is a catch-all proxy that accepts `PUT /crs/accounts/{id}/riskSettings`.
 *  - Every read in this domain is a **POST**, so nothing about HOW a request is made
 *    distinguishes it from a write. Principle IV says so explicitly: "The request
 *    mechanics MUST NOT be relied on as the guard."
 *
 * A behavioural test can only prove that the calls we happen to make today are reads.
 * This proves that no caller-supplied value can REACH a query or a path at all — which
 * is the property that survives a future edit by someone who has not read this file.
 *
 * ## Re-run after the composite lands
 *
 * `get_bet_risk_context` builds its own event paths, so an audit written before that
 * code existed would prove less than it appears to. The path-construction assertion
 * below enumerates every path expression in the domain, so a new one fails this test
 * until it is explicitly accounted for.
 */

const DOMAIN = new URL('../../src/domains/customer/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Strip comments, so every assertion below is about CODE rather than prose.
 *
 * This matters more than it looks. The modules in this domain explain at length why
 * `?instance=` must never be sent, why the GraphQL document must contain no mutation,
 * and why `betNotesDetails` is not requested — so a scan of raw source would flag its
 * own rationale and force the explanation to be deleted to make the gate pass. That is
 * exactly backwards: the comments are why the next person keeps the property.
 *
 * String literals are preserved, because the GraphQL document IS a string literal and
 * the whole point is to inspect it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const files = walk(DOMAIN).map((path) => {
  const source = readFileSync(path, 'utf8');
  return {
    path: path.slice(DOMAIN.length),
    source,
    /** The same file with comments removed — what every assertion should read. */
    code: stripComments(source)
  };
});

const allCode = files.map((file) => file.code).join('\n');
const schemaFile = files.find((file) => file.path === 'schemas.ts');

/**
 * The schema file with `completenessSchema` excised.
 *
 * `completenessSchema` mirrors core's shared `Completeness`, including its
 * `errors: [{ instance, message }]` shape — where `instance` names the SOURCE that
 * failed, a concept every domain's verdict carries. That is not a scoping input, and
 * the assertions below are about what a caller may SUPPLY. Excising the block keeps the
 * assertion sharp instead of loosening the pattern until it stops catching anything.
 */
const domainSchemas = (schemaFile?.code ?? '').replace(
  /export const completenessSchema[\s\S]*?\n {2}\);\n/,
  ''
);

describe('read-only by construction (SC-010)', () => {
  it('has the customer domain source to inspect', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(schemaFile).toBeDefined();
  });

  describe('case: no schema accepts a query, path, or operation name (FR-024, FR-025)', () => {
    it.each([
      ['a query', /\b(query|gql|graphql)\s*:\s*z\./i],
      ['a query fragment', /\bfragment\s*:\s*z\./i],
      ['a field selection', /\b(fields|selection|select|projection)\s*:\s*z\./i],
      ['an operation name', /\boperationName\s*:\s*z\./i],
      ['an upstream path', /\b(path|pathTemplate|url|endpoint|uri)\s*:\s*z\./i],
      ['a brand', /\b(brand|commercialBrand)\s*:\s*z\./i],
      ['an instance', /\b(instance|instances|instancesList|configSource)\s*:\s*z\./i],
      ['a completeness verdict', /\b(completeness|complete|caveat)\s*:\s*z\./i],
      ['an operational value', /\b(baseUrl|timeout|issuer|host|accountSystem)\s*:\s*z\./i]
    ])('the schema file declares no input named like %s', (_label, pattern) => {
      // Asserted over the whole schema file (less `completenessSchema`) rather than
      // only the input schemas: an OUTPUT field of one of these names would be almost
      // as bad, because it would teach the model that such a value is part of this
      // domain's vocabulary.
      expect(domainSchemas.length).toBeGreaterThan(0);
      expect(domainSchemas).not.toMatch(pattern);
    });

    it("excised only the shared completeness block, not the domain's own schemas", () => {
      // Guards the guard: if the excision regex stopped matching, `domainSchemas`
      // would silently become the whole file (making the assertions above fail) or an
      // empty string (making them vacuous). Neither can pass unnoticed.
      expect(domainSchemas).not.toContain('unavailableComponents');
      expect(domainSchemas).toContain('customerRiskConfigurationSchema');
      expect(domainSchemas).toContain('findCustomerBetsInputSchema');
    });

    it('exposes no bare `instance` as a tool INPUT (constitution v1.2.0)', () => {
      // `?instance=` is ROUTING, not scoping. v1.2.0 forbids sending it while
      // multi-instance routing is disabled AND ever exposing it as a tool argument.
      //
      // Two mentions are legitimate and must not be confused with a routing knob:
      //   - `catalogueInstanceId` on a bet — a datum the BET reports about ITSELF.
      //   - `instance` inside the completeness error shape — that is core's
      //     `InstanceError`, the shared type every domain's verdict carries.
      // So this asserts about the INPUT schemas specifically.
      const inputSchemas = [...schemaFile!.code.matchAll(/InputSchema = \{[\s\S]*?\n\};/g)]
        .map((match) => match[0])
        .join('\n');

      expect(inputSchemas.length).toBeGreaterThan(0);
      expect(inputSchemas).not.toMatch(/\binstance/i);
      expect(inputSchemas).not.toMatch(/\bbrand/i);
      expect(inputSchemas).not.toMatch(/\bcompleteness/i);
    });

    it('constructs no instance query parameter anywhere in the domain', () => {
      expect(allCode).not.toMatch(/instance=/);
      expect(allCode).not.toMatch(/searchParams/);
      expect(allCode).not.toMatch(/instancesList/);
    });
  });

  describe('case: the GraphQL document is a constant with NO interpolation (FR-024)', () => {
    const documentFile = files.find((file) => file.path === 'gql/searchBets.ts');

    it('exists as its own module', () => {
      expect(documentFile).toBeDefined();
    });

    it('contains no template interpolation inside the document literal', () => {
      // The document is the one string in this domain a caller value must never
      // reach: an agent that can shape the query can send a mutation.
      const document = documentFile!.code;
      const literal = document.slice(document.indexOf('export const SEARCH_BETS_DOCUMENT'));
      const body = literal.slice(literal.indexOf('`') + 1, literal.indexOf('`;'));

      // GraphQL variable declarations (`$input`) are fine; JS interpolation is not.
      expect(body).not.toMatch(/\$\{(?!SEARCH_BETS_OPERATION_NAME)/);
    });

    it('contains no mutation keyword, and none of the four QBS mutations', () => {
      for (const { path, code } of files) {
        expect(code, path).not.toMatch(/\bmutation\s/i);
        for (const write of [
          'createBetNote',
          'deleteBetNote',
          'pinBetNote',
          'unpinBetNote',
          // A path fragment, not the CRS DTO name: `CrsAccountRiskSettings` is the
          // READ response type, while `/riskSettings` is the write endpoint.
          '/riskSettings'
        ]) {
          expect(code, `${path} references the write operation ${write}`).not.toContain(write);
        }
      }
    });

    it('never builds a document by concatenation or from a function argument', () => {
      const document = documentFile!.code;

      expect(document).not.toMatch(/function\s+build\w*Document/);
      expect(document).not.toMatch(/SEARCH_BETS_DOCUMENT\s*\+/);
      // The export is a plain `const`, so it cannot be reassigned at runtime.
      expect(document).toMatch(/export const SEARCH_BETS_DOCUMENT = `/);
    });

    it('requests no staff-authored note field, enforcing FR-004 at the document', () => {
      // Stronger than filtering after retrieval: the data never enters this process.
      expect(documentFile!.code).not.toContain('betNotesDetails');
      expect(documentFile!.code).not.toContain('settlementDetails');
      expect(documentFile!.code).not.toContain('settleBy');
    });
  });

  describe('case: every upstream path is a literal or a locally-validated template (FR-025)', () => {
    /**
     * Every `client.get(...)` / `client.post(...)` first argument in the domain.
     *
     * Enumerated rather than pattern-matched loosely, so a NEW call site fails this
     * test until it is accounted for — which is the point of re-running this gate
     * after the composite adds its own path construction.
     */
    const callSites = files.flatMap(({ path, code }) =>
      [...code.matchAll(/client\.(get|post)<[^>]*>\(\s*([^,\n]+)/g)].map((match) => ({
        file: path,
        method: match[1] as string,
        pathArgument: (match[2] as string).trim()
      }))
    );

    it('finds every call site, so the enumeration is not vacuous', () => {
      expect(callSites.length).toBeGreaterThan(0);
    });

    it('uses only a literal, a module constant, or a template with a validated identifier', () => {
      for (const site of callSites) {
        const isConstant = /^[A-Z][A-Z0-9_]*$/.test(site.pathArgument);
        const isLiteral = /^'[^']*'$/.test(site.pathArgument);
        // A template is allowed ONLY when every substitution is an
        // `encodeURIComponent(...)` of a locally-validated identifier. That is what
        // keeps a caller value from changing which resource is addressed on a
        // catch-all proxy.
        const isSafeTemplate =
          site.pathArgument.startsWith('`') &&
          [...site.pathArgument.matchAll(/\$\{([^}]*)\}/g)].every((match) =>
            (match[1] as string).includes('encodeURIComponent')
          );

        expect(
          isConstant || isLiteral || isSafeTemplate,
          `${site.file}: client.${site.method} path argument "${site.pathArgument}" is neither a literal, a constant, nor a template of encoded validated identifiers`
        ).toBe(true);
      }
    });

    it('never passes a caller-supplied value straight into a path', () => {
      // `args.x` reaching a path directly would defeat the whole guard.
      for (const site of callSites) {
        expect(
          site.pathArgument,
          `${site.file}: a caller argument reaches the path directly`
        ).not.toMatch(/\bargs\./);
      }
    });

    it('encodes every interpolated identifier, so a path separator cannot escape', () => {
      for (const site of callSites) {
        if (!site.pathArgument.startsWith('`')) continue;
        for (const match of site.pathArgument.matchAll(/\$\{([^}]*)\}/g)) {
          expect(
            match[1],
            `${site.file}: an unencoded value is interpolated into a path`
          ).toContain('encodeURIComponent');
        }
      }
    });

    it("reaches no upstream operation outside the constitution's surface register", () => {
      // Principle IV: "a tool MUST NOT call an operation absent from it." The
      // `customer` row permits exactly these.
      const REGISTERED = [
        '/crs/contexts',
        '/crs/accounts/',
        '/accounts/',
        '/qbs/graphql',
        '/v5/events/'
      ];

      const paths = [...allCode.matchAll(/['"`](\/(?:crs|qbs|v5|accounts)[^'"`\s]*)/g)].map(
        (match) => match[1] as string
      );

      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          REGISTERED.some((registered) => path.startsWith(registered)),
          `path "${path}" is not in the constitution's surface register for the customer domain`
        ).toBe(true);
      }
    });
  });

  describe('case: no HTTP verb capable of a write is used (Principle IV)', () => {
    it('calls only client.get and client.post', () => {
      // The client exposes no other verb, but asserting it here means adding one
      // would fail this test rather than passing silently.
      for (const { path, code } of files) {
        expect(code, path).not.toMatch(/client\.(put|patch|delete|head)/);
      }
    });

    it('never calls fetch, or any HTTP library, directly', () => {
      // Everything goes through the shared `core` client, which is what keeps the
      // identity, completeness and privacy guarantees in one auditable place.
      for (const { path, code } of files) {
        expect(code, path).not.toMatch(/\bfetch\s*\(/);
        expect(code, path).not.toMatch(/\b(axios|got|https?\.request)\b/);
        expect(code, path).not.toMatch(/new\s+XMLHttpRequest/);
      }
    });
  });

  describe('case: no operational value is agent-supplied (Principle V)', () => {
    it('reads process.env nowhere in the domain', () => {
      for (const { path, code } of files) {
        expect(code, path).not.toContain('process.env');
      }
    });

    it('hardcodes no host', () => {
      for (const { path, code } of files) {
        expect(code.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [], path).toEqual([]);
      }
    });

    it('declares no module-level mutable binding that could cache a token', () => {
      for (const { path, code } of files) {
        const offenders = code.split('\n').filter((line) => /^(let|var)\s/.test(line));
        expect(offenders, path).toEqual([]);
      }
    });
  });
});
