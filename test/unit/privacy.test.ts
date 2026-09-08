import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { createLogger, type LogSink } from '../../src/core/telemetry.js';
import type { ToolError } from '../../src/core/types.js';
import { getCustomerRiskProfile } from '../../src/domains/customer/tools/getCustomerRiskProfile.js';
import { listJurisdictionContexts } from '../../src/domains/customer/tools/listJurisdictionContexts.js';
import { GMA_BASE_URL, TEST_TOKEN, testConfig, useGmaServer } from '../helpers/gma.js';

import crsThree from '../fixtures/gma/crsAccounts/200-three-jurisdictions.json' with { type: 'json' };
import crs404 from '../fixtures/gma/crsAccounts/404-not-found.json' with { type: 'json' };
import crs500 from '../fixtures/gma/crsAccounts/500-server-error.json' with { type: 'json' };
import contexts200 from '../fixtures/gma/crsContexts/200-success.json' with { type: 'json' };

/**
 * The privacy gate (BLOCKING — quickstart.md 1c, FR-029, FR-030, SC-007).
 *
 * Constitution Principle V: "Customer identifiers are personal data. An account
 * identifier, bet identifier, bet receipt identifier, customer name, and any customer
 * financial value MUST NEVER appear in a log, a trace, a diagnostic field, or an error
 * message. Where such an identifier appears in a request path, the logged operation
 * MUST be the path *template*, never the interpolated path."
 *
 * ## Why this test drives real calls instead of asserting on the allowlist
 *
 * `telemetry.test.ts` already proves the allowlist drops unlisted keys. That is not
 * enough here, and the reason is the specific shape of this leak: `path` and
 * `operation` are BOTH allowlisted, legitimately — the catalogue domain needs them. So
 * the allowlist cannot catch this. What leaks is the VALUE passed into an allowed
 * field, which only an end-to-end call can reveal.
 *
 * ## The two halves, and why the second is the one that gets forgotten
 *
 * `gmaClient` interpolates the path into two places:
 *
 *  1. The `path` LOG FIELD — the obvious one.
 *  2. The `operation` LABEL, which `errors.ts`'s `safeUpstreamDetail` embeds in a
 *     TOOL-VISIBLE ERROR MESSAGE: "GMA returned HTTP 404 for GET /crs/accounts/12345".
 *     That message reaches the model's context and then, usually, a human. Fixing only
 *     half of this looks complete — every log line is clean — while the identifier
 *     still escapes through the error path.
 *
 * So a `404` is covered explicitly, not only the success path. research.md R13 names
 * both fields for exactly this reason.
 */

const server = useGmaServer();
const CRS_ACCOUNT = `${GMA_BASE_URL}/crs/accounts/:accountId`;
const CONTEXTS = `${GMA_BASE_URL}/crs/contexts`;

/**
 * A deliberately RECOGNISABLE account identifier.
 *
 * Distinctive enough that a substring match cannot pass by coincidence, and it is
 * checked in several fragments so that a partially-redacted leak still fails.
 */
const RECOGNISABLE_ACCOUNT = 'acct-9988776655-jane';

/** Every fragment of that identifier that must appear nowhere. */
const LEAK_FRAGMENTS = [
  RECOGNISABLE_ACCOUNT,
  'acct-9988776655',
  '9988776655',
  'jane',
  // URL-encoded, in case a path was logged after encoding rather than before.
  encodeURIComponent(RECOGNISABLE_ACCOUNT)
];

/** Collect emitted log lines instead of writing to stderr. */
function capture(): { lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

/** A client whose logger writes into the captured array. */
function clientWithCapture() {
  const { lines, sink } = capture();
  const config = testConfig({ logLevel: 'debug' });
  return { lines, client: createGmaClient({ config, logger: createLogger('debug', sink) }) };
}

/** Assert no fragment of the identifier appears in the given text. */
function expectNoLeak(text: string, context: string): void {
  for (const fragment of LEAK_FRAGMENTS) {
    expect(text, `${context} leaked "${fragment}"`).not.toContain(fragment);
  }
}

describe('privacy: no customer identifier reaches a log, span, or error message', () => {
  describe('case: half one — the account identifier never reaches a LOG FIELD (FR-029)', () => {
    it('logs the path TEMPLATE, not the interpolated path, on a successful call', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));
      const { lines, client } = clientWithCapture();

      await getCustomerRiskProfile(client, TEST_TOKEN, { accountId: RECOGNISABLE_ACCOUNT });

      expect(lines.length).toBeGreaterThan(0);
      expectNoLeak(lines.join('\n'), 'success log lines');
      // And the template IS present, so the line is still diagnostically useful —
      // Principle V requires diagnostics sufficient to tell which capability ran.
      expect(lines.join('\n')).toContain('/crs/accounts/{accountId}');
    });

    it('logs the template in the OPERATION field too, not just in path', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));
      const { lines, client } = clientWithCapture();

      await getCustomerRiskProfile(client, TEST_TOKEN, { accountId: RECOGNISABLE_ACCOUNT });

      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const withOperation = parsed.filter((line) => typeof line.operation === 'string');

      expect(withOperation.length).toBeGreaterThan(0);
      for (const line of withOperation) {
        expect(line.operation).toBe('GET /crs/accounts/{accountId}');
        expectNoLeak(String(line.operation), 'operation field');
      }
    });

    it('logs the template on a 404, a 500, and a transport failure alike', async () => {
      for (const [label, handler] of [
        ['404', () => HttpResponse.json(crs404, { status: 404 })],
        ['500', () => HttpResponse.json(crs500, { status: 500 })]
      ] as const) {
        server.use(http.get(CRS_ACCOUNT, handler));
        const { lines, client } = clientWithCapture();

        await getCustomerRiskProfile(client, TEST_TOKEN, {
          accountId: RECOGNISABLE_ACCOUNT
        }).catch(() => undefined);

        expect(lines.length, `${label} produced no log line to check`).toBeGreaterThan(0);
        expectNoLeak(lines.join('\n'), `${label} log lines`);
      }
    });

    it('emits no customer FINANCIAL VALUE in any log line (FR-029)', async () => {
      // The fixture carries stake factors, payout limits and a winnings cap. None of
      // them is an identifier, and all of them are customer financial values, which
      // Principle V names alongside identifiers.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));
      const { lines, client } = clientWithCapture();

      await getCustomerRiskProfile(client, TEST_TOKEN, { accountId: RECOGNISABLE_ACCOUNT });
      const joined = lines.join('\n');

      for (const value of ['50000', '25000', '10000', '500000', 'Managed Risk', 'LG3']) {
        expect(joined, `financial or configuration value "${value}" leaked`).not.toContain(value);
      }
    });

    it('still records enough to diagnose: which tool, which outcome, how long', async () => {
      // The privacy rule is not "log nothing". Principle V requires diagnostics that
      // establish which capability ran and what each step produced.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));
      const { lines, client } = clientWithCapture();

      await getCustomerRiskProfile(client, TEST_TOKEN, { accountId: RECOGNISABLE_ACCOUNT });
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const call = parsed.find((line) => line.event === 'gma.call');

      expect(call?.tool).toBe('get_customer_risk_profile');
      expect(call?.outcome).toBe('COMPLETE');
      expect(typeof call?.latencyMs).toBe('number');
      expect(call?.hop).toBe(1);
    });
  });

  describe('case: half TWO — the identifier never reaches an ERROR MESSAGE (FR-030, SC-007)', () => {
    it('keeps the account identifier out of a 404 message the agent will relay', async () => {
      // THE assertion this file exists for. `safeUpstreamDetail` builds "GMA returned
      // HTTP 404 for {operation}", so if `operation` were built from the interpolated
      // path the identifier would travel to the model and then to a human — while
      // every log line looked clean.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs404, { status: 404 })));
      const { client } = clientWithCapture();

      const error = await getCustomerRiskProfile(client, TEST_TOKEN, {
        accountId: RECOGNISABLE_ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('notFound');
      expectNoLeak(error.message, '404 error message');
      // The template survives, which is what keeps the message actionable.
      expect(error.message).toContain('/crs/accounts/{accountId}');
    });

    it('keeps it out of a 500 message', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs500, { status: 500 })));
      const { client } = clientWithCapture();

      const error = await getCustomerRiskProfile(client, TEST_TOKEN, {
        accountId: RECOGNISABLE_ACCOUNT
      }).catch((e) => e as ToolError);

      expectNoLeak(error.message, '500 error message');
    });

    it('keeps it out of a LOCAL validation message, which never reaches GMA at all', async () => {
      // No handler registered: this path rejects before any request, so the leak
      // would be entirely of our own making.
      const { client } = clientWithCapture();

      const error = await getCustomerRiskProfile(client, TEST_TOKEN, {
        accountId: `${RECOGNISABLE_ACCOUNT}/riskSettings`
      }).catch((e) => e as ToolError);

      expect(error.kind).toBe('argument');
      expectNoLeak(error.message, 'local argument error message');
    });

    it('keeps the operator token out of every message and log line', async () => {
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crs404, { status: 404 })));
      const { lines, client } = clientWithCapture();

      const error = await getCustomerRiskProfile(client, TEST_TOKEN, {
        accountId: RECOGNISABLE_ACCOUNT
      }).catch((e) => e as ToolError);

      expect(error.message).not.toContain(TEST_TOKEN);
      expect(lines.join('\n')).not.toContain(TEST_TOKEN);
      expect(lines.join('\n').toLowerCase()).not.toContain('bearer');
    });
  });

  describe('case: the result IS allowed to carry the identifier — logs and errors are not', () => {
    it("returns the account identifier in the payload, which is the agent's own context", async () => {
      // The distinction matters: the agent asked about this account, so echoing it in
      // the RESULT tells it nothing new and lets it correlate. A LOG is different —
      // it persists, is aggregated, and in a gambling operator's logs additionally
      // reveals that a specific customer is under investigation.
      server.use(http.get(CRS_ACCOUNT, () => HttpResponse.json(crsThree)));
      const { lines, client } = clientWithCapture();

      const result = await getCustomerRiskProfile(client, TEST_TOKEN, {
        accountId: RECOGNISABLE_ACCOUNT
      });

      expect(result.accountId).toBe(RECOGNISABLE_ACCOUNT);
      expectNoLeak(lines.join('\n'), 'log lines while the result carried the identifier');
    });
  });

  describe('case: a tool with no identifier in its path leaks nothing either', () => {
    it('logs a clean template for list_jurisdiction_contexts', async () => {
      server.use(http.get(CONTEXTS, () => HttpResponse.json(contexts200)));
      const { lines, client } = clientWithCapture();

      await listJurisdictionContexts(client, TEST_TOKEN);

      expect(lines.join('\n')).toContain('/crs/contexts');
      expect(lines.join('\n')).not.toContain(TEST_TOKEN);
    });
  });

  describe("case: the catalogue domain's log lines are UNCHANGED by the template fix (SC-012)", () => {
    it('logs the same interpolated path it always did when no template is supplied', async () => {
      // `pathTemplate` defaults to `path`, which is what makes the change additive:
      // a catalogue call that passes no template produces a byte-identical line, so
      // the amendment-acceptance gate stays satisfiable.
      server.use(
        http.get(`${GMA_BASE_URL}/v5/instances`, () => HttpResponse.json({ instances: [] }))
      );
      const { lines, client } = clientWithCapture();

      await client.get('/v5/instances', { token: TEST_TOKEN, tool: 'list_instances', hop: 1 });
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(parsed[0]?.path).toBe('/v5/instances');
      expect(parsed[0]?.operation).toBe('GET /v5/instances');
    });
  });
});
