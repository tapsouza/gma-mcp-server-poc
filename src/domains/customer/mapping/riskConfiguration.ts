import type {
  CataloguePathNode,
  CustomerRiskConfiguration,
  HierarchyLevel,
  HierarchyOverride,
  JurisdictionRef,
  LiabilityGroupRef
} from '../schemas.js';

/**
 * CRS `AccountRiskSettings` → one `CustomerRiskConfiguration` per jurisdiction.
 *
 * This is the client boundary for the CRS vocabulary, and it is the ONLY place the
 * upstream names appear (constitution Principle IV). `contextId`, `hierarchyGroups`,
 * `birDelay`, `gpEligibility`, `gmltl`, `entityType` and friends stop here.
 *
 * Three rules this module exists to enforce, each of which would be a wrong answer
 * about a real customer's money if broken:
 *
 *  1. **Nothing is merged** (FR-006, SC-003). One configuration per jurisdiction, in
 *     upstream order. No averaging, no "most restrictive wins", no collapsing.
 *  2. **An absent value is `null`, never `0`.** The upstream types are boxed
 *     (`Float`, `Integer`, `Boolean`), so any of them may be absent. A stake factor of
 *     zero blocks a customer; an unset one does not.
 *  3. **No name is ever fabricated.** An override whose `metadata.entities` is empty
 *     gets an empty `path` with its `entityId` intact.
 *
 * It also DROPS two things deliberately, and both are privacy decisions rather than
 * curation: `customerNotes` (FR-004 — staff-authored notes about customers are out of
 * scope for this slice) and `nickname`, whose `creatorName` and `updaterName` name
 * actual members of staff (Principle V).
 */

/** The subset of `GET /crs/accounts/{accountId}` this mapper reads. Upstream vocabulary. */
export interface CrsAccountRiskSettings {
  readonly accountId?: string | null;
  readonly contexts?: readonly CrsContext[] | null;
}

interface CrsLiabilityGroup {
  readonly code?: string | null;
  readonly description?: string | null;
  readonly interceptValue?: number | null;
}

interface CrsHierarchyGroupEntity {
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly entityName?: string | null;
}

interface CrsHierarchyGroup {
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly stakeFactor?: number | null;
  readonly liabilityGroup?: CrsLiabilityGroup | null;
  readonly metadata?: { readonly entities?: readonly CrsHierarchyGroupEntity[] | null } | null;
}

interface CrsContext {
  readonly contextId?: string | null;
  readonly stakeFactor?: number | null;
  readonly birDelay?: number | null;
  readonly liabilityGroup?: CrsLiabilityGroup | null;
  readonly hierarchyGroups?: readonly CrsHierarchyGroup[] | null;
  readonly gmltl?: boolean | null;
  readonly maxWinningsCap?: number | null;
  readonly gpEligibility?: string | null;
  readonly earlySettlementRestricted?: boolean | null;
  readonly gpPayoutLimitSingles?: number | null;
  readonly gpPayoutLimitMultiples?: number | null;
}

/** The closed set of catalogue levels an override may carry. */
const HIERARCHY_LEVELS: readonly HierarchyLevel[] = [
  'SUPERCLASS',
  'SUBCLASS',
  'EVENT_TYPE',
  'MARKET_TYPE'
];

const ELIGIBILITY_VALUES = ['STANDARD', 'RESTRICTED', 'UNRESTRICTED'] as const;

/**
 * A number, or `null` — never a coerced zero.
 *
 * The distinction this preserves is the whole reason the schema is nullable: `0` and
 * "unset" are different facts about a customer, and `?? 0` anywhere in this file would
 * report an unconfigured customer as one whose stake factor is zero.
 */
function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: boolean | null | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A recognised catalogue level, or `null` when upstream sent something else. */
function levelOrNull(value: string | null | undefined): HierarchyLevel | null {
  return HIERARCHY_LEVELS.find((level) => level === value) ?? null;
}

/**
 * A liability group, or `null`.
 *
 * Requires a `code`: a group with no code cannot be compared against a bet's applied
 * liability group, which is what `agreement.ts` exists to do. `description` falls back
 * to the code rather than to an invented phrase.
 */
function toLiabilityGroup(raw: CrsLiabilityGroup | null | undefined): LiabilityGroupRef | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw.code !== 'string' || raw.code.length === 0) return null;

  return {
    code: raw.code,
    description: raw.description ?? raw.code,
    // `interceptValue` is part of the group's identity for a risk operator, so a
    // missing one becomes 0 rather than dropping the whole group — unlike a stake
    // factor, this is a group attribute and not a customer's setting.
    interceptValue: numberOrNull(raw.interceptValue) ?? 0
  };
}

/**
 * Project `metadata.entities` into a BROADEST-FIRST named path.
 *
 * GMA fills these specific-to-broad (`MARKET_TYPE`, then its `EVENT_TYPE`, then
 * `SUBCLASS`, then `SUPERCLASS`), so the projection reverses them. That is not a
 * cosmetic choice: the catalogue domain's `ancestors` field is documented "broadest to
 * nearest parent", and a model reading two orderings from one server will get one of
 * them wrong.
 *
 * An entity with an unrecognised level is dropped rather than guessed, and an empty
 * result is returned as an empty path — never as a fabricated name (research.md R3).
 */
function toCataloguePath(group: CrsHierarchyGroup): CataloguePathNode[] {
  const entities = group.metadata?.entities ?? [];

  const nodes = entities.flatMap<CataloguePathNode>((entity) => {
    const level = levelOrNull(entity?.entityType);
    if (level === null) return [];
    if (typeof entity.entityId !== 'string' || entity.entityId.length === 0) return [];

    return [
      {
        level,
        id: entity.entityId,
        // Falls back to the id: a terse correct value beats an invented name.
        name: entity.entityName ?? entity.entityId
      }
    ];
  });

  return nodes.reverse();
}

/** One hierarchy override, or `null` when it carries no usable level or identifier. */
function toOverride(group: CrsHierarchyGroup): HierarchyOverride | null {
  const level = levelOrNull(group.entityType);
  if (level === null) return null;
  if (typeof group.entityId !== 'string' || group.entityId.length === 0) return null;

  return {
    level,
    entityId: group.entityId,
    path: toCataloguePath(group),
    stakeFactor: numberOrNull(group.stakeFactor),
    liabilityGroup: toLiabilityGroup(group.liabilityGroup)
  };
}

/**
 * Map one upstream context to one jurisdiction's configuration.
 *
 * @param resolveJurisdiction supplies the code and name for a context identifier when
 *   the platform context list is available. It is a PARAMETER rather than a lookup
 *   this module performs, so the mapper stays pure and I/O-free — and so a tool that
 *   has no context list still produces a correct configuration with a terse
 *   jurisdiction reference rather than failing.
 */
function toConfiguration(
  context: CrsContext,
  resolveJurisdiction: (contextId: string) => JurisdictionRef
): CustomerRiskConfiguration | null {
  if (typeof context?.contextId !== 'string' || context.contextId.length === 0) return null;

  const eligibility = ELIGIBILITY_VALUES.find((value) => value === context.gpEligibility) ?? null;

  return {
    jurisdiction: resolveJurisdiction(context.contextId),
    stakeFactor: numberOrNull(context.stakeFactor),
    inRunningDelaySeconds: numberOrNull(context.birDelay),
    liabilityGroup: toLiabilityGroup(context.liabilityGroup),
    eligibility,
    payoutLimitSingles: numberOrNull(context.gpPayoutLimitSingles),
    payoutLimitMultiples: numberOrNull(context.gpPayoutLimitMultiples),
    maxWinningsCap: numberOrNull(context.maxWinningsCap),
    guaranteedMaxLimitToLose: booleanOrNull(context.gmltl),
    earlySettlementRestricted: booleanOrNull(context.earlySettlementRestricted),
    overrides: (context.hierarchyGroups ?? []).flatMap((group) => {
      const override = toOverride(group);
      return override === null ? [] : [override];
    })
  };
}

/**
 * The identity resolver used when no platform context list is available.
 *
 * The code and name fall back to the identifier, which is honest: it says "this is the
 * jurisdiction, and I do not have a friendlier name for it" rather than inventing one.
 */
export function unresolvedJurisdiction(contextId: string): JurisdictionRef {
  return { code: contextId, id: contextId, name: contextId };
}

/**
 * Map a CRS account response to one configuration per jurisdiction.
 *
 * Pure and I/O-free: everything it needs about jurisdictions arrives through
 * `resolveJurisdiction`, so it is testable as a function rather than through an HTTP
 * round trip.
 *
 * @param resolveJurisdiction defaults to `unresolvedJurisdiction`, so a caller with no
 *   context list gets terse-but-correct jurisdiction references
 */
export function toRiskConfigurations(
  raw: CrsAccountRiskSettings | null | undefined,
  resolveJurisdiction: (contextId: string) => JurisdictionRef = unresolvedJurisdiction
): CustomerRiskConfiguration[] {
  const contexts = raw?.contexts ?? [];

  // ONE per context, in upstream order. Nothing is merged, sorted by restrictiveness,
  // or collapsed — FR-006 prohibits all three, and SC-003 is the test.
  return contexts.flatMap((context) => {
    const configuration = toConfiguration(context, resolveJurisdiction);
    return configuration === null ? [] : [configuration];
  });
}
