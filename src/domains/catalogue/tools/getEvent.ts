import type { Config } from '../../../core/config.js';
import { argumentError, malformedResponse } from '../../../core/errors.js';
import type { GmaClient } from '../../../core/gmaClient.js';
import type { OperatorToken } from '../../../core/identity.js';
import { resolveInstances } from '../../../core/instances.js';
import type { Completeness } from '../../../core/types.js';
import type { CatalogueEvent, EventAncestor } from '../schemas.js';

/**
 * `get_event` — the catalogue lookup for a single sporting event.
 *
 * ## Why this exists, and why it is not `get_catalogue_entity`
 *
 * `get_catalogue_entity` serves the three CONFIGURATION levels — superclass, subclass,
 * event type — which are the levels risk settings attach to. An event is a different
 * kind of thing: a concrete fixture at a point in time, sitting under an event type.
 * Three differences make it a separate tool rather than a fourth enum member:
 *
 *  1. **The response shape differs.** `/v5/{level}/{id}` NESTS parents
 *     (`eventType.subclass.superclass`); `GET /v5/events/{id}` returns them FLAT, as
 *     six sibling fields (`superclassId`, `subclassName`, …). One function cannot walk
 *     both without a branch that is really two functions in a trench coat.
 *  2. **The scoping parameter differs.** This operation declares `sources`; the others
 *     declare `instancesList` (`api_catalogue.yaml`, `getEventById` → `sourcesParam`).
 *     A wrong name is not rejected — it is IGNORED, and the lookup silently fans out
 *     across every instance.
 *  3. **`Ancestor.type` would become a lie.** `entityTypeSchema` is reused for an
 *     ancestor's `type`, and an event is never an ancestor of anything. Widening that
 *     enum to `'event'` would let a path claim an event as a parent level.
 *
 * ## What it answers
 *
 * `find_customer_bets` hands the model an event name AND an event id per leg, and until
 * now the id was inert — nothing could act on it. This closes that loop: the model can
 * take a leg's event id and obtain the event's name plus its position in the catalogue
 * hierarchy, which is the context a risk question needs.
 *
 * ## Both id forms are accepted, and neither is guessed
 *
 * A bet states its event id as `source:sourceId` (`gpd:14643022`); the catalogue wants
 * the long URN (`urn:sbk:pc:e:gpd:14643022`). Both are accepted because an agent will
 * legitimately hold either — one echoed from a bet, one echoed from a previous answer.
 * The `source` is always READ from the value and never defaulted: `gpd` is data, and a
 * hardcoded namespace fabricates an id nobody issued (see `betProjection.ts`, R9).
 *
 * A bare number is REJECTED as an argument error rather than prefixed, because the
 * namespace cannot be recovered from it. That is a self-correctable failure naming what
 * to supply (SC-008), which is categorically better than a confident lookup of a
 * fabricated id — and better than the `null`-and-carry-on the composite needs, since
 * here the caller is an agent that can be told.
 */

/** This operation's path. A literal; the id is interpolated at the call site only. */
const EVENT_PATH = '/v5/events';

/** The path TEMPLATE for telemetry — never the interpolated id (Principle V). */
export const EVENT_PATH_TEMPLATE = '/v5/events/{id}';

/** The catalogue level segment for an event, matching GMA's `EVENT_LEVEL` (`"e"`). */
const EVENT_LEVEL = 'e';

/** The number of colon-separated parts in a GBP long URN, per `GbpId.fromLongUrn`. */
const LONG_URN_PARTS = 6;

/**
 * The description the model sees.
 *
 * It names where an event id comes from, because an agent that does not know will
 * either invent one or send an event NAME. There is no name-based event search to fall
 * back on: `POST /v5/searchByName` covers superclass, subclass and event type only
 * (`SearchByNameResult` is a three-field record), so saying so here is what stops the
 * model trying.
 */
export const GET_EVENT_DESCRIPTION =
  'Retrieves a sporting event by its id, with the catalogue hierarchy it sits under ' +
  '(superclass, subclass, event type) and its markets. Use this to act on an event id from ' +
  'a bet — find_customer_bets and get_bet_risk_context report one per leg. Accepts either ' +
  'the short "source:id" form (e.g. "gpd:14643022") or the full urn. There is no search by ' +
  'event name: if you have only a name, ask the user for the event id, or use ' +
  'find_catalogue_entity for the event TYPE instead. Relay any data-completeness caveat.';

/** The shape `GET /v5/events/{id}` returns. Upstream vocabulary, translated here. */
interface EventResponse {
  readonly event?: {
    readonly id?: string | null;
    readonly name?: string | null;
    readonly superclassId?: string | null;
    readonly superclassName?: string | null;
    readonly subclassId?: string | null;
    readonly subclassName?: string | null;
    readonly eventTypeId?: string | null;
    readonly eventTypeName?: string | null;
    readonly markets?: readonly ({ id?: string | null; name?: string | null } | null)[] | null;
  } | null;
}

export interface GetEventArgs {
  readonly id: string;
  readonly instances?: readonly string[] | undefined;
}

export interface GetEventResult {
  readonly event: CatalogueEvent;
  readonly completeness: Completeness;
}

/**
 * The event id as the catalogue's long URN, or `null` when one cannot be built.
 *
 * Mirrors GMA's own `GbpId.fromSourceId(value, "e").toLongUrn()` (`GbpId.java:17`,
 * used at `Rule4EnrichmentService:121`). Deliberately duplicated from the customer
 * domain's `toEventLookupId` rather than shared: Principle III forbids a domain
 * importing another domain, and hoisting it into `core` would put catalogue URN
 * vocabulary in the shared layer, where `core/instances.ts` keeps only the INSTANCE
 * URN. Two short mirrored functions are the cheaper price.
 */
export function toEventUrn(id: string): string | null {
  const trimmed = id.trim();

  // Already a long URN. Checked for the exact part count `GbpId.fromLongUrn` requires,
  // so a short urn is rejected here rather than forwarded to be rejected upstream.
  if (trimmed.startsWith('urn:')) {
    return trimmed.split(':').length === LONG_URN_PARTS ? trimmed : null;
  }

  const parts = trimmed.split(':');
  if (parts.length !== 2) return null;

  const [source, sourceId] = parts as [string, string];
  if (source.length === 0 || sourceId.length === 0) return null;

  return `urn:sbk:pc:${EVENT_LEVEL}:${source}:${sourceId}`;
}

/**
 * The event's position, BROADEST-FIRST.
 *
 * Same ordering as `get_catalogue_entity`'s `ancestors` — the order a human reads a
 * path in — so the two tools' outputs read the same way even though the upstream shapes
 * they come from do not.
 */
function toAncestors(event: NonNullable<EventResponse['event']>): EventAncestor[] {
  const levels: { type: EventAncestor['type']; id?: string | null; name?: string | null }[] = [
    { type: 'superclass', id: event.superclassId, name: event.superclassName },
    { type: 'subclass', id: event.subclassId, name: event.subclassName },
    { type: 'eventType', id: event.eventTypeId, name: event.eventTypeName }
  ];

  return levels.flatMap<EventAncestor>(({ type, id, name }) =>
    typeof id === 'string' && id.length > 0 ? [{ id, name: name ?? id, type }] : []
  );
}

/**
 * Retrieve an event by id.
 *
 * @param token THIS invocation's operator token, threaded explicitly (FR-023a)
 */
export async function getEvent(
  client: GmaClient,
  config: Config,
  token: OperatorToken,
  args: GetEventArgs
): Promise<GetEventResult> {
  const urn = toEventUrn(args.id);

  if (urn === null) {
    // Self-correctable and specific: the agent is told which forms work and where a
    // real id comes from. Note this fires BEFORE any GMA call — a malformed argument
    // must not cost an upstream round trip (SC-008).
    //
    // The supplied value is NOT echoed. An event id is not personal data, but the
    // client boundary treats identifiers uniformly, and there is nothing the agent
    // learns from being shown back what it just sent.
    throw argumentError(
      'id must be an event identifier in "source:id" form (e.g. "gpd:14643022") or a full ' +
        'urn (e.g. "urn:sbk:pc:e:gpd:14643022"). A bare number is not enough on its own: ' +
        'the source namespace cannot be guessed from it.',
      // An explicit hint, because the default `argument` guidance talks about instance
      // codes and `list_instances` — true for the scoped tools, misdirecting here, where
      // the rejected argument is the id.
      'Event ids are reported per leg by find_customer_bets and get_bet_risk_context; use one ' +
        'of those rather than constructing an id.'
    );
  }

  const instances = resolveInstances(args.instances, config);

  // A 404 becomes a `notFound` ToolError in the client, never an empty success (FR-010).
  const result = await client.get<EventResponse>(`${EVENT_PATH}/${encodeURIComponent(urn)}`, {
    token,
    pathTemplate: EVENT_PATH_TEMPLATE,
    instances,
    // `sources`, NOT `instancesList` — see this module's header. Carried per call
    // because the v5 surface is not uniform about the name.
    instancesParam: 'sources',
    tool: 'get_event',
    hop: 1
  });

  const event = result.data?.event;

  if (event === null || event === undefined || typeof event.id !== 'string') {
    // A 200 whose body does not carry the event. Reporting an empty success here is the
    // "confidently wrong" failure Principle II exists to prevent.
    throw malformedResponse(`GET ${EVENT_PATH_TEMPLATE}`);
  }

  return {
    event: {
      id: event.id,
      name: event.name ?? event.id,
      ancestors: toAncestors(event),
      markets: (event.markets ?? []).flatMap((market) =>
        market !== null && market !== undefined && typeof market.id === 'string'
          ? [{ id: market.id, name: market.name ?? market.id }]
          : []
      )
    },
    completeness: result.completeness
  };
}
