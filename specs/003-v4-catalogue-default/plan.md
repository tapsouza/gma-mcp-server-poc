# Implementation Plan: v4 Catalogue Surface by Default

**Branch**: `003-v4-catalogue-default` (working branch: `002-local-cli-agent`) | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-v4-catalogue-default/spec.md`

## Summary

Make the **v4** GMA catalogue surface the default for the three existing tools, with **v5** reached
only where explicitly declared. Nothing about the tool surface changes: same three tools, same
input and output schemas, same completeness semantics.

The mechanism is a single startup resolution step. `core/surface.ts` holds one table of logical
operations — which generations offer each, and each one's path template. At startup, every
capability's declared operations are resolved against the deployment's configured default plus any
per-operation pin, producing `ResolvedOperation` handles the tools hold. **Tools stop naming paths
entirely**, so "exactly one place decides the generation" (FR-003) is structural rather than a rule
someone must remember.

**Three findings shape this plan, and two of them are not about v4:**

1. **v4 has no by-name search at all** ([research.md](./research.md) R1). Not a rename, not a
   different shape — the operation does not exist, and was added to v5 only recently. So
   `find_catalogue_entity`'s search hop stays on v5 via a declared pin while its child hop follows
   the v4 default. One tool call, two generations, one aggregated completeness. This is why pins are
   **per operation**, not per capability (R5).

2. ⚠️ **Two pre-existing defects sit in the exact read path this feature touches** (R8). The
   subclass child listing reads `eventTypes[]` where both generations return `entities[]`, so every
   matched subclass reports `children: []` with `complete: true`. And ancestry is read from nested
   parent objects that neither generation returns — they are flat scalars — so `ancestors` is always
   `[]`. Five hand-crafted fixtures encode the same mistakes, which is why the suite is green. These
   are corrected **within this feature**, as separate labelled tasks, because this feature's central
   promise (behaviour unchanged across generations) cannot otherwise be honestly verified — see
   Complexity Tracking.

3. **The constitution pins the v1 surface to v5 by name** (R9), so a **MINOR amendment to v1.1.0 is
   a blocking prerequisite**, not a follow-up. Governance is explicit that the constitution wins
   over a plan.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS *(unchanged)*

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, OpenTelemetry SDK *(no new
dependency)*

**Storage**: N/A — stateless *(unchanged)*

**Testing**: `vitest`, `msw`; existing fixture library **shared across generations**, with request
handlers parameterised per generation (R2, R3)

**Target Platform**: Developer machine, stdio transport *(unchanged)*

**Project Type**: Single service — modular monolith, shared `core` + domain modules *(unchanged)*

**Performance Goals**: None quantified. Generation resolution happens once at startup and adds zero
per-request work.

**Constraints**: Coverage ≥ 90% line / 85% branch, ≥ 95% line for `core/` (constitutional). No new
agent-facing field. No credential in any log. `completeness.ts` **must not need editing** — if it
does, the design has leaked generation into the safety-critical module.

**Scale/Scope**: 6 logical operations across 2 generations; 3 tools; 1 new config variable; 1 new
core module; 2 read-path corrections; 5 fixtures corrected.

**No NEEDS CLARIFICATION remain.** Every unknown is resolved in [research.md](./research.md).

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-evaluated post-Phase 1. Constitution v1.0.2.*

| Principle | Gate | Status | Evidence |
|---|---|---|---|
| **I. Pass-Through Identity** (NON-NEGOTIABLE) | Token forwarded unaltered, per-invocation; never cached; 401 → `auth` | **PASS** | `identity.ts` untouched. Generation resolves at startup and touches nothing identity-shaped; `options.token` stays a required explicit parameter on the new client signature (R10, [contracts](./contracts/generation-selection.md) §2) |
| **II. Mandatory Completeness Caveat** (NON-NEGOTIABLE) | Structured top-level verdict on every result; single mapping place; multi-hop aggregation | **PASS** | **`completeness.ts` is not edited at all.** Both generations signal partial success by HTTP 206 with identical envelope fields (R2), so the single source of truth stays single. FR-018/SC-008 add a test for a capability spanning both generations |
| **III. Modular Boundaries** | `core ↛ domains`; `domain ↛ domain`; additive growth | **PASS** | `surface.ts` is domain-agnostic → `core/`. The startup check needs domain declarations, so it is wired in `server/register.ts` (may import both): `core/` exposes the validator, the domain exposes the data. No `core → domain` import; ESLint rule and `architecture.test.ts` still enforce |
| **IV. Curated Task-Oriented Tools** | Exactly 3 tools; no GMA DTO leakage; **no deprecated endpoints** | **PASS** | Tool surface byte-identical (FR-008, SC-002). **v4 has zero `deprecated: true` operations** and is documented upstream as current (R1) — so defaulting to it is permitted by the letter and intent. R7 *reduces* upstream leakage in agent-visible error text |
| **V. Config-Driven Ops & Safe Observability** | Env-config only; fail-fast; never agent-supplied; no token/PII logged | **PASS** | One new optional variable, read once at startup, absent from every tool schema. Invalid value → startup refusal. `generation` added to the allowlist is a two-value enum — no credential, no identifier |

**Testing gates**: fixture per outcome per operation ✅ — satisfied by parameterising **handlers**
per generation over shared bodies, which is sound only while the schemas agree; that soundness is
recorded with a date (R2) and re-verified manually ([quickstart.md](./quickstart.md) Validation 5),
because CI cannot reach `../gma-service`. New must-cover cases named in
[quickstart.md](./quickstart.md) Validation 1. Coverage thresholds unchanged.

**Blocking governance item**: the constitution's *"v1 API surface: the v5 catalogue API"* sentence
contradicts this feature. **Amendment to v1.1.0 must merge first** (R9, Complexity Tracking).

**Post-Phase 1 re-evaluation**: all five principles still PASS. The design introduced no new
violation. Two items are recorded in Complexity Tracking: the constitutional amendment, and the R8
read-path corrections.

## Project Structure

### Documentation (this feature)

```text
specs/003-v4-catalogue-default/
├── plan.md                              # This file
├── spec.md                              # Feature specification
├── research.md                          # Phase 0 — R1 (the gap), R8 (the defects), R9 (governance)
├── data-model.md                        # Phase 1 — Generation, descriptors, pins, resolved handles
├── quickstart.md                        # Phase 1 — validation, incl. mandatory live R8 checks
├── contracts/
│   └── generation-selection.md          # Phase 1 — operator, table, declaration, diagnostics
├── checklists/
│   └── requirements.md                  # Spec quality checklist (16/16)
└── tasks.md                             # Phase 2 — created by /speckit-tasks, NOT here
```

### Source Code (repository root)

```text
src/
├── index.ts                             # unchanged
├── server/
│   ├── stdio.ts                         # unchanged
│   ├── register.ts                      # CHANGED: resolves generations at startup, passes handles
│   └── health.ts                        # unchanged
├── core/                                # MUST NOT import from domains/
│   ├── surface.ts                       # NEW: operation table + resolver + availability check
│   ├── config.ts                        # CHANGED: + optional GMA_CATALOGUE_GENERATION (default v4)
│   ├── gmaClient.ts                     # CHANGED: takes ResolvedOperation + params, not a path
│   ├── telemetry.ts                     # CHANGED: + `generation` in the allowlist
│   ├── completeness.ts                  # UNCHANGED — deliberately (Principle II)
│   ├── errors.ts                        # UNCHANGED
│   ├── identity.ts                      # UNCHANGED
│   ├── instances.ts                     # UNCHANGED
│   └── types.ts                         # UNCHANGED
└── domains/
    └── catalogue/
        ├── index.ts                     # CHANGED: declares operations + the searchByName pin
        ├── schemas.ts                   # UNCHANGED — the whole point (FR-008, SC-002)
        ├── mapSearchResults.ts          # UNCHANGED — verified correct (R8)
        ├── resolve.ts                   # UNCHANGED
        ├── traversal.ts                 # CHANGED: handles instead of paths; + R8 defect 1 fix
        └── tools/
            ├── listInstances.ts         # CHANGED: handle instead of path
            ├── findCatalogueEntity.ts   # CHANGED: handle instead of path
            └── getCatalogueEntity.ts    # CHANGED: handles; + R8 defect 2 fix (flat ancestry)

test/
├── fixtures/gma/                        # CHANGED: 5 entity fixtures corrected to the real schema
│   └── README.md                        # CHANGED: shared-across-generations rationale + corrections
├── unit/
│   ├── surface.test.ts                  # NEW: table invariants, resolution, startup failure
│   ├── config.test.ts                   # CHANGED: + generation parsing and validation
│   ├── telemetry.test.ts                # CHANGED: + `generation` allowlisted
│   └── architecture.test.ts             # CHANGED: + no path literal outside surface.ts
├── integration/                         # CHANGED: parameterised over both generations
└── protocol/smoke.test.ts               # CHANGED: asserts no generation in the tool surface
```

**Structure Decision**: Unchanged architecture — the modular monolith and the `core ↛ domains`
boundary stay exactly as 001 established them. The one new module, `core/surface.ts`, is
domain-agnostic and belongs in `core/` by that same rule. The startup availability check is the
only genuinely new wiring, and it lives in `server/register.ts` because that is the one layer
permitted to see both `core/` and a domain — which is what lets the domain own its declarations
without `core/` ever importing a domain.

Notice what is **not** in the changed list: `schemas.ts`, `completeness.ts`, `errors.ts`,
`identity.ts`, `resolve.ts`. A feature that changes which upstream generation answers should not
need to touch the tool surface or the safety-critical verdict logic, and it does not. That is the
main structural evidence the design is correctly scoped.

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Constitutional amendment to v1.1.0 required before merge** (R9) | The constitution names the v1 surface as "the v5 catalogue API" with v5 paths listed explicitly. This feature contradicts that sentence directly, and governance says the constitution wins over a plan | Proceeding without amending would leave code in knowing violation of a ratified document — the failure mode the amendment procedure exists to prevent. Reading the sentence as merely descriptive was considered and rejected: it is under *Technology & Platform Constraints* and worded as a constraint. MINOR because no **principle** changes — only a constraints section — though a maintainer could argue MAJOR since v5-pinned code becomes non-compliant; the amendment PR should state both readings and let the maintainer settle it |
| **Two pre-existing read-path defects corrected inside this feature** (R8) | `traversal.ts` reads `eventTypes[]` where GMA returns `entities[]`; `getCatalogueEntity.ts` walks nested parent objects where GMA returns flat scalars. Five fixtures encode the same mistakes, so the suite is green and proves nothing about these paths. FR-017/FR-018/SC-002 all require asserting behaviour is unchanged across generations — asserting that against a body no generation sends would be verifying nothing | Filing them as separate bugs and shipping the generation change first was the obvious call and was rejected: it would mean **writing new tests that assert known-false behaviour**, and re-affirming under FR-016 five fixtures known to contradict their own stated source. The constitution's fixture rule is already violated by these files on its own terms. The fix is small and mechanical — one field name, one function, five fixtures — touching no tool schema, no completeness, no identity path. Scope is fenced: separate labelled tasks, ordered first, independently reviewable and revertible |
| **One fixture body shared across both generations** rather than a fixture per generation (R2, R3) | Every field the tools read is shape-identical on v4 and v5, verified field by field on 2026-09-07. Duplicating a 21-file library with byte-identical content creates two copies that drift independently | Per-generation fixture trees were rejected as duplication that decays. What makes sharing sound is that the **handler** is parameterised per generation and each run asserts the request path — so routing is genuinely exercised twice and only the body is shared. The residual risk (schemas could diverge later, and CI cannot see `../gma-service`) is bounded by a dated manual re-verification in quickstart Validation 5, not hidden. Vendoring both OpenAPI files here to diff automatically was rejected: a vendored copy goes stale on the next upstream merge, converting a real check into false reassurance |
| **`operation` log field re-keyed** from `GET /v5/instances` to `listInstances` (R7) | A generation-bearing operation label splits every metric series in two the moment the generation changes, which defeats the point of making the generation configurable | Adding `generation` while leaving `operation` as a versioned path was considered. Rejected: dashboards would still fragment, and the versioned path also reaches agent-visible error text, which FR-012 wants free of upstream mechanics. This is a **breaking change to log output**, called out in the contracts so it is not mistaken for a regression, and existing tests asserting the old format are updated deliberately |

**None of these is a shortcut.** Two are the design conforming to verified reality rather than to
a stale document — the same pattern 001 hit with the `status.code` envelope, and resolved the same
way: correct the record rather than quietly contradict it.

## Follow-up actions

1. **BLOCKING — amend the constitution to v1.1.0** before any code from this feature merges (R9):
   generalise the *"v1 API surface"* constraint to name both catalogue generations with v4 as the
   default; reword Principle II's mapping table, the *"Deployed GMA partial-failure contract"*
   subsection, and the fixture-library gate so they are surface-general rather than v5-specific.
   One PR editing only that file, per the amendment procedure.
2. **Correct `docs/gma-mcp-server-plan.md`** — §2, §4.1–§4.3, decisions #8/#13/#14/#15/#16, and §6
   all name v5 paths as the v1 surface. Non-blocking (it is a design record, not governing) but it
   should not be left contradicting the shipped code.
3. **Perform quickstart Validation 4c against live GMA before release.** Mandatory, not optional:
   the R8 corrections are verified only by hand-crafted fixtures, so a wrong reading of the schema
   would be invisible to the entire automated suite.
4. **Re-verify schema parity (Validation 5) and date it** at release time, and again whenever
   `../gma-service` changes its catalogue specs.
