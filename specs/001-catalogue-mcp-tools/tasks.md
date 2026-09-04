---

description: "Task list for Catalogue MCP Tools (v1 vertical slice)"
---

# Tasks: Catalogue MCP Tools (v1 Vertical Slice)

**Input**: Design documents from `/specs/001-catalogue-mcp-tools/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/tools.md](./contracts/tools.md),
[quickstart.md](./quickstart.md)

**Tests**: **REQUIRED, not optional.** Constitution v1.0.2 makes the fixture library and the
must-cover cases *blocking*, and enforces coverage gates in CI (≥90% line / ≥85% branch
overall, ≥95% line for `core/`). Tests are **not** written test-first — tests and
implementation may land in the same task or commit (clarified 2026-09-03: fixture-driven and
coverage-gated, no TDD mandate).

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`, `[US2]`, `[US3]` — user story phases only
- Exact file paths in every task

## Path Conventions

Single project at repository root: `src/`, `test/`. Layout is authoritative — the Prefab
scaffold is deferred (research.md R6), so no external template constrains it.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Plain TypeScript project, no scaffold. Nothing here touches GMA.

- [X] T001 Initialise `package.json` at repo root: name `gma-mcp-server`, `"type": "module"`, Node 22 engine constraint, scripts `build`/`dev`/`test`/`test:coverage`/`lint`
- [X] T002 Add `tsconfig.json` at repo root: `strict: true`, `target`/`module` ES2022, `moduleResolution` bundler, `outDir: dist`, `rootDir: src`
- [X] T003 [P] Install runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `@opentelemetry/sdk-node`, `@opentelemetry/api`
- [X] T004 [P] Install dev dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `msw`, `eslint`, `prettier`, `@types/node`
- [X] T005 [P] Configure ESLint in `eslint.config.js` with an import-boundary rule that **fails the build** if `src/core/**` imports from `src/domains/**`, or if one domain imports another (constitution Principle III — enforced, not conventional)
- [X] T006 [P] Configure Prettier in `.prettierrc` and add `.editorconfig`
- [X] T007 Configure `vitest.config.ts` with coverage thresholds: global 90% lines / 85% branches, and a per-directory override of 95% lines for `src/core/**`. A shortfall must fail the run, not warn
- [X] T008 [P] Add `.env.example` documenting `GMA_BASE_URL`, `GMA_DEFAULT_INSTANCES`, `OKTA_ISSUER`, `GMA_TIMEOUT_MS`, `GMA_MAX_CANDIDATES`, `LOG_LEVEL` (values illustrative only — never real hosts or tokens)
- [X] T009 [P] Extend root `.gitignore` with `node_modules/`, `dist/`, `coverage/`, `.env`

**Checkpoint**: `npm install && npm run lint && npm test` runs (no tests yet) and the boundary lint rule is active.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: All of `src/core/` plus the fixture library. This is where the constitution's two
NON-NEGOTIABLE principles are implemented.

**⚠️ CRITICAL**: No user story can begin until this phase is complete. Every story depends on
the client, the completeness type, and the error mapping.

### Fixture library (blocking — constitution Development Workflow)

- [X] T010 [P] Create `test/fixtures/gma/instances/` with one fixture per HTTP outcome for `GET /v5/instances`: `200-success.json`, `206-partial.json`, `400-bad-request.json`, `401-unauthorized.json`, `500-server-error.json`. Shape them on `EntityResponseSuccess` / `EntityResponsePartialSuccess` (`successfulConfigSources`, `failedConfigSources`, `errors[].configSource`) per research.md R1 — **not** a `status.code` envelope
- [X] T011 [P] Create `test/fixtures/gma/searchByName/` fixtures for `POST /v5/searchByName`: `200-single-match.json`, `200-multi-match.json`, `200-no-match.json`, `200-many-matches.json` (> 25 results, to drive too-broad), `400-bad-request.json`, `401-unauthorized.json`, `500-server-error.json`. Each result is a `{ superclass?, subclass?, eventType? }` triple per research.md R3
- [X] T012 [P] Create `test/fixtures/gma/entities/` fixtures for `GET /v5/{superclasses|subclasses|eventTypes}/{id}` and `GET /v5/subclasses/{id}/eventTypes`: `200-success.json`, `206-partial.json`, `404-not-found.json`, `401-unauthorized.json`, `500-server-error.json`
- [X] T013 [P] Add `test/fixtures/README.md` recording which fixtures were hand-crafted from the OpenAPI schema rather than captured live (constitution requires hand-crafted fixtures be marked as such)

### Core types and configuration

- [X] T014 [P] Implement `src/core/types.ts`: `Outcome` (`COMPLETE` | `PARTIAL` | `TOO_BROAD` | `TIMEOUT_PARTIAL`), `InstanceError`, `Completeness`, `GmaResult<T>`, `ToolError`, `ErrorKind` — exactly as specified in data-model.md §1, §5, §6
- [X] T015 [P] Implement `src/core/config.ts`: read and validate the six env vars with zod, applying defaults (timeout 30000, maxCandidates 25, logLevel info). Throw a `config` ToolError naming the missing variable. Export a `loadConfig()` called **once at startup** (FR-018, FR-019, FR-024b)
- [X] T016 [P] Unit-test config in `test/unit/config.test.ts`: each required var missing → refuses with that var named; invalid URL rejected; defaults applied; **no value readable from a tool argument**

### Completeness (constitution Principle II — the correctness core)

- [X] T017 Implement `src/core/completeness.ts`: `fromHttpStatus(status, body)` mapping 200 → `COMPLETE` and 206 → `PARTIAL`, translating upstream `configSource` → `instance` at this boundary; `aggregate(hops[])` implementing AND of `complete`, worst-outcome precedence `TIMEOUT_PARTIAL > TOO_BROAD > PARTIAL > COMPLETE`, and deduplicated union of instances and errors; `caveat` generated when incomplete, `null` when complete (data-model.md §1)
- [X] T018 Unit-test completeness in `test/unit/completeness.test.ts`: assert the type-level invariant `complete === true ⟺ outcome === 'COMPLETE' ⟺ failedInstances.length === 0`; every precedence pair; union deduplication; `caveat` null iff complete; **`completeness` present on full success** (FR-005, FR-006, FR-008)
- [X] T019 Implement `src/core/errors.ts` as the **single** place mapping HTTP and transport outcomes to `ToolError`: 400 → `argument`, 401 → `auth`, 404 → `notFound`, 500 → `upstream`, timeout-with-no-data → `upstream`. `retryable: false` for `auth` and `argument`. Never include a token or response body credential in `message` (contracts/tools.md error contract)
- [X] T020 Unit-test error mapping in `test/unit/errors.test.ts`: each status → correct `kind`; `retryable` flags; assert a token passed through the mapper never appears in the resulting message

### Identity and telemetry

- [X] T021 Implement `src/core/identity.ts`: extract the bearer from the **per-request** handler argument and return it as a value. No module-level variable, no singleton, no async-local storage. Export a type that makes the token an explicit parameter rather than ambient state (FR-002, FR-023a)
- [X] T022 Implement `src/core/telemetry.ts`: OTel tracer setup, plus a structured JSON logger using an explicit **field allowlist** (tool name, GMA operation and path, per-hop outcome, resolution outcome, latency). Unlisted fields are never emitted, so a new field cannot leak by being forgotten (FR-020, research.md R7)
- [X] T023 Unit-test the logger in `test/unit/telemetry.test.ts`: attempting to log an object containing `Authorization`, a raw token, or an unlisted key emits neither the key nor its value; assert on span attributes too (SC-006)

### GMA client

- [X] T024 Implement `src/core/gmaClient.ts`: typed `get`/`post` taking `(path, { token, instances, signal })`. Attaches `Authorization: Bearer <token>` **unaltered** and a W3C `traceparent`; applies the configured timeout via `AbortSignal`; returns `GmaResult<T>` for 200/206 and throws a `ToolError` otherwise. Accepts the token as an argument — never reads it from state (FR-001, FR-003, T021)
- [X] T025 Implement instance-code resolution in `src/core/instances.ts`: map short codes (`PP`) to URNs (`urn:i:PP:PP`), fall back to configured defaults when none supplied, and raise an `argument` ToolError naming `list_instances` for an unknown code (FR-017, data-model.md §3, SC-008)
- [X] T026 Integration-test the client in `test/integration/gmaClient.test.ts` against msw using the fixtures: 200 → complete result; 206 → partial with named failed instances; 401 → `auth`; 400 → `argument`; 500 → `upstream`; simulated slow response + abort → timeout handling; **assert the outbound request carried the exact token supplied and a `traceparent` header**
- [X] T027 Integration-test identity isolation in `test/integration/identityIsolation.test.ts`: two client calls in the **same process** with different tokens each forward their own token, with no bleed. This is the test that makes the later remote transport safe (FR-023a, SC-010)

**Checkpoint**: `core` is complete and independently tested. Coverage for `src/core/**` should already be at or above 95% lines. No user story code exists yet.

---

## Phase 3: User Story 1 — Discover brand instances (Priority: P1) 🎯 MVP

**Goal**: An agent can obtain the valid brand instance codes, with a completeness verdict, so
it never has to guess or hardcode them.

**Independent Test**: Invoke `list_instances` with a valid identity against mocked GMA and
assert the returned codes plus the completeness statement. Delivers standalone value — and by
exercising identity forwarding, envelope parsing, and caveat production in one call, it retires
every architectural risk in the design exactly once.

### Implementation for User Story 1

- [X] T028 [P] [US1] Implement `src/domains/catalogue/schemas.ts` with the zod output schema for `BrandInstance` (`code`, `id`, `name`) and the shared `completeness` output shape. LLM-facing only — no GMA DTO field names, no `configSource` (Principle IV)
- [X] T029 [US1] Implement `src/domains/catalogue/tools/listInstances.ts`: no input; calls `GET /v5/instances` via the core client with the per-invocation token; maps the response to `BrandInstance[]`; returns `{ instances, completeness }`
- [X] T030 [US1] Implement `src/server/register.ts`: a **transport-agnostic** module registering domain tools on an MCP server instance, with the tool description from contracts/tools.md §1 — including the instruction to relay caveats (FR-009, FR-023b)
- [X] T031 [US1] Implement `src/domains/catalogue/index.ts` registering the catalogue domain's tools, and wire `list_instances` into it
- [X] T032 [US1] Implement `src/server/health.ts`: an identity-free health signal (FR-021)
- [X] T033 [US1] Implement `src/server/stdio.ts` (stdio transport wiring) and `src/index.ts` (entrypoint: `loadConfig()` → build server via `register.ts` → start stdio). Startup must fail before serving if config is invalid (FR-019)
- [X] T034 [US1] Integration-test in `test/integration/listInstances.test.ts`: 200 → codes + `complete: true`; 206 → codes + caveat naming failed instances + `complete: false`; 401 → `auth` error; 500 → error rather than an empty list presented as complete (Story 1 scenarios 1–4)
- [X] T035 [US1] Protocol smoke test in `test/protocol/smoke.test.ts`: the server lists its tools, `list_instances` round-trips through a real MCP client, and neither `completeness` nor identity appears as an **input** parameter

**Checkpoint**: MVP. The full pipeline works end-to-end — identity forwarded, response parsed, completeness produced, tool callable over MCP. Stop and validate here.

---

## Phase 4: User Story 2 — Find entity by name with disambiguation (Priority: P2)

**Goal**: An agent can find a catalogue entity by partial name and receive it with its
immediate children; when several match, it receives **all** candidates and picks none.

**Independent Test**: Against mocked GMA, assert each resolution outcome — one match, several
matches, none, too-broad — and that completeness aggregates across both hops.

### Implementation for User Story 2

- [X] T036 [P] [US2] Extend `src/domains/catalogue/schemas.ts` with `CatalogueEntity` (`id`, `name`, `type`, `ancestors[]`) and the `ResolutionOutcome` **discriminated union** (`resolved` | `candidates` | `none` | `tooBroad`). The union must make "resolved and candidates both populated" unrepresentable — this is FR-014 enforced by the type system, not by a runtime check (data-model.md §2, §4)
- [X] T037 [US2] Implement `src/domains/catalogue/mapSearchResults.ts`: convert each `SearchByNameResult` triple into a `CatalogueEntity`, deriving `type` from the most specific populated field and `ancestors` from the remaining ones. The ancestor chain is the distinguishing detail FR-014 requires (research.md R3)
- [X] T038 [US2] Implement `src/domains/catalogue/traversal.ts`: one-level child resolution — matched `subclass` → `GET /v5/subclasses/{id}/eventTypes`; matched `superclass` → `GET /v5/superclasses/{id}`; matched `eventType` → **no second hop**. Never traverse deeper (FR-025)
- [X] T039 [US2] Implement `src/domains/catalogue/resolve.ts`: cardinality-based resolution returning `none` for 0, `resolved` (+ traversal) for 1, `candidates` for >1, and `tooBroad` with `narrowBy` when the count exceeds `maxCandidates`. Auto-picking from >1 match must be impossible by construction (FR-014, FR-015, research.md R2)
- [X] T040 [US2] Implement `src/domains/catalogue/tools/findCatalogueEntity.ts`: input `{ name, instances? }`; calls `POST /v5/searchByName` (note: `instancesList` goes in the **request body** here, unlike the GET operations); delegates to `resolve.ts`; aggregates completeness across **both** hops; registers with the contracts/tools.md §2 description
- [X] T041 [P] [US2] Unit-test resolution in `test/unit/resolve.test.ts`: 0/1/many/too-many cardinalities; assert no auto-pick above one match; `narrowBy` populated for too-broad; `ancestors` preserved on every candidate
- [X] T042 [US2] Integration-test in `test/integration/findCatalogueEntity.test.ts`: single match → resolved + children; multi-match → all candidates, none resolved; no match → `kind: 'none'` and **not** an error; too-broad → narrow hint; **206 on hop 2 only → whole result incomplete** (FR-008, SC-011); explicit `instances` honoured and omitted `instances` falls back to the configured default (Story 2 scenarios 1–6)

**Checkpoint**: Stories 1 and 2 both work independently. The hero capability is live and multi-hop caveat aggregation is proven.

---

## Phase 5: User Story 3 — Retrieve entity by identifier (Priority: P3)

**Goal**: An agent holding an entity id — typically one a human chose from US2's candidate
list — can retrieve that entity's details directly.

**Independent Test**: Request a known type and id and assert details plus completeness; then
assert the behaviour for an unknown id and an unsupported type.

### Implementation for User Story 3

- [X] T043 [P] [US3] Extend `src/domains/catalogue/schemas.ts` with the `get_catalogue_entity` input schema: `type` as a zod enum over the three supported types (so an unsupported type is rejected by validation **before** any GMA call), `id`, optional `instances`
- [X] T044 [US3] Implement `src/domains/catalogue/tools/getCatalogueEntity.ts`: dispatch on `type` to `GET /v5/{superclasses|subclasses|eventTypes}/{id}`; return `{ entity, completeness }`; register with the contracts/tools.md §3 description, which points the agent at `find_catalogue_entity` for name-based lookup
- [X] T045 [US3] Integration-test in `test/integration/getCatalogueEntity.test.ts`: valid type and id → entity + completeness; 404 → `notFound` rather than an empty success; unsupported type → `argument` error raised by schema validation with no outbound call made (Story 3 scenarios 1–3)

**Checkpoint**: All three tools functional and independently testable. The US2 → US3 loop closes: a human picks from candidates, the agent retrieves the choice.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T046 Verify the full must-cover matrix from [quickstart.md](./quickstart.md) is present and each test **names** its case; add any missing case rather than adjusting the list
- [X] T047 Run `npm run test:coverage` and close any gap to the constitutional gates. Raise coverage by adding tests — **never** by lowering a threshold (lowering requires a constitutional amendment)
- [X] T048 [P] Add `README.md` at repo root: what the server is, the three tools, how to run stdio locally, the env vars, and an explicit note that remote transport and deployment are out of scope for v1
- [X] T049 [P] Audit the three tool descriptions in `src/domains/catalogue/tools/*.ts` and `src/server/register.ts` for the caveat-relaying instruction and for absence of GMA DTO vocabulary (FR-009, Principle IV)
- [X] T050 Grep the whole of `src/` for any module-level mutable token or config state, confirming identity and configuration are threaded rather than ambient (FR-023a, FR-002)
- [ ] T051 Execute the manual live-GMA validation in [quickstart.md](./quickstart.md) Validation 3 against **non-production** GMA with a real per-environment token, including the expired-token step

  > **BLOCKED — requires a human, by design.** Not executed. This step needs a real OKTA
  > access token from the target environment's authorization server and network reach to a
  > non-production GMA host; neither is available to an automated run, and the constitution
  > states live GMA validation "is manual and pre-release, never CI" because token management
  > is human-in-the-loop. Everything it would exercise is already covered offline against
  > fixtures (see [test/MUST-COVER.md](../../test/MUST-COVER.md)), with one gap only a human
  > can close: whether GMA's runtime behaviour matches the schema the fixtures were built
  > from. Run it before any release: `export GMA_USER_TOKEN=...` then `npm run dev`, and work
  > through quickstart.md Validation 3 steps 1-5 including the expired-token step.
- [X] T052 Verify fail-fast startup (quickstart.md Validation 4): unset `GMA_BASE_URL` and confirm the process refuses to start rather than failing at first request (SC-007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**
- **User Stories (Phases 3–5)**: all depend on Phase 2. Then sequential by priority, or parallel if staffed
- **Polish (Phase 6)**: depends on the stories you intend to ship

### Critical path within Phase 2

`T014` (types) → `T017` (completeness) → `T024` (client) is the spine; `T019` (errors) and
`T021` (identity) are needed by `T024`. Fixtures (T010–T013) and config (T015–T016) are fully
parallel to all of it.

### User Story Dependencies

- **US1 (P1)**: no dependencies beyond Phase 2. Also delivers the shared server wiring (T030–T033) that US2 and US3 register into — which is why it is genuinely first, not merely highest priority
- **US2 (P2)**: needs Phase 2 and the registration wiring from T030–T031. Independently testable
- **US3 (P3)**: needs Phase 2 and the same wiring. Independently testable. `schemas.ts` is touched by all three stories (T028/T036/T043) — sequence those or expect a merge

### Parallel Opportunities

- **Phase 1**: T003–T006, T008, T009 in parallel after T001–T002
- **Phase 2**: all four fixture tasks (T010–T013) in parallel with each other and with T014–T016; T018/T020/T023 follow their implementations
- **Phase 3+**: with multiple developers, US1 → then US2 and US3 concurrently, provided `schemas.ts` edits are coordinated

---

## Parallel Example: Phase 2 Foundational

```bash
# Fixture library — four independent directories:
Task: "Create instances fixtures in test/fixtures/gma/instances/"
Task: "Create searchByName fixtures in test/fixtures/gma/searchByName/"
Task: "Create entity fixtures in test/fixtures/gma/entities/"
Task: "Add fixture provenance README in test/fixtures/README.md"

# Independent core modules, concurrent with the fixtures:
Task: "Implement core types in src/core/types.ts"
Task: "Implement config loading in src/core/config.ts"
```

---

## Implementation Strategy

### MVP scope: Phases 1–3 (T001–T035)

Setup, all of `core`, and `list_instances`. This is the smallest increment that proves the
entire pipeline — identity pass-through, envelope parsing, completeness caveat, MCP round-trip.
**Stop at the Phase 3 checkpoint and validate before writing another tool.** If something in
the design is wrong, it is wrong here, and it is cheapest to find here.

### Incremental delivery

1. Phases 1–2 → foundation, `core` at ≥95% line coverage
2. Phase 3 → **MVP**, validate independently, demo
3. Phase 4 → the hero capability; multi-hop aggregation proven
4. Phase 5 → closes the candidate-selection loop
5. Phase 6 → coverage gates, docs, manual live validation

### Out of scope (do not add tasks for these)

Remote/HTTP transport, MCP OAuth resource-server handshake, shared-environment deployment,
Prefab scaffold adoption, traversal below one level, any fourth tool. Each is deliberately
deferred — see spec.md Clarifications and research.md R6.

---

## Notes

- **Tests are required but not test-first.** Tests and implementation may land together; what
  is blocking is that the fixtures exist and every must-cover case is named.
- Coverage thresholds are constitutional. A failing gate is fixed with tests, never by editing
  the threshold.
- Two mechanisms deliberately replace vigilance with enforcement: the ESLint import-boundary
  rule (T005) and the logger field allowlist (T022). Prefer that pattern wherever a rule could
  otherwise be forgotten.
- Upstream vocabulary (`configSource`, `successfulConfigSources`) is translated to project
  vocabulary (`instance`, `successfulInstances`) at the client boundary and must not appear in
  any tool schema.
- Commit after each task or logical group. Stop at any checkpoint to validate a story alone.
