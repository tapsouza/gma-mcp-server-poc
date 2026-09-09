# Phase 1 Data Model: Customer Risk & Bet Tools (FanDuel)

**Feature**: `004-customer-bet-tools` | **Date**: 2026-09-08 | **Plan**: [plan.md](./plan.md)

These are **internal and LLM-facing** types. No GMA DTO field name appears in a tool schema
(constitution Principle IV): `configSource`, `contextId`, `entityIds`, `hierarchyGroups`,
`riskInfo`, `EVENTTYPE` and friends are translated at the client boundary, exactly as
`configSource → instance` already is.

Sections 1–2 modify **shared** `core` types and are the amendment's migration surface.
Sections 3–10 are new and live entirely in `domains/customer/`.

---

## 1. `Completeness` — gains a second failure axis (MODIFIES `core/types.ts`)

The change constitution v1.1.0 requires. **Additive**: the new collection is empty for every
existing catalogue call, so `complete` keeps its present value everywhere and the existing
catalogue tests must pass **unmodified** (the amendment-acceptance gate).

```ts
export interface Completeness {
  readonly complete: boolean;
  readonly outcome: Outcome;
  readonly successfulInstances: readonly string[];
  readonly failedInstances: readonly string[];
  /** NEW — named sections of a composite answer that could not be retrieved. */
  readonly unavailableComponents: readonly string[];
  readonly errors: readonly InstanceError[];
  readonly caveat: string | null;
}
```

### The invariant, restated

`core/completeness.ts` already documents why the data-model's original three-way equivalence
was unsatisfiable (`TOO_BROAD` has zero failed instances yet is incomplete). That reasoning
is preserved verbatim and extended by one clause:

1. `complete === true` **iff** `outcome === 'COMPLETE'`
2. `failedInstances.length > 0` **implies** `NOT complete`
3. **NEW** — `unavailableComponents.length > 0` **implies** `NOT complete`
4. `caveat === null` **iff** `complete`

Clause 3 is one-directional for the same reason clause 2 is. `complete` remains **never an
input** to any function in that module: a caller cannot assert completeness it has not
earned.

### Why the two axes must not merge

| Axis | Question it answers | Correct agent behaviour |
|---|---|---|
| `failedInstances` | *Is this list missing rows?* | Retry with narrower scoping |
| `unavailableComponents` | *Is this record missing a section?* | State what is absent; do **not** retry |

Reporting a missing section as a failed instance instructs the agent to retry with different
scoping — a correction that cannot work, so it retries indefinitely.

### Component names (a closed set)

Only these strings may appear in `unavailableComponents`. A closed set keeps the agent-facing
vocabulary stable and makes the schema `enum`-able.

| Name | Meaning |
|---|---|
| `customerRiskConfiguration` | The customer's per-jurisdiction settings could not be retrieved |
| `betDetail` | The bet itself could not be retrieved |
| `legCataloguePositions` | One or more legs' catalogue positions are unresolved — the unresolved legs are named in the result body, not here |
| `jurisdictionContexts` | The platform jurisdiction list could not be retrieved |

### New constructor and aggregation

```ts
/** A composite hop that answered, but whose named section is missing. */
export function withUnavailableComponents(
  base: Completeness,
  components: readonly ComponentName[]
): Completeness;
```

`aggregate` takes the **deduplicated union** of `unavailableComponents` across hops,
alongside the existing union of instances and errors and the worst outcome by
`OUTCOME_SEVERITY`. `Outcome` itself is **unchanged** — a missing component is not a new
severity, it is an independent axis.

---

## 2. `ErrorKind` — gains `forbidden` (MODIFIES `core/types.ts`, `core/errors.ts`)

```ts
export type ErrorKind =
  | 'auth'        // 401 — human re-authenticates
  | 'forbidden'   // NEW — 403; identity valid, permission absent
  | 'argument'    // 400 or local validation
  | 'notFound'    // 404
  | 'upstream'    // 500, timeout with nothing usable
  | 'config';     // startup only
```

Mapping additions in `core/errors.ts` — the single place Principle II permits:

| Status | `kind` | `retryable` | Guidance |
|---|---|---|---|
| `403` | `forbidden` | **false** | "Request access — do not sign in again, and do not retry." |
| `207` | *(not an error)* | — | Treated as `206` is: result + caveat |
| `424` | `upstream` | **true** | "A dependency of the upstream system failed." |

**`403` is the behaviourally important one.** Today `fromHttpStatus(403)` falls through to
`upstream` with `retryable: true` (asserted in `test/unit/errors.test.ts:32`), which is a
retry loop the moment the QBS authorization flag flips (research.md R10). `forbidden` is
never conflated with `auth` — the human action differs — and never reported as an upstream
failure, which would invite a retry.

`RETRYABLE` and `GUIDANCE` gain a `forbidden` row. Every existing row is untouched.

---

## 3. Jurisdiction context

The customer domain's scoping unit, replacing the catalogue's brand instance. Per Principle V
a scoping argument **MUST NOT** be a list where the domain admits one value — but the metrics
API genuinely accepts several `contexts`, so the metrics filter is a list and the composite's
governing jurisdiction is a single value. The difference is real, not stylistic.

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | What a person says and what the metrics filter takes, e.g. `NJ`, `NXTCANBS` |
| `id` | `string` | Opaque identifier |
| `name` | `string` | Human-readable, e.g. `New Jersey` |

Derived from upstream `ContextEntity { contextCode, contextId, contextName }` (research.md
R7). Note the deliberate shape match with `brandInstanceSchema` — `{ code, id, name }` — so
the two discovery tools read the same way to a model.

---

## 4. Customer risk configuration (one per jurisdiction)

**There is no global configuration.** A customer holds several of these, one per
jurisdiction. Merging them is prohibited (FR-006): a customer restricted on one sport in one
state and unrestricted in another must not be reported as either.

| Field | Type | Upstream |
|---|---|---|
| `jurisdiction` | `JurisdictionRef` | `contextId`, enriched with name/code when available |
| `stakeFactor` | `number \| null` | `stakeFactor` |
| `inRunningDelaySeconds` | `number \| null` | `birDelay` |
| `liabilityGroup` | `LiabilityGroupRef \| null` | `liabilityGroup` |
| `eligibility` | `'STANDARD' \| 'RESTRICTED' \| 'UNRESTRICTED' \| null` | `gpEligibility` |
| `payoutLimitSingles` | `number \| null` | `gpPayoutLimitSingles` |
| `payoutLimitMultiples` | `number \| null` | `gpPayoutLimitMultiples` |
| `maxWinningsCap` | `number \| null` | `maxWinningsCap` |
| `guaranteedMaxLimitToLose` | `boolean \| null` | `gmltl` |
| `overrides` | `HierarchyOverride[]` | `hierarchyGroups` |

`LiabilityGroupRef` is `{ code, description, interceptValue }` — the three members a risk
operator reads. `displayOrder` and `colour` are presentation concerns and are dropped, since
a tool schema is for a model, not a UI.

Every scalar is nullable because the upstream Java types are boxed (`Float`, `Integer`,
`Boolean`) and CRS may omit any of them. A missing value is `null`, never `0` — a stake
factor of zero and an unset stake factor are different facts.

---

## 5. Hierarchy override

A risk setting applied to part of the catalogue rather than to the whole configuration.

| Field | Type | Notes |
|---|---|---|
| `level` | `'SUPERCLASS' \| 'SUBCLASS' \| 'EVENT_TYPE' \| 'MARKET_TYPE'` | `entityType` |
| `entityId` | `string` | `entityId` |
| `path` | `CataloguePathNode[]` | From `metadata.entities`, **broadest first** |
| `stakeFactor` | `number \| null` | The overriding value |
| `liabilityGroup` | `LiabilityGroupRef \| null` | The overriding value |

`CataloguePathNode` is `{ level, id, name }`. GMA already supplies the full named ancestor
chain (research.md R3), so `path` is a projection and this domain makes **no** catalogue
call for it. Upstream returns entities in specific-to-broad order; the projection reverses
them so `path` reads like the catalogue domain's `ancestors` field, which is documented
"broadest to nearest parent".

An override with an **empty** `path` is possible — `createHierarchyGroupMetadataEntities`
returns `List.of()` when the id matches nothing in the catalogue. That is surfaced as an
empty `path` with `entityId` intact, never as a fabricated name.

---

## 6. Bet (risk projection)

A **curated, fixed** projection (FR-009). The upstream `searchBets` document GMA packages
requests ~200 fields; this projection is the subset a risk question needs. Notably absent:
**`betNotesDetails`** — FR-004 excludes staff-authored notes, and this is enforced by the
document constant, not by filtering after retrieval.

| Field | Type | Upstream |
|---|---|---|
| `betId` | `string` | `ids.betId` |
| `receiptId` | `string \| null` | `ids.betReceiptId` |
| `accountId` | `string` | `ids.accountId` |
| `placedAt` | `string` | `placementDate` |
| `status` | `string` | `status` |
| `betType` | `string` | `betType` |
| `jurisdiction` | `string \| null` | `instance` |
| `catalogueInstanceId` | `string \| null` | `catalogueInstanceId` |
| `legCount` | `number` | `numberOfLines.total` |
| `appliedRisk` | `AppliedRiskFigures \| null` | `riskInfo` |
| `wager` | `WagerAmounts` | `wageInfo` |
| `legs` | `BetLeg[]` | `legs` |

`WagerAmounts` is `{ stake, currency, potentialPayout, winnings, refunds }`. `productId` is
carried **internally** (some QBS lookups are keyed by bet+product) but is not in the tool
output: it is an upstream mechanic, not a risk fact.

### 6a. Applied risk figures — bet-level, not per-leg

| Field | Type | Upstream |
|---|---|---|
| `stakeFactor` | `number \| null` | `riskInfo.stakeFactor` |
| `liabilityGroup` | `string \| null` | `riskInfo.liabilityGroup` — a bare string; see R14 |
| `maxBet` | `number \| null` | `riskInfo.maxBet` |
| `maxValuePercent` | `number \| null` | `riskInfo.maxValue` |
| `cumulativeMaxPercent` | `number \| null` | `riskInfo.cumulativeMax` |
| `overlayMaxPercent` | `number \| null` | `riskInfo.overlayMax` |

**Their derivation is not available to this system** (FR-017). These are computed by GMA's
downstream pricing and risk engine, whose formula is not exposed. The type carries no field
that would let a caller think otherwise, and no tool output ever explains *how* a limit was
reached.

### 6b. Bet leg

| Field | Type | Notes |
|---|---|---|
| `legNumber` | `number` | |
| `selection` / `market` / `event` / `competition` / `sport` | `NamedEntity` | `{ name, id }` — `id` from `entityIds` (R9) |
| `placedInPlay` | `boolean \| null` | |
| `price` | `{ numerator, denominator } \| null` | `legPrice` |
| `result` | `string \| null` | |

**A leg carries no risk-side catalogue level.** `sport`/`competition`/`event`/`market`/
`selection` is a different tree from `SUPERCLASS`/`SUBCLASS`/`EVENT_TYPE`/`MARKET_TYPE`
(research.md R5). Bridging them requires the event hop, and that is why the composite exists.

---

## 7. Resolved leg (composite only)

Produced by resolving a leg's event through `GET /v5/events/{id}`.

| Field | Type | Notes |
|---|---|---|
| `legNumber` | `number` | |
| `leg` | `BetLeg` | The projection above |
| `cataloguePath` | `CataloguePathNode[] \| null` | Superclass → subclass → eventType; `null` when unresolved |
| `overridesInScope` | `HierarchyOverride[]` | Every override covering this leg's position |
| `resolution` | `LegResolutionOutcome` | Below |
| `resolvedVia` | `'rampId' \| 'gbpId' \| null` | Which `entityIds` member produced the event identifier; `null` when unresolved. **R9's disclosure** — see below |

`LegResolutionOutcome` is a closed enum, and the split is the point:

| Value | Meaning |
|---|---|
| `resolved` | The event resolved and the path is present |
| `notResolvedUpstreamFailure` | The event lookup failed |
| `notResolvedIdentifierUnusable` | No usable event identifier on the leg (R9's failure mode) |
| `notAttemptedBoundReached` | The per-bet resolution bound was hit before this leg |

`notResolvedIdentifierUnusable` is kept separate from `notResolvedUpstreamFailure` because
Principle IV requires *"the case where the tool's own matching logic failed, kept separate
from the case where the records genuinely contain no applicable entry"*. If R9's assumption
is wrong, **every** leg lands in `notResolvedIdentifierUnusable` — a systematic defect that
is immediately visible in a way an `upstream` bucket would hide.

**`overridesInScope` is empty ≠ "no restrictions".** An empty list on a `resolved` leg means
no override covers that position. An empty list on an unresolved leg means nothing is known.
The `resolution` field is what distinguishes them, which is why it is mandatory.

An override covering several legs appears on **each** leg it covers (FR-019) — duplicated
deliberately, so an agent reading one leg sees the whole truth for that leg.

### `resolvedVia` — stating R9 in the result, as Principle IV requires

*Added 2026-09-08.* Principle IV: a tool *"MUST NOT assert an upstream behaviour it has not
verified"*, and where such an assumption is load-bearing *"the tool MUST state the limitation in
its result"*. R9 is exactly that assumption — which member of a leg's `entityIds` is the v5 event
identifier — so the result names which one actually worked: `rampId` first, `gbpId` as a fallback.

Two things make this the right shape:

- It is a **field level**, never an identifier. `'rampId'` is the name of a member, so it carries
  no customer datum and Principle V's personal-data rule is untouched. It is safe in the payload
  and would be safe in a log (though it needs no log field — see below).
- It is **R9's closure evidence**. quickstart.md Validation 4 closes R9 by observing one real leg
  resolve; `resolvedVia` is what records the answer, turning the removal condition into a value an
  operator can read rather than a debugging session.

It lives in the **result**, not in telemetry, deliberately. `telemetry.ts` uses an allowlist, so a
new log field is a reviewed act; the result is where Principle IV asks for the disclosure, and it
reaches the human who needs it. Nothing here needs a `LOG_FIELD_ALLOWLIST` entry.

**A caution for whoever closes R9**: if every leg reports `notResolvedIdentifierUnusable`, the
`entityIds` assumption is the *second* thing to suspect. An absent or wrong instance scope on the
event hop produces an identical symptom, and that decision is still open (tasks.md T043).

---

## 8. Jurisdiction-matching outcome — **NOT** a form of incompleteness

FR-018's four outcomes, a fifth added after live validation, and FR-027's rule that this
never touches `Completeness`.

| Value | Meaning | Configurations returned |
|---|---|---|
| `matched` | The bet's jurisdiction matched one configuration, named in `governingJurisdiction` | All, with the governing one identified |
| `noConfigurationForJurisdiction` | The bet's jurisdiction is known; the customer has no configuration for it | All that exist |
| `jurisdictionNotMatched` | The bet's jurisdiction is known but matched no configuration and no known context | All that exist |
| `jurisdictionUnknown` | The bet did not report a jurisdiction | All that exist |
| `jurisdictionMatchNotAttempted` | The configurations could not be RETRIEVED, so no matching was performed | None — the hop failed |

In **every** non-`matched` case the result returns all configurations that do exist and
**MUST NOT** assert that default settings applied (FR-018), **nor infer that the applied
figures came from defaults** — that a bet matched no configuration is not evidence about
where its figures came from.

Rows 2 and 3 look similar and are deliberately distinct: row 2 is a **fact about the
customer**, row 3 is a **failure of our matching**. Folding them would make a systematic
matching defect indistinguishable from a fact — and the defect would then be unobservable.
Ontario (`urn:i:FD:CA-ON` vs a context observed as `NXTCANBS`) is the known row-3 case.

**Row 5 was added on 2026-09-09**, after a live run in which CRS returned `400` for every
call. Matching ran anyway against an empty configuration list — which can only ever answer
"nothing matched" — so the tool reported row 3, a claim that *our matching failed on a
jurisdiction we knew*, when the truth was *we never had anything to match against*. The
agent then told the user the figures "come from defaults", the one inference this section
forbids; it was not being careless, since nothing distinguished a matching failure from
absent inputs, and a matching failure genuinely does suggest the bet fell through to
something. Row 5 is checked **first**, before the bet's own jurisdiction, because with no
configurations every other answer is an artefact of an empty list rather than a finding.

This is the same rule as `notResolvedIdentifierUnusable` on a leg (§7), one level up:
**logic that FAILED must stay separate from logic that never RAN.**

A jurisdiction may also be stated by context **NAME** (live: a bet reporting `INTBS1`
against `{ contextCode: 'NJ1', contextName: 'INTBS1' }`). Names resolve only through the
platform context list, tried after id and code, and only when exactly one context bears the
name — the live list contains two contexts sharing an id, so ambiguity is demonstrated, and
on a tie the outcome stays row 3 rather than attributing a bet to the wrong jurisdiction.

With R7's context lookup available, matching proceeds: exact match against the customer's
own configurations → match against the fetched platform context list → US-state derivation
→ `jurisdictionNotMatched`. Each step is deterministic and testable.

**A result whose sources all answered fully is `complete: true` even when the jurisdiction is
unresolved.** Marking it incomplete would train the agent to caveat data that is in fact
whole, devaluing every genuine caveat.

---

## 9. Agreement verdict

FR-020's three-valued comparison. `notComparable` is the **default**.

```ts
interface AgreementVerdict {
  readonly field: 'stakeFactor' | 'liabilityGroup';
  readonly verdict: 'consistent' | 'differs' | 'notComparable';
  readonly configuredValue: string | number | null;
  readonly appliedValue: string | number | null;
  readonly reason: string | null;   // present iff notComparable
}
```

`notComparable` is emitted whenever **any** of these holds — a whitelist of comparability,
not a blacklist of problems:

- the governing configuration is unresolved (section 8 is not `matched`)
- either value is absent
- the bet has more than one leg and the applied value is bet-level (FR-021)

Both values are **always** present in the payload, even when `notComparable`, so an operator
can see what was compared and judge for themselves. This is the guard that makes R14's
unverified liability-group assumption safe: a description-vs-code mismatch reports `differs`
with both strings visible, rather than being silently wrong.

---

## 10. Betting metrics

Shaped by the caller's chosen aggregation, which the caller **must** supply (FR-014).

| Field | Type | Notes |
|---|---|---|
| `aggregation` | `'BET_TYPE' \| 'HIERARCHY_ENTITY' \| 'TIMEFRAME'` | Echoed back, so the answer states its own shape |
| `lifetime` | `MetricsFigures \| null` | Unfiltered lifetime totals |
| `filteredTotal` | `MetricsFigures \| null` | Totals for the filtered set |
| `groups` | `MetricsGroup[]` | One per aggregation bucket |

`MetricsGroup` is `{ key, keyKind, figures }` where `keyKind` is `betType` | `hierarchyEntity`
| `period` — a discriminated shape rather than three sibling optional fields, so the model
cannot read a bet type as a period.

`MetricsFigures` is a **curated subset** of the ~40 upstream measures. The upstream response
is a flat bag of every metric the data API computes; a tool schema of 40 numbers is a schema
a model cannot use. The projection keeps the commercial and behavioural core:
`betCount`, `grossStake`, `settledStake`, `averageStake`, `tradingRevenue`, `tradingMargin`,
`expectedMargins`, `inPlayStake`, `averageLegsPerBet`, `averageLegPrice`, `distinctEvents`,
`playerDays`, `nearLimitBet`, `firstBetDate`, `lastBetDate`.

Deliberately **excluded**: `vipManager` (a named person — Principle V), and the ~20 promo,
device-link, and internal-scoring measures, which are neither self-describing nor useful
without documentation the model does not have. Excluding them is a curation decision under
Principle IV; adding one later is additive.

---

## Configuration additions (`core/config.ts`)

Per Principle V every bound comes from deployment configuration and reaching one is reported.

| Variable | Default | Purpose |
|---|---|---|
| `CUSTOMER_MAX_BETS` | `20` | FR-010's bet cap |
| `CUSTOMER_MAX_EVENT_RESOLUTIONS` | `10` | FR-023's per-bet catalogue-resolution bound |

Both validate as positive integers through the existing `positiveIntFromString` helper, and
both are optional with a default — so **no existing deployment's startup breaks**, which the
fail-fast rule would otherwise cause.

There is **no** `CUSTOMER_JURISDICTIONS` default-scoping variable. Unlike the catalogue,
which fans out across brand instances by default, a customer call is scoped by the account
identifier alone; a default jurisdiction set would silently narrow an answer.
