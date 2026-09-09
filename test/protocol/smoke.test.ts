import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGmaClient } from '../../src/core/gmaClient.js';
import { STDIO_TOKEN_ENV_VAR } from '../../src/core/identity.js';
import { buildServer } from '../../src/server/register.js';
import { GMA_BASE_URL, TEST_TOKEN, testConfig, useGmaServer } from '../helpers/gma.js';

import instances200 from '../fixtures/gma/instances/200-success.json' with { type: 'json' };
import instances206 from '../fixtures/gma/instances/206-partial.json' with { type: 'json' };
import qbsSingleBet from '../fixtures/gma/qbsSearchBets/200-single-bet.json' with { type: 'json' };
import crsContexts from '../fixtures/gma/crsContexts/200-success.json' with { type: 'json' };
import event200 from '../fixtures/gma/events/200-success.json' with { type: 'json' };
import crsAccount from '../fixtures/gma/crsAccounts/200-three-jurisdictions.json' with { type: 'json' };
import metricsByBetType from '../fixtures/gma/customerMetrics/200-by-bet-type.json' with { type: 'json' };
import metricsAllZero from '../fixtures/gma/customerMetrics/200-all-zero-no-data.json' with { type: 'json' };

/**
 * MCP protocol smoke test.
 *
 * Proves the schemas resolve and a call round-trips through a REAL MCP client over a
 * real transport — not by invoking the tool function directly. That is what catches a
 * schema the SDK cannot serialise, which no unit test would.
 */

const gma = useGmaServer();
const INSTANCES = `${GMA_BASE_URL}/v5/instances`;

/** Connect a real client to a real server over an in-memory transport pair. */
async function connect() {
  const config = testConfig();
  const server = buildServer({ config, client: createGmaClient({ config }) });
  const client = new Client({ name: 'smoke-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe('MCP protocol smoke', () => {
  // stdio has no HTTP request to carry a bearer, so the token comes from the
  // environment (constitution Principle I, development only).
  const originalToken = process.env[STDIO_TOKEN_ENV_VAR];

  beforeEach(() => {
    process.env[STDIO_TOKEN_ENV_VAR] = TEST_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env[STDIO_TOKEN_ENV_VAR];
    else process.env[STDIO_TOKEN_ENV_VAR] = originalToken;
  });

  describe('tool discovery', () => {
    it('lists EXACTLY the curated tools, with resolvable schemas (FR-022)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      // An EXACT list, deliberately. The surface is curated, never generated from
      // GMA's API, and expanding it is governed by Principle IV rather than by
      // convenience — so growth means editing this assertion, which is the reviewed
      // act. Four catalogue tools plus the customer domain's five.
      expect(tools.map((t) => t.name).sort()).toEqual([
        'find_catalogue_entity',
        'find_customer_bets',
        'get_bet_risk_context',
        'get_catalogue_entity',
        'get_customer_betting_metrics',
        'get_customer_risk_profile',
        'get_event',
        'list_instances',
        'list_jurisdiction_contexts'
      ]);
      // Exactly nine: four catalogue tools plus the customer domain's five.
      //
      // `get_event` is the ninth, added so a bet leg's event id becomes actionable —
      // `find_customer_bets` reports one per leg and nothing could act on it. It calls
      // `GET /v5/events/{id}`, already present in the catalogue row of the constitution's
      // surface register, so the operation needed no amendment; the TOOL count changing
      // is the reviewed act, and this line is where it is reviewed.
      expect(tools).toHaveLength(9);
      for (const tool of tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description!.length).toBeGreaterThan(0);
      }

      await close();
    });

    it('gives every tool a description telling the agent to relay caveats (FR-009)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.description!.toLowerCase()).toContain('relay');
      }

      await close();
    });

    it('never exposes completeness as an INPUT parameter', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const inputProperties = Object.keys(
          (tool.inputSchema?.properties as Record<string, unknown>) ?? {}
        );
        expect(inputProperties).not.toContain('completeness');
        expect(inputProperties).not.toContain('complete');
        expect(inputProperties).not.toContain('caveat');
      }

      await close();
    });

    it('never exposes identity as an input parameter (FR-023a)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const serialised = JSON.stringify(tool.inputSchema ?? {}).toLowerCase();
        for (const forbidden of ['token', 'authorization', 'bearer', 'credential', 'identity']) {
          expect(serialised).not.toContain(forbidden);
        }
      }

      await close();
    });

    it('never exposes an operational value as an input parameter (FR-018)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const serialised = JSON.stringify(tool.inputSchema ?? {}).toLowerCase();
        for (const forbidden of ['baseurl', 'issuer', 'timeout', 'host']) {
          expect(serialised).not.toContain(forbidden);
        }
      }

      await close();
    });

    it('exposes no GMA DTO vocabulary in any schema (Principle IV)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();
      const serialised = JSON.stringify(tools);

      expect(serialised).not.toContain('configSource');
      expect(serialised).not.toContain('ConfigSources');
      expect(serialised).not.toContain('instancesList');

      await close();
    });
  });

  describe('one call round-trips', () => {
    it('returns structured content carrying instances and completeness', async () => {
      gma.use(http.get(INSTANCES, () => HttpResponse.json(instances200)));
      const { client, close } = await connect();

      const result = await client.callTool({ name: 'list_instances', arguments: {} });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        instances: { code: string }[];
        completeness: { complete: boolean };
      };
      expect(structured.instances.map((i) => i.code)).toEqual(['PP', 'BF']);
      expect(structured.completeness.complete).toBe(true);

      await close();
    });

    it('surfaces the completeness caveat through the protocol on a partial result', async () => {
      gma.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));
      const { client, close } = await connect();

      const result = await client.callTool({ name: 'list_instances', arguments: {} });

      const structured = result.structuredContent as {
        completeness: { complete: boolean; failedInstances: string[]; caveat: string };
      };
      expect(structured.completeness.complete).toBe(false);
      expect(structured.completeness.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(structured.completeness.caveat).toContain('urn:i:BF:BF');

      await close();
    });

    it('round-trips get_event, turning a bet leg id into a catalogue position', async () => {
      // The registration layer is the only place argument threading and per-tool logging
      // exist, and neither is reachable by calling `getEvent` directly.
      gma.use(http.get(`${GMA_BASE_URL}/v5/events/:id`, () => HttpResponse.json(event200)));
      const { client, close } = await connect();

      // The SHORT form, exactly as a bet leg reports it — the form this tool exists to
      // make actionable.
      const result = await client.callTool({
        name: 'get_event',
        arguments: { id: 'gpd:9201' }
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        event: { name: string; ancestors: { type: string }[]; markets: unknown[] };
        completeness: { complete: boolean };
      };
      expect(structured.event.name).toBe('Team A v Team B');
      expect(structured.event.ancestors.map((a) => a.type)).toEqual([
        'superclass',
        'subclass',
        'eventType'
      ]);
      expect(structured.event.markets).toHaveLength(2);
      expect(structured.completeness.complete).toBe(true);

      await close();
    });

    it('surfaces a bare event id as an MCP error, before any upstream call', async () => {
      // No GMA handler: `onUnhandledRequest: 'error'` means a call would fail this test.
      // The error must reach the agent as an MCP error rather than as a payload, since a
      // failure that looks like data is the failure Principle II exists to prevent.
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_event',
        arguments: { id: '14643022' }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result._meta).toMatchObject({ kind: 'argument', retryable: false });

      await close();
    });

    it('mirrors the same verdict in the text content, so no client sees data without it', async () => {
      gma.use(http.get(INSTANCES, () => HttpResponse.json(instances206, { status: 206 })));
      const { client, close } = await connect();

      const result = await client.callTool({ name: 'list_instances', arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]!.text;

      expect(JSON.parse(text)).toHaveProperty('completeness');
      expect(JSON.parse(text).completeness.complete).toBe(false);

      await close();
    });

    it('returns an MCP error carrying the kind, with no completeness, on a 401', async () => {
      gma.use(http.get(INSTANCES, () => HttpResponse.json({ status: 401 }, { status: 401 })));
      const { client, close } = await connect();

      const result = await client.callTool({ name: 'list_instances', arguments: {} });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('[auth]');
      expect(text).not.toContain(TEST_TOKEN);

      await close();
    });

    it('round-trips find_catalogue_entity, resolving one match with its children', async () => {
      gma.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            results: [
              {
                superclass: { id: 'urn:sc:football', name: 'Football' },
                subclass: { id: 'urn:sub:pl', name: 'Premier League' }
              }
            ]
          })
        ),
        http.get(`${GMA_BASE_URL}/v5/subclasses/:id/eventTypes`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            eventTypes: [{ id: 'urn:et:w', name: 'Winner' }]
          })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: 'Premier League' }
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        kind: string;
        entity: { name: string };
        children: { name: string }[];
        completeness: { complete: boolean };
      };
      expect(structured.kind).toBe('resolved');
      expect(structured.entity.name).toBe('Premier League');
      expect(structured.children.map((c) => c.name)).toEqual(['Winner']);
      expect(structured.completeness.complete).toBe(true);

      await close();
    });

    it('round-trips get_catalogue_entity by type and id', async () => {
      gma.use(
        http.get(`${GMA_BASE_URL}/v5/subclasses/:id`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: {
              id: 'urn:sub:pl',
              name: 'Premier League',
              superclass: { id: 'urn:sc:football', name: 'Football' }
            }
          })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_catalogue_entity',
        arguments: { type: 'subclass', id: 'urn:sub:pl' }
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        entity: { name: string; ancestors: { name: string }[] };
        completeness: { complete: boolean };
      };
      expect(structured.entity.name).toBe('Premier League');
      expect(structured.entity.ancestors.map((a) => a.name)).toEqual(['Football']);
      expect(structured.completeness.complete).toBe(true);

      await close();
    });

    it('rejects an unsupported entity type through the protocol, before any GMA call', async () => {
      // No GMA handler is registered: msw's onUnhandledRequest:'error' means this
      // test fails if validation let a call through.
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_catalogue_entity',
        arguments: { type: 'market', id: 'urn:m:1' }
      });

      expect(result.isError).toBe(true);

      await close();
    });

    it('reports an auth error when no identity accompanies the request', async () => {
      delete process.env[STDIO_TOKEN_ENV_VAR];
      const { client, close } = await connect();

      const result = await client.callTool({ name: 'list_instances', arguments: {} });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('[auth]');

      await close();
    });

    it('round-trips a CUSTOMER-domain call with BOTH completeness axes present', async () => {
      // quickstart.md Validation 2. The second axis crosses the protocol here for the
      // first time: `unavailableComponents` was added to the shared `Completeness` for
      // this feature, and a shape the SDK cannot serialise would surface only here.
      //
      // A CRS failure is the case that exercises it — one missing SECTION of a composite
      // answer, which must arrive as `unavailableComponents` (retry cannot help) and NOT
      // as `failedInstances` (retry may help). Conflating them across the protocol would
      // tell an agent to retry something that can never succeed.
      gma.use(
        http.post(`${GMA_BASE_URL}/qbs/graphql`, () => HttpResponse.json(qbsSingleBet)),
        http.get(`${GMA_BASE_URL}/crs/accounts/:accountId`, () =>
          HttpResponse.json({}, { status: 500 })
        ),
        http.get(`${GMA_BASE_URL}/crs/contexts`, () => HttpResponse.json(crsContexts)),
        http.get(`${GMA_BASE_URL}/v5/events/:id`, () => HttpResponse.json(event200))
      );

      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_bet_risk_context',
        arguments: { betId: 'bet-000111' }
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        bet: { betId: string };
        completeness: {
          complete: boolean;
          failedInstances: string[];
          unavailableComponents: string[];
          caveat: string | null;
        };
      };

      // BOTH axes present, and independent.
      expect(structured.completeness.unavailableComponents).toEqual(['customerRiskConfiguration']);
      expect(structured.completeness.failedInstances).toEqual([]);
      expect(structured.completeness.complete).toBe(false);
      expect(structured.completeness.caveat).not.toBeNull();
      // The tool still answered — one missing section is not a failed tool.
      expect(structured.bet.betId).toBe('bet-000111');
      // And no customer identifier reached the caveat a human reads (Principle V).
      expect(structured.completeness.caveat).not.toContain('acct-test-0001');

      await close();
    });
  });

  describe('every customer tool round-trips through the protocol', () => {
    /**
     * The registration layer is the only place these paths exist: argument threading,
     * per-tool logging, and — for the metrics tool — the DECISION about whether to look up
     * jurisdiction codes at all. None of it is reachable by calling a tool function
     * directly, which is why it belongs here rather than in an integration suite.
     */
    it("round-trips list_jurisdiction_contexts, including Ontario's undeducible code", async () => {
      gma.use(http.get(`${GMA_BASE_URL}/crs/contexts`, () => HttpResponse.json(crsContexts)));
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'list_jurisdiction_contexts',
        arguments: {}
      });

      const structured = result.structuredContent as {
        jurisdictions: { code: string }[];
        completeness: { complete: boolean };
      };
      // `NXTCANBS` is the standing proof that these codes must be looked up, not derived.
      expect(structured.jurisdictions.map((j) => j.code)).toContain('NXTCANBS');
      expect(structured.completeness.complete).toBe(true);

      await close();
    });

    it('round-trips get_customer_risk_profile with one configuration per jurisdiction', async () => {
      // Only ONE handler: this tool makes a single hop, and `onUnhandledRequest: 'error'`
      // means a stray `/crs/contexts` call would fail this test — which is the assertion.
      gma.use(
        http.get(`${GMA_BASE_URL}/crs/accounts/:accountId`, () => HttpResponse.json(crsAccount))
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_customer_risk_profile',
        arguments: { accountId: 'acct-test-0001' }
      });

      const structured = result.structuredContent as {
        jurisdictionConfigurations: { jurisdiction: { code: string } }[];
      };
      // THREE jurisdictions, nothing merged (FR-006, SC-003).
      expect(structured.jurisdictionConfigurations).toHaveLength(3);
      // Terse-but-honest jurisdiction references, NOT enriched codes. This tool is ONE
      // hop by design: it does not fetch the context list, because a second hop that can
      // fail is a poor trade for a prettier label. The reference falls back to the
      // identifier rather than inventing a name — `list_jurisdiction_contexts` is where
      // an agent gets the friendly code.
      expect(structured.jurisdictionConfigurations.map((c) => c.jurisdiction.code)).toEqual([
        'ctx-us-nj',
        'ctx-us-pa',
        'ctx-us-co'
      ]);

      await close();
    });

    it('round-trips find_customer_bets with its unconditional ordering caveat', async () => {
      gma.use(http.post(`${GMA_BASE_URL}/qbs/graphql`, () => HttpResponse.json(qbsSingleBet)));
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_customer_bets',
        arguments: { accountId: 'acct-test-0001' }
      });

      const structured = result.structuredContent as {
        bets: { betId: string }[];
        orderingCaveat: string;
      };
      expect(structured.bets).toHaveLength(1);
      expect(structured.orderingCaveat.length).toBeGreaterThan(0);

      await close();
    });

    it('round-trips get_customer_betting_metrics WITHOUT looking up jurisdictions', async () => {
      // No jurisdiction filter, so the code lookup must not happen: an unconditional hop
      // would make every call pay for a check most calls do not need.
      // `onUnhandledRequest: 'error'` means a stray `/crs/contexts` call fails this test.
      gma.use(
        http.post(`${GMA_BASE_URL}/accounts/:accountId/metrics`, () =>
          HttpResponse.json(metricsByBetType)
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_customer_betting_metrics',
        arguments: { accountId: 'acct-test-0001', aggregation: 'BET_TYPE' }
      });

      const structured = result.structuredContent as {
        aggregation: string;
        groups: { keyKind: string }[];
      };
      expect(structured.aggregation).toBe('BET_TYPE');
      expect(structured.groups.length).toBeGreaterThan(0);
      // `vipManager` names a member of staff and must not cross the protocol.
      expect(JSON.stringify(structured)).not.toContain('vipManager');

      await close();
    });

    it('carries noDataNotice across the protocol when upstream answers all-zero', async () => {
      // The registration layer is where the notice becomes part of the payload, and a
      // spread that dropped it would leave every other test passing.
      gma.use(
        http.post(`${GMA_BASE_URL}/accounts/:accountId/metrics`, () =>
          HttpResponse.json(metricsAllZero)
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_customer_betting_metrics',
        arguments: { accountId: 'acct-test-0001', aggregation: 'TIMEFRAME' }
      });

      const structured = result.structuredContent as { noDataNotice?: string };
      expect(structured.noDataNotice).toContain('NOT evidence');
      // A successful result, not an error: the figures are data, their meaning is caveated.
      expect(result.isError).toBeFalsy();
      // Present in the TEXT mirror too, so a client that reads only text still sees it —
      // the same rule the completeness verdict follows.
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text).noDataNotice).toContain('NOT evidence');

      await close();
    });

    it('DOES look up jurisdictions when a filter was supplied, and rejects an unknown code', async () => {
      gma.use(http.get(`${GMA_BASE_URL}/crs/contexts`, () => HttpResponse.json(crsContexts)));
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_customer_betting_metrics',
        arguments: {
          accountId: 'acct-test-0001',
          aggregation: 'BET_TYPE',
          jurisdictions: ['NEWJERSEY']
        }
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('[argument]');
      expect(text).toContain('list_jurisdiction_contexts');

      await close();
    });

    it('still answers when the jurisdiction lookup FAILS, rather than denying valid work', async () => {
      // A code we merely failed to verify is forwarded. Rejecting it would deny a request
      // that may well be correct.
      gma.use(
        http.get(`${GMA_BASE_URL}/crs/contexts`, () => HttpResponse.json({}, { status: 500 })),
        http.post(`${GMA_BASE_URL}/accounts/:accountId/metrics`, () =>
          HttpResponse.json(metricsByBetType)
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_customer_betting_metrics',
        arguments: {
          accountId: 'acct-test-0001',
          aggregation: 'BET_TYPE',
          jurisdictions: ['ANYTHING']
        }
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { aggregation: string }).aggregation).toBe('BET_TYPE');

      await close();
    });

    it('surfaces a customer-tool failure as an MCP error with no completeness', async () => {
      gma.use(
        http.post(`${GMA_BASE_URL}/qbs/graphql`, () => HttpResponse.json({}, { status: 500 }))
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_customer_bets',
        arguments: { accountId: 'acct-test-0001' }
      });

      expect(result.isError).toBe(true);
      // A failure must never be readable as data (Principle II)...
      expect(result.structuredContent).toBeUndefined();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('[upstream]');
      // ...and must never echo the account identifier (Principle V, FR-029).
      expect(text).not.toContain('acct-test-0001');

      await close();
    });
  });

  describe('every tool surfaces failures as MCP errors, never as data', () => {
    it('returns an MCP error from find_catalogue_entity on an upstream failure', async () => {
      gma.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () =>
          HttpResponse.json({ status: 500 }, { status: 500 })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: 'Premier League' }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect((result.content as { text: string }[])[0]!.text).toContain('[upstream]');

      await close();
    });

    it('returns an MCP error from get_catalogue_entity on an unknown id', async () => {
      gma.use(
        http.get(`${GMA_BASE_URL}/v5/subclasses/:id`, () =>
          HttpResponse.json({ status: 404 }, { status: 404 })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_catalogue_entity',
        arguments: { type: 'subclass', id: 'urn:sub:nope' }
      });

      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toContain('[notFound]');

      await close();
    });

    it('returns an MCP error naming list_instances for an unknown instance code', async () => {
      // No GMA handler: msw's onUnhandledRequest:'error' proves no call was made.
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: 'Premier League', instances: ['Not A Code'] }
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain('[argument]');
      expect(text).toContain('list_instances');

      await close();
    });

    it('surfaces a too-broad search through the protocol with its narrowing hint', async () => {
      gma.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            results: Array.from({ length: 40 }, (_, i) => ({
              superclass: { id: 'urn:sc:f', name: 'Football' },
              subclass: { id: `urn:sub:${i}`, name: `League ${i}` }
            }))
          })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: 'a' }
      });

      const structured = result.structuredContent as {
        kind: string;
        narrowBy: string[];
        completeness: { complete: boolean };
      };
      expect(structured.kind).toBe('tooBroad');
      expect(structured.narrowBy.length).toBeGreaterThan(0);
      expect(structured.completeness.complete).toBe(false);

      await close();
    });

    it('surfaces several candidates through the protocol without choosing one (FR-014)', async () => {
      gma.use(
        http.post(`${GMA_BASE_URL}/v5/searchByName`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            results: [
              {
                superclass: { id: 'urn:sc:f', name: 'Football' },
                subclass: { id: 'urn:sub:pl', name: 'Premier League' },
                eventType: { id: 'urn:et:a', name: 'Winner' }
              },
              {
                superclass: { id: 'urn:sc:t', name: 'Tennis' },
                subclass: { id: 'urn:sub:w', name: 'Wimbledon' },
                eventType: { id: 'urn:et:b', name: 'Winner' }
              }
            ]
          })
        )
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: 'Winner' }
      });

      const structured = result.structuredContent as {
        kind: string;
        candidates: { ancestors: { name: string }[] }[];
      };
      expect(structured.kind).toBe('candidates');
      expect(structured.candidates).toHaveLength(2);
      expect(structured).not.toHaveProperty('entity');
      // Each candidate keeps the ancestor path a human needs to choose.
      for (const candidate of structured.candidates) {
        expect(candidate.ancestors.length).toBeGreaterThan(0);
      }

      await close();
    });

    it('rejects a blank name at the schema, before any GMA call', async () => {
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'find_catalogue_entity',
        arguments: { name: '   ' }
      });

      expect(result.isError).toBe(true);

      await close();
    });
  });

  describe('health signal (FR-021)', () => {
    it('answers without any caller identity', async () => {
      delete process.env[STDIO_TOKEN_ENV_VAR];
      const { client, close } = await connect();

      const result = await client.readResource({ uri: 'health://gma-mcp-server' });
      const payload = JSON.parse(result.contents[0]!.text as string);

      expect(payload.status).toBe('ok');
      expect(payload.service).toBe('gma-mcp-server');
      expect(typeof payload.uptimeSeconds).toBe('number');

      await close();
    });

    it('discloses no configuration values', async () => {
      const { client, close } = await connect();

      const result = await client.readResource({ uri: 'health://gma-mcp-server' });
      const text = result.contents[0]!.text as string;

      expect(text).not.toContain(GMA_BASE_URL);
      expect(text).not.toContain('okta');
      expect(text).not.toContain(TEST_TOKEN);

      await close();
    });
  });

  describe('transport independence (FR-023b, SC-010)', () => {
    it('registers the same tools over a transport that is not stdio', async () => {
      // This suite runs over InMemoryTransport, not stdio, and the tools are
      // identical — which is the property that makes adding Streamable HTTP later
      // require no change to any tool definition.
      const { client, close } = await connect();

      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      await close();
    });
  });
});
