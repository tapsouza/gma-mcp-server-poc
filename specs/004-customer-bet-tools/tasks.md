# Tasks: Customer Risk & Bet Tools (FanDuel)

**Input**: Design documents from `/specs/004-customer-bet-tools/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/tools.md](./contracts/tools.md),
[quickstart.md](./quickstart.md), `.specify/memory/constitution.md` (**v1.2.0 or later** — the
surface-register amendment landed 2026-09-08; without it, `GET /crs/contexts` is absent from the
register and Principle IV blocks the fifth tool).

**Tests**: **REQUIRED, and blocking.** Not an optional TDD preference here — the constitution's
_Development Workflow & Quality Gates_ makes a fixture per distinguishable upstream outcome, the
must-cover matrix, and the coverage thresholds (≥ 90% line / 85% branch overall, ≥ 95% line for
`src/core/**`) hard gates. quickstart.md 1a–1c names three additional blocking gates.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and
demonstrated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Every task names its exact file path

## Path Conventions

Single project, TypeScript on Node.js 22: `src/` and `test/` at repository root. Paths below are
taken verbatim from plan.md's *Project Structure*.

## Artifact corrections landed 2026-09-08

Three inconsistencies surfaced by `/speckit-analyze` have been **amended in the design documents**,
so the artifacts now agree with each other and with this task list. Recorded here because each
changes a fact an implementer or reviewer would otherwise carry from memory:

| Document | Was | Now |
|---|---|---|
| contracts/tools.md §4 + register table; plan.md Technical Context & Complexity Tracking | `get_bet_risk_context` makes `2 + N` hops (worst case 12) | **`3 + N`** (worst case 13) — hop 3 is `GET /crs/contexts`, because constitution v1.2.0 makes the context list the *primary* matching mechanism and derivation a fallback only (T052) |
| data-model.md §7 (`ResolvedLeg`) | five fields | **six** — `resolvedVia: 'rampId' \| 'gbpId' \| null`, which Principle IV requires in the result and which is R9's closure evidence (T051) |
| spec.md FR-001, FR-002, Interpretation, and the requirements preamble | "exactly four" capabilities; `FR-001 – FR-025` | **exactly five**; `FR-001 – FR-030`. FR-001 carries the amendment note explaining why the four-capability set was not buildable as specified |

contracts/tools.md also gained caveat-relaying wording in the three tool descriptions that lacked
it, which `test/protocol/smoke.test.ts:74` requires of every tool (T019, T028, T059, T062).

**One decision remains open**, deliberately: whether the composite's event hop is instance-scoped
by the bet's `catalogueInstanceId`, by `config.defaultInstances`, or unscoped. It is assigned to
T043 rather than guessed, because a wrong answer is indistinguishable from R9 being wrong.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The two new deployment bounds and the fixture-library scaffolding every later phase
writes into. No behaviour changes here.

- [X] T001 Add `CUSTOMER_MAX_BETS` (default 20) and `CUSTOMER_MAX_EVENT_RESOLUTIONS` (default 10) to the zod schema and `Config` interface in `src/core/config.ts`, both via the existing `positiveIntFromString` helper so they are optional-with-default and no existing deployment's startup breaks
- [X] T002 [P] Document both new variables, with their defaults and their purpose (FR-010's bet cap, FR-023's per-bet resolution bound), in `.env.example`
- [X] T003 [P] Create the **five** new fixture directories `test/fixtures/gma/crsAccounts/`, `test/fixtures/gma/crsContexts/`, `test/fixtures/gma/qbsSearchBets/`, `test/fixtures/gma/customerMetrics/`, and `test/fixtures/gma/events/` (each with a `.gitkeep`), and add a *Provenance* subsection to `test/fixtures/README.md` recording that CRS fixtures derive from the **Java model classes** (`AccountRiskSettings` → `AccountContextRiskSettings` → `AccountContextHierarchyGroup` → `HierarchyGroupMetadata` → `HierarchyGroupMetadataEntity`, plus `LiabilityGroup`, `EligibilityProfile`) rather than an OpenAPI schema (research.md R15). **`events/` is separate from the existing `entities/`**: those fixtures are `eventType` documents, and `GET /v5/events/{id}` returns an `Event` carrying the three id/name pairs the composite needs — no existing fixture covers it
- [X] T004 Extend `testConfig()` in `test/helpers/gma.ts` with `customerMaxBets` and `customerMaxEventResolutions`, overridable so a test can drive the bound with a small value (depends on T001)
- [X] T005 Add cases to `test/unit/config.test.ts` covering both new bounds: absent → default, valid value → parsed, zero/negative/non-numeric → `config` error naming the variable (depends on T001)

**Checkpoint**: Configuration accepts and validates the two bounds; fixture directories exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared `core` changes every customer tool depends on, the domain skeleton, and
the domain's scoping-vocabulary discovery tool.

**⚠️ CRITICAL**: No user story work can begin until T006–T017 are complete. The `Completeness`
second axis and the `forbidden` error kind are used by every tool in the domain.

**Why `list_jurisdiction_contexts` (T018–T022) is here and not in a story phase**: two stories
consume it and neither owns it — US4 supplies its codes as a filter (the Principle V requirement
that creates the tool), and US3's composite calls the same operation directly for jurisdiction
matching (T052). Placing it here keeps US3 and US4 independently testable instead of making one
depend on the other. It is unlabelled per the format rules, and it does **not** block US1 or US2.

### Shared `core` changes (the amendment's migration surface)

- [X] T006 Add `unavailableComponents: readonly string[]` to the `Completeness` interface and export the closed `ComponentName` union (`'customerRiskConfiguration' | 'betDetail' | 'legCataloguePositions' | 'jurisdictionContexts'`) in `src/core/types.ts`, with the doc comment stating why the two axes must never merge (data-model.md §1). All four members are reachable: the fourth is emitted by the composite when its `GET /crs/contexts` hop fails (T052) — if any member ends up unreachable, that is a defect in the tool that should have emitted it, not a spare enum entry
- [X] T007 Add `'forbidden'` to the `ErrorKind` union in `src/core/types.ts`, documented as "403 — identity valid, permission absent; never conflated with `auth`" (same file as T006, so sequential)
- [X] T008 Extend `src/core/completeness.ts`: thread the new axis through `build()`, add invariant clause 3 (`unavailableComponents.length > 0` implies NOT `complete`) to the module doc comment, add `withUnavailableComponents(base, components)`, extend `buildCaveat()` with the missing-section sentence telling the agent **not** to retry with different scoping, and make `aggregate()` take the deduplicated union of the new axis (depends on T006)
- [X] T009 Extend `src/core/errors.ts`: add `403 → 'forbidden'` to `STATUS_TO_KIND`, `424 → 'upstream'`, a `forbidden: false` row to `RETRYABLE`, and a `forbidden` row to `GUIDANCE` reading "Request access — do not sign in again, and do not retry" (depends on T007)
- [X] T010 **The PII fix (R13), and it has two halves — both are required.** In `src/core/gmaClient.ts` add an optional `pathTemplate` to `GmaCallOptions`, defaulting to `path`, then: (a) log `pathTemplate` in place of the interpolated `path` at all four log sites (transport failure, HTTP error, unreadable body, successful call); **and (b) build the `operation` label from `pathTemplate`, not `path`** — `operationLabel(method, path)` at `gmaClient.ts:66,80` is separately allowlisted in `telemetry.ts` *and* is interpolated into tool-visible error messages by `safeUpstreamDetail` (`errors.ts:54,78`), so a `404` on `/crs/accounts/{id}` would otherwise read "GMA returned HTTP 404 for GET /crs/accounts/12345" — violating Principle V, FR-029, **and** FR-030's no-echo rule. research.md R13 names both fields ("**both** would carry the account id"). Passing a template equal to the path leaves every catalogue log line and error message byte-identical
- [X] T011 Correct the one existing assertion at `test/unit/errors.test.ts:32` from `403 → upstream, retryable: true` to `403 → forbidden, retryable: false`, with a comment recording it as a **deliberate defect correction** (it presently documents a live retry loop, research.md R10) and not an accommodation of the amendment
- [X] T012 [P] Extend `test/unit/completeness.test.ts` with cases for the second axis: `withUnavailableComponents` marks a result incomplete, `aggregate` unions the axis across hops and deduplicates, a hop with an unavailable component and zero failed instances is still `complete: false`, and the caveat text names the section — leaving every existing test in the file unchanged
- [X] T013 [P] Add `424` and `forbidden` cases to `test/unit/errors.test.ts`, asserting `forbidden` is never conflated with `auth` and is marked not retryable (SC-009)
- [X] T014 Update `test/unit/architecture.test.ts` so the single-mapping assertion covers the new kind — extend the `kind:\s*'(auth|notFound|argument)'` pattern to include `forbidden`, keeping the rule that only `core/errors.ts` constructs it
- [X] T015 **Amendment-acceptance gate (blocking, SC-012)**: run `npm test` and confirm every existing catalogue test passes **unmodified** apart from T011, per quickstart.md 1a. If any other existing test needs editing, the change is not additive and the amendment's MINOR classification is wrong — stop and record it rather than editing the test (depends on T006–T014)

  **Result (run 2026-09-08, `src/` at T014 with every test file reverted to its `HEAD` version):
  13 of 15 files passed, 363 of 365 tests passed, and exactly two assertions failed.** Both are
  accounted for, and neither is an accommodation of a shared type:

  | Failing assertion | Classification |
  |---|---|
  | `test/unit/errors.test.ts:32` — `403 → upstream, retryable: true` | **The permitted defect correction** (T011). It documented a live retry loop; the amendment changes the behaviour itself, which is the one edit quickstart.md 1a admits |
  | `test/unit/config.test.ts:147` — `Object.keys(config)` equals an exhaustive six-name list | **Not a shared-type accommodation.** It is a deliberately exhaustive enumeration whose stated purpose is that a new configuration field must be added *consciously*; `CUSTOMER_MAX_BETS` and `CUSTOMER_MAX_EVENT_RESOLUTIONS` (T001) are new fields, not a new member of `Completeness` or `ErrorKind`. Updating it is the assertion working as designed, and it is a `core` config test rather than an existing domain's test |

  **The amendment is therefore additive, and its MINOR classification holds.** The evidence is
  the files that did *not* fail: all five catalogue integration suites, the protocol smoke test,
  `architecture.test.ts`, `completeness.test.ts`, `telemetry.test.ts`, `resolve.test.ts`,
  `instances.test.ts`, `identity.test.ts` and `toolResults.test.ts` all passed **byte-unmodified**
  against a `Completeness` carrying a new axis and an `ErrorKind` carrying a new member. In
  particular `completeness.test.ts` passing unmodified is the load-bearing result: the second axis
  neither changed an existing verdict nor disturbed the invariant helper. Confirmed at T066.

### Customer domain skeleton

- [X] T016 Create `src/domains/customer/schemas.ts` with the domain's `completenessSchema` — both axes present, `unavailableComponents` as a zod `enum` over the four component names, each `.describe()` telling the agent what to **do** (`failedInstances`: "a narrowed retry may help"; `unavailableComponents`: "state what is absent; retrying with different scoping will NOT help") — plus `jurisdictionRefSchema` (`{ code, id, name }`, shaped deliberately like the catalogue's `brandInstanceSchema`)
- [X] T017 Create `src/domains/customer/index.ts` exporting `registerCustomerDomain(server, deps)` and reusing the `DomainDeps` / `toErrorResult` / `toSuccessResult` pattern from `src/domains/catalogue/index.ts` (imported from `core` only — no `domain → domain` import, which the lint rule and `architecture.test.ts` both block), then wire it into `buildServer` in `src/server/register.ts` and extend the server `instructions` to mention that customer results carry both completeness axes

### The scoping-vocabulary discovery tool

- [X] T018 [P] Add `test/fixtures/gma/crsContexts/` fixtures for `GET /crs/contexts`: `200-success.json` (including at least one **non**-US-state code — Ontario's `NXTCANBS` is the known case and the concrete justification for this tool), `401-unauthorized.json`, `403-forbidden.json`, `500-server-error.json`, each recorded in `test/fixtures/README.md`
- [X] T019 Create `src/domains/customer/tools/listJurisdictionContexts.ts` — one `GET /crs/contexts` hop through the shared client with `pathTemplate: '/crs/contexts'`, mapping upstream `ContextEntity { contextCode, contextId, contextName }` to `JurisdictionRef { code, id, name }` at the client boundary, plus the agent-facing `LIST_JURISDICTION_CONTEXTS_DESCRIPTION` from contracts/tools.md §1 — including the caveat-relaying instruction contracts/tools.md §1 now carries (FR-009), since `test/protocol/smoke.test.ts:74` asserts every tool description contains "relay"
- [X] T020 Add `listJurisdictionContextsOutputSchema` to `src/domains/customer/schemas.ts` and register the `list_jurisdiction_contexts` tool (no input, `readOnlyHint: true`) in `src/domains/customer/index.ts`
- [X] T021 [P] Create `test/integration/listJurisdictionContexts.test.ts` — full success with a non-derivable code surviving the mapping, `401 → auth`, `403 → forbidden` and not retryable, `500 → upstream`, and `completeness` present with both axes on success
- [X] T022 Add the `list_jurisdiction_contexts` rows to `test/MUST-COVER.md`, including the `403 → forbidden` case quickstart.md 1b marks blocking

**Checkpoint**: `core` carries both completeness axes and the `forbidden` kind; the customer
domain is registered and already serves one working tool. User stories can now proceed.

---

## Phase 3: User Story 1 — Read a customer's risk configuration (Priority: P1) 🎯 MVP

**Goal**: `get_customer_risk_profile` returns a customer's risk configuration for **every**
jurisdiction they have one in, never merged, each hierarchy override carrying its full named
catalogue path.

**Independent Test**: Request a known account's configuration and assert three jurisdictions come
back as three separate configurations with their overrides and named paths; then assert the
unknown-account, expired-identity, and insufficient-permission outcomes.

**Why first**: the only single-hop capability in the domain, and it proves both things the rest
depends on — per-jurisdiction fidelity, and an honest completeness verdict on a surface that
publishes no partial-failure signal of its own.

### Tests for User Story 1 (write these first; they must fail before T026–T028)

- [X] T023 [P] [US1] Add `test/fixtures/gma/crsAccounts/` fixtures for `GET /crs/accounts/{accountId}`: `200-three-jurisdictions.json` (different restrictions per jurisdiction, at least one hierarchy override per level with its `metadata.entities` ancestor chain), `200-override-empty-path.json` (`metadata.entities` is `[]` — `createHierarchyGroupMetadataEntities` returns `List.of()` when the id matches nothing), `200-nulls.json` (boxed scalars absent, to prove `null ≠ 0`), `401-unauthorized.json`, `403-forbidden.json`, `404-not-found.json`, `500-server-error.json`; record provenance (Java model classes) and confirm **no** fixture carries a real customer identifier or financial value
- [X] T024 [P] [US1] Create `test/unit/riskConfiguration.test.ts` — three jurisdictions map to three configurations with nothing merged, averaged, or collapsed (FR-006, SC-003); an override's `path` is reversed to **broadest-first** to match the catalogue domain's `ancestors` ordering; an empty `metadata.entities` yields an empty `path` with `entityId` intact and **no** fabricated name; an absent boxed scalar becomes `null`, never `0`
- [X] T025 [P] [US1] Create `test/integration/getCustomerRiskProfile.test.ts` — full success carrying `completeness` with both axes present on success (FR-005); `404 → notFound` rather than an empty success with fabricated defaults; `401 → auth`; `403 → forbidden`, not retryable, and never conflated with `auth`; `500 → upstream`; and the CRS honesty rule — this tool returns a complete answer or a tool error and **never** synthesises a partial verdict (research.md R2)

### Implementation for User Story 1

- [X] T026 [P] [US1] Add to `src/domains/customer/schemas.ts`: `liabilityGroupRefSchema` (`{ code, description, interceptValue }` — `displayOrder` and `colour` dropped as presentation concerns), `cataloguePathNodeSchema` (`{ level, id, name }`), `hierarchyOverrideSchema`, `customerRiskConfigurationSchema`, and the `get_customer_risk_profile` input/output schemas — no CRS DTO name (`contextId`, `hierarchyGroups`, `gpEligibility`, `birDelay`, `gmltl`) may appear
- [X] T027 [US1] Create `src/domains/customer/mapping/riskConfiguration.ts` — `AccountRiskSettings` → `CustomerRiskConfiguration[]`, one per jurisdiction, translating every upstream field name at this boundary and projecting `metadata.entities` into a broadest-first `path` (data-model.md §4, §5)
- [X] T028 [US1] Create `src/domains/customer/tools/getCustomerRiskProfile.ts` — local shape validation of `accountId` that **never echoes the value** (FR-030), one `GET /crs/accounts/{accountId}` hop with `pathTemplate: '/crs/accounts/{accountId}'`, and the agent-facing description from contracts/tools.md §2 including the "never summarise across jurisdictions" instruction **and** the caveat-relaying instruction §2 now carries (FR-009 — the smoke test requires it of every tool) (depends on T027)
- [X] T029 [US1] Register `get_customer_risk_profile` in `src/domains/customer/index.ts` with its input/output schemas, `readOnlyHint: true`, and a `tool.success` log line carrying only counts and outcomes — never an identifier (depends on T026, T028)

### Privacy gate for User Story 1

- [X] T030 [US1] Create `test/unit/privacy.test.ts` (blocking, quickstart.md 1c) — drive a `get_customer_risk_profile` call with a recognisable account identifier through a capturing log sink and assert the identifier appears in **no** emitted log line, span attribute, **or error message**, proving **both halves** of T010 took effect: the `path` field *and* the `operation` label, the latter reachable through a `404`'s tool-visible message. Cover a `404` explicitly, not only the success path (FR-029, FR-030, SC-007)
- [X] T031 [US1] Add the US1 rows to `test/MUST-COVER.md`: three jurisdictions unmerged (FR-006, SC-003), unknown account → `notFound`, `403 → forbidden` non-retryable (SC-009), the privacy assertion including the error-message path (SC-007)

**Checkpoint**: `get_customer_risk_profile` is fully functional and independently demonstrable.
This is the MVP — stop and validate here.

---

## Phase 4: User Story 2 — Find a customer's recent bets (Priority: P2)

**Goal**: `find_customer_bets` returns a curated risk-shaped projection of a customer's bets by
account, bet id, or the receipt id a customer quotes — with the ordering caveat always stated and
a technically-successful-but-partially-unpopulated response marked **incomplete**.

**Independent Test**: Search by account, by bet id, and by receipt id; assert the projection's
shape, the unconditional `orderingCaveat`, `kind: 'none'` for nothing matched, and — the case that
matters most — a `200` carrying GraphQL `errors[]` marked incomplete.

### Tests for User Story 2 (write these first; they must fail before T035–T039)

- [X] T032 [P] [US2] Add `test/fixtures/gma/qbsSearchBets/` fixtures for `POST /qbs/graphql`: **`200-success-with-errors.json`** (a `200` carrying GraphQL `errors[]` with requested fields unpopulated — the constitution calls this "the single most important one on that surface", and it is this feature's mandatory fixture), `200-single-bet.json`, `200-multi-leg-bet.json` (several legs, two sharing one event, to drive dedupe), `200-multiple-matches.json`, `200-no-match.json`, `200-over-limit.json` (more than the cap), `401-unauthorized.json`, `403-forbidden.json`, `500-server-error.json`; record provenance and confirm no fixture carries a real customer datum
- [X] T033 [P] [US2] Create `test/unit/betProjection.test.ts` and `test/unit/qbsErrors.test.ts` — the projection keeps exactly the curated field set and drops the rest; **no** returned bet carries a staff-authored note (FR-004); GraphQL `errors[]` map to `unavailableComponents`, never to `failedInstances` (FR-011, FR-026, research.md R1)
- [X] T034 [P] [US2] Create `test/integration/findCustomerBets.test.ts` — a `200` with `errors[]` is `complete: false` and names what was unavailable and is **never** presented as complete (FR-011, SC-002); zero identifiers and two identifiers each produce an `argument` error naming the choices and echoing **no** value (FR-008, FR-030, SC-008); `kind: 'none'` for nothing matched is neither an error nor a caveat (FR-012); `orderingCaveat` present on every success; a request over the cap sets `limitReached: true` rather than truncating silently (FR-010); `403 → forbidden` not retryable; the request body carries `sort: { field: PLACEMENT_DATE, order: DESC }`; **and the observed request URL carries no `instance` query parameter** — `requestRecorder()` in `test/helpers/gma.ts` already captures the URL, and the constitution requires `?instance=` never be sent while multi-instance routing is disabled (FR-025)

### Implementation for User Story 2

- [X] T035 [P] [US2] Create `src/domains/customer/gql/searchBets.ts` — the **fixed** `searchBets` document as a string constant selecting only the curated projection's fields and **omitting `betNotesDetails` entirely**, so FR-004 is enforced by the document rather than by filtering after retrieval (FR-024, research.md R4)
- [X] T036 [P] [US2] Add to `src/domains/customer/schemas.ts`: `namedEntitySchema`, `betLegSchema`, `appliedRiskFiguresSchema` (with a doc comment stating their derivation is not available to this system — FR-017), `wagerAmountsSchema`, `betSchema`, and the `find_customer_bets` input/output schemas — no QBS DTO name (`riskInfo`, `wageInfo`, `entityIds`, `numberOfLines`) may appear, and `productId` is carried internally only
- [X] T037 [US2] Create `src/domains/customer/mapping/betProjection.ts` — QBS `Bet` → the curated risk projection, including `entityIds` → a leg's `NamedEntity.id` trying `rampId` then `gbpId` (R9) and **recording which member supplied it**, so T051's `resolvedVia` has something to report (data-model.md §6)
- [X] T038 [US2] Create `src/domains/customer/mapping/qbsErrors.ts` — GraphQL `errors[]` plus unpopulated fields → `ComponentName[]` for `withUnavailableComponents`, deliberately **not** `failedInstances`, because a missing section must not tell the agent to retry with different scoping (FR-011, FR-026)
- [X] T039 [US2] Create `src/domains/customer/tools/findCustomerBets.ts` — exactly-one-of `{accountId, betId, receiptId}` validation, caller values placed only in `variables.input.ids`, `params.sort = PLACEMENT_DATE DESC` (research.md R6) with a post-retrieval sort as a safeguard, **no `?instance=` on the request** (constitution: it is routing, not scoping, and must not be sent nor exposed as an argument), the configured `CUSTOMER_MAX_BETS` clamp with `limitReached`, the unconditional `orderingCaveat`, `kind: 'bets' | 'none'`, and the description from contracts/tools.md §3 — which already relays the ordering caveat, satisfying FR-009 (depends on T035, T037, T038)
- [X] T040 [US2] Register `find_customer_bets` in `src/domains/customer/index.ts` (depends on T036, T039)

### Read-only gate for User Story 2

- [X] T041 [US2] Create `test/unit/readOnly.test.ts` (blocking, SC-010) — a **structural** assertion over `src/domains/customer/**` proving no caller-supplied value can reach an upstream query or path: the GraphQL document contains no interpolation, every `client.get`/`client.post` path argument is a literal or a template with only locally-validated identifiers, no schema in `schemas.ts` accepts a query/query fragment/field selection/operation name/path/brand/**`instance`**/`completeness`, no source in the domain constructs an `instance` query parameter, and the document contains no mutation keyword. **Re-run and extend this after T052**, which adds the composite's own path construction for event ids — a read-only audit written before the last path-building code exists proves less than it appears to
- [X] T042 [US2] Add the US2 rows to `test/MUST-COVER.md`: the `200`-with-errors case (SC-002), zero/two identifiers (SC-008), `kind: 'none'` (FR-012), bound reported not truncated (FR-010), no staff notes (FR-004), no `?instance=` sent (FR-025), the read-only structural assertion (SC-010)

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 — Understand the risk context behind one bet (Priority: P3)

**Goal**: `get_bet_risk_context` places one bet's **applied** risk figures beside the customer
risk settings that were **in scope** for it — the composite the domain exists for.

**Independent Test**: A single-leg bet, a multi-leg bet, a bet whose jurisdiction has no
configuration, and a bet whose jurisdiction cannot be matched — asserting in each case what is
claimed and, more importantly, what is **not**.

**Note on the pure modules**: `jurisdiction.ts`, `agreement.ts`, and `legResolution.ts` hold every
decision this feature could get *confidently wrong*, and are separated from the tool precisely so
they can be tested exhaustively as functions rather than through an HTTP round-trip.

### Tests for User Story 3 (write these first; they must fail before T048–T052)

- [X] T043 [P] [US3] Add `test/fixtures/gma/events/` fixtures for `GET /v5/events/{id}` — the composite's third hop, and **the one operation this feature depends on that has no fixture today**: `200-success.json` (an `Event` carrying all three required id/name pairs — `superclassId/Name`, `subclassId/Name`, `eventTypeId/Name`), `206-partial.json` (**the one that matters most**: an event resolved from a partial response must make the whole composite `PARTIAL`, per Principle II's hop-merge rule), `400-bad-request.json`, `401-unauthorized.json`, `404-not-found.json`, `500-server-error.json`. Record provenance (`api_catalogue.yaml`, the `Event` schema) in `test/fixtures/README.md`, and note that the existing `entities/` fixtures do **not** cover this operation — they are `eventType` documents from a different path. **Open question to settle while writing these** (analyse finding M1): whether this hop is instance-scoped by the bet's `catalogueInstanceId`, by `config.defaultInstances`, or deliberately unscoped. It matters — an absent or wrong scope makes *every* leg fail to resolve, which is indistinguishable from R9 being wrong
- [X] T044 [P] [US3] Create `test/unit/jurisdiction.test.ts` — all **four** FR-018 outcomes each exercised (`matched`, `noConfigurationForJurisdiction`, `jurisdictionNotMatched`, `jurisdictionUnknown`) with the matching order asserted (exact match against the customer's own configurations → **the fetched platform context list** → US-state derivation → not matched); a case proving derivation is **not** consulted when the context list already matches, since the constitution makes the list primary and derivation a fallback only; a case where the context list is **absent** (its hop failed) showing derivation still runs and the result carries `unavailableComponents: ['jurisdictionContexts']`; rows 2 and 3 stay **distinct**, so a systematic matching failure is never reported as a fact about the customer (SC-003, SC-004); and an unresolved jurisdiction leaves the result `complete: true`, because matching is **not** incompleteness (FR-027)
- [X] T045 [P] [US3] Create `test/unit/agreement.test.ts` — `consistent` and `differs` with both values always present, and `notComparable` emitted for **each** of its three triggers separately (governing configuration unresolved; either value absent; multi-leg bet with a bet-level applied value) (FR-020); plus the R14 guard — a liability-group description-vs-code mismatch reports `differs` with both strings visible rather than being silently wrong
- [X] T046 [P] [US3] Create `test/unit/legResolution.test.ts` — the same event on several legs is resolved **once** (SC-013); the `CUSTOMER_MAX_EVENT_RESOLUTIONS` bound names the unresolved legs via `notAttemptedBoundReached` rather than truncating silently (FR-023); each of the four `LegResolutionOutcome` values is produced, with `notResolvedIdentifierUnusable` kept separate from `notResolvedUpstreamFailure` so R9 being wrong is immediately visible; `resolvedVia` reports which `entityIds` member worked on a resolved leg and is absent on an unresolved one (R9's closure evidence); and an empty `overridesInScope` on an unresolved leg is never readable as "unrestricted"
- [X] T047 [P] [US3] Create `test/integration/getBetRiskContext.test.ts` — single-leg matched bet returns applied figures, the governing configuration, the leg's resolved path, in-scope overrides, and a per-field agreement verdict; a multi-leg bet carries `attributionNotice` and every verdict is `notComparable` (FR-021, SC-006); more than one bet match returns all candidates with **zero** further hops — no CRS call, no context call, and no event calls (FR-022); a CRS failure yields `unavailableComponents: ['customerRiskConfiguration']` with `complete: false` and **not** a failed instance (FR-026, SC-001); a `GET /crs/contexts` failure yields `unavailableComponents: ['jurisdictionContexts']` and the tool still answers by falling back to derivation; a `206` on one event hop makes the whole result `PARTIAL`; the bound reached yields `unavailableComponents: ['legCataloguePositions']`; and an override covering several legs appears on **each** leg (FR-019)

### Implementation for User Story 3

- [X] T048 [P] [US3] Create `src/domains/customer/jurisdiction.ts` — the four-outcome matcher, **pure and I/O-free**, taking the bet's jurisdiction, the customer's configurations, and the platform context list (which may be `null` when its hop failed) and returning a `JurisdictionMatchOutcome` with the governing reference when matched. The context list is **primary** and derivation is the **fallback**, never the reverse; **no hardcoded jurisdiction table** — prohibited by constitution v1.2.0 because it would fail *confidently* as jurisdictions are added (data-model.md §8)
- [X] T049 [P] [US3] Create `src/domains/customer/agreement.ts` — the three-valued verdict, **pure**, with `notComparable` as the default and both values always present in the payload (data-model.md §9)
- [X] T050 [P] [US3] Create `src/domains/customer/legResolution.ts` — distinct-event dedupe before fan-out, the configured resolution bound, per-leg `LegResolutionOutcome` plus `resolvedVia`, and override-to-position matching that duplicates a covering override onto every leg it covers (data-model.md §7, FR-019, FR-023)
- [X] T051 [P] [US3] Add to `src/domains/customer/schemas.ts`: `legResolutionOutcomeSchema`, `resolvedLegSchema` (with `resolution` **mandatory** and a `.describe()` telling the agent to check it before reading `overridesInScope`, plus **`resolvedVia: 'rampId' | 'gbpId' | null`** — the sixth field per data-model.md §7: Principle IV requires a tool to state a load-bearing unverified assumption **in its result**, and R9 is exactly that. It is a field *level*, never an identifier, so it carries no PII and needs no telemetry allowlist entry), `jurisdictionMatchOutcomeSchema`, `agreementVerdictSchema`, `betRefSchema`, and the `get_bet_risk_context` input/output schemas
- [X] T052 [US3] Create `src/domains/customer/tools/getBetRiskContext.ts` — exactly-one-of `{betId, receiptId}`; **`3 + N` hops** per contracts/tools.md §4: (1) `POST /qbs/graphql`, then the multi-match early return that does **zero** further work; (2) `GET /crs/accounts/{accountId}`; (3) `GET /crs/contexts`, because constitution v1.2.0 makes the context list the **primary** matching mechanism and derivation a fallback only — without this hop T048's context argument is always empty and derivation silently becomes primary, which is the confident-failure mode the amendment exists to prevent. A failed context hop is **not** fatal: emit `unavailableComponents: ['jurisdictionContexts']` and fall back to derivation. Then (4) up to `CUSTOMER_MAX_EVENT_RESOLUTIONS` `GET /v5/events/{id}` calls, all through the shared `core` client (composition, not a `domain → domain` import). Plus `appliedFiguresAreBetLevel` with `attributionNotice` for a multi-leg bet, and the description from contracts/tools.md §4 including "read `jurisdictionMatch` first" and the prohibition on claiming default settings (depends on T048, T049, T050)
- [X] T053 [US3] Register `get_bet_risk_context` in `src/domains/customer/index.ts` (depends on T051, T052)
- [X] T054 [US3] Add the US3 rows to `test/MUST-COVER.md`: all four jurisdiction outcomes (SC-004), the context list preferred over derivation, unresolved jurisdiction still `complete: true` (FR-027), multi-leg never attributed to one leg (SC-006), each `notComparable` trigger (FR-020), multi-match → zero further hops (FR-022), each missing section via `unavailableComponents` (SC-001), `206` on an event hop flagging the whole result, dedupe and bound (SC-013)

**Checkpoint**: The composite works, and User Stories 1–3 are each independently demonstrable.

---

## Phase 6: User Story 4 — Read a customer's betting metrics (Priority: P4)

**Goal**: `get_customer_betting_metrics` returns a customer's betting metrics in the aggregation
the caller chose, optionally narrowed by period, bet type, placement status, jurisdiction, or
catalogue hierarchy position.

**Independent Test**: Request metrics with and without each filter and assert the aggregation
requested is the aggregation returned; then assert each invalid-filter outcome is a
self-correctable `argument` error.

### Tests for User Story 4 (write these first; they must fail before T057–T059)

- [X] T055 [P] [US4] Add `test/fixtures/gma/customerMetrics/` fixtures for `POST /accounts/{accountId}/metrics`: `200-by-bet-type.json`, `200-by-hierarchy-entity.json`, `200-by-timeframe.json` (each with lifetime and filtered totals, and including `vipManager` in the raw body so the exclusion is provable), `400-multiple-hierarchy-levels.json`, `400-too-many-hierarchy-entities.json`, `400-account-identifier-missing.json`, `401-unauthorized.json`, `500-server-error.json`; record provenance (`customer-metrics.yaml`)
- [X] T056 [P] [US4] Create `test/unit/metricsMapping.test.ts` and `test/integration/getCustomerBettingMetrics.test.ts` — a missing `aggregation` is an `argument` error **naming the three choices**, never defaulted (FR-014, SC-008); the requested aggregation is echoed back and `keyKind` discriminates so a bet type cannot be read as a period; each upstream `400` `errorCode` becomes a self-correctable hint with the upstream `message` **never** interpolated (it can echo the account identifier); an unrecognised jurisdiction code is an `argument` error pointing at `list_jurisdiction_contexts`, never a silently-dropped filter; `vipManager` is absent from the output (it names a person — Principle V); and the LLM-facing `EVENT_TYPE` is translated to upstream `EVENTTYPE` at the client boundary (research.md R12)

### Implementation for User Story 4

- [X] T057 [P] [US4] Add to `src/domains/customer/schemas.ts`: `aggregationSchema` (**required**, no default), `periodSchema`, `betTypeSchema`, `placementStatusSchema`, `hierarchyFilterSchema` (one level only), `metricsFiguresSchema` (the curated ~15-measure subset from data-model.md §10), `metricsGroupSchema` (discriminated by `keyKind`), and the `get_customer_betting_metrics` input/output schemas
- [X] T058 [US4] Create `src/domains/customer/mapping/metrics.ts` — the request-body builder translating `EVENT_TYPE → EVENTTYPE`, the response projection keeping only the curated measures and excluding `vipManager` and the ~20 promo/device/internal-scoring measures, and the `400` `errorCode` → argument-hint table (`MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE`, `TOO_MANY_HIERARCHY_ENTITIES`, `ACCOUNT_IDENTIFIER_MISSING`)
- [X] T059 [US4] Create `src/domains/customer/tools/getCustomerBettingMetrics.ts` — one `POST /accounts/{accountId}/metrics` hop with `pathTemplate: '/accounts/{accountId}/metrics'` (the **`POST`** variant; the `GET` is `deprecated: true` and must not be used — FR-015), the required-aggregation check, jurisdiction-code validation against `list_jurisdiction_contexts`, and the description from contracts/tools.md §5, including the caveat-relaying instruction it now carries (FR-009 — the smoke test requires it of every tool) (depends on T058)
- [X] T060 [US4] Register `get_customer_betting_metrics` in `src/domains/customer/index.ts` (depends on T057, T059)
- [X] T061 [US4] Add the US4 rows to `test/MUST-COVER.md`: missing aggregation (SC-008), each `400` error code, unrecognised jurisdiction code, `vipManager` excluded

**Checkpoint**: All five tools ship; all four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T062 Extend `test/protocol/smoke.test.ts` — the tool list grows from exactly **three** to exactly **eight** (`smoke.test.ts:51`); every schema resolves with a non-empty description; **every one of the five new descriptions contains "relay"**, which the existing assertion at `smoke.test.ts:74` already requires of *all* tools (contracts/tools.md §§1, 2 and 5 gained the wording on 2026-09-08; T019, T028 and T059 carry it into code); `completeness` appears in **no** tool's input properties; and one customer-domain call round-trips with both completeness axes in its `structuredContent` (quickstart.md Validation 2)
- [X] T063 Extend `test/unit/architecture.test.ts` — assert no CRS/QBS/metrics DTO vocabulary (`configSource`, `contextId`, `entityIds`, `hierarchyGroups`, `riskInfo`, `wageInfo`, `EVENTTYPE`, `betNotesDetails`, `vipManager`) appears in `src/domains/customer/schemas.ts`, and that the module-boundary and no-hardcoded-value rules still hold across the new domain
- [X] T064 [P] Complete `test/fixtures/README.md` — an outcome-coverage table per new surface **including `events/`**, and an explicit note that CRS declares **no** partial-failure contract so there is deliberately no `206` fixture for it, while QBS's partial signal is a `200` body and therefore lives in `200-success-with-errors.json` (SC-011)
- [X] T065 Final audit of `test/MUST-COVER.md` — every blocking case in quickstart.md 1b (the constitution's standing list, v1.1.0's seven additions, and this feature's own seven) names a `describe('case: …')` block that exists, and every GMA operation the five tools depend on has a fixture row (SC-011 — the gap this audit exists to catch is an operation reached through the shared `core` client whose fixtures nobody owned)
- [X] T066 Run `npm run lint` and `npm run test:coverage` — all suites pass, coverage ≥ 90% line / 85% branch overall and ≥ 95% line for `src/core/**`; a shortfall **fails the run** and lowering a threshold is never the fix (quickstart.md Validation 1)
- [X] T067 [P] Run `npm run agent` and work through quickstart.md Validation 3's five asks, confirming the agent **refuses** to summarise across jurisdictions, narrate a limit calculation, or claim a restriction for an unresolved leg, and that one bet's risk context is answered in a single call with no manual identifier conversion (SC-005) — a failure here is a tool-description defect, not an agent defect. **Run 2026-09-09 against live GMA. First pass FAILED three of five asks; all three were description defects, fixed and re-run clean — see PR-NOTES defects 13 to 15. Note the task's "no live GMA" premise is wrong: every ask needs a tool call that returns DATA, so this validation requires a token.**
- [X] T068 Close or record **R9** and **R14** per quickstart.md Validation 4 against live GMA — R9's evidence is each resolved leg's `resolvedVia` (T051), which names the `entityIds` member that actually worked; if **every** leg reports `notResolvedIdentifierUnusable`, check T043's instance-scoping decision before concluding the assumption is wrong, since the two failures look identical. Record **R8** as a question for the owner of the customer-risk system; whichever remain open must carry an owner and a removal condition in the PR description. **Done 2026-09-09. R9 CLOSED against the assumption (`gbpId`, not `rampId`; nine legs `resolvedVia: gbpId`, plus a live `get_event` 200 on the same id form that 400s for an OpenBet event — the discriminating case). R14 CLOSED as assumed. R8 remains open WITH an owner and a sharpened question in PR-NOTES: 32 of 35 jurisdictions were absent entirely rather than default-valued, so observation points at omission, but whether that is CRS's contract only its owner can say.**
- [X] T069 Record in the PR description that `test/unit/errors.test.ts:32` was edited as a **documented defect correction** (it asserted a retry loop), that it is the only existing test the amendment-acceptance gate permits changing, that every other existing catalogue test passed unmodified (SC-012), and that three design documents were amended on 2026-09-08 to resolve inconsistencies (`get_bet_risk_context` is `3 + N` hops in contracts/tools.md and plan.md; `ResolvedLeg` gained `resolvedVia` in data-model.md §7; spec.md FR-001 is now "exactly five" with the requirements range corrected to FR-030) — none changes the design, each corrects a document against it. Note also that the event hop's instance scoping was settled at T043 and record which option was chosen and why

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup. T006–T017 **block all user stories**; T018–T022 block only US3 and US4
- **User Stories (Phases 3–6)**: all depend on T006–T017
  - Then either in priority order (P1 → P2 → P3 → P4), or in parallel if staffed
- **Polish (Phase 7)**: depends on every story you intend to ship

### User Story Dependencies

- **US1 (P1)**: depends only on T006–T017. No dependency on any other story
- **US2 (P2)**: depends only on T006–T017. Independent of US1
- **US3 (P3)**: depends on T006–T022 — it calls `GET /crs/contexts` directly (T052) and reuses T019's mapper, as well as the CRS mapping (T027) and the bet projection (T037). Implement it after US1 and US2
- **US4 (P4)**: depends on T006–T022 (it is `list_jurisdiction_contexts`' agent-facing consumer). Independent of US1, US2, and US3

### Within Each User Story

- Tests are written first and MUST fail before the implementation task that satisfies them
- Fixtures → schemas → mapping → tool → registration → gates
- Story complete and its checkpoint validated before moving to the next priority

### Parallel Opportunities

- **Phase 1**: T002, T003 in parallel; T004 and T005 in parallel once T001 lands
- **Phase 2**: T012, T013 in parallel; T018 and T021 in parallel with the `core` work
- **Phase 3**: T023, T024, T025 in parallel (all tests); T026 in parallel with them
- **Phase 4**: T032, T033, T034 in parallel; T035 and T036 in parallel
- **Phase 5**: T043–T047 all in parallel (fixtures + four test files); T048–T051 all in parallel (three pure modules + schemas — this is the widest parallel window in the feature)
- **Phase 6**: T055, T056 in parallel; T057 in parallel with them
- **Across stories**: once T017 lands, US1 and US2 can be built by different people simultaneously; US4 joins once T020 lands

---

## Parallel Example: User Story 3

```bash
# Launch the fixtures and all four test files together — the tests must fail first:
Task: "Add test/fixtures/gma/events/ fixtures for GET /v5/events/{id}, incl. 206"
Task: "Create test/unit/jurisdiction.test.ts — all four FR-018 outcomes, list before derivation"
Task: "Create test/unit/agreement.test.ts — three verdicts, each notComparable trigger"
Task: "Create test/unit/legResolution.test.ts — dedupe, bound, four outcomes, resolvedVia"
Task: "Create test/integration/getBetRiskContext.test.ts — the composite's outcomes"

# Then launch the three pure modules and the schemas together:
Task: "Create src/domains/customer/jurisdiction.ts — the four-outcome matcher"
Task: "Create src/domains/customer/agreement.ts — the three-valued verdict"
Task: "Create src/domains/customer/legResolution.ts — dedupe, bound, per-leg outcome"
Task: "Add resolvedLeg/jurisdictionMatch/agreementVerdict schemas to schemas.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup (T001–T005)
2. Phase 2: Foundational (T006–T022) — **T015, the amendment-acceptance gate, is blocking**
3. Phase 3: User Story 1 (T023–T031)
4. **STOP and VALIDATE**: `get_customer_risk_profile` returns three jurisdictions unmerged, and
   `test/unit/privacy.test.ts` passes for both the log path **and** a `404`'s error message
5. Demo: a risk manager's agent reads a customer's configuration per jurisdiction

### Incremental Delivery

1. Setup + Foundational → the domain exists and `list_jurisdiction_contexts` already works
2. Add US1 → validate → demo (**MVP**)
3. Add US2 → validate the `200`-with-errors path specifically → demo
4. Add US3 → validate all four jurisdiction outcomes → demo (**the reason the domain exists**)
5. Add US4 → validate → demo
6. Polish: the protocol surface, the fixture audit, coverage, and closing R9/R14

### Parallel Team Strategy

1. Everyone completes Setup + Foundational together — the `core` changes are the shared surface
   and are cheapest to review as one change
2. Then:
   - Developer A: US1 (CRS mapping, the privacy gate)
   - Developer B: US2 (the fixed document, the QBS partial-success path, the read-only gate)
   - Developer C: US4 (metrics — it joins nothing and blocks nothing)
3. US3 lands after US1 and US2, because it reuses both their mappings and T019's context mapper

---

## Notes

- **[P]** = different files, no dependency on an incomplete task
- **[Story]** maps a task to a user story for traceability; Setup, Foundational, and Polish carry
  no story label
- The four blocking gates are easy to defer and expensive to defer: **T015** (existing tests pass
  unmodified), **T030** (no customer identifier in any log **or error message** — and the trap is
  `gmaClient`'s two interpolated fields, `path` *and* `operation`), **T041** (no caller value
  reaches a query or path, re-checked after T052), and **T043/T065** (a fixture for every
  operation, including one reached only through the shared `core` client)
- The single worst defect this feature could ship is a `200` carrying GraphQL `errors[]` presented
  as complete. Its fixture (T032) and its assertion (T034) are non-negotiable. The second worst is
  a jurisdiction match that silently degrades to derivation-only: it compiles, tests green against
  a hand-passed context list, and fails *confidently* — which is why T052's third hop is not
  optional and T044 asserts the ordering
- Every member of the closed `ComponentName` set has an emitter: `customerRiskConfiguration` and
  `legCataloguePositions` and `jurisdictionContexts` from T052, `betDetail` from T038. An enum
  member no task populates is a missing hop, not a spare label
- `/mcp/customer` is the endpoint this domain will own once a non-stdio transport exists; today
  `registerCustomerDomain` registers onto the same shared server as the catalogue, exactly as
  `register.ts` already documents for `/mcp/catalogue`
- Commit after each task or logical group; stop at any checkpoint to validate a story on its own
