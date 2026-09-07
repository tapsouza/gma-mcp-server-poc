---
description: "Task list for v4 Catalogue Surface by Default"
---

# Tasks: v4 Catalogue Surface by Default

**Input**: Design documents from `/specs/003-v4-catalogue-default/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/generation-selection.md](./contracts/generation-selection.md), [quickstart.md](./quickstart.md)

**Tests**: **REQUIRED, not optional.** The constitution (v1.0.2, *Development Workflow & Quality
Gates*) makes the fixture library and the must-cover matrix **blocking**, and enforces coverage
gates in CI. Test tasks here are therefore first-class, not a TDD preference.

**Organization**: Grouped by user story. Two phases precede the stories: the **blocking governance
amendment** (Phase 1) and the **R8 read-path corrections** (Phase 2), which must land before any
generation work so that "behaviour is unchanged across generations" is verified against bodies GMA
actually sends.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`–`[US4]`, mapping to spec.md's user stories
- Every task names its exact file path

## Path Conventions

Single project at repository root: `src/`, `test/`, `specs/`, `.specify/`.

---

## Phase 1: Governance (BLOCKING PREREQUISITE — no code may merge first)

**Purpose**: The constitution names the v1 surface as "the v5 catalogue API" with v5 paths listed
explicitly (`.specify/memory/constitution.md:259-262`). This feature contradicts that sentence, and
governance states the constitution wins over a plan. Amending it is a prerequisite, not a
follow-up (research.md R9).

**⚠️ The amendment PR MUST edit only `.specify/memory/constitution.md`,** per the amendment
procedure.

- [X] T001 Amend the **v1 API surface** constraint in `.specify/memory/constitution.md` (§Technology & Platform Constraints, lines 259-262) to name **both** catalogue generations, with v4 as the default and v5 reached only by declared per-operation requirement; record that v4 carries zero `deprecated: true` operations and is documented upstream as current, so defaulting to it satisfies Principle IV
- [X] T002 Generalise Principle II's mapping table in `.specify/memory/constitution.md` so "HTTP `200` on the v5 catalogue surface" reads as surface-general — the same status contract holds on v4 (research.md R2). Change wording only; change no rule
- [X] T003 Retitle and reword the **"Deployed GMA partial-failure contract (verified 2026-09-03)"** subsection in `.specify/memory/constitution.md` to state that its verified facts hold identically on v4 and v5, citing the 2026-09-07 verification
- [X] T004 Generalise the fixture-library gate in `.specify/memory/constitution.md` (§Development Workflow) so the outcome set is not described as "the v5 catalogue surface"
- [X] T005 Update the version to **1.1.0**, set Last Amended to 2026-09-07, and write the Sync Impact Report at the top of `.specify/memory/constitution.md` — including the MINOR-vs-MAJOR reasoning from plan.md's Complexity Tracking, stated explicitly so the maintainer can settle it rather than inherit an assumption

**Checkpoint**: Constitution is v1.1.0 and no longer contradicts this feature. Code work may begin.

---

## Phase 2: R8 read-path corrections (BLOCKING — must precede generation work)

**Purpose**: Two pre-existing defects sit in the exact read path this feature touches, and five
hand-crafted fixtures encode the same mistakes, which is why the suite is green (research.md R8).
Correcting them first is what makes FR-017/FR-018/SC-002 verifiable at all — otherwise this feature
would assert "unchanged across generations" against a body no generation sends.

**Scope fence**: these tasks correct **only** the two wrong read paths and the fixtures that hide
them. No refactoring, no new fields, no new capability. Reviewable and revertible independently of
every later phase.

### Fixtures first — so the corrections are red before they are green

- [X] T006 [P] Correct `test/fixtures/gma/entities/200-eventTypes-children.json`: rename the `eventTypes` key to `entities` — both generations declare this operation's 200 as `EntitiesResponse` (research.md R2, confirmed in GMA's `SearchCatalogueApiDelegateImpl.searchEventTypesByInstancesAndSubclassId`)
- [X] T007 [P] Correct `test/fixtures/gma/entities/206-partial.json`: rename `eventTypes` to `entities`, keeping the `failedConfigSources` / `errors[]` envelope untouched
- [X] T008 [P] Correct `test/fixtures/gma/entities/200-success.json`: replace the nested `subclass.superclass` object with flat `superclassId` / `superclassName` scalars on the subclass
- [X] T009 [P] Correct `test/fixtures/gma/entities/200-eventType.json`: replace the nested `eventType.subclass.superclass` chain with flat `superclassId` / `superclassName` / `subclassId` / `subclassName` scalars
- [X] T010 [P] Correct `test/fixtures/gma/entities/206-partial-entity.json` the same way as T008
- [X] T011 Verify `test/fixtures/gma/entities/200-superclass.json` needs **no** change — `superclass.subclasses[]` is genuinely what both generations return (research.md R8) — and record that in `test/fixtures/README.md` so a later reader does not "fix" a correct fixture
- [X] T012 Run `npm test` and confirm the child-listing and ancestry tests now **FAIL**. A green suite here means a fixture was not actually corrected — investigate before proceeding

### Then the source corrections

- [X] T013 Fix defect 1 in `src/domains/catalogue/traversal.ts`: read subclass children from `data.entities` instead of `data.eventTypes`, and update the `ChildrenResponse` interface accordingly. Keep the tolerant fallback shape for the superclass hop, which is correct as-is
- [X] T014 Fix defect 2 in `src/domains/catalogue/tools/getCatalogueEntity.ts`: rewrite `collectAncestors` to derive ancestry from the flat scalars `superclassId` / `superclassName` / `subclassId` / `subclassName` per [data-model.md §8](./data-model.md), and replace the nested-object fields on `UpstreamNode` with those scalars
- [X] T015 In `src/domains/catalogue/tools/getCatalogueEntity.ts`, make a missing or blank ancestry scalar yield a **shorter** chain rather than a fabricated entry — an invented ancestor id an agent might then try to fetch is worse than a shorter path
- [X] T016 Add named cases to `test/integration/getCatalogueEntity.test.ts`: `case: ancestry is derived from flat scalars, not nested objects (R8 defect 2, 001-FR-014)` covering a subclass (one ancestor) and an event type (two, superclass then subclass), plus a blank-scalar case asserting a shorter chain and no fabricated id
- [X] T017 Add a named case to `test/integration/findCatalogueEntity.test.ts`: `case: subclass children are read from entities[] (R8 defect 1)`, asserting `children` is non-empty for a matched subclass — the assertion that would have caught this defect
- [X] T018 Rewrite the provenance section of `test/fixtures/README.md` to record that five entity fixtures previously contradicted their own stated source of truth, what changed, and that the schema — not the implementation — is authoritative when they disagree
- [X] T019 Run `npm test` and confirm green. The two corrections are now covered by tests that would fail if either regressed

**Checkpoint**: The read paths match what GMA actually returns, on both generations. Generation
work can now be verified honestly.

---

## Phase 3: Foundational — the generation mechanism (BLOCKING for all stories)

**Purpose**: One resolution step, one table, one place that decides. Every user story depends on
this phase; none can start before it completes.

### The operation table and resolver

- [X] T020 Create `src/core/surface.ts` with the `Generation` type (`'v4' | 'v5'`), the `CatalogueOperation` union of the six logical operations, and the `OperationDescriptor` / `ResolvedOperation` / `OperationPins` interfaces per [data-model.md §1-§5](./data-model.md)
- [X] T021 In `src/core/surface.ts`, add the frozen `OPERATIONS` descriptor table encoding [data-model.md §3](./data-model.md)'s matrix: `availableOn`, `paths` per generation, `method`, and `instancesIn`. `searchByName` MUST be `availableOn: ['v5']` with no `v4` path — that single entry is the encoding of research.md R1. `listInstances` takes no instance scoping at all, so it MUST omit `instancesIn` (the field is optional, per [data-model.md §3](./data-model.md)) rather than carry a misleading `'query'`
- [X] T022 In `src/core/surface.ts`, implement `resolveOperations({ capability, operations, pins, defaultGeneration })`: effective generation is `pins[op] ?? defaultGeneration`, asserted against `availableOn`, returning `Record<CatalogueOperation, ResolvedOperation>`. `capability` is carried **only** so T023's error message can name it — resolution logic must not branch on it
- [X] T023 Add an `unsatisfiableGeneration(capability, operation, effective, availableOn)` factory to `src/core/errors.ts` returning a `config` `ToolError` whose message names all four, per [contracts §1](./contracts/generation-selection.md). It goes in `errors.ts` because that file is the single place `ToolError`s are constructed — putting it in `surface.ts` would erode the assertion at `test/unit/architecture.test.ts:127`, whose intent is exactly that
- [X] T024 In `src/core/surface.ts`, throw `unsatisfiableGeneration(...)` when an effective generation is not in `availableOn`, so the process refuses to start. This is FR-006's check; resolution *is* the check, so no separate validation pass exists
- [X] T025 Verify `npm test` still passes `test/unit/architecture.test.ts` — specifically the `case: keeps HTTP-status-to-error mapping in exactly one module` assertion, which must remain green with the new factory in `errors.ts` rather than being widened to accommodate it
- [X] T026 [P] Create `test/unit/surface.test.ts` asserting the four table invariants from [data-model.md §3](./data-model.md): `availableOn` non-empty; `paths` keys exactly equal `availableOn`; each path's first segment matches its generation key (the invariant that catches a copy-paste leaving a v5 path under `v4`); `instancesIn: 'body'` only on POST
- [X] T027 [P] In `test/unit/surface.test.ts`, add `case: searchByName exists only on v5 (research.md R1)` asserting `availableOn` is exactly `['v5']` and `paths` has no `v4` key — R1 as a test, not a comment
- [X] T028 [P] In `test/unit/surface.test.ts`, add `case: an unsatisfiable pin fails resolution naming capability, operation and generations (FR-006)`
- [X] T029 [P] In `test/unit/surface.test.ts`, add `case: resolution never returns a generation outside availableOn, and never retries (FR-002, FR-007)` — the two prohibitions are satisfied structurally today, and an unasserted prohibition is one a later edit can break silently

### Configuration

- [X] T030 Add `defaultGeneration: Generation` to the `Config` interface in `src/core/config.ts`, and `GMA_CATALOGUE_GENERATION` to the zod schema as **optional**, accepting exactly `v4` or `v5`, defaulting to `v4` when unset or empty (research.md R6, FR-013). Do **not** add it to `REQUIRED_VARS` — the default is the safe value, which is precisely where fail-fast should not apply
- [X] T031 Ensure an invalid `GMA_CATALOGUE_GENERATION` produces a `config` `ToolError` naming the variable and its accepted values, matching [contracts §1](./contracts/generation-selection.md) (FR-014)
- [X] T032 [P] Add named cases to `test/unit/config.test.ts`: unset → `v4`; empty and whitespace-only → `v4`; `v4` and `v5` accepted; `v6`, `V4`, `4`, and `latest` each rejected with a message naming the variable
- [X] T033 [P] Document `GMA_CATALOGUE_GENERATION` in `.env.example` — accepted values, the `v4` default, that it is operational and never an agent argument — left **commented out**, because the default is the intended value

### Client and telemetry

- [X] T034 Change `GmaClient` in `src/core/gmaClient.ts` to take a `ResolvedOperation` plus a path-parameter record instead of a path string, per [contracts §2](./contracts/generation-selection.md). Interpolate and `encodeURIComponent` path parameters here, absorbing the duplication currently in two tool modules. `options.token` stays a **required, explicit** parameter — Principle I is untouched
- [X] T035 In `src/core/gmaClient.ts`, drive instance placement from `instancesIn`: query string for GET, request body for `searchByName` (FR-011 — narrowing must behave identically on both generations) — the existing asymmetry (research.md R1) now lives in the table rather than in a tool
- [X] T036 In `src/core/gmaClient.ts`, log `generation` and re-key `operation` to the logical operation id, with the resolved template in `path` (research.md R7). Agent-visible error text becomes `getEventType` rather than `GET /v5/eventTypes/{id}`, moving toward FR-012
- [X] T037 Add `'generation'` to `LOG_FIELD_ALLOWLIST` in `src/core/telemetry.ts` with a comment stating it is a two-value enum carrying no credential, identifier, or personal datum (FR-015, 001-FR-020, SC-009). The allowlist is the only egress path for both logs and span attributes, so this one addition covers both
- [X] T038 [P] Add `case: generation is allowlisted and a token-bearing field still is not (FR-015, SC-006)` to `test/unit/telemetry.test.ts`, and update the existing cases that assert the old `operation` format (lines ~72, ~234) to the logical id
- [X] T039 Update `test/unit/errors.test.ts` (24 occurrences) and `test/unit/toolResults.test.ts` to pass logical operation labels to `fromHttpStatus` instead of `GET /v5/...` strings. `src/core/errors.ts` itself needs no logic change — only its doc comment's example label
- [X] T040 Update `test/integration/gmaClient.test.ts` (20 occurrences) to build calls from `ResolvedOperation` handles rather than path strings, keeping every existing outcome assertion intact
- [X] T041 Update `test/helpers/gma.ts` so `testConfig()` includes `defaultGeneration: 'v4'`, and add a helper that builds a `ResolvedOperation` for a given operation and generation — the seam every parameterised suite in Phase 4 will use

### Startup wiring

- [X] T042 In `src/domains/catalogue/index.ts`, export `CATALOGUE_OPERATIONS` (the six ids) and `CATALOGUE_PINS` (`{ searchByName: 'v5' }`) per [contracts §3](./contracts/generation-selection.md), with a comment recording that the pin encodes an upstream fact — v4 has no by-name search — not a preference
- [X] T043 In `src/server/register.ts`, call `resolveOperations` once at startup with the domain's declarations and `config.defaultGeneration`, and pass the resolved handles into `registerCatalogueDomain`. This is the one layer permitted to see both `core/` and a domain, which is what lets the domain own its declarations without `core/` importing a domain (Principle III)
- [X] T044 Change `registerCatalogueDomain` in `src/domains/catalogue/index.ts` to accept the resolved handles on `DomainDeps` and thread them to each tool
- [X] T045 Add `case: no upstream path literal exists outside core/surface.ts` to `test/unit/architecture.test.ts` — a structural assertion that FR-003's "exactly one place decides" cannot be eroded by a later edit, in the same spirit as the existing hardcoded-host assertion

**Checkpoint**: Generation resolves once at startup; tools hold handles and can no longer name a
path or a generation. User stories can begin.

---

## Phase 4: User Story 1 — Existing capabilities answer from v4 by default (Priority: P1) 🎯 MVP

**Goal**: The three tools consult v4 by default, with agent-facing results byte-identical to before.

**Independent Test**: Run each tool against a controlled upstream with default config; assert the
request went to a `/v4/...` path and the payload is unchanged from the v5 behaviour.

- [X] T046 [US1] Convert `src/domains/catalogue/tools/listInstances.ts` to use its `listInstances` handle instead of the `LIST_INSTANCES_OPERATION` path constant, removing the last path literal from the file
- [X] T047 [US1] Convert `src/domains/catalogue/tools/getCatalogueEntity.ts` to use the `getSuperclass` / `getSubclass` / `getEventType` handles, deleting the `PATH_BY_TYPE` map — the table in `surface.ts` now owns that mapping
- [X] T048 [US1] Convert `src/domains/catalogue/traversal.ts` to use the `subclassEventTypes` and `getSuperclass` handles, deleting the `SUBCLASS_EVENT_TYPES` / `SUPERCLASS` constants and the exported `TRAVERSAL_PATHS` (its test moves to asserting handles)
- [X] T049 [P] [US1] Parameterise `test/integration/listInstances.test.ts` over both generations with `describe.each(['v4','v5'])`, asserting per run that the request hit that generation's path and the parsed result is identical (research.md R3). Keep every existing outcome case — this parameterisation is what satisfies FR-016 and SC-003 for this operation
- [X] T050 [P] [US1] Parameterise `test/integration/getCatalogueEntity.test.ts` the same way, across all three entity types, covering each outcome both generations declare (FR-016)
- [X] T051 [P] [US1] Parameterise the child-listing cases in `test/integration/findCatalogueEntity.test.ts` over both generations, leaving the search hop pinned to v5 (that is US2's subject). `searchByName` has doubles for v5 only, and no partial-success double, because that is all the upstream declares (FR-016)
- [X] T052 [US1] Add `case: default config routes every non-search operation to v4 (FR-001, FR-017, SC-001)` to `test/integration/listInstances.test.ts` — an explicit default-path assertion, not merely an implication of the parameterised runs
- [X] T053 [US1] Add `case: agent-facing payload is deeply equal on v4 and v5 (FR-008, SC-002)` to `test/integration/getCatalogueEntity.test.ts`: same 200 and same 206 body, once per generation, asserting deep equality. This is the strongest available guard against routing leaking into a result
- [X] T054 [US1] Update `test/integration/identityIsolation.test.ts` (15 occurrences) to build handles rather than paths, preserving every 001-FR-023a assertion unchanged — identity behaviour must be visibly untouched by this feature
- [X] T055 [US1] Update `test/protocol/smoke.test.ts` (8 occurrences) to mount handlers on the generations the default config resolves to: `/v4/...` for entity and child operations, `/v5/searchByName` for the search

**Checkpoint**: All three tools work on v4 by default, with identical results. **MVP reached** —
except that `find_catalogue_entity` depends on US2, which is why US2 is also P1.

---

## Phase 5: User Story 2 — The by-name search still works (Priority: P1)

**Goal**: `find_catalogue_entity` keeps working on a v4-default deployment, its search hop served
by v5 through the declared pin, with completeness aggregated across both generations.

**Independent Test**: Invoke the search on a default (v4) deployment; assert it succeeds, that the
search hit `/v5/searchByName`, and that the child hop hit a `/v4/...` path.

**Note**: Also P1. The pin itself lands in T042; this phase proves it and covers the
two-generation traversal.

- [X] T056 [US2] Convert the search hop in `src/domains/catalogue/tools/findCatalogueEntity.ts` to its `searchByName` handle, deleting the `SEARCH_PATH` constant, and pass `instances` via the handle's `instancesIn: 'body'`
- [X] T057 [US2] Add `case: the search is served by v5 on a v4-default deployment (FR-004, SC-004)` to `test/integration/findCatalogueEntity.test.ts`, asserting the search request hit `/v5/searchByName` while default config is v4
- [X] T058 [US2] Add `case: a search on a v4 default is never degraded or refused (FR-004, Story 2 scenario 2)` to `test/integration/findCatalogueEntity.test.ts`, covering all four resolution outcomes — resolved, candidates, none, tooBroad — with unchanged shapes
- [X] T059 [US2] Add `case: one tool call spanning v5 search and v4 children aggregates completeness identically to a single-generation traversal (FR-009, FR-018, SC-008)` to `test/integration/findCatalogueEntity.test.ts`: 206 on the v5 hop alone, then 206 on the v4 hop alone, each marking the whole result incomplete
- [X] T060 [US2] Add `case: a timeout on the v4 child hop after a successful v5 search still yields TIMEOUT_PARTIAL (FR-010, FR-018)` to `test/integration/findCatalogueEntity.test.ts` — the generation boundary must not reset, soften, or duplicate the verdict
- [X] T061 [US2] Add `case: a 401 on the v4 child hop after a v5 search still surfaces as auth (001-FR-003)` to `test/integration/findCatalogueEntity.test.ts`, confirming the existing auth-wins rule survives a cross-generation traversal

**Checkpoint**: The hero tool works on a v4 default, spanning two generations with one correct
verdict. Together with US1 this is the shippable increment.

---

## Phase 6: User Story 3 — An operator pins the generation (Priority: P2)

**Goal**: The deployment default is a configuration choice, taking effect for every request, with
an invalid value refusing startup.

**Independent Test**: Start with each supported setting and assert which generation each capability
consults; assert startup refusal for an unsupported value.

**Note**: The parsing lands in T030-T032; this phase proves the end-to-end effect.

- [X] T062 [P] [US3] Add `case: GMA_CATALOGUE_GENERATION=v5 routes every operation to v5 (FR-013, SC-005, Story 3 scenario 2)` to `test/integration/listInstances.test.ts` and `test/integration/getCatalogueEntity.test.ts`
- [X] T063 [P] [US3] Add `case: unset and v4 produce identical routing (FR-013, Story 3 scenario 1)` to `test/unit/surface.test.ts`, asserting the two resolutions are deeply equal
- [X] T064 [US3] Add `case: generation is never an agent-supplied argument (FR-013, Story 3 scenario 4)` to `test/protocol/smoke.test.ts`, asserting no tool's input schema accepts a generation, version, or path field and that an extra `generation` argument is rejected rather than honoured
- [X] T065 [US3] Add `case: no tool schema, description, or output mentions a generation (FR-012)` to `test/protocol/smoke.test.ts`, asserting the serialised tool list contains neither `v4` nor `v5` nor `generation`

**Checkpoint**: The default is a real operational choice, not relocated hard-coding.

---

## Phase 7: User Story 4 — A future capability declares a v5 requirement (Priority: P3)

**Goal**: A capability needing v5 declares it once and is honoured on every deployment.

**Independent Test**: Declare a pin, run on a v4-default deployment, assert only that operation
moved.

- [X] T066 [P] [US4] Add `case: a pinned operation is honoured while its siblings follow the default (FR-005, SC-007, Story 4 scenario 1)` to `test/unit/surface.test.ts`, using a hypothetical extra pin to prove per-operation granularity is real and not an artefact of `searchByName` being the only pin
- [X] T067 [P] [US4] Add `case: an unpinned operation follows the deployment default (Story 4 scenario 2)` to `test/unit/surface.test.ts`
- [X] T068 [P] [US4] Add `case: a pin matching the deployment default is a no-op, not a conflict (Story 4 scenario 3)` to `test/unit/surface.test.ts`
- [X] T069 [P] [US4] Add `case: removing a pin moves an operation back to the default without other change (spec edge case 8)` to `test/unit/surface.test.ts`, using a hypothetical descriptor where the operation is available on both — proving that if upstream ever adds by-name search to v4, the migration is deleting one pin, not a rewrite
- [X] T070 [US4] Add a short "Adding a capability that requires v5" section to `test/fixtures/README.md` or a comment block in `src/core/surface.ts`, stating the one-line change (`CATALOGUE_PINS`) and that omitting it fails at startup rather than at first use (SC-007, FR-006)

**Checkpoint**: The mechanism is general, and `searchByName` is demonstrably its first instance
rather than a carve-out.

---

## Phase 8: Polish & Cross-Cutting

- [X] T071 Add every new must-cover case from [quickstart.md](./quickstart.md) Validation 1 to `test/MUST-COVER.md`, each naming its `describe('case: …')` block and file, including the two R8 rows
- [X] T072 [P] Update the fixture outcome tables in `test/fixtures/README.md` to state that one body serves both generations, why that is sound (research.md R2), and that soundness is re-verified manually because CI cannot reach `../gma-service` (R3)
- [X] T073 [P] Correct `docs/gma-mcp-server-plan.md` §2, §4.1-§4.3, decisions #8/#13/#14/#15/#16, and §6, which name v5 paths as the v1 surface. Non-blocking — it is a design record, not governing — but it must not be left contradicting shipped code
- [X] T074 [P] Update `README.md` if it names the catalogue surface, so the documented default is v4
- [X] T075 Run `npm run lint` and `npm run format`, confirming the ESLint module-boundary rule still passes — no `core → domain` import was introduced by the startup wiring
- [X] T076 Run `npm run test:coverage` and confirm the constitutional gates: ≥90% line / ≥85% branch overall, ≥95% line for `core/`. `core/surface.ts` is new `core/` code and must meet the 95% line bar; a shortfall is a failure, never a reason to lower a threshold
- [X] T077 Run `npm run test:agent` and confirm the local CLI agent harness still drives the server end to end — it exercises the real registration path that T042 changed
- [X] T078 Perform [quickstart.md](./quickstart.md) Validation 3 (fail-fast on generation config) against a local run: `v6` refuses startup, `v4` starts, unset starts as v4
- [X] T079 Perform [quickstart.md](./quickstart.md) Validation 5 (manual schema-parity re-verification against `../gma-service`) and record the date in `research.md` R2
- [ ] T080 **MANDATORY** — perform [quickstart.md](./quickstart.md) Validation 4c against live non-production GMA: a real subclass returns **non-empty** `children`, and a real event type returns **two-deep** `ancestors`. Both paths are covered only by hand-crafted fixtures, so nothing in the automated suite can detect a wrong reading of the schema. An empty result here means the R8 correction is wrong — investigate, do not ship
- [ ] T081 Perform [quickstart.md](./quickstart.md) Validation 4a, 4b and 4d against live non-production GMA: v4 serves the non-search tools, the search hop logs `generation=v5` while the child hop logs `generation=v4`, and `GMA_CATALOGUE_GENERATION=v5` produces the same results with every line `generation=v5`
- [X] T082 Walk [quickstart.md](./quickstart.md)'s Definition of Done and tick every box, confirming in particular that no credential appears in any log, trace, or error message

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Governance)**: no code dependencies — **blocks everything**. No code merges until the constitution is v1.1.0
- **Phase 2 (R8 corrections)**: depends on Phase 1 merging; **blocks Phase 3+**, because generation tests must assert against real response shapes
- **Phase 3 (Foundational)**: depends on Phase 2 — **blocks all user stories**
- **Phase 4 (US1)** and **Phase 5 (US2)**: both depend on Phase 3. Independent of each other, though both are P1 and ship together
- **Phase 6 (US3)**: depends on Phase 3; independent of US1/US2
- **Phase 7 (US4)**: depends on Phase 3 only — it is pure `surface.ts` unit work
- **Phase 8 (Polish)**: depends on every story intended for the release

### Critical path

```
T001-T005 (constitution)
   └─► T006-T012 (fixtures red) ─► T013-T019 (source green)
          └─► T020-T028 (surface) ─► T030-T033 (config) ─► T034-T041 (client/telemetry)
                 └─► T042-T045 (wiring)
                        ├─► T046-T055 (US1)
                        ├─► T056-T061 (US2)
                        ├─► T062-T065 (US3)
                        └─► T066-T070 (US4)
                               └─► T071-T082 (polish + live validation)
```

### Within Phase 3

T020 → T021 → T022 → T024 are strictly sequential in `surface.ts`, each building on the last; T023 (the `errors.ts` factory) precedes T024, and T025 verifies the architecture assertion afterwards. T030-T031
depend on T020 for the `Generation` type. T034-T036 depend on T022 for `ResolvedOperation`.
T042-T045 depend on everything before them.

### Ordering note on T012

T012 is deliberately a task that expects **failure**. It is the checkpoint proving the fixtures were
genuinely corrected rather than adjusted to keep the suite green — the exact mistake that produced
the R8 defects in the first place.

### Parallel Opportunities

- **Phase 1**: T001-T004 all edit the same file — sequential. T005 last
- **Phase 2**: T006-T010 are five different fixture files — fully parallel. T013/T014 are different source files — parallel. T016/T017 are different test files — parallel
- **Phase 3**: T026-T029 (one new test file) parallel with each other; T032, T033, T038 touch different files and are parallel
- **Phase 4**: T049-T051 are three different test files — parallel. T046-T048 are three different source files — parallel. T053 (cross-generation id) is independent of both
- **Phase 6/7**: T062-T063 and T066-T069 are parallel within their phases
- **Phase 8**: T072-T074 are parallel; all live validations (T078, T079, T080, T081) are sequential against one deployment

---

## Parallel Example: Phase 2 fixtures

```bash
# All five fixture corrections at once — five distinct files, no shared state:
Task: "Correct test/fixtures/gma/entities/200-eventTypes-children.json — eventTypes → entities"
Task: "Correct test/fixtures/gma/entities/206-partial.json — eventTypes → entities"
Task: "Correct test/fixtures/gma/entities/200-success.json — nested superclass → flat scalars"
Task: "Correct test/fixtures/gma/entities/200-eventType.json — nested chain → flat scalars"
Task: "Correct test/fixtures/gma/entities/206-partial-entity.json — nested superclass → flat scalars"

# Then, serially, the checkpoint that must FAIL:
Task: "Run npm test and confirm child-listing and ancestry tests now fail"
```

## Parallel Example: Phase 4 test parameterisation

```bash
Task: "Parameterise test/integration/listInstances.test.ts over both generations"
Task: "Parameterise test/integration/getCatalogueEntity.test.ts over both generations"
Task: "Parameterise the child-listing cases in test/integration/findCatalogueEntity.test.ts"
```

---

## Implementation Strategy

### The MVP is US1 + US2 together

Unusually, the P1 MVP spans two stories. US1 alone would leave `find_catalogue_entity` broken on a
v4 default, because v4 has no by-name search — so shipping US1 without US2 would delete the tool the
server exists for. They are one increment.

### Recommended sequence

1. **Phase 1** — amend the constitution to v1.1.0. Merge it before writing any code
2. **Phase 2** — correct the fixtures (watch the suite go red at T012), then the two read paths
   (watch it go green at T019). Reviewable and revertible on its own
3. **Phase 3** — build the mechanism. Nothing user-visible changes yet; the default is still
   whatever the table says
4. **Phases 4 + 5** — the shippable increment. **STOP and run quickstart Validations 1-3, plus 4a,
   4b and — mandatorily — 4c**
5. **Phase 6** — make the default a real operational choice
6. **Phase 7** — prove the mechanism generalises
7. **Phase 8** — docs, coverage, and the remaining live validations

### Two things worth stopping for

**T012 must fail.** If the suite is green after the fixtures are corrected, a fixture was not
actually corrected, or a test asserts something weaker than believed. Investigate before continuing.

**T080 is not optional.** The R8 corrections rest on a reading of GMA's OpenAPI schema, verified
against its MapStruct converters and domain records but never against a live response. Every
automated test in this repository uses hand-crafted fixtures, so all of them would pass even if that
reading were wrong. One real subclass with children and one real event type with ancestry is the only
check that closes the gap.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task
- `[Story]` labels appear only on user-story phases; Phases 1, 2, 3 and 8 carry none, by the
  template's rule
- **SC-010** (zero upstream code or configuration changes) is satisfied by construction: no task
  in this list touches `../gma-service`. Verified by the task inventory itself, not by a test
- **82 tasks**: 5 governance, 14 R8 corrections, 26 foundational, 10 US1, 6 US2, 4 US3, 5 US4,
  12 polish
- `src/core/completeness.ts`, `src/core/errors.ts` (logic), `src/core/identity.ts`,
  `src/core/instances.ts`, `src/core/types.ts`, `src/domains/catalogue/schemas.ts`,
  `src/domains/catalogue/resolve.ts` and `src/domains/catalogue/mapSearchResults.ts` appear in **no
  task**. A feature that changes which upstream generation answers should not need to touch the tool
  surface or the safety-critical verdict logic — that absence is the design's main structural
  evidence, so treat any task that starts editing them as a signal to re-read the plan
- Commit after each task or logical group; stop at any checkpoint to validate independently
