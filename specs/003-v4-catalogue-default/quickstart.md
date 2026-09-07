# Phase 1 Quickstart: Validating the v4 Default

**Date**: 2026-09-07 | **Contracts**: [contracts/generation-selection.md](./contracts/generation-selection.md) | **Types**: [data-model.md](./data-model.md)

How to prove this feature works. Everything from
[001's quickstart](../001-catalogue-mcp-tools/quickstart.md) still applies — this adds what is
specific to generation selection, plus the **two live checks that are now mandatory** because of
research R8.

---

## Prerequisites

As 001, plus:

- `../gma-service` checked out, for the manual schema-parity re-verification (Validation 5). Not
  needed for the automated suite.

## Setup

```bash
npm install
cp .env.example .env    # then fill in as 001 describes
```

`GMA_CATALOGUE_GENERATION` is **optional** and should be left unset for the default path — unset
means `v4` (FR-013).

---

## Validation 1 — Automated suite

The primary gate. Fully offline.

```bash
npm test
npm run test:coverage    # constitutional gates: ≥90% line / ≥85% branch, ≥95% line for core/
```

### New must-cover cases

Each needs a test whose `describe('case: …')` block names it, and each must be added to
[`test/MUST-COVER.md`](../../test/MUST-COVER.md).

| Case | Asserts |
|---|---|
| Default config → each capability's non-search operations go to a **v4** path | **FR-001, FR-017, SC-001** |
| Default config → the by-name search goes to a **v5** path | **FR-004, FR-017, SC-004** |
| `GMA_CATALOGUE_GENERATION=v5` → every operation goes to a v5 path | FR-013, Story 3 scenario 2 |
| `GMA_CATALOGUE_GENERATION` unset vs `v4` → identical routing | FR-013, Story 3 scenario 1 |
| `GMA_CATALOGUE_GENERATION=v6` (and `V4`, and empty-after-trim) → startup fails naming the variable | FR-014, SC-006 |
| `searchByName` pin removed on a v4 default → **startup** fails naming capability + operation + generations | **FR-006** |
| Pin honoured on a v5-default deployment as a no-op | Story 4 scenario 3 |
| A capability spanning both generations aggregates completeness identically to a single-generation traversal | **FR-018, SC-008** |
| Each tool, each outcome (200/206/400/401/404/500/timeout), parameterised over **both** generations | **FR-016, SC-003** |
| `generation` present in the log line for every upstream call | FR-015, SC-009 |
| No tool input or output schema mentions a generation | FR-012 |
| Availability table invariants (paths ⇔ availableOn; path prefix matches its generation key) | R1 encoded as data |
| Resolution never returns a generation outside `availableOn`, and never retries | **FR-002, FR-007** |
| An identifier obtained under one generation resolves under the other | spec edge case 2 |
| Removing a pin moves an operation back to the default with no other change | spec edge case 8 |
| **`subclassEventTypes` children read from `entities[]`** | **R8 defect 1** |
| **Ancestry derived from flat `superclassId`/`subclassId` scalars, for subclass and event type** | **R8 defect 2, 001-FR-014** |
| Missing or blank ancestry scalars → shorter chain, never a fabricated ancestor | R8 |

### Regression check on output equality (SC-002)

The strongest single assertion available: for one 200 and one 206 body, call each tool with
default (v4) config and then with `v5` config, and assert the two agent-facing payloads are
**deeply equal**. If routing leaks into the result, this fails.

---

## Validation 2 — Protocol smoke

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

**Expected**: exactly three tools, unchanged names and descriptions, and **no generation, version,
or path** anywhere in any input schema, output schema, or description (FR-012, SC-002).

---

## Validation 3 — Fail-fast on generation config

```bash
GMA_CATALOGUE_GENERATION=v6 npm run dev     # → refuses to start, names the variable
GMA_CATALOGUE_GENERATION=v4 npm run dev     # → starts
npm run dev                                  # → starts, v4 (unset === v4)
```

**Expected**: the invalid value never starts and never silently falls back (FR-014, SC-006).

---

## Validation 4 — Live GMA (manual, pre-release) — **two steps now mandatory**

Never in CI: needs a human token, and cannot force failure modes.

```bash
export GMA_USER_TOKEN="<your OKTA access token>"
npm run dev
```

Run 001's Validation 3 steps 1–5 first (they must still pass against v4), then:

### 4a — v4 default serves the non-search tools

1. `list_instances` → real brand codes, `complete: true`.
   Log line: `operation=listInstances`, **`generation=v4`**, `path=/v4/instances`.
2. `get_catalogue_entity` with a known subclass id → the entity, `generation=v4`.

### 4b — the by-name search still works on a v4-default deployment

3. `find_catalogue_entity` with a name you expect to be unique → `kind: 'resolved'`.
   Logs must show **`generation=v5`** for the search hop and **`generation=v4`** for the child hop
   — one tool call, two generations, one aggregated `completeness` (FR-004, SC-008).

### 4c — ⚠️ MANDATORY: the two R8 corrections, against real GMA

These are **required**, not optional. Both paths are covered only by hand-crafted fixtures, so a
corrected fixture is only as good as this reading of the schema. Nothing else in this feature can
detect it if that reading is wrong.

4. `find_catalogue_entity` with a name that resolves to a **subclass you know has event types** →
   `children` is **non-empty**.
   *Before this feature's correction this returned `[]` with `complete: true` for every subclass.
   An empty `children` here means the correction is wrong or incomplete — investigate, do not
   ship.*
5. `get_catalogue_entity` with `type: 'eventType'` and a real event type id → `ancestors` has
   **two** entries, superclass then subclass, both with real ids and names.
   *Before the correction this was always `[]`. A `[]` here means the same — investigate.*

### 4d — v5 default still works

```bash
GMA_CATALOGUE_GENERATION=v5 npm run dev
```

6. Repeat steps 1, 2, 4 and 5 → same results, every log line `generation=v5` (Story 3 scenario 2).

---

## Validation 5 — Manual schema-parity re-verification

Because one fixture body serves both generations (research R2, R3), and CI cannot check that,
re-verify by hand before any release that changes generation behaviour:

```bash
cd ../gma-service/gma-api/src/main/resources/static

# 1. Every operation the tools use still exists on v4, and searchByName still does not
grep -n "^  /v4/" api_catalogue_v4.yaml
grep -ic "searchbyname" api_catalogue_v4.yaml          # expect 0

# 2. Neither generation has deprecated operations
grep -c "deprecated: true" api_catalogue_v4.yaml api_catalogue.yaml   # expect 0 and 0

# 3. The fields the tools read are still shaped the same on both
#    (entities[], flat superclassId/superclassName/subclassId/subclassName,
#     successfulConfigSources/failedConfigSources/errors[].configSource)
```

Any divergence means the shared fixtures are no longer sound: fork the affected fixture by
generation and update research R2 with the new finding.

---

## Definition of done

Ticked 2026-09-07 at implementation time. The two unticked boxes are the live-GMA checks, which
need a human token and a reachable non-production GMA — see the note below them.

- [x] `npm test` green (590 tests); coverage gates met — 99.22% line / 91.45% branch overall,
      `core/surface.ts` at 100% line and branch against the 95% bar for new `core/` code
- [x] Every new must-cover case present, named, and listed in `test/MUST-COVER.md`
- [x] Both-generation parameterised outcome tests pass (FR-016, SC-003) — all three tool suites
      plus the client suite run under `describe.each(BOTH_GENERATIONS)`
- [x] Output-equality regression check passes (SC-002) — `toEqual` **and** identical
      `JSON.stringify`, for 200 and 206 bodies across all three entity types
- [x] Protocol smoke shows no generation anywhere in the tool surface (FR-012), and an extra
      `generation` argument is ignored rather than honoured
- [x] Invalid generation value refuses startup; unset behaves as `v4` — verified against a real
      `node dist/index.js`: `v6`, `V4`, `4` and `latest` each exit **78** naming the variable
      and its accepted values; `v4`, `v5`, unset and empty all start
- [x] Removing the `searchByName` pin on a v4 default fails at **startup** (FR-006) — verified by
      actually emptying `CATALOGUE_PINS` and running the built server, which refused with
      *"Capability \"catalogue\" requires operation \"searchByName\" on generation \"v4\", but that
      operation exists only on: v5"*
- [ ] **Live 4c: real subclass children non-empty, real event-type ancestry two-deep** — ⚠️ **STILL
      REQUIRED, MANDATORY BEFORE RELEASE.** See below
- [ ] Live 4d with `GMA_CATALOGUE_GENERATION=v5` — requires the same live access
- [x] Validation 5 schema parity re-verified and dated — see the verification log in research R2,
      re-run in full against `../gma-service` on 2026-09-07
- [x] **Constitution amended to v1.1.0** (research R9) — merged first, as its own commit touching
      only that file
- [x] `.env.example` documents `GMA_CATALOGUE_GENERATION`, left commented out
- [x] `test/fixtures/README.md` records the corrected shapes and the shared-across-generations
      rationale, plus the rule that the schema wins when a fixture disagrees with it
- [x] No credential in any log, trace, or error message — every log line the suite emits was
      scanned: **zero** occurrences of `eyJ`, `Bearer`, `authorization`, `token`, `access_token`,
      or either test subject's email. The only fields emitted anywhere are
      `errorKind, event, generation, hop, latencyMs, level, operation, path, retryable, status, tool, ts`,
      and `path` is always a **template** — no emitted path carried an interpolated id

### ⚠️ What is NOT yet verified, and why it matters

**Live Validation 4c has not run.** It needs a human OKTA token against a reachable
non-production GMA, which is not available in this environment.

This is the one gap the automated suite structurally cannot close. The **R8 corrections rest on a
reading of GMA's OpenAPI schema** — verified against the schema itself, against
`SearchCatalogueApiDelegateImpl`, and against `gbp.gma.domain.catalogue` records, but never against
a live response. Every test in this repository uses hand-crafted fixtures or inline bodies written
from that same reading, so **all 590 would still pass if the reading were wrong.** That is exactly
how the two original defects survived a green suite.

One real subclass with event types, and one real event type with ancestry, is the only check that
closes it. An empty `children` or an empty `ancestors` there means the correction is wrong —
investigate, do not ship.

Out of scope, deliberately: any fourth tool, any v5-only operation beyond the by-name search,
remote transport, the Prefab scaffold (still deferred), traversal below one level, and any change
to `completeness` derivation.
