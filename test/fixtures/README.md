# GMA fixture library

The constitution (v1.0.2, _Development Workflow & Quality Gates_) makes this library
**blocking**: a fixture must exist for every distinguishable upstream outcome, for every GMA
operation a tool depends on, and a hand-crafted fixture must record that it was hand-crafted.

## Provenance

**Every fixture in this directory is hand-crafted from the OpenAPI schema, not captured from a
live GMA.** None has been observed against a running instance.

- **Source of truth**: `gma-api/src/main/resources/static/api_catalogue.yaml` (the v5 catalogue
  surface), as analysed in [research.md](../../specs/001-catalogue-mcp-tools/research.md) R1 and R3.
- **Why hand-crafted**: partial failure (`206`) and transport timeouts cannot be provoked on
  demand against a live BFF, and live GMA access is a manual pre-release step that is never part
  of CI. Constitution: _"Hand-crafting a fixture from the OpenAPI schema is acceptable when the
  real response cannot be captured; the fixture MUST record that it was hand-crafted."_
- **Consequence to keep in mind**: these fixtures are faithful to the _schema_, so they prove the
  client parses the declared contract correctly. They cannot prove GMA's runtime behaviour matches
  its own schema. That gap is closed by the manual live validation in
  [quickstart.md](../../specs/001-catalogue-mcp-tools/quickstart.md) Validation 3, not here.
- Entity names (`Football`, `Premier League`, `Winner`) and instance codes (`PP`, `BF`) are
  illustrative. No real host, credential, or personal datum appears anywhere in this library.

### Provenance of the customer-domain fixtures (feature 004)

The four customer surfaces do **not** share the catalogue's provenance, and the difference is
recorded here because a reader would otherwise assume an OpenAPI source that does not exist.

| Directory          | Operation                            | Derived from                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crsAccounts/`     | `GET /crs/accounts/{accountId}`      | **The Java model classes**, read field-for-field — `AccountRiskSettings` → `AccountContextRiskSettings` → `AccountContextHierarchyGroup` → `HierarchyGroupMetadata` → `HierarchyGroupMetadataEntity`, plus `LiabilityGroup` and `EligibilityProfile`. This path appears in **no** OpenAPI spec (research.md R15) |
| `crsContexts/`     | `GET /crs/contexts`                  | `ContextEntity { contextName, contextId, contextCode }`, typed in `@flutter-global/gma-client` `endpoints/account/types.d.ts` (research.md R7)                                                                                                                                                                   |
| `qbsSearchBets/`   | `POST /qbs/graphql`                  | QBS `schema.graphql` (the `Bet`, `Leg`, `RiskInfo`, `WageInfo` types) plus the observed `200`-with-`errors[]` shape (`BetSearchClient.java:52`, research.md R1)                                                                                                                                                  |
| `customerMetrics/` | `POST /accounts/{accountId}/metrics` | `customer-metrics.yaml`, the `post:` block and its `oneOf` `400` shapes (research.md R12)                                                                                                                                                                                                                        |
| `events/`          | `GET /v5/events/{id}`                | `api_catalogue.yaml`, the `Event` schema. **Separate from `entities/`**: those are `eventType` documents from a different path and cover a different operation (research.md R5)                                                                                                                                  |

**Why `events/` is not covered by `entities/`.** The composite resolves each leg's event to
obtain its risk-side catalogue position, and `GET /v5/events/{id}` returns an `Event` carrying
`superclassId/Name`, `subclassId/Name` and `eventTypeId/Name` — three id/name pairs no existing
fixture holds. The existing `entities/` fixtures are `eventType` documents; using one here would
assert a response shape this operation does not return.

**No customer datum, anywhere.** Account, bet, and receipt identifiers in these fixtures are
obviously synthetic, no fixture carries a customer name, and monetary values are illustrative
round numbers. This is the same standing rule the catalogue fixtures follow, restated because
this surface is where breaking it would matter (Principle V).

## Outcome coverage

Fixtures are keyed by **HTTP status**, not by a `status.code` envelope: the v5 catalogue surface
has no such envelope (research.md R1). A `status.code` fixture set would be fiction.

### `instances/` — `GET /v5/instances`

| Fixture                 | Outcome                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `200-success.json`      | all config sources answered                                    |
| `206-partial.json`      | one config source failed, with a per-instance `errors[]` entry |
| `400-bad-request.json`  | malformed argument → agent self-corrects                       |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates           |
| `500-server-error.json` | nothing usable                                                 |

### `searchByName/` — `POST /v5/searchByName`

This operation declares only `200 / 400 / 401 / 500` — **notably not `206`** (research.md R2).
There is deliberately no `206` fixture here; adding one would assert a response GMA does not
declare.

| Fixture                 | Outcome                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `200-single-match.json` | exactly one match → resolve and traverse one level                                                       |
| `200-multi-match.json`  | three matches all named "Winner", distinguished only by their ancestor path — the case FR-014 exists for |
| `200-no-match.json`     | zero matches → `kind: 'none'`, which is not an error                                                     |
| `200-many-matches.json` | 40 matches, above the default `GMA_MAX_CANDIDATES` of 25 → drives the client-derived too-broad path      |
| `400-bad-request.json`  | blank `name` rejected upstream                                                                           |
| `401-unauthorized.json` | identity invalid or expired                                                                              |
| `500-server-error.json` | nothing usable                                                                                           |

### `entities/` — `GET /v5/{superclasses,subclasses,eventTypes}/{id}` and `GET /v5/subclasses/{id}/eventTypes`

| Fixture                        | Outcome                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`             | a subclass with its parent superclass inline                                                                            |
| `200-superclass.json`          | a superclass with its subclasses inline (children of a matched superclass)                                              |
| `200-eventType.json`           | an event type with its full ancestor chain                                                                              |
| `200-eventTypes-children.json` | `GET /v5/subclasses/{id}/eventTypes` — the second hop for a matched subclass                                            |
| `206-partial.json`             | second-hop partial failure, so a `206` on hop 2 alone can be shown to mark the whole result incomplete (FR-008, SC-011) |
| `206-partial-entity.json`      | single-entity retrieval with a failed config source                                                                     |
| `404-not-found.json`           | unknown identifier → `kind: 'notFound'`                                                                                 |
| `401-unauthorized.json`        | identity invalid or expired                                                                                             |
| `500-server-error.json`        | nothing usable                                                                                                          |

### `crsAccounts/` — `GET /crs/accounts/{accountId}`

Derived from the **Java model classes** (see the provenance table above), cross-checked against
`@flutter-global/gma-client`'s `AccountRiskSettings` / `Context` / `HierarchyGroup` /
`LiabilityGroup` types. This path appears in no OpenAPI spec.

Note the `path` field in the error fixtures carries the **template**, not an interpolated
identifier — the standing rule that no fixture holds a customer datum applies to error bodies too.

| Fixture                        | Outcome                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200-three-jurisdictions.json` | three jurisdictions with **deliberately different** settings (0.5 / 1.0 / 2.0 stake factors, RESTRICTED / STANDARD / UNRESTRICTED), one override per level with its full ancestor chain — built so that any merge, average, or collapse is visible (FR-006, SC-003). Also carries `customerNotes` and a `nickname` with staff names, so their exclusion is provable |
| `200-override-empty-path.json` | an override whose `metadata.entities` is `[]` — `createHierarchyGroupMetadataEntities` returns `List.of()` when the id matches nothing in the catalogue                                                                                                                                                                                                             |
| `200-nulls.json`               | every boxed scalar absent, to prove `null ≠ 0`                                                                                                                                                                                                                                                                                                                      |
| `401-unauthorized.json`        | identity invalid or expired → human re-authenticates                                                                                                                                                                                                                                                                                                                |
| `403-forbidden.json`           | identity valid, permission absent → `forbidden`, NOT retryable                                                                                                                                                                                                                                                                                                      |
| `404-not-found.json`           | unknown account → `notFound`, never an empty success with fabricated defaults                                                                                                                                                                                                                                                                                       |
| `500-server-error.json`        | nothing usable                                                                                                                                                                                                                                                                                                                                                      |

There is deliberately **no `206`**: CRS publishes no partial-failure contract at all
(research.md R2), and a `206` fixture would assert a response this surface never sends.

### `qbsSearchBets/` — `POST /qbs/graphql` (the fixed `searchBets` document)

Derived from `qbs-graphql-schema/graphql/schema.graphqls` — the `Bet`, `Leg`, `RiskInfo`,
`WageInfo`, `Ids`, `CatalogEntity`, `EntityIds` and `PageInfo` types — plus the observed
`200`-with-`errors[]` shape (`BetSearchClient.java:52`).

Reading that schema confirmed three facts this feature depends on:

- **`sort` exists** on `input RequestParameters`, with `enum SortField { PLACEMENT_DATE, … }`,
  which retires one of the spec's UNVERIFIED assumptions (research.md R6).
- **Mutations exist** — `createBetNote`, `deleteBetNote`, `pinBetNote`, `unpinBetNote` — which is
  why FR-024's read-only guard has to be structural rather than inferred from the request verb.
- **The four `searchBy*` queries are `@deprecated`** in favour of `searchBets`, so FR-015 requires
  the current one.

| Fixture                            | Outcome                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`200-success-with-errors.json`** | **THE MANDATORY ONE.** HTTP `200` carrying GraphQL `errors[]` at `results[0].riskInfo` and `results[0].legs`, with both fields left `null` while `numberOfLines.total` survives as 3 — so reporting `legCount: 0` would be a distinguishable second defect. The constitution calls this "the single most important" fixture on this surface |
| `200-single-bet.json`              | one fully-populated single-leg bet                                                                                                                                                                                                                                                                                                          |
| `200-multi-leg-bet.json`           | three legs where **legs 1 and 3 share one event**, so distinct-event dedupe is provable (SC-013)                                                                                                                                                                                                                                            |
| `200-multiple-matches.json`        | two bets for one receipt identifier → all candidates, zero further resolution work (FR-022)                                                                                                                                                                                                                                                 |
| `200-openbet-bet.json`             | an **OpenBet-stack** bet (`isOb: true`, numeric `betId`) whose leg carries a namespaced `gbpId` exactly as the live one does. Paired with `events/400-bad-request.json`: the hop IS attempted, upstream refuses, and the leg reports `notResolvedUpstreamFailure`. The observed shape, replacing an earlier invented one — see below        |
| `200-no-match.json`                | zero matches → `kind: 'none'`, which is neither an error nor a caveat (FR-012)                                                                                                                                                                                                                                                              |
| `200-over-limit.json`              | 25 bets with `pageInfo.count: 137`, above the default cap of 20 → `limitReached: true`, never silent truncation (FR-010). Placement dates descend, so the post-retrieval sort is observable                                                                                                                                                 |
| `401-unauthorized.json`            | identity invalid or expired                                                                                                                                                                                                                                                                                                                 |
| `403-forbidden.json`               | permission absent → `forbidden`, NOT retryable (SC-009)                                                                                                                                                                                                                                                                                     |
| `500-server-error.json`            | nothing usable                                                                                                                                                                                                                                                                                                                              |

There is deliberately **no `206`**: this surface signals partial failure in a `200` **body**, not
in a status code, which is precisely what makes it dangerous and why the success-carrying-errors
fixture is mandatory instead.

**`200-openbet-bet.json` is a worked example of how a fixture goes wrong.** It was first authored
with legs carrying only a bare `rampId`, on the theory that OpenBet legs lack a `gbpId` — a shape
nobody had observed. It was then contradicted by live data on both counts: the leg carries
`gpd:14643022`, and the 400 that theory was built to explain also reaches the GMA UI, so it is
upstream's answer and not a symptom of our request. The rule the episode argues for: **a fixture
must state a shape someone has seen, and a fixture invented to explain a symptom will agree with
the code that invented it.** Both the fixture and its suite now assert the observed behaviour.

### `crsContexts/` — `GET /crs/contexts`

The response is a **bare JSON array** of `ContextEntity`, not an object with a `contexts` key —
verified against `@flutter-global/gma-client`, whose `fetchCrsContexts` is typed
`Promise<ContextEntity[]>`. Getting this wrong would have produced an always-empty jurisdiction
list that still reported `complete: true`.

| Fixture                 | Outcome                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`      | four jurisdictions, including Ontario's **`NXTCANBS`** — a code no derivation from a state name produces, and the concrete justification for `list_jurisdiction_contexts` |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates                                                                                                                      |
| `403-forbidden.json`    | identity valid, permission absent → `forbidden`, NOT retryable (SC-009)                                                                                                   |
| `500-server-error.json` | nothing usable → `upstream`, never an empty jurisdiction list                                                                                                             |

There is deliberately **no `206`** and no `400` fixture: `/crs/**` is a raw forwarding proxy that
declares no partial-failure contract at all (research.md R2), and this operation takes no
argument to malform.

### `events/` — `GET /v5/events/{id}`

The composite's fourth hop, and the operation whose fixtures nobody owned before this feature —
the gap the SC-011 audit exists to catch. Note the **`sources`** parameter: this operation
declares its instance scoping as `sources`, not `instancesList` (`api_catalogue.yaml`,
`getEventById` → `sourcesParam`), and a wrong name is silently ignored rather than rejected.

The three id/name pairs are chosen so the **FR-019 join is provable**: `3` / `7` / `3307` are the
same entities the `crsAccounts/` overrides name, stated here as URNs (`urn:sbk:pc:spc:gpd:3`) and
there bare (`"3"`), which is how the two systems really differ. A fixture that used one vocabulary
on both sides would have let a join that cannot work pass.

| Fixture                 | Outcome                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`      | an `Event` with all three required id/name pairs → the leg resolves and its overrides are in scope                                                                                                |
| `200-second-event.json` | a **different** event, so a multi-leg bet's distinct-event dedupe is observable as two calls rather than three (SC-013)                                                                           |
| `206-partial.json`      | **the one that matters most**: one instance answered, one failed → the WHOLE composite becomes `PARTIAL`, and the failure is a `failedInstance` (retry may help), never an `unavailableComponent` |
| `400-bad-request.json`  | a well-formed URN the catalogue cannot serve — the **live OpenBet-event answer**, which the GMA UI receives too → `argument`, NOT retryable, leg `notResolvedUpstreamFailure`                     |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates                                                                                                                                              |
| `404-not-found.json`    | no such event → the leg is a NAMED unresolved leg, never "no overrides apply"                                                                                                                     |
| `500-server-error.json` | nothing usable → the leg is unresolved and `legCataloguePositions` is reported missing                                                                                                            |

There is no `403` fixture: this is a v5 catalogue read, and the `403` path documented in
research.md R10 is specific to the QBS surface's bet-note operations.

### `customerMetrics/` — `POST /accounts/{accountId}/metrics`

The **`POST`** variant deliberately: the `GET` is `deprecated: true` (FR-015). Every `200` fixture
carries `vipManager` and the ~20 promo, device-link and internal-scoring measures **on purpose** —
a fixture that omitted them could not prove the exclusion, only assume it (Principle V).

Note the `400`: `customer-metrics.yaml` declares it as a `oneOf` over **three** shapes, so three
fixtures are needed to cover one status code.

| Fixture                                | Outcome                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200-by-bet-type.json`                 | `BET_TYPE` aggregation, with lifetime and filtered totals that DIFFER, so conflating them is observable                                                                                              |
| `200-by-hierarchy-entity.json`         | `HIERARCHY_ENTITY`, whose rows state `EVENT_TYPE` while the REQUEST body wants `EVENTTYPE` — both spellings of one level (R12)                                                                       |
| `200-by-timeframe.json`                | `TIMEFRAME`, so all three `keyKind` discriminator values are exercised                                                                                                                               |
| `400-multiple-hierarchy-levels.json`   | `MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE` → a hint saying to choose one level                                                                                                                       |
| `400-too-many-hierarchy-entities.json` | `TOO_MANY_HIERARCHY_ENTITIES` → a hint saying to ask for fewer or aggregate broader                                                                                                                  |
| `400-account-identifier-missing.json`  | `ACCOUNT_IDENTIFIER_MISSING` → a hint naming the argument                                                                                                                                            |
| `400-data-api-error.json`              | the third `400` shape, carrying **no** `errorCode` and a `message` that echoes the account identifier — so the "upstream text never reaches the agent" rule is provable rather than assumed (FR-029) |
| `401-unauthorized.json`                | identity invalid or expired → human re-authenticates                                                                                                                                                 |
| `500-server-error.json`                | nothing usable → `upstream`, and the message names the path TEMPLATE, not the interpolated path                                                                                                      |

There is deliberately **no `206`**: this operation declares only `200`, `400`, `401` and `500`, so
it has no partial-failure contract to model. That is the same conclusion as CRS but for a different
reason — CRS is an undeclared proxy, whereas this surface declares its statuses and simply has no
partial among them.

## The timeout outcome has no fixture, by design

`REQUEST_TIMEOUT` does not exist on the v5 surface (research.md R1): a timeout produces **no HTTP
response at all**. It is therefore simulated in tests with a delayed `msw` handler plus an abort
signal, which is what preserves the spec's distinction between _timeout with partial data already
gathered_ (result + caveat, `TIMEOUT_PARTIAL`) and _timeout with nothing usable_ (a `ToolError`) —
FR-010.

## Vocabulary

These files intentionally use GMA's **upstream** vocabulary — `successfulConfigSources`,
`failedConfigSources`, `errors[].configSource` — because that is what GMA sends. It is translated
to the project's `instance` vocabulary at the client boundary (`src/core/completeness.ts`) and must
never appear in a tool schema (constitution Principle IV).
