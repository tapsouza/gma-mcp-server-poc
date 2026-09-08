import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { ToolError } from '../../src/core/types.js';
import {
  LIST_JURISDICTION_CONTEXTS_DESCRIPTION,
  LIST_JURISDICTION_CONTEXTS_OPERATION,
  listJurisdictionContexts
} from '../../src/domains/customer/tools/listJurisdictionContexts.js';
import { GMA_BASE_URL, TEST_TOKEN, testConfig, useGmaServer } from '../helpers/gma.js';

import contexts200 from '../fixtures/gma/crsContexts/200-success.json' with { type: 'json' };
import contexts401 from '../fixtures/gma/crsContexts/401-unauthorized.json' with { type: 'json' };
import contexts403 from '../fixtures/gma/crsContexts/403-forbidden.json' with { type: 'json' };
import contexts500 from '../fixtures/gma/crsContexts/500-server-error.json' with { type: 'json' };

/**
 * `list_jurisdiction_contexts` — the domain's scoping-discovery tool.
 *
 * The tool's whole justification is testable in one assertion: a code that no
 * derivation could produce survives the round trip. If that failed, the tool would be
 * redundant and a hardcoded table would be defensible — which constitution v1.2.0
 * prohibits precisely because it would fail confidently as jurisdictions are added.
 */

const server = useGmaServer();
const CONTEXTS = `${GMA_BASE_URL}${LIST_JURISDICTION_CONTEXTS_OPERATION}`;
const client = () => createGmaClient({ config: testConfig() });

describe('list_jurisdiction_contexts (foundational)', () => {
  describe('case: full success returns every jurisdiction with a complete verdict', () => {
    it('maps upstream context vocabulary to code/id/name', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts200)));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(result.jurisdictions).toEqual([
        { code: 'NJ', id: 'ctx-us-nj', name: 'New Jersey' },
        { code: 'PA', id: 'ctx-us-pa', name: 'Pennsylvania' },
        { code: 'CO', id: 'ctx-us-co', name: 'Colorado' },
        { code: 'NXTCANBS', id: 'ctx-ca-on', name: 'Ontario' }
      ]);
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.outcome).toBe('COMPLETE');
      expect(result.completeness.caveat).toBeNull();
    });

    it('carries a NON-DERIVABLE code through unchanged — the reason this tool exists', () => {
      // Ontario's context code is `NXTCANBS` against a catalogue jurisdiction of
      // `urn:i:FD:CA-ON`. No derivation covers both that and `NJ`, which is why
      // Principle V requires a lookup and v1.2.0 prohibits a hardcoded table.
      const ontario = contexts200.find((context) => context.contextName === 'Ontario');

      expect(ontario?.contextCode).toBe('NXTCANBS');
      expect(ontario?.contextCode).not.toMatch(/^[A-Z]{2}$/);
    });

    it('surfaces that non-derivable code in the mapped result, not just in the fixture', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts200)));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);
      const codes = result.jurisdictions.map((j) => j.code);

      expect(codes).toContain('NXTCANBS');
      // And a two-letter code is present too, so the tool is not accidentally
      // filtering to one shape.
      expect(codes).toContain('NJ');
    });

    it('carries completeness with BOTH axes present on full success (FR-005, FR-026)', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts200)));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(Object.keys(result).sort()).toEqual(['completeness', 'jurisdictions']);
      expect(result.completeness).toHaveProperty('failedInstances');
      expect(result.completeness).toHaveProperty('unavailableComponents');
      expect(result.completeness.failedInstances).toEqual([]);
      expect(result.completeness.unavailableComponents).toEqual([]);
    });

    it('exposes no upstream DTO vocabulary in the result (Principle IV)', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts200)));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain('contextCode');
      expect(serialised).not.toContain('contextId');
      expect(serialised).not.toContain('contextName');
    });

    it('forwards the operator token unaltered', async () => {
      let observed: string | null = null;
      server.use(
        http.get(CONTEXTS, ({ request }) => {
          observed = request.headers.get('authorization');
          return HttpResponse.json(contexts200);
        })
      );

      await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(observed).toBe(`Bearer ${TEST_TOKEN}`);
    });
  });

  describe('case: a context with no usable code is dropped rather than fabricated', () => {
    it('omits an entry whose code is absent or empty', async () => {
      // This surface is a raw forwarding proxy with no declared contract, so a
      // missing field is a real possibility. A fabricated code would be handed to
      // the metrics filter and rejected there, blaming the agent for our invention.
      server.use(
        http.get(CONTEXTS, () =>
          HttpResponse.json([
            { contextId: 'ctx-us-nj', contextCode: 'NJ', contextName: 'New Jersey' },
            { contextId: 'ctx-broken', contextCode: '', contextName: 'Nowhere' },
            { contextId: 'ctx-also-broken', contextName: 'Nameless' }
          ])
        )
      );

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(result.jurisdictions).toEqual([{ code: 'NJ', id: 'ctx-us-nj', name: 'New Jersey' }]);
    });

    it('falls back to the code rather than inventing a name', async () => {
      server.use(
        http.get(CONTEXTS, () => HttpResponse.json([{ contextId: 'ctx-x', contextCode: 'XX' }]))
      );

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(result.jurisdictions).toEqual([{ code: 'XX', id: 'ctx-x', name: 'XX' }]);
    });

    it('returns an empty list without error when the body is not an array at all', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json({ unexpected: true })));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(result.jurisdictions).toEqual([]);
      // Still complete: the source answered, and it answered with nothing usable.
      // Inventing a partial verdict here is what Principle II forbids on a surface
      // that publishes no partial-failure signal (research.md R2).
      expect(result.completeness.complete).toBe(true);
    });

    it('returns an empty list for an empty upstream array', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json([])));

      const result = await listJurisdictionContexts(client(), TEST_TOKEN);

      expect(result.jurisdictions).toEqual([]);
      expect(result.completeness.complete).toBe(true);
    });
  });

  describe('case: 401 is an auth error a human can act on (Principle I)', () => {
    it('maps to kind auth, not retryable, carrying no completeness', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts401, { status: 401 })));

      await expect(listJurisdictionContexts(client(), TEST_TOKEN)).rejects.toThrow(ToolError);

      try {
        await listJurisdictionContexts(client(), TEST_TOKEN);
        expect.unreachable('a 401 must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('auth');
        expect(toolError.retryable).toBe(false);
        expect(toolError).not.toHaveProperty('completeness');
      }
    });
  });

  describe('case: 403 is forbidden and NOT retryable, never conflated with auth (SC-009)', () => {
    it('maps to kind forbidden with retryable false', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts403, { status: 403 })));

      try {
        await listJurisdictionContexts(client(), TEST_TOKEN);
        expect.unreachable('a 403 must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('forbidden');
        expect(toolError.retryable).toBe(false);
      }
    });

    it('is a DIFFERENT kind from a 401 on the same operation', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts403, { status: 403 })));
      const forbidden = await listJurisdictionContexts(client(), TEST_TOKEN).catch(
        (e) => e as ToolError
      );

      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts401, { status: 401 })));
      const auth = await listJurisdictionContexts(client(), TEST_TOKEN).catch(
        (e) => e as ToolError
      );

      expect(forbidden.kind).toBe('forbidden');
      expect(auth.kind).toBe('auth');
      expect(forbidden.kind).not.toBe(auth.kind);
    });

    it('tells the human to request access, and the agent not to retry', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts403, { status: 403 })));

      const error = await listJurisdictionContexts(client(), TEST_TOKEN).catch(
        (e) => e as ToolError
      );

      expect(error.message).toMatch(/request access/i);
      expect(error.message.toLowerCase()).toContain('do not retry');
      expect(error.message).not.toMatch(/re-?authenticate/i);
    });
  });

  describe('case: 500 is a retryable upstream error, not an empty list', () => {
    it('maps to kind upstream rather than returning zero jurisdictions', async () => {
      // The failure mode this rules out: an empty list would tell the agent that no
      // jurisdiction exists, so it would report every code as invalid.
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts500, { status: 500 })));

      try {
        await listJurisdictionContexts(client(), TEST_TOKEN);
        expect.unreachable('a 500 must not resolve to an empty list');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('upstream');
        expect(toolError.retryable).toBe(true);
      }
    });
  });

  describe('case: the description instructs the agent as Principle IV and FR-009 require', () => {
    it('tells the agent to relay a caveat, which the smoke test requires of every tool', () => {
      expect(LIST_JURISDICTION_CONTEXTS_DESCRIPTION.toLowerCase()).toContain('relay');
    });

    it("warns that codes are not derivable, which is the tool's entire justification", () => {
      expect(LIST_JURISDICTION_CONTEXTS_DESCRIPTION).toMatch(/not derivable/i);
    });

    it('states that an absent jurisdiction is not evidence it does not exist', () => {
      // The honesty property specific to a discovery tool: an incomplete list must
      // not become a claim about what the platform supports.
      expect(LIST_JURISDICTION_CONTEXTS_DESCRIPTION).toMatch(/not evidence/i);
    });

    it('exposes no upstream DTO vocabulary to the model', () => {
      expect(LIST_JURISDICTION_CONTEXTS_DESCRIPTION).not.toContain('contextCode');
      expect(LIST_JURISDICTION_CONTEXTS_DESCRIPTION).not.toContain('crs');
    });
  });
});
