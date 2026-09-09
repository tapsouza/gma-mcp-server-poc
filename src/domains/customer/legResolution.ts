import type { EntityIdSource } from './mapping/betProjection.js';
import type { BetLeg, CataloguePathNode, HierarchyOverride } from './schemas.js';

/**
 * Leg resolution: distinct-event dedupe, the configured bound, and per-leg outcome
 * (FR-019, FR-023, SC-013, data-model.md section 7).
 *
 * PURE. The actual event fetching is the caller's job — this module decides WHICH
 * events to fetch and then interprets the answers, which is where every mistake worth
 * catching lives.
 *
 * ## Three properties, each of which would be a wrong answer if broken
 *
 *  1. **A distinct event is resolved ONCE** however many legs reference it (SC-013).
 *     A three-leg parlay with two legs on one match makes two calls, not three.
 *  2. **Reaching the bound NAMES the unresolved legs** rather than truncating (FR-023).
 *     Silent truncation is prohibited by Principle V, and here it would be worse than
 *     usual: a dropped leg reads as a leg with no restrictions.
 *  3. **An empty `overridesInScope` is NEVER readable as "unrestricted".** On a
 *     `resolved` leg it means no override covers that position. On an unresolved leg it
 *     means nothing is known. `resolution` is the field that tells them apart, which is
 *     why it is mandatory rather than optional.
 */

/** Why a leg's catalogue position is or is not known (data-model.md section 7). */
export type LegResolutionOutcome =
  /** The event resolved and the path is present. */
  | 'resolved'
  /** The event lookup failed upstream. */
  | 'notResolvedUpstreamFailure'
  /**
   * The leg carried no usable event identifier — R9's failure mode.
   *
   * Kept SEPARATE from `notResolvedUpstreamFailure` because Principle IV requires "the
   * case where the tool's own matching logic failed, kept separate from the case where
   * the records genuinely contain no applicable entry". If R9's assumption about which
   * `entityIds` member is the event id is wrong, EVERY leg lands here — a systematic
   * defect that is immediately visible, where an `upstream` bucket would hide it.
   */
  | 'notResolvedIdentifierUnusable'
  /** The per-bet resolution bound was reached before this leg (FR-023). */
  | 'notAttemptedBoundReached';

export interface ResolvedLeg {
  readonly legNumber: number;
  readonly leg: BetLeg;
  /** Superclass → subclass → eventType; `null` when unresolved. */
  readonly cataloguePath: CataloguePathNode[] | null;
  /** Every override covering this leg's position. Empty ≠ unrestricted — see below. */
  readonly overridesInScope: HierarchyOverride[];
  /** MANDATORY. Check this before reading `overridesInScope`. */
  readonly resolution: LegResolutionOutcome;
  /**
   * Which `entityIds` member produced the event identifier; `null` when unresolved.
   *
   * R9's DISCLOSURE (Principle IV: a tool "MUST state the limitation in its result"
   * where a load-bearing assumption is unverified). It is a field LEVEL, never an
   * identifier value, so it carries no personal datum — and it is the evidence that
   * closes R9: an operator reading `rampId` here knows which member actually worked.
   */
  readonly resolvedVia: EntityIdSource | null;
}

/** A resolved event's catalogue position, as the caller obtained it. */
export interface ResolvedEvent {
  readonly cataloguePath: CataloguePathNode[];
}

/** What the caller managed to fetch, keyed by event identifier. */
export interface EventResolutions {
  /** Successfully resolved events. */
  readonly resolved: ReadonlyMap<string, ResolvedEvent>;
  /** Event identifiers whose lookup FAILED upstream. */
  readonly failed: ReadonlySet<string>;
  /** Event identifiers not attempted because the bound was reached. */
  readonly notAttempted: ReadonlySet<string>;
  /**
   * Event identifiers that could not be expressed as a catalogue URN, so no lookup was
   * ATTEMPTED.
   *
   * Distinct from `failed` on purpose. `failed` means we asked and upstream could not
   * answer — retrying might work. This means the leg carried no namespaced identifier, so
   * asking is impossible and no retry can help. Folding the two would hide a systematic
   * identifier problem inside a bucket that reads as transient (Principle IV).
   *
   * Optional so existing callers and tests are unaffected.
   */
  readonly unusable?: ReadonlySet<string> | undefined;
}

/**
 * The DISTINCT event identifiers across a bet's legs, in first-seen order, and which of
 * them fall inside the configured bound.
 *
 * Dedupe happens BEFORE the bound is applied, which is the only ordering that makes
 * sense: a three-leg bet with two legs on one match should consume one unit of the
 * budget for that match, not two. Doing it the other way would exhaust a bound of 2 on
 * a bet that needs only two lookups.
 *
 * @param legs the bet's legs, already projected
 * @param maxResolutions the configured bound (`CUSTOMER_MAX_EVENT_RESOLUTIONS`)
 */
export function planEventResolutions(
  legs: readonly BetLeg[],
  maxResolutions: number
): { readonly toResolve: string[]; readonly beyondBound: string[] } {
  const distinct: string[] = [];

  for (const leg of legs) {
    const id = leg.event.id;
    // A leg with no usable identifier consumes NO budget: it cannot be looked up, so
    // spending a unit on it would deny a resolvable leg its lookup.
    if (id === null) continue;
    if (!distinct.includes(id)) distinct.push(id);
  }

  return {
    toResolve: distinct.slice(0, maxResolutions),
    beyondBound: distinct.slice(maxResolutions)
  };
}

/**
 * The comparable form of a catalogue identifier: its trailing segment.
 *
 * `urn:sbk:pc:spc:gpd:27` → `27`, and a bare `27` stays `27`.
 *
 * ## Why this is needed at all, and why it is not a guess
 *
 * The two sides of the FR-019 join state the SAME identifier in two different forms:
 *
 *  - CRS overrides carry bare ids — `'3'`, `'7'`, `'3307'`, `'507531'`
 *    (`crs-service/docs/openapi/api.yaml` examples `"1234"`/`"3307"`;
 *    `gbpcrsui-tool/src/constants/mocks.ts:541-558`).
 *  - `GET /v5/events/{id}` returns URNs — `urn:sbk:pc:spc:gpd:27`.
 *
 * Comparing them verbatim matches NOTHING, so every leg would report an empty
 * `overridesInScope` — and an empty list is the shape that reads as "no restriction
 * covers this leg". That is a confidently-wrong answer about a real customer's limits,
 * and it is the worst failure available to this module, which is why it is normalised
 * here rather than left to look like data.
 *
 * The trailing segment is the bridge R9 already documents, read in the other direction:
 * `gbpbmui-tool` builds `urn:sbk:pc:e:gpd:{rampId}`, so the segment after the final `:`
 * IS the ramp-side id that CRS states bare. Nothing is derived beyond taking that
 * segment — there is no namespace table and no per-level special case, so this cannot go
 * stale as levels or namespaces are added.
 *
 * **Recorded as an extension of R9** (unverified for the three non-event levels): R9's
 * evidence covers events only. `resolvedVia` remains the disclosure, and the failure mode
 * stays honest — a level whose ids do not correspond simply yields no override in scope on
 * a `resolved` leg, never a fabricated one.
 */
function comparableId(id: string): string {
  const segments = id.split(':');
  return (segments[segments.length - 1] ?? id).trim().toUpperCase();
}

/**
 * Which overrides cover a given catalogue position.
 *
 * An override covers a leg when its `entityId` corresponds to a node anywhere in the
 * leg's resolved path. So a `SUPERCLASS` override on Soccer covers every soccer leg, and
 * an `EVENT_TYPE` override covers only legs whose event is of that type.
 *
 * The `level` is checked alongside the identifier rather than trusting the id alone. That
 * matters more once identifiers are compared by trailing segment: the four risk levels
 * draw their ids from different namespaces, so bare `3` could be a superclass, an event
 * type, or a market type. Requiring the level to agree is what stops a market-type
 * override being attributed to a superclass position — a restriction claimed for a
 * position it does not apply to.
 */
function overridesCovering(
  path: readonly CataloguePathNode[],
  overrides: readonly HierarchyOverride[]
): HierarchyOverride[] {
  return overrides.filter((override) =>
    path.some(
      (node) =>
        node.level === override.level &&
        (node.id === override.entityId || comparableId(node.id) === comparableId(override.entityId))
    )
  );
}

export interface ResolveLegsInput {
  readonly legs: readonly BetLeg[];
  /** Which `entityIds` member supplied each leg's event id, keyed by `legNumber`. */
  readonly eventIdSources: ReadonlyMap<number, EntityIdSource>;
  readonly resolutions: EventResolutions;
  /** Every override from the GOVERNING configuration, or empty when none governs. */
  readonly overrides: readonly HierarchyOverride[];
}

/**
 * Attach each leg's catalogue position and the overrides in scope for it.
 *
 * Note that an override covering several legs appears on EACH leg it covers (FR-019),
 * duplicated deliberately. A normalised list plus per-leg references would be smaller
 * and would require the model to perform a join to answer "is this leg restricted?" —
 * and a model doing a join in-context is a model that gets it wrong.
 */
export function resolveLegs(input: ResolveLegsInput): ResolvedLeg[] {
  const { legs, eventIdSources, resolutions, overrides } = input;

  return legs.map((leg) => {
    const eventId = leg.event.id;
    const resolvedVia = eventIdSources.get(leg.legNumber) ?? null;

    // R9's failure mode, and the reason it has its own outcome: if the assumption
    // about which `entityIds` member is the event id is wrong, every leg lands here.
    if (eventId === null) {
      return {
        legNumber: leg.legNumber,
        leg,
        cataloguePath: null,
        overridesInScope: [],
        resolution: 'notResolvedIdentifierUnusable',
        resolvedVia: null
      };
    }

    // The identifier existed but could not be expressed as a catalogue URN, so nothing
    // was asked. Reported as unusable rather than as an upstream failure: no retry can
    // help, and calling it `notResolvedUpstreamFailure` would blame the wrong system.
    if (resolutions.unusable?.has(eventId) === true) {
      return {
        legNumber: leg.legNumber,
        leg,
        cataloguePath: null,
        overridesInScope: [],
        resolution: 'notResolvedIdentifierUnusable',
        // The MEMBER is still reported: knowing the leg carried only a `rampId` is
        // exactly what tells an operator why this leg could not be looked up.
        resolvedVia
      };
    }

    if (resolutions.notAttempted.has(eventId)) {
      return {
        legNumber: leg.legNumber,
        leg,
        cataloguePath: null,
        overridesInScope: [],
        resolution: 'notAttemptedBoundReached',
        // The identifier WAS usable — we simply did not spend a lookup on it — so the
        // source is reported. That distinction is what makes a bound-reached leg
        // different from an unusable one.
        resolvedVia
      };
    }

    if (resolutions.failed.has(eventId)) {
      return {
        legNumber: leg.legNumber,
        leg,
        cataloguePath: null,
        overridesInScope: [],
        resolution: 'notResolvedUpstreamFailure',
        resolvedVia
      };
    }

    const event = resolutions.resolved.get(eventId);
    if (event === undefined) {
      // Neither resolved, nor failed, nor deferred. The caller's bookkeeping is
      // incomplete, and reporting an upstream failure is the honest reading: we do not
      // have the position, and we must not imply that no override applies.
      return {
        legNumber: leg.legNumber,
        leg,
        cataloguePath: null,
        overridesInScope: [],
        resolution: 'notResolvedUpstreamFailure',
        resolvedVia
      };
    }

    return {
      legNumber: leg.legNumber,
      leg,
      cataloguePath: event.cataloguePath,
      overridesInScope: overridesCovering(event.cataloguePath, overrides),
      resolution: 'resolved',
      resolvedVia
    };
  });
}

/**
 * True when any leg's position is unknown, for whatever reason.
 *
 * The caller uses this to decide whether to emit
 * `unavailableComponents: ['legCataloguePositions']`. Every non-`resolved` outcome
 * counts, including `notAttemptedBoundReached`: a bound reached is a section of the
 * answer that is missing, and FR-023 requires it be reported rather than absorbed.
 */
export function hasUnresolvedLegs(legs: readonly ResolvedLeg[]): boolean {
  return legs.some((leg) => leg.resolution !== 'resolved');
}
