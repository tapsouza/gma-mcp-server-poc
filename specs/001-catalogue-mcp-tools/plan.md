# Implementation Plan: Catalogue MCP Tools (v1 Vertical Slice)

**Branch**: `001-catalogue-mcp-tools` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-catalogue-mcp-tools/spec.md`

## Summary

Build a standalone TypeScript MCP server exposing **three curated catalogue tools**
(`list_instances`, `find_catalogue_entity`, `get_catalogue_entity`) over GMA's v5 catalogue
API. The operator's OKTA token is forwarded **unaltered and per-invocation**, so GMA's own
authorization applies to the real human. Every result carries a **mandatory structured
completeness verdict**, so an agent can never present multi-instance partial data as complete.

Scope is local (stdio) transport and local-only "done". The Prefab scaffold is
**deferred** (decided 2026-09-03): nothing is deployed in this slice, so its
pipeline/TLS/monitoring value is unrealised. Env-config discipline is kept regardless
(FR-018, FR-019, FR-024b), which is what keeps later adoption a configuration exercise.

**One research finding materially corrects the design inputs**: GMA v5 signals partial
success via **HTTP 206 with `successfulConfigSources`/`failedConfigSources`**, not via the
`status.code` envelope described in `docs/gma-mcp-server-plan.md` and in the constitution's
Principle II table. The semantics are unchanged — partial failure is still first-class and
machine-readable — but the parsing layer and every fixture differ. See
[research.md](./research.md) R1.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, OpenTelemetry SDK, structured
logger with field allowlist

**Storage**: N/A — stateless. No credential, entity, or result is ever persisted.

**Testing**: `vitest` (unit + integration + protocol smoke), `msw` for HTTP interception,
fixture library keyed by **HTTP outcome** (revised by R1)

**Target Platform**: Developer machine (macOS/Linux), stdio transport only this slice

**Project Type**: Single service — modular monolith, shared `core` + domain modules

**Performance Goals**: None quantified. Single local operator, no concurrency; latency is
dominated by GMA. Deliberately deferred rather than invented.

**Constraints**: Coverage ≥ 90% line / 85% branch overall, ≥ 95% line for `core/`
(constitutional, not negotiable). No credential in any log, trace, or error. No operational
value hardcoded or agent-supplied. Startup fails on missing config.

**Scale/Scope**: 3 tools, 1 domain, ~6 GMA operations, 2 hops maximum per tool call.

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-evaluated post-Phase 1. Constitution v1.0.1.*

| Principle | Gate | Status | Evidence |
|---|---|---|---|
| **I. Pass-Through Identity** (NON-NEGOTIABLE) | Token forwarded unaltered; never minted/cached/stored; per-env issuer from config; 401 → `auth`; no GAHS compensation | **PASS** | FR-001–FR-004, FR-023a; identity absent from every model ([data-model.md](./data-model.md)); `auth` in error contract |
| **II. Mandatory Completeness Caveat** (NON-NEGOTIABLE) | Structured top-level `completeness` on every result incl. success; `complete` only on unqualified success; multi-hop aggregation; single source of truth for mapping | **PASS** *(with amendment needed)* | `Completeness` + `GmaResult<T>`; aggregation rules and type-level invariant in [data-model.md](./data-model.md); mapping table in [contracts/tools.md](./contracts/tools.md). **The constitution's mapping table itself is keyed on a `status.code` envelope that v5 does not use — see Complexity Tracking.** |
| **III. Modular Boundaries** | `core ↛ domains`; `domains ↛ domains`; per-domain endpoint; additive growth | **PASS** | Structure below; lint rule enforces import direction; SC-009 |
| **IV. Curated Task-Oriented Tools** | Exactly the 3 tools; never generated; never collapse plausible answers; no GMA DTO leakage; no deprecated endpoints | **PASS** | FR-014/FR-022; `ResolutionOutcome` makes auto-picking unrepresentable; v5 only, `search.yaml` avoided |
| **V. Config-Driven Ops & Safe Observability** | Env-config only; fail-fast; no base URL as tool arg; `list_instances` for discovery; no token/PII logged; `traceparent` emitted | **PASS** | `Config` table in [data-model.md](./data-model.md); FR-018–FR-021; allowlist logger (R7) makes SC-006 provable |

**Testing gates** (Development Workflow section): fixture per upstream outcome per operation
✅ (revised to HTTP-keyed per R1); all must-cover cases named ✅
([quickstart.md](./quickstart.md)); coverage thresholds wired into CI ✅.

**Post-Phase 1 re-evaluation**: all five principles still PASS. No new violation was
introduced by the design. The single deviation is the constitution's own factual drift
(Principle II's table), recorded below rather than worked around silently.

## Project Structure

### Documentation (this feature)

```text
specs/001-catalogue-mcp-tools/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — includes the R1 envelope correction
├── data-model.md        # Phase 1 — internal LLM-facing types
├── quickstart.md        # Phase 1 — how to run and prove it
├── contracts/
│   └── tools.md         # Phase 1 — the MCP tool surface
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16)
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT here
```

### Source Code (repository root)

The layout below is now **authoritative** for this slice: the Prefab scaffold is deferred
(see Summary), so no external template constrains it. Should Prefab be adopted before a
later deployment, directory names may yield — what is non-negotiable is the
`core` ↛ `domains` boundary (Principle III), not the paths.

```text
src/
├── index.ts                     # entrypoint: reads config, starts stdio transport
├── server/
│   ├── stdio.ts                 # stdio transport wiring
│   ├── register.ts              # transport-agnostic tool registration (FR-023b)
│   └── health.ts                # identity-free health signal (FR-021)
├── core/                        # SHARED — MUST NOT import from domains/
│   ├── config.ts                # env-config + startup validation (FR-018, FR-019)
│   ├── identity.ts              # per-invocation token extraction (FR-023a) — no globals
│   ├── gmaClient.ts             # typed GMA calls; forwards token + traceparent
│   ├── completeness.ts          # HTTP outcome → Completeness; multi-hop aggregation
│   ├── errors.ts                # HTTP/transport → ToolError mapping (single source)
│   └── telemetry.ts             # OTel + allowlist logger (FR-020)
└── domains/
    └── catalogue/
        ├── index.ts             # registers the 3 tools
        ├── schemas.ts           # zod schemas — LLM-facing, no GMA DTOs
        ├── traversal.ts         # one-level child resolution (FR-025)
        └── tools/
            ├── listInstances.ts
            ├── findCatalogueEntity.ts
            └── getCatalogueEntity.ts

test/
├── fixtures/gma/                # one per HTTP outcome per operation (R1, R5)
├── unit/                        # completeness aggregation, resolution, error mapping
├── integration/                 # each tool vs mocked GMA (msw)
└── protocol/                    # MCP smoke: schemas resolve, one call round-trips
```

**Structure Decision**: Modular monolith with a shared `core` and one `domains/catalogue`
module, per constitution Principle III. `core` holds everything domain-agnostic; the domain
owns its traversal and schemas. Import direction is enforced by a lint rule, not convention,
because reviewer vigilance is not a mechanism. Tool registration lives in
`server/register.ts` — separate from `server/stdio.ts` — so adding an HTTP transport later
touches no tool (FR-023b).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Contracts keyed on **HTTP status** rather than the constitution's `status.code` envelope (Principle II table) | GMA v5 does not expose that envelope; `api_catalogue.yaml` has zero references to `common.yaml`, and 206 + `successfulConfigSources` is the actual contract (R1) | Building to the documented envelope would mean parsing a field that does not exist and a fixture library made of fiction. Using the older surface that *does* carry the envelope was rejected: those operations are `deprecated: true`, which FR-022 and Principle IV forbid. **Every completeness rule is preserved** — only the parsing differs. Requires a **PATCH amendment** to the constitution's Principle II table. |
| `TOO_BROAD` derived client-side from result cardinality rather than parsed from upstream | v5 has no `TOO_MANY_EVENTS` response; it exists only on the older envelope, produced inside GMA's IPMA provider (R2) | Omitting too-broad entirely would drop FR-015 and leave agents with silently truncated answers. Client derivation is deterministic and testable, and does not depend on a flag we cannot provoke. |

**Neither entry is a shortcut.** Both are the design conforming to verified reality instead of
to a stale document, and both are recorded so the constitution can be corrected rather than
quietly contradicted.

## Follow-up actions (outside this plan's scope)

1. ~~Amend constitution Principle II (PATCH).~~ **Done 2026-09-03** — constitution is now
   **v1.0.2**: Principle II's table is keyed on HTTP status, the outcome vocabulary is
   surface-independent, and a "Deployed GMA partial-failure contract" subsection records the
   verified facts. Principles IV and V and the fixture/must-cover gates were updated to match.
2. ~~Correct `docs/gma-mcp-server-plan.md`.~~ **Done 2026-09-03** — §2, §4.1, §4.2, §4.3,
   decisions #8/#9/#13/#14/#15, the repo layout, Phase 0/1 steps, §6 testing, and §9 summary
   all corrected.
3. ~~Resolve the Prefab template before implementation.~~ **Closed 2026-09-03** — scaffold
   deferred while local-only; constitution v1.0.2 records it as still blocking for any
   non-local deployment.
