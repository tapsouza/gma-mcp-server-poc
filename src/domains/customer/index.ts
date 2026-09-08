import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../core/config.js';
import { isToolError } from '../../core/errors.js';
import type { GmaClient } from '../../core/gmaClient.js';
import { extractOperatorToken, type RequestIdentitySource } from '../../core/identity.js';
import type { Logger } from '../../core/telemetry.js';
import {
  findCustomerBetsInputSchema,
  findCustomerBetsOutputSchema,
  getBetRiskContextInputSchema,
  getBetRiskContextOutputSchema,
  getCustomerRiskProfileInputSchema,
  getCustomerRiskProfileOutputSchema,
  listJurisdictionContextsOutputSchema
} from './schemas.js';
import { FIND_CUSTOMER_BETS_DESCRIPTION, findCustomerBets } from './tools/findCustomerBets.js';
import { GET_BET_RISK_CONTEXT_DESCRIPTION, getBetRiskContext } from './tools/getBetRiskContext.js';
import {
  GET_CUSTOMER_RISK_PROFILE_DESCRIPTION,
  getCustomerRiskProfile
} from './tools/getCustomerRiskProfile.js';
import {
  LIST_JURISDICTION_CONTEXTS_DESCRIPTION,
  listJurisdictionContexts
} from './tools/listJurisdictionContexts.js';

/**
 * The customer domain (constitution Principle III).
 *
 * This domain owns its schemas, its mapping, its pure decision modules, and its tools.
 * It imports from `core/` and NEVER from another domain — the `module-boundaries` lint
 * rule and `test/unit/architecture.test.ts` both fail the build otherwise, so the
 * boundary is a mechanism rather than a convention.
 *
 * Note what that permits and what it forbids. `get_bet_risk_context` calls
 * `GET /v5/events/{id}`, which is the catalogue's primary surface — through the shared
 * `core` client. That is COMPOSITION, explicitly allowed by Principle III ("A tool MAY
 * call any GMA path through the shared core client"). What would be coupling is
 * importing the catalogue domain's traversal code, and nothing here does.
 *
 * All five tools live in ONE domain deliberately (FR-002): `get_customer_risk_profile`
 * and `get_bet_risk_context` share the CRS mapping, and splitting them across two
 * domains would have forced that shared code into `core/`, where no other domain
 * needs it.
 *
 * ## The privacy rule this whole domain turns on
 *
 * Every identifier this domain handles — account, bet, receipt — is PERSONAL DATA
 * (constitution Principle V). None may reach a log field, a span attribute, or an
 * error message. Two consequences bind every tool below:
 *
 *  1. Every `client.get`/`client.post` call passes `pathTemplate`, so the interpolated
 *     path never reaches the logger OR the `operation` label that `errors.ts`
 *     interpolates into tool-visible messages.
 *  2. Every `tool.success` / `tool.error` log line carries counts and outcomes only.
 *
 * `test/unit/privacy.test.ts` proves both, including through a `404`'s error message.
 */

export interface DomainDeps {
  readonly config: Config;
  readonly client: GmaClient;
  readonly logger: Logger;
}

/**
 * Turn a thrown `ToolError` into an MCP tool error.
 *
 * A tool error carries NO completeness — a failure must never be readable as data
 * (Principle II) — and its `kind` is surfaced so the agent can tell "you must fix your
 * arguments" from "your user must re-authenticate" from "your user must request
 * access" (FR-028, SC-009).
 *
 * Deliberately duplicated from the catalogue domain rather than shared: hoisting it
 * into `core/` would put MCP protocol shaping into the layer that is supposed to know
 * nothing about MCP, and a `domain → domain` import is forbidden. Nine lines of
 * duplication is the cheaper side of that trade.
 */
export function toErrorResult(error: unknown): CallToolResult {
  if (isToolError(error)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `[${error.kind}] ${error.message}` }],
      // Deliberately no `structuredContent`: an MCP error result must not resemble a
      // successful payload, and it must never carry a completeness verdict.
      _meta: { kind: error.kind, retryable: error.retryable }
    };
  }

  // An unexpected throw. The message is NOT surfaced: it has not been vetted, and on
  // this domain's surfaces an unvetted message could carry an account identifier.
  // FR-029 and FR-030 admit no exception for unexpected paths.
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: '[upstream] An unexpected internal error occurred. The request was not completed.'
      }
    ],
    _meta: { kind: 'upstream', retryable: true }
  };
}

/** Wrap a successful payload as an MCP result carrying both structured and text content. */
export function toSuccessResult(payload: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: payload,
    // The text mirror exists for clients that do not read structuredContent. It is
    // the same object, so the completeness verdict cannot be present in one
    // representation and absent from the other.
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

/** Register every customer tool on the given server. */
export function registerCustomerDomain(server: McpServer, deps: DomainDeps): void {
  const { client, config, logger } = deps;

  server.registerTool(
    'list_jurisdiction_contexts',
    {
      title: 'List jurisdiction contexts',
      description: LIST_JURISDICTION_CONTEXTS_DESCRIPTION,
      outputSchema: listJurisdictionContextsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (extra) => {
      const startedAt = Date.now();
      try {
        // Identity is extracted from THIS request and threaded as a value. No
        // module-level token, no singleton, no async-local storage (FR-023a).
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await listJurisdictionContexts(client, token);

        logger.info({
          tool: 'list_jurisdiction_contexts',
          aggregateOutcome: result.completeness.outcome,
          // A COUNT, never the codes. Jurisdiction codes are not personal data, but
          // the allowlist admits counts here and there is no reason to widen it.
          instanceCount: result.jurisdictions.length,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({
          jurisdictions: result.jurisdictions,
          completeness: result.completeness
        });
      } catch (error) {
        logger.error({
          tool: 'list_jurisdiction_contexts',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'get_customer_risk_profile',
    {
      title: "Get a customer's risk configuration",
      description: GET_CUSTOMER_RISK_PROFILE_DESCRIPTION,
      inputSchema: getCustomerRiskProfileInputSchema,
      outputSchema: getCustomerRiskProfileOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await getCustomerRiskProfile(client, token, { accountId: args.accountId });

        logger.info({
          tool: 'get_customer_risk_profile',
          aggregateOutcome: result.completeness.outcome,
          // A COUNT of jurisdictions, and nothing else. NOT the account identifier,
          // NOT a jurisdiction code, NOT a stake factor — every one of those is
          // either personal data or a customer financial value (Principle V,
          // FR-029). `test/unit/privacy.test.ts` proves this line stays clean.
          matchCount: result.jurisdictionConfigurations.length,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({
          accountId: result.accountId,
          jurisdictionConfigurations: result.jurisdictionConfigurations,
          completeness: result.completeness
        });
      } catch (error) {
        logger.error({
          tool: 'get_customer_risk_profile',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'find_customer_bets',
    {
      title: "Find a customer's bets",
      description: FIND_CUSTOMER_BETS_DESCRIPTION,
      inputSchema: findCustomerBetsInputSchema,
      outputSchema: findCustomerBetsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        // The cap comes from CONFIGURATION, never from the agent. `args.limit` may
        // only narrow it (Principle V).
        const result = await findCustomerBets(client, config.customerMaxBets, token, {
          accountId: args.accountId,
          betId: args.betId,
          receiptId: args.receiptId,
          limit: args.limit
        });

        logger.info({
          tool: 'find_customer_bets',
          // `resolution` records WHICH KIND of answer this was, not which identifier
          // was searched — that value is personal data.
          resolution: result.kind,
          matchCount: result.bets?.length ?? 0,
          aggregateOutcome: result.completeness.outcome,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({
          kind: result.kind,
          ...(result.bets === undefined ? {} : { bets: result.bets }),
          ...(result.totalMatched === undefined ? {} : { totalMatched: result.totalMatched }),
          orderingCaveat: result.orderingCaveat,
          limitReached: result.limitReached,
          completeness: result.completeness
        });
      } catch (error) {
        logger.error({
          tool: 'find_customer_bets',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'get_bet_risk_context',
    {
      title: 'Get the risk context behind one bet',
      description: GET_BET_RISK_CONTEXT_DESCRIPTION,
      inputSchema: getBetRiskContextInputSchema,
      outputSchema: getBetRiskContextOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra) => {
      const startedAt = Date.now();
      try {
        const token = extractOperatorToken(extra as RequestIdentitySource);
        const result = await getBetRiskContext(
          { client, maxEventResolutions: config.customerMaxEventResolutions },
          token,
          { betId: args.betId, receiptId: args.receiptId }
        );

        logger.info({
          tool: 'get_bet_risk_context',
          // The MATCH OUTCOME, which is a mechanism rather than a customer datum — and
          // the field an operator would actually key an alert on. If this ever reads
          // `jurisdictionNotMatched` for every call, the matching is broken.
          resolution: result.jurisdictionMatch ?? 'candidates',
          matchCount: result.candidates?.length ?? 1,
          // A COUNT of legs, never a leg's contents.
          instanceCount: result.resolvedLegs?.length ?? 0,
          aggregateOutcome: result.completeness.outcome,
          latencyMs: Date.now() - startedAt,
          event: 'tool.success'
        });

        return toSuccessResult({
          ...(result.bet === undefined ? {} : { bet: result.bet }),
          ...(result.jurisdictionMatch === undefined
            ? {}
            : { jurisdictionMatch: result.jurisdictionMatch }),
          ...(result.governingJurisdiction === undefined
            ? {}
            : { governingJurisdiction: result.governingJurisdiction }),
          ...(result.allJurisdictionConfigurations === undefined
            ? {}
            : { allJurisdictionConfigurations: result.allJurisdictionConfigurations }),
          ...(result.resolvedLegs === undefined ? {} : { resolvedLegs: result.resolvedLegs }),
          ...(result.agreement === undefined ? {} : { agreement: result.agreement }),
          ...(result.appliedFiguresAreBetLevel === undefined
            ? {}
            : { appliedFiguresAreBetLevel: result.appliedFiguresAreBetLevel }),
          ...(result.attributionNotice === undefined
            ? {}
            : { attributionNotice: result.attributionNotice }),
          ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
          completeness: result.completeness
        });
      } catch (error) {
        logger.error({
          tool: 'get_bet_risk_context',
          errorKind: isToolError(error) ? error.kind : 'upstream',
          latencyMs: Date.now() - startedAt,
          event: 'tool.error'
        });
        return toErrorResult(error);
      }
    }
  );
}
