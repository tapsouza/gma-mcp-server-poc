import { aggregate, withUnavailableComponents } from '../../../core/completeness.js';
import { argumentError, isToolError } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import type { Completeness, ComponentName } from '../../../core/types.js';
import { assessAgreement, type AgreementVerdict } from '../agreement.js';
import {
  FIRST_PAGE,
  PLACEMENT_DATE_DESC,
  QBS_GRAPHQL_PATH,
  SEARCH_BETS_DOCUMENT,
  SEARCH_BETS_OPERATION_NAME
} from '../gql/searchBets.js';
import { matchJurisdiction, type JurisdictionMatchOutcome } from '../jurisdiction.js';
import {
  hasUnresolvedLegs,
  planEventResolutions,
  resolveLegs,
  type ResolvedEvent,
  type ResolvedLeg
} from '../legResolution.js';
import {
  toEventLookupId,
  toProjectedBets,
  type ProjectedBet,
  type QbsSearchBetsResponse
} from '../mapping/betProjection.js';
import { unavailableFromQbs } from '../mapping/qbsErrors.js';
import {
  toRiskConfigurations,
  unresolvedJurisdiction,
  type CrsAccountRiskSettings
} from '../mapping/riskConfiguration.js';
import type {
  Bet,
  BetRef,
  CataloguePathNode,
  CustomerRiskConfiguration,
  HierarchyLevel,
  JurisdictionRef
} from '../schemas.js';
import { LIST_JURISDICTION_CONTEXTS_OPERATION } from './listJurisdictionContexts.js';

/**
 * `get_bet_risk_context` — User Story 3 (P3), FR-016 to FR-023. THE COMPOSITE.
 *
 * The capability the domain exists for, and the only one an agent cannot assemble from
 * the others: joining a bet leg to a risk override requires resolving the leg's EVENT
 * to obtain its risk-side catalogue position, because bet legs and risk overrides live
 * in two different trees that meet nowhere else (research.md R5).
 *
 * ## `3 + N` hops
 *
 *   1. `POST /qbs/graphql` — the bet. A multi-match here returns candidates and does
 *      ZERO further work (FR-022).
 *   2. `GET /crs/accounts/{accountId}` — the customer's configurations.
 *   3. `GET /crs/contexts` — the platform jurisdiction list.
 *   4. `GET /v5/events/{id}` × DISTINCT events, bounded by configuration.
 *
 * Hop 3 is not optional and not a nicety. Constitution v1.2.0 makes the context list
 * the PRIMARY matching mechanism with derivation "a fallback, never the primary
 * mechanism". Without this hop the matcher receives an empty list and derivation
 * silently becomes primary — which compiles, passes every unit test that hands the
 * matcher a list directly, answers US bets correctly, and is CONFIDENTLY WRONG about
 * every non-US one. That is the exact failure the amendment exists to prevent.
 *
 * Hop 3 is also NOT FATAL. Its failure emits
 * `unavailableComponents: ['jurisdictionContexts']` and the tool still answers by
 * falling back to derivation.
 *
 * ## Instance scoping on hop 4 — the decision tasks.md T043 left open
 *
 * **Settled: scope by the bet's own `catalogueInstanceId`, and send NOTHING when the
 * bet did not report one.** Verified in `api_catalogue.yaml`:
 *
 *  - `getEventById` declares its scoping parameter as **`sources`**, NOT
 *    `instancesList` — the adjacent `/v5/events/{id}/markets` uses `instancesList`. The
 *    shared client hardcoded the latter, which would have been silently IGNORED, so
 *    `instancesParam` was added to `core` for this call. A wrong parameter name does
 *    not error; it fans the lookup out across every instance instead of the one asked
 *    for, which is a confident failure rather than a loud one.
 *  - The parameter is `required: false`, so omitting it is legal and returns the
 *    event's default view.
 *
 * Why the BET's instance and not `config.defaultInstances`: the bet's
 * `catalogueInstanceId` names the catalogue the leg's event actually lives in, so it is
 * a fact about this bet rather than a deployment default that could silently narrow —
 * or widen — the lookup. And why nothing when it is absent: an event that fails to
 * resolve is reported as a NAMED unresolved leg (never as "no overrides apply"), so an
 * unscoped attempt that succeeds is strictly better than a scoped attempt we cannot
 * make, and a failure is visible either way.
 *
 * A caution recorded for whoever closes R9: if EVERY leg reports
 * `notResolvedIdentifierUnusable`, suspect this scoping decision as well as the
 * `entityIds` assumption. The two symptoms are identical.
 */

/** The path template for the CRS account hop — never the interpolated path. */
export const CRS_ACCOUNT_TEMPLATE = '/crs/accounts/{accountId}';

/** The path template for an event hop. */
export const EVENT_TEMPLATE = '/v5/events/{id}';

/** The notice a multi-leg bet always carries (FR-021). */
export const ATTRIBUTION_NOTICE =
  'The applied risk figures are bet-level and cannot be attributed to any single leg. Relay this ' +
  'to the user: for a multi-leg bet, no per-leg configured setting can be said to have produced ' +
  'them.';

/**
 * The description the model sees, from contracts/tools.md section 4.
 *
 * Three instructions here prevent three specific wrong answers: "read
 * jurisdictionMatch first" prevents claiming a configuration governed a bet when none
 * did; the default-settings prohibition prevents the most tempting inference from an
 * unmatched jurisdiction; and the `resolution` instruction prevents reading an empty
 * override list on an unresolved leg as "unrestricted".
 */
export const GET_BET_RISK_CONTEXT_DESCRIPTION =
  'For ONE bet, returns its APPLIED risk figures side by side with the customer risk settings that ' +
  'were IN SCOPE for it. Supply exactly one of betId or receiptId. It does NOT and CANNOT explain ' +
  'how any limit was calculated — that formula is not available to this system, so never narrate ' +
  'one. Read jurisdictionMatch FIRST: only "matched" means a specific configuration governed this ' +
  'bet, and in every other case you MUST NOT tell the user the customer was on default settings. ' +
  'For a multi-leg bet, relay attributionNotice: the applied figures are bet-level. Check each ' +
  "leg's resolution before reading its overridesInScope — an empty override list on an unresolved " +
  'leg does NOT mean unrestricted. If the result is incomplete, relay the caveat verbatim.';

export interface GetBetRiskContextArgs {
  readonly betId?: string | undefined;
  readonly receiptId?: string | undefined;
}

export interface GetBetRiskContextResult {
  readonly bet?: Bet;
  readonly jurisdictionMatch?: JurisdictionMatchOutcome['match'];
  /**
   * WHICH step matched the jurisdiction. `null` when nothing matched.
   *
   * The matcher has always computed this and its own doc comment says it exists "for the
   * caller to report" — but nothing surfaced it, so the one signal that distinguishes
   * "the context list did its job" from "we fell back to derivation and got lucky" was
   * computed and discarded. Constitution v1.2.0 makes the context list PRIMARY and
   * derivation "a fallback, never the primary mechanism"; without this field, an
   * inversion of that ordering is invisible in the field, which is exactly where it
   * matters (US bets keep working, non-US bets are confidently wrong).
   */
  readonly jurisdictionMatchMechanism?: JurisdictionMatchOutcome['mechanism'];
  readonly governingJurisdiction?: JurisdictionRef;
  readonly allJurisdictionConfigurations?: CustomerRiskConfiguration[];
  readonly resolvedLegs?: ResolvedLeg[];
  readonly agreement?: AgreementVerdict[];
  readonly appliedFiguresAreBetLevel?: boolean;
  readonly attributionNotice?: string;
  readonly candidates?: BetRef[];
  readonly completeness: Completeness;
}

export interface GetBetRiskContextDeps {
  readonly client: GmaClient;
  readonly maxEventResolutions: number;
}

/** Enforce EXACTLY ONE identifier, echoing neither value (FR-016, FR-030). */
function resolveIdentifier(args: GetBetRiskContextArgs): {
  kind: 'betId' | 'receiptId';
  value: string;
} {
  const supplied: { kind: 'betId' | 'receiptId'; value: string }[] = [];
  if (typeof args.betId === 'string' && args.betId.trim().length > 0) {
    supplied.push({ kind: 'betId', value: args.betId.trim() });
  }
  if (typeof args.receiptId === 'string' && args.receiptId.trim().length > 0) {
    supplied.push({ kind: 'receiptId', value: args.receiptId.trim() });
  }

  if (supplied.length === 0) {
    throw argumentError(
      'Exactly one identifier is required, and none was supplied.',
      'Supply exactly one of betId or receiptId — receiptId is the reference a customer quotes.'
    );
  }
  if (supplied.length > 1) {
    throw argumentError(
      'Exactly one identifier is required, but both betId and receiptId were supplied.',
      'Choose one and omit the other. The values are not repeated here because bet identifiers are personal data.'
    );
  }

  return supplied[0] as { kind: 'betId' | 'receiptId'; value: string };
}

/** The shape `GET /v5/events/{id}` returns. Upstream vocabulary, translated here. */
interface EventResponse {
  readonly event?: {
    readonly id?: string | null;
    readonly superclassId?: string | null;
    readonly superclassName?: string | null;
    readonly subclassId?: string | null;
    readonly subclassName?: string | null;
    readonly eventTypeId?: string | null;
    readonly eventTypeName?: string | null;
  } | null;
}

/**
 * Project an event into a BROADEST-FIRST risk-side catalogue path.
 *
 * Superclass → subclass → eventType, matching the ordering an override's `path` uses so
 * the two can be compared node for node. `MARKET_TYPE` is absent because the event does
 * not carry one; a market-type override therefore only ever matches through a leg's
 * market, which this hop does not resolve — so such an override simply does not appear
 * in scope, which is honest rather than wrong.
 */
function toCataloguePath(response: EventResponse | null): CataloguePathNode[] | null {
  const event = response?.event;
  if (event === null || event === undefined) return null;

  const levels: { level: HierarchyLevel; id?: string | null; name?: string | null }[] = [
    { level: 'SUPERCLASS', id: event.superclassId, name: event.superclassName },
    { level: 'SUBCLASS', id: event.subclassId, name: event.subclassName },
    { level: 'EVENT_TYPE', id: event.eventTypeId, name: event.eventTypeName }
  ];

  const path = levels.flatMap<CataloguePathNode>(({ level, id, name }) =>
    typeof id === 'string' && id.length > 0 ? [{ level, id, name: name ?? id }] : []
  );

  // All three pairs are `required` in the Event schema, so an empty projection means
  // the response did not match its own contract — reported as unresolved rather than
  // as a leg with an empty path, which would read as "no override covers this".
  return path.length === 0 ? null : path;
}

/**
 * The comparison key for a context identifier.
 *
 * Case and whitespace are not meaningful in either vocabulary, and treating them as
 * meaningful here would silently drop the enrichment — leaving a configuration with a
 * terse reference that the matcher cannot bridge to the bet's jurisdiction code.
 */
function normaliseKey(value: string): string {
  return value.trim().toUpperCase();
}

/** A bet reference for the multi-match case. */
function toBetRef(bet: Bet): BetRef {
  return {
    betId: bet.betId,
    receiptId: bet.receiptId,
    accountId: bet.accountId,
    placedAt: bet.placedAt,
    status: bet.status,
    betType: bet.betType
  };
}

/**
 * Assemble one bet's risk context.
 *
 * @param token THIS invocation's operator token — threaded to every hop as a value
 *   (FR-023a). All four hops go through the shared `core` client, which is composition
 *   rather than coupling: no `domain → domain` import exists (Principle III).
 */
export async function getBetRiskContext(
  deps: GetBetRiskContextDeps,
  token: OperatorToken,
  args: GetBetRiskContextArgs
): Promise<GetBetRiskContextResult> {
  const { client, maxEventResolutions } = deps;
  const identifier = resolveIdentifier(args);

  // ---- Hop 1: the bet ----------------------------------------------------------
  const betResult = await client.post<QbsSearchBetsResponse>(
    QBS_GRAPHQL_PATH,
    {
      query: SEARCH_BETS_DOCUMENT,
      operationName: SEARCH_BETS_OPERATION_NAME,
      variables: {
        input: { ids: { [identifier.kind]: [identifier.value] } },
        // Two is enough to DETECT a multi-match, which is all this tool needs: on more
        // than one it returns candidates and stops. Asking for more would fetch bets
        // it has already decided not to use.
        // ZERO-based (see `FIRST_PAGE`). Two items is enough to DETECT a multi-match,
        // which is all this tool needs: on more than one it returns candidates and stops.
        params: { pageNumber: FIRST_PAGE, itemsPerPage: 2, sort: PLACEMENT_DATE_DESC }
      }
    },
    { token, pathTemplate: QBS_GRAPHQL_PATH, tool: 'get_bet_risk_context', hop: 1 }
  );

  const hops: Completeness[] = [betResult.completeness];
  const components: ComponentName[] = [...unavailableFromQbs(betResult.data)];
  const projected: ProjectedBet[] = toProjectedBets(betResult.data);

  // Nothing matched: a tool error is wrong here (there is no failure) and so is an
  // empty success (which would read as "this bet has no risk context"). `notFound`
  // states the absence, echoing no identifier.
  if (projected.length === 0) {
    return {
      completeness: withUnavailableComponents(aggregate(hops), components),
      candidates: []
    };
  }

  // MORE THAN ONE MATCH → all candidates, and ZERO further work (FR-022). No CRS call,
  // no context call, no event calls. Resolving one of several plausible bets would be
  // exactly the auto-picking Principle IV prohibits.
  if (projected.length > 1) {
    return {
      candidates: projected.map(({ bet }) => toBetRef(bet)),
      completeness: withUnavailableComponents(aggregate(hops), components)
    };
  }

  const { bet, eventIdSources } = projected[0] as ProjectedBet;

  // ---- Hop 2: the customer's configurations ------------------------------------
  // A failure here is NOT fatal: it is one SECTION of a composite answer, so it
  // becomes `unavailableComponents` rather than a tool error (FR-026, research.md R2).
  //
  // The RAW response is kept and mapped after hop 3, because mapping needs the context
  // list to give each configuration a jurisdiction reference carrying its CODE. CRS
  // states only a `contextId`, and the code is what the bet's own jurisdiction is
  // expressed in — so mapping before hop 3 produces configurations that nothing can
  // match, and every bet reports `jurisdictionNotMatched`.
  let crsAccount: CrsAccountRiskSettings | null = null;
  try {
    const crsResult = await client.get<CrsAccountRiskSettings>(
      `/crs/accounts/${encodeURIComponent(bet.accountId)}`,
      { token, pathTemplate: CRS_ACCOUNT_TEMPLATE, tool: 'get_bet_risk_context', hop: 2 }
    );
    hops.push(crsResult.completeness);
    crsAccount = crsResult.data;
  } catch (error) {
    if (!isToolError(error)) throw error;
    components.push('customerRiskConfiguration');
  }

  // ---- Hop 3: the platform jurisdiction list -----------------------------------
  // MANDATORY, and not fatal. `null` (the hop failed) is meaningfully different from
  // `[]` (the platform reported none): only the first is a missing section.
  let platformContexts: JurisdictionRef[] | null = null;
  try {
    const contextResult = await client.get<
      readonly {
        contextId?: string | null;
        contextCode?: string | null;
        contextName?: string | null;
      }[]
    >(LIST_JURISDICTION_CONTEXTS_OPERATION, {
      token,
      pathTemplate: LIST_JURISDICTION_CONTEXTS_OPERATION,
      tool: 'get_bet_risk_context',
      hop: 3
    });
    hops.push(contextResult.completeness);
    platformContexts = (Array.isArray(contextResult.data) ? contextResult.data : [])
      .filter(
        (context) => typeof context?.contextCode === 'string' && context.contextCode.length > 0
      )
      .map((context) => {
        const code = context.contextCode as string;
        return { code, id: context.contextId ?? code, name: context.contextName ?? code };
      });
  } catch (error) {
    if (!isToolError(error)) throw error;
    // Fall back to derivation, and SAY SO. Silently degrading to derivation-only is
    // the confident-failure mode constitution v1.2.0 exists to prevent.
    components.push('jurisdictionContexts');
  }

  // Now that both hops have answered, map the configurations — enriching each
  // jurisdiction reference from the context list when it is available, and falling back
  // to the terse-but-honest identity resolver when it is not.
  const contextsById = new Map(
    (platformContexts ?? []).map((context) => [normaliseKey(context.id), context])
  );
  const configurations: CustomerRiskConfiguration[] = toRiskConfigurations(
    crsAccount,
    (contextId) => contextsById.get(normaliseKey(contextId)) ?? unresolvedJurisdiction(contextId)
  );

  // ---- Matching: NOT a form of incompleteness (FR-027) -------------------------
  const outcome = matchJurisdiction(
    bet.jurisdiction ?? bet.catalogueInstanceId,
    configurations,
    platformContexts
  );
  const governing =
    outcome.match === 'matched'
      ? (configurations.find(
          (configuration) => configuration.jurisdiction.id === outcome.governing?.id
        ) ?? null)
      : null;

  // ---- Hop 4: up to N event resolutions ----------------------------------------
  const { toResolve, beyondBound } = planEventResolutions(bet.legs, maxEventResolutions);

  const resolved = new Map<string, ResolvedEvent>();
  const failed = new Set<string>();
  const unusable = new Set<string>();

  for (const eventId of toResolve) {
    // A leg whose identifier cannot be turned into a GBP long URN is NOT looked up. The
    // `source` namespace lives in the `gbpId` value and is never assumed, so a bare
    // number yields `null` here (see `toEventLookupId`). Attempting a fabricated URN is
    // what produced a live 400; skipping is the honest alternative, and GMA's own join
    // does the same (`Rule4EnrichmentService:114` skips a leg with a blank gbpId).
    const lookupId = toEventLookupId(eventId);
    if (lookupId === null) {
      unusable.add(eventId);
      continue;
    }

    try {
      // The bookkeeping keys off the PROJECTED `eventId` so dedupe and per-leg
      // attribution stay in the bet's own vocabulary; only the URL carries the URN.
      const eventResult = await client.get<EventResponse>(
        `/v5/events/${encodeURIComponent(lookupId)}`,
        {
          token,
          pathTemplate: EVENT_TEMPLATE,
          tool: 'get_bet_risk_context',
          hop: 4,
          // T043's settled decision: scope by the BET's own catalogue instance, and
          // send nothing when it reported none. `sources` is the parameter name THIS
          // operation declares — `instancesList` would be silently ignored.
          ...(bet.catalogueInstanceId === null
            ? {}
            : { instances: [bet.catalogueInstanceId], instancesParam: 'sources' as const })
        }
      );
      // A 206 on ANY event hop makes the WHOLE result PARTIAL, via `aggregate`.
      hops.push(eventResult.completeness);

      const path = toCataloguePath(eventResult.data);
      if (path === null) failed.add(eventId);
      else resolved.set(eventId, { cataloguePath: path });
    } catch (error) {
      if (!isToolError(error)) throw error;
      // One leg failing must not lose the others' findings.
      failed.add(eventId);
    }
  }

  const resolvedLegs = resolveLegs({
    legs: bet.legs,
    eventIdSources,
    resolutions: { resolved, failed, notAttempted: new Set(beyondBound), unusable },
    overrides: governing?.overrides ?? []
  });

  if (hasUnresolvedLegs(resolvedLegs) && !components.includes('legCataloguePositions')) {
    components.push('legCataloguePositions');
  }

  const appliedFiguresAreBetLevel = bet.legCount > 1;

  return {
    bet,
    jurisdictionMatch: outcome.match,
    jurisdictionMatchMechanism: outcome.mechanism,
    ...(outcome.governing === null ? {} : { governingJurisdiction: outcome.governing }),
    // ALWAYS every configuration that exists, whatever the match outcome (FR-018).
    allJurisdictionConfigurations: configurations,
    resolvedLegs,
    agreement: assessAgreement({
      governingConfiguration: governing,
      appliedRisk: bet.appliedRisk,
      legCount: bet.legCount
    }),
    appliedFiguresAreBetLevel,
    ...(appliedFiguresAreBetLevel ? { attributionNotice: ATTRIBUTION_NOTICE } : {}),
    completeness: withUnavailableComponents(aggregate(hops), components)
  };
}
