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

/**
 * MCP protocol smoke test.
 *
 * Proves the schemas resolve and a call round-trips through a REAL MCP client over a
 * real transport — not by invoking the tool function directly. That is what catches a
 * schema the SDK cannot serialise, which no unit test would.
 */

const gma = useGmaServer();
/**
 * These handlers are mounted on the generations a DEFAULT deployment resolves to: v4 for
 * every entity and child operation, v5 for the by-name search, which exists nowhere else
 * (003-FR-001, FR-004). This suite drives `buildServer`, so it exercises the real startup
 * resolution — a handler on the wrong generation fails here rather than passing quietly.
 */
const INSTANCES = `${GMA_BASE_URL}/v4/instances`;

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
    it('lists EXACTLY the three curated tools, with resolvable schemas (FR-022)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      // Exactly three. The surface is curated, never generated from GMA's API, and
      // expanding it is governed by Principle IV rather than by convenience.
      expect(tools.map((t) => t.name).sort()).toEqual([
        'find_catalogue_entity',
        'get_catalogue_entity',
        'list_instances'
      ]);
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
    it('case: no tool schema, description, or output mentions a generation (003-FR-012)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();
      const serialised = JSON.stringify(tools);

      // The whole serialised tool list — names, descriptions, input and output schemas.
      // A generation is upstream mechanics: the model has no use for it and must not be
      // able to condition on it.
      expect(serialised).not.toContain('v4');
      expect(serialised).not.toContain('v5');
      expect(serialised).not.toContain('generation');
      expect(serialised).not.toContain('/v4/');
      expect(serialised).not.toContain('/v5/');
      // Nor any upstream path or method, which the same reasoning excludes.
      expect(serialised).not.toContain('searchByName');
      expect(serialised).not.toContain('eventTypes/');

      await close();
    });

    it('case: generation is never an agent-supplied argument (003-FR-013, Story 3 scenario 4)', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const inputProperties = Object.keys(
          (tool.inputSchema?.properties as Record<string, unknown>) ?? {}
        );
        // No field by any plausible name through which a model could pick a generation.
        for (const forbidden of ['generation', 'version', 'apiVersion', 'path', 'surface']) {
          expect(inputProperties, tool.name).not.toContain(forbidden);
        }
      }

      await close();
    });

    it('ignores an extra generation argument entirely rather than honouring it (003-FR-013)', async () => {
      // Structural absence is the real guarantee, but an agent WILL try. What matters is
      // that trying cannot work: the argument reaches nothing, and the call still goes to
      // the generation the OPERATOR configured.
      //
      // Only the v4 handler is mounted, so a honoured `generation: 'v5'` would hit msw's
      // `onUnhandledRequest: 'error'` and fail this test rather than passing silently.
      let pathname: string | null = null;
      gma.use(
        http.get(`${GMA_BASE_URL}/v4/subclasses/:id`, ({ request }) => {
          pathname = new URL(request.url).pathname;
          return HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: { id: 'urn:sub:pl', name: 'Premier League' }
          });
        })
      );
      const { client, close } = await connect();

      const result = await client.callTool({
        name: 'get_catalogue_entity',
        arguments: { type: 'subclass', id: 'urn:sub:pl', generation: 'v5' }
      });

      // The call succeeded, on v4, with the extra argument discarded.
      expect(result.isError).toBeFalsy();
      expect(pathname).toBe('/v4/subclasses/urn%3Asub%3Apl');
      expect(JSON.stringify(result.structuredContent)).not.toContain('v5');

      await close();
    });

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
        http.get(`${GMA_BASE_URL}/v4/subclasses/:id/eventTypes`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            // `entities`, not `eventTypes`: this operation's 200 is `EntitiesResponse`
            // on both generations (research.md R8 defect 1).
            entities: [{ id: 'urn:et:w', name: 'Winner' }]
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
        http.get(`${GMA_BASE_URL}/v4/subclasses/:id`, () =>
          HttpResponse.json({
            successfulConfigSources: ['urn:i:PP:PP'],
            subclass: {
              id: 'urn:sub:pl',
              name: 'Premier League',
              // Flat scalars, not a nested parent object: that is what both
              // generations declare (research.md R8 defect 2).
              superclassId: 'urn:sc:football',
              superclassName: 'Football'
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
        http.get(`${GMA_BASE_URL}/v4/subclasses/:id`, () =>
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
