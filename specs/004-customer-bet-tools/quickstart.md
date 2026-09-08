# Quickstart: Customer Risk & Bet Tools (FanDuel)

**Feature**: `004-customer-bet-tools` | **Date**: 2026-09-08

How to run this slice and prove it works. Types are in [data-model.md](./data-model.md); the
tool surface is in [contracts/tools.md](./contracts/tools.md).

---

## Prerequisites

1. Node.js 22 LTS, dependencies installed (`npm ci`).
2. **Constitution v1.2.0 or later.** The surface-register amendment landed 2026-09-08; without
   it, `GET /crs/contexts` is absent from the register and a reviewer must block on
   Principle IV. Verify with `grep '^\*\*Version\*\*' .specify/memory/constitution.md`.
3. `.env` with the existing required values plus, optionally, the two new bounds:

   ```bash
   CUSTOMER_MAX_BETS=20                 # optional; default 20
   CUSTOMER_MAX_EVENT_RESOLUTIONS=10    # optional; default 10
   ```

   Both are optional with defaults, so **no existing deployment's startup breaks**.
4. For live validation only: `GMA_USER_TOKEN`, or `OKTA_CLIENT_ID` for interactive sign-in
   through the agent harness.

---

## Validation 1 — the offline suite (blocking, CI)

```bash
npm run lint
npm test
npm run test:coverage
```

**Expected**: all suites pass; coverage ≥ 90% line / 85% branch overall and ≥ 95% line for
`src/core/**`. A shortfall **fails the run**; lowering a threshold requires a constitutional
amendment and is never a fix for a failing build.

### 1a. The amendment-acceptance gate (blocking, and check this first)

The constitution makes this the acceptance condition for the shared-type amendment:

```bash
git stash && npm test              # baseline, before the domain exists
```

> **Every existing catalogue test must pass UNMODIFIED** after `Completeness` gains
> `unavailableComponents` and `ErrorKind` gains `forbidden`. A change that requires editing an
> existing catalogue test to accommodate a shared-type addition is **not additive**, and the
> amendment's MINOR classification is then wrong.

Two known pressure points, both to be verified rather than assumed:

- `test/integration/*.test.ts` asserts `Object.keys(result).sort()` on **tool results** (not
  on `Completeness` itself), so a new field inside the verdict does not disturb them.
- `test/unit/errors.test.ts:32` currently asserts `403 → upstream, retryable: true`. This test
  **will** need to change — and that is a **deliberate correction of a defect**, not
  accommodation: it presently documents a retry loop. Record it as such in the PR; it is the
  one edit the gate permits, because the behaviour itself is what the amendment changes.

### 1b. Must-cover cases (blocking)

Each must be covered by a test **naming the case**, and recorded in `test/MUST-COVER.md`.

Inherited from the constitution's standing list — per new tool: single-match auto-resolve;
multi-match candidates; zero-match; partial-success caveat at top level; too-broad → narrow
hint (where applicable); multi-hop aggregation where one partial hop flags the whole result;
argument error and upstream failure → tool error; `401` → auth-flagged; timeout with partial
data vs timeout with none.

Added by v1.1.0 for composite and read-only tools — **these are the ones this feature exists
to get right**:

| Case | Why it is blocking |
|---|---|
| A `200` carrying reported errors is marked **incomplete** | The single worst defect this feature could ship (SC-002) |
| A composite answer missing one section is reported via `unavailableComponents` and is **never** `complete: true` | The whole reason for the second axis (SC-001) |
| `403` produces a non-retryable `forbidden` error the agent does **not** retry | SC-009 |
| **Every** distinguishable resolution outcome, with the tool's own matching failure kept separate from a genuine absence | SC-004 — a systematic defect must stay observable |
| A bound reached is **reported**, not silently truncated | FR-010, FR-023, SC-013 |
| Duplicate work deduplicated before fan-out | SC-013 |
| An automated assertion that **no** caller-supplied value can reach an upstream query or path | SC-010 |

Plus this feature's own:

| Case | Requirement |
|---|---|
| Three jurisdictions return three configurations, none merged | FR-006, SC-003 |
| All four jurisdiction-matching outcomes, each exercised | FR-018, SC-004 |
| An unresolved jurisdiction is `complete: true` — matching is **not** incompleteness | FR-027 |
| A multi-leg bet never attributes bet-level figures to one leg | FR-021, SC-006 |
| `notComparable` emitted for each of its three triggers | FR-020 |
| More than one bet match → all candidates, **zero** further hops | FR-022 |
| No returned bet carries a staff-authored note | FR-004 |

### 1c. Privacy assertion (blocking)

```bash
npm test -- test/unit/privacy.test.ts
```

An automated check must prove that **no** account identifier, bet identifier, receipt
identifier, customer name, or customer financial value appears in any log field, trace field,
or error message (FR-029, FR-030, SC-007).

The specific trap: `core/gmaClient.ts` currently logs the **interpolated** `path`, which is
safe for `/v5/superclasses/{urn}` and a **PII leak** for `/crs/accounts/{accountId}`. The test
drives a customer-domain call with a recognisable account identifier and asserts the identifier
appears in **no** emitted line — proving the path-template change (research.md R13) actually
took effect.

---

## Validation 2 — the protocol surface

```bash
npm test -- test/protocol/
```

**Expected**:

- Tool discovery lists exactly the **eight** tools: the three catalogue tools unchanged, plus
  `list_jurisdiction_contexts`, `get_customer_risk_profile`, `find_customer_bets`,
  `get_bet_risk_context`, `get_customer_betting_metrics`.
  (`test/protocol/smoke.test.ts:51` currently asserts *exactly three*; extending that list is
  the intended, reviewed way this surface grows — Principle IV.)
- Every schema resolves, and every tool has a non-empty description.
- `completeness` appears in **no** tool's input properties.
- One customer-domain call round-trips, and its `structuredContent` carries both completeness
  axes.

---

## Validation 3 — the local agent harness (manual, no live GMA)

```bash
npm run agent
```

Ask questions that exercise the honesty properties rather than the happy path. What matters is
what the agent **refuses** to claim:

| Ask | What to look for |
|---|---|
| *"What is account &lt;id&gt;'s risk configuration?"* | Per-jurisdiction answer, **not** a single summary. If the agent averages across states, the tool description has failed. |
| *"Why did bet &lt;id&gt; get this limit?"* | Applied and configured values side by side. The agent must **not** narrate a calculation. |
| *"Is this customer restricted on soccer?"* | Only claimed for legs whose `resolution` is `resolved`. |
| *"Show me their recent bets."* | The ordering caveat is relayed. |
| *"Their metrics?"* | The agent asks which aggregation, rather than picking one. |

---

## Validation 4 — live GMA (manual, pre-release, never CI)

Token management is human-in-the-loop and the failure modes below cannot be forced against a
live BFF, which is why this step is manual.

```bash
GMA_USER_TOKEN=<token> npm run agent
```

**This step exists to close research.md's three open assumptions.** Nothing else here can:

| Check | Closes | What to record |
|---|---|---|
| One real bet leg resolves via `GET /v5/events/{id}` | **R9** | Which `entityIds` member worked (`rampId` or `gbpId`). If **every** leg reports `notResolvedIdentifierUnusable`, the assumption is wrong — and the design made that visible instead of reporting "unrestricted". |
| A bet whose applied `liabilityGroup` matches a configured group | **R14** | Whether the applied string equals `.description` or `.code` |
| A customer with a jurisdiction absent from their configuration list | **R8** | Whether an unconfigured jurisdiction is omitted — **ask a human who owns CRS**; this one cannot be settled by observation alone |

Also confirm: `GET /crs/contexts` returns a code that is **not** a US state abbreviation
(Ontario is the known case), which is the concrete justification for the fifth tool.

**Do not** attempt to provoke `403`: the QBS authorization flag is `false` in all three
deployed environments and its enforced-operations list contains no read
(research.md R10). Its correctness rests on the fixture and the test, not on a live probe.

---

## What "done" means for this slice

- [ ] Constitution v1.2.0 or later is in effect (the register amendment landed 2026-09-08)
- [ ] Every existing catalogue test passes unmodified (the one `403` test being a documented
      defect correction)
- [ ] Coverage gates pass at the constitutional thresholds
- [ ] `test/MUST-COVER.md` names a test for every blocking case above
- [ ] `test/fixtures/README.md` records provenance for every new fixture, including that the
      CRS fixtures derive from **Java model classes** rather than an OpenAPI schema
- [ ] The privacy assertion passes, including for a path carrying an account identifier
- [ ] R9 and R14 are either closed by Validation 4 or carry an owner and removal condition in
      the PR description
- [ ] No fixture, log, test name, or error message contains a real customer identifier or
      financial value
