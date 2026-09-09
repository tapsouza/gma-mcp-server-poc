# Phase 0 Research: Customer Risk & Bet Tools (FanDuel)

**Feature**: `004-customer-bet-tools` | **Date**: 2026-09-08 | **Plan**: [plan.md](./plan.md)

Every finding below was verified by reading source in `../gma-service`,
`../all-chef-fdg/sbv2_gmafd_chef`, and the two front-ends that already consume these
surfaces (`../gbpbmui-tool`, `../gbpcrsui-tool`). Where a fact could not be established from
source it is marked **UNVERIFIED** and carries an owner and a removal condition, as
constitution Principle IV requires for a load-bearing assumption.

The spec's three UNVERIFIED assumptions are revisited here: **two are now resolved** (R6, R7)
and **one is confirmed unverifiable from source** (R8).

---

## R1 — The three upstream surfaces behave differently from each other, and from v5

**Decision**: Treat CRS, QBS, and the metrics API as **three distinct completeness
contracts**, mapped in one place (`core/completeness.ts`) onto the single surface-independent
`Completeness` vocabulary. Do **not** generalise them into one parser.

**Rationale**: verified per surface.

| Surface | Partial-failure signal | Evidence |
|---|---|---|
| v5 catalogue | HTTP `206` + `successfulConfigSources`/`failedConfigSources` | `api_catalogue.yaml`; already implemented |
| `GET /crs/accounts/{accountId}` | **none** — no declared contract at all | `CrsHttpRequestsController` is `@RequestMapping("/crs")` + `@RequestMapping("/**")`, a raw forwarding proxy; the path appears in **no** OpenAPI spec |
| `POST /qbs/graphql` | HTTP **`200`** carrying GraphQL `errors[]` with requested fields unpopulated | `BetSearchClient.java:53-58` logs a warning and **returns the partial result** |
| `POST /accounts/{accountId}/metrics` | none; declares only `200`/`400`/`401`/`500` | `customer-metrics.yaml`, `post:` block |

The QBS case is the dangerous one and is why constitution v1.1.0 added the
success-carrying-errors mapping row. GMA's own client treats a `200` with `errors[]` as
usable data; a tool that trusted the status line would present a half-populated bet as
complete. `gbpbmui-tool/src/api/fetcher.ts:78-88` confirms the front-end sees the same shape:
it explicitly comments *"If error is found, response will still be 200 OK"* and still returns
`data`.

**Alternatives considered**:
- *One generic envelope parser.* Rejected: there is no envelope to parse on two of three
  surfaces. A parser looking for fields that do not exist would silently return "complete".
- *Treat any QBS `errors[]` as a tool error.* Rejected: it discards usable data the operator
  asked for, and contradicts Principle II's mapping row (result + caveat, `complete: false`).

---

## R2 — CRS publishes no partial-failure signal, so the composite needs the second axis

**Decision**: `get_customer_risk_profile` reports either a **complete** answer or a
**tool error** — never a synthesised partial verdict. Inside `get_bet_risk_context`, a CRS
failure is reported through `unavailableComponents: ['customerRiskConfiguration']`, and the
result is `complete: false`.

**Rationale**: `/crs/**` is a catch-all proxy (`CrsHttpRequestsController:95`,
`@RequestMapping("/**")`). `GET /crs/accounts/{accountId}` is intercepted at line 213 for
enrichment, but declares no statuses anywhere — so completeness **cannot** be derived from a
declared contract. Constitution Principle II: *"Where a surface publishes no
partial-failure signal at all … a tool MUST NOT invent one."*

This is precisely why the amendment's second axis exists. A bet's applied stake factor
returned **without** the configured settings it should be compared against is a
plausible-looking half answer: every source that was consulted answered, so a one-axis
verdict would call it complete.

**Alternatives considered**:
- *Report the CRS failure as a `failedInstance`.* Rejected, and explicitly forbidden by
  Principle II: it tells the agent to retry with narrower scoping, a correction that cannot
  work, so the agent retries indefinitely.

---

## R3 — GMA already resolves override names; a tool must not redo it

**Decision**: `get_customer_risk_profile` is **one hop**. It makes no catalogue calls.

**Rationale**: `CustomerRiskCatalogEnrichmentService.enrichAccountHierarchyGroups` fills each
`AccountContextHierarchyGroup.metadata.entities` with the full named ancestor chain —
verified per level in `createHierarchyGroupMetadataEntities`:

| `entityType` | Ancestors GMA fills in |
|---|---|
| `SUPERCLASS` | itself |
| `SUBCLASS` | itself + superclass |
| `EVENT_TYPE` | itself + subclass + superclass |
| `MARKET_TYPE` | itself + eventType + subclass + superclass |

It is skipped when metadata is already present (`metadataIsPresent`, line 83), and it is
wired into **both** intercepted paths (`:223`, `:244`). FR-007 is therefore satisfied by
projecting `metadata.entities`, and Principle IV's rule against duplicating GMA's resolution
binds directly.

**Alternatives considered**:
- *Resolve override names via the catalogue domain's own calls.* Rejected: N extra hops for
  data already in the response, and it would need a `domain → domain` import, which the
  lint rule blocks.

---

## R4 — Read-only by construction: the fixed-document design

**Decision**: The GraphQL document is a **string constant in this repository**
(`domains/customer/gql/searchBets.ts`). The tool accepts only typed filter values, which are
placed in `variables`. `core/gmaClient.ts` gains **no** new generality: the `path` argument
stays a literal in the domain, and a new automated assertion proves no caller value reaches
a query or a path.

**Rationale**: `POST /qbs/{pathToQbs}` takes both the path and the query from the caller
(`QbsHttpRequestsController:82-85`), and `/crs/**` takes the whole path. Both would accept a
mutation: QBS's own schema declares `deleteBetNote`, and CRS accepts `PUT
/crs/accounts/{id}/riskSettings`. Constitution Principle IV therefore requires the guard to
be structural, and explicitly says *"the request mechanics MUST NOT be relied on as the
guard"* — every read here is a POST, exactly as a write would be.

Two facts fix the concrete values:

- The path is `/qbs/graphql` — confirmed in `@flutter-global/gma-client`
  (`gqlBetManagement`: `endpoint = '/qbs/graphql'`) and by `grep -o "/qbs/[a-z]*"` over its
  dist bundle, which yields only `/qbs/graphql` and `/qbs/export`.
- `operationName` and `variables` accompany `query` in the body
  (`QbsRequest(String query, String operationName, Map<String, Object> variables)`).

**Alternatives considered**:
- *Accept an allowlisted operation name.* Rejected: an operation name is still a
  caller-supplied value reaching a query selector, and Principle IV names "operation name"
  among the forbidden inputs.
- *Use GMA's named document (`documentName("searchBets")`).* Rejected: `documentName` is
  GMA-internal (`BetSearchClient`), not reachable through the proxy, which forwards a raw
  `query` string.

---

## R5 — The leg → risk-override join requires an event hop, and the vocabularies differ

**Decision**: For each **distinct** event across a bet's legs, call
`GET /v5/events/{id}` to obtain `superclassId/Name`, `subclassId/Name`,
`eventTypeId/Name`. Match overrides against that path. Bound the number of event
resolutions by configuration; deduplicate before fan-out.

**Rationale**: The two trees do not meet without this hop.

| Side | Levels | Source |
|---|---|---|
| Risk overrides | `SUPERCLASS`, `SUBCLASS`, `EVENT_TYPE`, `MARKET_TYPE` | `HierarchyEntityType`; `HierarchyLevel` enum in `customer-metrics.yaml` |
| Bet legs | `sport`, `competition`, `event`, `market`, `selection` | QBS `Leg` type, each a `CatalogEntity` |

A leg carries **no** risk-side level. `GET /v5/events/{id}` returns exactly the missing
three (`Event` schema, `api_catalogue.yaml:4953-4982`, all three id/name pairs `required`),
and declares `200/206/400/401/404/500` — so it is completeness-bearing and already handled by
the existing client.

**The identifier form is a real gap.** A leg's `event.entityIds` carries
`{sportexId, rampId, openbetId, gbpId}`; `GET /v5/events/{id}` wants
`urn:sbk:pc:e:gpd:{n}`. `gbpbmui-tool` bridges this by prefixing the **`rampId`**
(`linkManager.ts:51` reads `event.entityIds.rampId`, line 88 prefixes
`URN_PREFIXES.EVENT = 'urn:sbk:pc:e:gpd:'`). That is the only observed bridge, and it is
recorded as **UNVERIFIED** below (R9).

**Alternatives considered**:
- *Match on names.* Rejected: names are not identifiers, and `|Football Matches|` style
  delimiters in catalogue names make it worse than fragile.
- *Resolve per leg.* Rejected: FR-023 and SC-013 require distinct positions resolved once.

---

## R6 — RESOLVED: upstream bet ordering IS controllable (spec assumption 1 retired)

**Decision**: Request `params.sort = { field: PLACEMENT_DATE, order: DESC }` explicitly. The
result is genuinely most-recent-first within the requested page, so FR-010's caveat narrows
from *"ordering is unknown"* to the still-true *"this is the first page, not necessarily the
global maximum"*.

**Rationale**: the spec assumed *"Nothing in the upstream interface exposes a sort option"*.
That is **false**, and the removal condition it named ("find a sort option") is met:

- `input RequestParameters { pageNumber: Int!, itemsPerPage: Int!, sort: Sort }`
  (`gbpbmui-tool/src/api/schema.ts:60-69`).
- `enum SortField { PLACEMENT_DATE, SETTLEMENT_DATE, STAKE, … }`,
  `enum SortOrder { ASC, DESC }` (same file, `:1377-1395`).
- The bet-management front-end's own default is exactly this:
  `DEFAULT_SORT = { field: SortField.PLACEMENT_DATE, order: SortOrder.DESC }`
  (`src/constants/paginationV2.ts:24`).

Note the schema GMA *packages* (`graphql-documents/qbs/schema.graphql`) declares
`RequestParameters` **without** `sort` — it is a trimmed local copy used for GMA's own
`searchByAccountId`. The QBS service accepts `sort`, which is why the front-end sends it. The
tool therefore sends `sort` and keeps the post-retrieval sort as a **belt-and-braces**
safeguard rather than as the primary mechanism.

**Owner/removal**: closed. No follow-up.

---

## R7 — RESOLVED: a jurisdiction-context lookup exists (spec assumption 3 partly retired)

**Decision**: Add a fifth tool, `list_jurisdiction_contexts`, on `GET /crs/contexts`. This
is the customer domain's analogue of `list_instances`, and it is what lets the metrics tool
keep FR-013's jurisdiction filter without the agent guessing codes.

**Rationale**: Principle V requires *"A discovery tool MUST exist for any scoping vocabulary
an agent is expected to supply"*. The codes are unguessable: `NJ`, `PA`, `CO`, `MA` are
observed in `gbpcrsui-tool/src/constants/mocks.ts`, but the constitution records `NXTCANBS`
for Ontario — no derivation covers both.

`GET /crs/contexts` returns `ContextEntity { contextName, contextId, contextCode }`
(`@flutter-global/gma-client`: `fetchCrsContexts` → `${url}/crs/contexts`, typed in
`endpoints/account/types.d.ts:350`). `contextCode` is exactly the value FR-018's derivation
was trying to guess, which also **downgrades** the matching problem: match on the fetched
list first, fall back to derivation, and report which happened (FR-018's four outcomes stay,
with far fewer results landing in the "could not be matched" bucket).

**This required a MINOR constitution amendment** adding `GET /crs/contexts` to the customer
row of the surface register (Principle IV: *"a tool MUST NOT call an operation absent from
it"*). **Landed 2026-09-08 as v1.2.0**, which additionally makes the context list the *primary*
matching mechanism and **prohibits** a hardcoded jurisdiction table — it would fail confidently
as jurisdictions are added.

**Alternatives considered**:
- *Drop the jurisdiction filter from metrics.* Rejected: FR-013 asks for it, and it is one of
  the filters a risk manager most obviously wants.
- *Learn contexts from `get_customer_risk_profile`.* Rejected as the sole mechanism: it only
  reveals jurisdictions this customer **already has settings in**, so an agent could never
  name a jurisdiction to check whether the customer bets there unconfigured — the exact case
  FR-018's second outcome exists for.

---

## R8 — UNVERIFIED (confirmed unverifiable from source): are unconfigured jurisdictions omitted?

**Status**: The spec's third UNVERIFIED assumption **stands**. It cannot be resolved by
reading source, which is itself a finding.

**What was checked**: `AccountRiskSettings.contexts` is a plain
`List<AccountContextRiskSettings>` with no completeness marker
(`AccountRiskSettings.java`); GMA neither filters nor annotates it — the enrichment service
passes every context through (`.map(context -> …).toList()`, no filter). Whether CRS itself
omits a default-only jurisdiction is a **CRS** behaviour, and CRS is a separate service
(`crs.base.url`) whose source is not in this workspace.

**Mitigation**: FR-018's second outcome states the fact ("no configuration exists for the
bet's jurisdiction") and refuses to conclude "defaults applied". With R7 in place, the tool
can additionally say whether the jurisdiction **exists in the platform's context list** —
which distinguishes *"a real jurisdiction this customer has no row for"* from *"a
jurisdiction code we do not recognise"* without asserting what absence means.

**Removal condition**: confirm with the owner of the customer-risk system. If omission is
confirmed, FR-018's second outcome may then assert defaults.
**Owner**: feature implementer — a human conversation, not a code change.

---

## R9 — UNVERIFIED (new): which leg identifier maps to a v5 event URN

**Status**: **NEW** UNVERIFIED assumption, introduced by R5. Recorded here because R5's
mandatory hop cannot be built without it.

**Assumption**: `leg.event.entityIds.rampId`, prefixed with `urn:sbk:pc:e:gpd:`, is the v5
event identifier.

**Evidence**: `gbpbmui-tool/src/utils/linkManager.ts:51` + `:88`, which is a production
front-end doing exactly this join to deep-link from a bet leg into the product catalogue.
It applies the same pattern for market, eventType (from `competition`!), subclass (from
`sport`), and selection — note the front-end maps `competition → EVENT_TYPE` and
`sport → SUBCLASS`, which corroborates R5's claim that the trees are offset rather than
aligned.

**Why it is not verified**: `entityIds` has four members and no schema comment says which is
the GBP one. `gbpId` is the more suggestive name, but the front-end uses `rampId`, and no
source in this workspace reconciles the two.

**Mitigation** (Principle IV requires the tool to state an unverified load-bearing
assumption in its result): a leg whose event fails to resolve is reported as a **named
unresolved leg** with the result marked incomplete, never as "no overrides apply" —
so a wrong identifier choice produces a visible gap, not a confidently-wrong "unrestricted".
Try `rampId` first and `gbpId` as a fallback before declaring the leg unresolved; report
which succeeded in a diagnostic field (a level, not an identifier — no PII).

**Removal condition**: confirm which `entityIds` member is the GBP catalogue identifier, or
observe one real bet leg resolving against `GET /v5/events/{id}`.
**Owner**: feature implementer, before release.

---

## R10 — `403` is reachable but inert by default; map it anyway

**Decision**: Map HTTP `403` to `ToolError { kind: 'forbidden', retryable: false }` in
`core/errors.ts`, and cover it with a fixture and a test for the QBS-backed tools.

**Rationale**: `QbsHttpRequestsController:94-97` returns `403` when
`customBetPermissionsEnabled && !hasPermission(query)`. Verified state of that flag:

- packaged default `spring.controller.qbs.custom.authorization.enabled=false`
  (`application.properties:142`)
- explicitly `false` in **all three** deployed environments
  (`attributes/{dev,stg,prd}.rb:46`)
- enforced operations are `createBetNote, deleteBetNote, pinBetNote, unpinBetNote`
  (`:143`) — **no** read operation, so even with the flag on, `searchBets` is not gated

So the `403` path is **not reachable today** for this feature's reads. It is mapped
regardless, because constitution Principle I requires it and because a flag flip or an
added enforced operation must not turn a distinct outcome into a retry loop. `403` is also
reachable via `@PreAuthorize` when GAHS is enabled — which is off everywhere
(`MethodSecurityConfig` is `@ConditionalOnProperty(havingValue = "true")`, and
`gahs.authorization.enabled` is unset in Chef, default `false`).

**Alternatives considered**:
- *Skip the `403` mapping as unreachable.* Rejected: unreachable-today is not unreachable,
  and `fromHttpStatus` currently maps `403` to `upstream`/**retryable: true**
  (`test/unit/errors.test.ts:32`) — a live retry loop the moment the flag flips.

---

## R11 — Both intercepted CRS paths and the metrics API are behind live flags

**Decision**: No new configuration for enablement; the tools simply call the paths. A `404`
or `500` from a disabled controller maps through the existing error table.

**Rationale**: `spring.controller.crs.enabled` and `spring.controller.qbs.enabled` are both
packaged `false` (`application.properties:90`, `:135`) but `default_unless … = true` in
`attributes/common.rb:72` and `:86`, unoverridden — so both are **on** in every deployed
environment, exactly as `okta.auth.enabled` is. `spring.controller.qbs.multiple.instances.enabled`
is `false` and set nowhere in Chef, so the `?instance=` query parameter is **not required**
and MUST NOT be sent: `QbsProxyService:39-47` returns `400` for a null instance only when
multi-instance is enabled.

Note `accountSystem` is an optional CRS routing parameter
(`CrsHttpRequestsController:99-102`, `RoutingCriteria.extractEndpointFromRequest`). It is
**not** a jurisdiction and **not** in scope: omitting it routes to the default `crs.base.url`,
which is FanDuel's, and FR-003 forbids a brand argument.

---

## R12 — Use the `POST` metrics variant; the `GET` is deprecated

**Decision**: `POST /accounts/{accountId}/metrics` with the filter set in the body.

**Rationale**: `customer-metrics.yaml` marks the `GET` variant `deprecated: true` with
*"use `POST /accounts/{accountId}/metrics` … instead"*. Constitution Principle IV and
FR-015 both forbid building on a deprecated operation where a current variant exists.

The `POST` body is fully specified and `aggregationMode` is the **only** required field —
which is exactly FR-014's requirement that the caller supply it and the system never default
it. The vocabulary is closed and small, so it maps cleanly to LLM-facing enums:

| Field | Values |
|---|---|
| `aggregationMode` (required) | `BET_TYPE`, `HIERARCHY_ENTITY`, `TIMEFRAME` |
| `period` | `_24_HOURS`, `LAST_WEEK`, `_1_MONTH`, `_3_MONTHS`, `_6_MONTHS`, `_1_YEAR`, `LIFETIME` |
| `betTypes` | `SINGLE`, `PARLAY`, `SGP`, `SGP_PLUS`, `TEASER` |
| `status` | `PRE_MATCH`, `IN_PLAY` |
| `contexts` | jurisdiction codes — see R7 |
| `hierarchyEntity` | `{ SUPERCLASS[], SUBCLASS[], EVENTTYPE[] }` |

The `400` body is a `oneOf` over three named error shapes with explicit `errorCode` enums
(`MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE`, `ACCOUNT_IDENTIFIER_MISSING`,
`TOO_MANY_HIERARCHY_ENTITIES`, plus a data-API failure shape). FR-014/SC-008 want the agent
to self-correct, so these codes are translated into argument-error **hints** — but the
upstream `message` field is never interpolated, since it can echo the account identifier
(Principle V, and `errors.ts`'s existing `safeUpstreamDetail` allowlist rule).

**Note the `EVENTTYPE` inconsistency**: the `POST` body spells it `EVENTTYPE` while the
deprecated `GET` and the `HierarchyLevel` enum spell it `EVENT_TYPE`. The tool's LLM-facing
enum uses `EVENT_TYPE` throughout and translates at the client boundary — the same treatment
`configSource → instance` already receives.

---

## R13 — Privacy: the account identifier is in the path, so logging must change shape

**Decision**: `core/gmaClient.ts` must log a **path template**, never the interpolated path.
The existing `path` log field is currently passed the real path — which is safe for the
catalogue (`/v5/superclasses/{urn}`) but is a **PII leak** for
`/crs/accounts/{accountId}`. Add a required `pathTemplate` on the call options and log that;
never log `path` for a customer-domain call.

**Rationale**: constitution Principle V, added in v1.1.0: *"Where such an identifier appears
in a request path, the logged operation MUST be the path template, never the interpolated
path."* The existing allowlist (`telemetry.ts`) admits `path` and `operation`, and
`gmaClient.ts:131-139, 160-166, 190-201` passes the real `path` and an `operation` built by
`operationLabel(method, path)` — both would carry the account id.

This is the one change this feature makes to an existing `core` file's behaviour, and it is
**additive for the catalogue**: passing a template equal to the path leaves catalogue log
lines byte-identical, which is what keeps the amendment-acceptance gate (existing tests pass
**unmodified**) satisfiable.

Also note GMA itself logs the full CRS URL and body at `INFO`
(`CrsHttpRequestsController:128-134`). That is GMA's exposure, not ours, and Principle I
forbids compensating for upstream behaviour — but it is worth recording that this feature's
privacy guarantee covers **this server's** logs only.

---

## R14 — The applied liability group is a description-shaped string (spec assumption 2)

**Status**: **UNVERIFIED**, unchanged from the spec, but now with schema evidence on both
sides.

**Assumption**: QBS `riskInfo.liabilityGroup: String` corresponds to CRS
`LiabilityGroup.description`, not `.code`.

**Evidence**: QBS types it as a bare `String` with the comment `""" liability group """`
(`schema.graphql`), while CRS returns a structured
`LiabilityGroup { code, description, interceptValue, displayOrder, colour }`
(`LiabilityGroup.java`). Nothing in either declares which member the string is.

**Mitigation**: FR-020's verdict is three-valued. The comparison tries `description` first,
then `code`, and reports `differs` **with both values present** when neither matches — so an
unexpected shape is visible rather than silently wrong. `notComparable` remains the default.

**Removal condition**: confirm which field the applied value corresponds to.
**Owner**: feature implementer, before release.

---

## R15 — Fixture provenance for surfaces with no declared contract

**Decision**: Extend `test/fixtures/gma/` with `crsAccounts/`, `qbsSearchBets/`,
`customerMetrics/`, and `crsContexts/`. Each fixture records its provenance in
`test/fixtures/README.md`; for CRS, provenance is **the Java model classes**, not an
OpenAPI schema.

**Rationale**: the constitution requires a hand-crafted fixture to record that it was
hand-crafted, and *"for a surface with no declared contract at all it MUST record what it was
derived from"*. For `/crs/accounts/{accountId}` the derivation is
`AccountRiskSettings` → `AccountContextRiskSettings` → `AccountContextHierarchyGroup` →
`HierarchyGroupMetadata` → `HierarchyGroupMetadataEntity`, plus `LiabilityGroup` and
`EligibilityProfile` — read directly and reproduced field-for-field.

The mandatory fixture per the constitution is the **success-carrying-errors** QBS response:
*"the single most important one on that surface."*

**Alternatives considered**:
- *Reuse the front-ends' mock data.* Rejected as a source of truth: `gbpcrsui-tool`'s mocks
  are illustrative and contain customer-shaped values. Fixtures here carry **no** personal
  datum, per the existing library's standing rule.

---

## Summary of what changed relative to the spec

| Spec assumption | Outcome |
|---|---|
| UNVERIFIED — upstream bet ordering | **Resolved** (R6). A sort option exists and is used. |
| UNVERIFIED — applied liability group | **Still unverified** (R14), now with schema evidence both sides. |
| UNVERIFIED — unconfigured jurisdictions omitted | **Still unverified** (R8), confirmed unverifiable from this workspace. |
| — | **New** UNVERIFIED (R9): which leg `entityIds` member is the v5 event id. |
| FR-001 "exactly four" capabilities | **Five** (R7): a jurisdiction-context discovery tool is required by Principle V. Constitution amended to v1.2.0 to permit it. |
