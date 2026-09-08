# Implementation Plan: Customer Risk & Bet Tools (FanDuel)

**Branch**: `004-customer-bet-tools` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-customer-bet-tools/spec.md`

## Summary

Add a second capability domain — **customer** — alongside the existing catalogue domain,
exposing a FanDuel customer's risk configuration, their bets, their betting metrics, and one
genuinely composite capability that places a single bet's **applied** risk figures beside the
customer risk settings that were **in scope** for it. Read-only, FanDuel only, local (stdio).

The composite is the reason the domain exists. It is also the only capability an agent cannot
assemble from the others: joining a bet leg to a risk override requires resolving the leg's
**event** to obtain its risk-side catalogue position, because bet legs and risk overrides live
in two different trees that meet nowhere else (research.md R5).

**Five tools, not the spec's four.** FR-013 has the agent supply jurisdiction codes to filter
metrics, and those codes are provably unguessable (`NJ`, `PA` — but Ontario is `NXTCANBS`).
Principle V requires a discovery tool for any scoping vocabulary an agent supplies, and
`GET /crs/contexts` provides exactly that list (research.md R7). This mirrors how
`list_instances` serves the catalogue domain, and it also *reduces* the number of results
landing in FR-018's "could not be matched" bucket.

**Three research findings materially change the design inputs:**

1. **A sort option exists.** The spec assumed upstream bet ordering was uncontrollable; QBS
   accepts `params.sort`, and the bet-management front-end's own default is
   `PLACEMENT_DATE DESC`. One of the spec's three UNVERIFIED assumptions is retired (R6).
2. **Three upstream surfaces, three different completeness contracts.** CRS publishes none at
   all; QBS returns `200` with GraphQL `errors[]` and unpopulated fields; the metrics API
   declares only terminal statuses. They map onto one internal vocabulary but cannot share a
   parser (R1).
3. **The interpolated request path is now a PII leak.** `core/gmaClient.ts` logs the real
   `path`, which is harmless for `/v5/superclasses/{urn}` and a personal-data disclosure for
   `/crs/accounts/{accountId}`. This is the one change this feature makes to an existing
   `core` file's behaviour (R13).

A **new** UNVERIFIED assumption is introduced and cannot be avoided: which member of a leg's
`entityIds` is the v5 event identifier (R9). The design makes a wrong answer produce a
**visible gap** rather than a confident "unrestricted".

## Prerequisites

**CLEARED 2026-09-08 — constitution is now v1.2.0.**

v1.1.0 was written for this feature and covered almost all of it; what remained was one row of
the surface register. That amendment has landed.

| Prerequisite | Amendment | Status |
|---|---|---|
| Add `GET /crs/contexts` to the surface register's `customer` row | **MINOR** (1.1.0 → 1.2.0) | ✅ **Done** — Principle IV satisfied; the fifth tool is now buildable |
| Narrow `POST /qbs/{path}` to `POST /qbs/graphql` in the same row | Folded into the above | ✅ **Done** — a register entry containing a path variable would appear to license the caller-chosen upstream target Principle IV forbids |

The amendment also recorded four newly verified facts in "Deployed GMA customer & bet surfaces"
(the context list, the QBS path, the `?instance=` condition, and both controller flags being on
in every deployed environment) and added two binding consequences: the context list MUST be
preferred over derivation, with a hardcoded jurisdiction table **prohibited** because it would
fail *confidently* as jurisdictions are added; and `?instance=` MUST NOT be sent nor exposed as
a tool argument.

No principle text changed, and no code was made non-compliant — nothing calls either operation
yet. **Implementation is unblocked.**

## Technical Context

**Language/Version**: TypeScript on Node.js 22 LTS — unchanged.

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, OpenTelemetry SDK. **No new
runtime dependency.** In particular **no GraphQL client**: the document is a string constant
and the request is an ordinary `POST` through the existing `core` client, which is what keeps
FR-024's read-only guarantee structural.

**Storage**: N/A — stateless. No credential, customer record, or result is ever persisted.

**Testing**: `vitest` (unit + integration + protocol smoke), `msw` for HTTP interception.
Fixture library extended with four new surfaces, keyed by distinguishable upstream outcome —
including the mandatory **success-carrying-errors** QBS fixture, which the constitution calls
*"the single most important one on that surface"*.

**Target Platform**: Developer machine (macOS/Linux), stdio transport only, as with the
existing slices.

**Project Type**: Single service — modular monolith, shared `core` + domain modules.

**Performance Goals**: None quantified. Single local operator; latency is dominated by GMA.
The composite's worst case is `3 + CUSTOMER_MAX_EVENT_RESOLUTIONS` hops (default 13), which is
a **correctness** bound reported in the result, not a performance target.

**Constraints**: Coverage ≥ 90% line / 85% branch overall, ≥ 95% line for `core/`
(constitutional). No credential **or customer identifier** in any log, trace, or error. No
operational value hardcoded or agent-supplied. Existing catalogue tests must pass
**unmodified** after the shared-type change.

**Scale/Scope**: 5 tools, 1 new domain, 5 GMA operations, up to `3 + N` hops for the composite
(hop 3 is `GET /crs/contexts`, which constitution v1.2.0 makes the primary matching mechanism —
see contracts/tools.md §4).

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-evaluated post-Phase 1. Constitution v1.2.0.*

| Principle | Gate | Status | Evidence |
|---|---|---|---|
| **I. Pass-Through Identity** (NON-NEGOTIABLE) | Token forwarded unaltered, per-invocation; never minted/cached; `401` → `auth`; `403` → `forbidden`, NOT retryable, never conflated with `401` | **PASS** *(needs a code change)* | Inherited unchanged from `core/identity.ts` — no new identity path. `403` currently maps to `upstream`/**retryable** (`test/unit/errors.test.ts:32`), a live retry loop; corrected in [data-model.md](./data-model.md) §2 |
| **II. Mandatory Completeness Caveat** (NON-NEGOTIABLE) | Structured top-level `completeness` on every result; **both** axes present and never merged; `complete` only when both empty; success-status ≠ complete on a body-error surface; no invented signal where none is published; resolution outcome NOT folded in | **PASS** | Second axis in [data-model.md](./data-model.md) §1; QBS body inspection (R1, FR-011); CRS reports complete-or-error only (R2); `jurisdictionMatch` is a sibling field, never a caveat (§8, FR-027) |
| **III. Modular Boundaries** | `core ↛ domains`; `domain ↛ domain`; per-domain endpoint; additive growth | **PASS** | New `domains/customer/`, registered at `/mcp/customer`; the composite reaches `GET /v5/events/{id}` through the shared `core` client — composition, not coupling. Lint rule and `test/unit/architecture.test.ts` both already enforce this |
| **IV. Curated Task-Oriented Tools** | Hand-curated; read-only **by construction**; no query/path/operation-name input; never collapse plausible answers; no GMA DTO leakage; no deprecated operation; unverified assumptions stated | **PASS** *(with the register amendment)* | Fixed document constant (R4); multi-match returns candidates and does zero further work (FR-022); `POST` metrics variant, not the deprecated `GET` (R12); R9/R14 stated in results with owners |
| **V. Config-Driven Ops & Safe Observability** | Env-config only; fail-fast; bounds from config and reported; **customer identifiers are personal data** — never in a log, trace, diagnostic field, or error, and the logged path is the **template**; discovery tool for any agent-supplied scoping vocabulary | **PASS** *(needs a code change)* | Two new optional bounds ([data-model.md](./data-model.md)); `pathTemplate` change (R13); `list_jurisdiction_contexts` satisfies the discovery rule (R7) |

**Testing gates**: a fixture per distinguishable outcome per operation, including
success-carrying-errors and `403` (R15) ✅; every must-cover case named, including v1.1.0's
seven additions ([quickstart.md](./quickstart.md) 1b) ✅; the privacy assertion, exercising a
path that carries an account identifier (1c) ✅; the **amendment-acceptance gate** (1a) ✅.

**Post-Phase 1 re-evaluation**: all five principles still PASS. The design introduced no new
violation. Two principles require a change to existing `core` code (`403` mapping,
`pathTemplate`) — both are corrections of defects the new surfaces expose, not concessions, and
both are recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-customer-bet-tools/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — R1-R15, incl. two resolved and two open assumptions
├── data-model.md        # Phase 1 — shared-type changes + the new domain's types
├── quickstart.md        # Phase 1 — how to run and prove it
├── contracts/
│   └── tools.md         # Phase 1 — the five-tool MCP surface
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16)
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT here
```

### Source Code (repository root)

Changed and added files only; everything unlisted is untouched.

```text
src/
├── core/                             # SHARED — three files change, all additively
│   ├── types.ts                      # + unavailableComponents on Completeness
│   │                                 # + 'forbidden' on ErrorKind
│   ├── completeness.ts               # + withUnavailableComponents(); aggregate() unions the
│   │                                 #   new axis; invariant gains clause 3
│   ├── errors.ts                     # + 403 → forbidden (NOT retryable); 424 → upstream;
│   │                                 #   207 routed to completeness, not here
│   ├── gmaClient.ts                  # + pathTemplate on call options, logged instead of the
│   │                                 #   interpolated path (R13 — the PII fix)
│   └── config.ts                     # + CUSTOMER_MAX_BETS, CUSTOMER_MAX_EVENT_RESOLUTIONS
│
├── server/
│   └── register.ts                   # + registerCustomerDomain(); catalogue untouched
│
└── domains/
    ├── catalogue/                    # UNTOUCHED
    └── customer/                     # NEW
        ├── index.ts                  # registers the 5 tools at /mcp/customer
        ├── schemas.ts                # zod, LLM-facing — no CRS/QBS/metrics DTO names
        ├── gql/
        │   └── searchBets.ts         # the FIXED document constant (FR-024) — omits
        │                             #   betNotesDetails entirely (FR-004)
        ├── mapping/
        │   ├── riskConfiguration.ts  # CRS AccountRiskSettings → per-jurisdiction configs
        │   ├── betProjection.ts      # QBS Bet → the curated risk projection
        │   ├── qbsErrors.ts          # GraphQL errors[] → unavailableComponents (FR-011)
        │   └── metrics.ts            # metrics response → curated figures; EVENTTYPE fix
        ├── jurisdiction.ts           # the four-outcome matcher (FR-018) — pure, no I/O
        ├── legResolution.ts          # distinct-event dedupe + bound + per-leg outcome (FR-023)
        ├── agreement.ts              # the three-valued verdict (FR-020) — pure
        └── tools/
            ├── listJurisdictionContexts.ts
            ├── getCustomerRiskProfile.ts
            ├── findCustomerBets.ts
            ├── getBetRiskContext.ts       # the composite
            └── getCustomerBettingMetrics.ts

test/
├── fixtures/gma/
│   ├── crsAccounts/                  # NEW — provenance is the JAVA MODEL CLASSES (R15)
│   ├── crsContexts/                  # NEW
│   ├── qbsSearchBets/                # NEW — incl. the MANDATORY 200-with-errors fixture
│   └── customerMetrics/              # NEW
├── unit/
│   ├── privacy.test.ts               # NEW — SC-007, incl. an account id in a path
│   ├── jurisdiction.test.ts          # NEW — all four outcomes (SC-004)
│   ├── agreement.test.ts             # NEW — all three verdicts and each notComparable trigger
│   ├── legResolution.test.ts         # NEW — dedupe, bound, per-leg outcome
│   ├── readOnly.test.ts              # NEW — SC-010, structural assertion
│   ├── completeness.test.ts          # EXTENDED — the second axis; existing tests unchanged
│   └── errors.test.ts                # ONE test corrected: 403 was asserted retryable
├── integration/                      # NEW — one suite per tool, against mocked GMA
└── protocol/smoke.test.ts            # EXTENDED — the tool list grows from 3 to 8
```

**Structure Decision**: One new domain folder, mirroring `domains/catalogue/` exactly, per
Principle III and FR-002. The composite's shared logic — jurisdiction matching, leg resolution,
the agreement verdict — stays **inside** the domain rather than migrating into `core`, which is
precisely why FR-002 groups all five tools in one domain: `get_customer_risk_profile` and
`get_bet_risk_context` share the CRS mapping, and a two-domain split would have forced that
shared code into the shared foundation where no other domain needs it.

The pure modules (`jurisdiction.ts`, `agreement.ts`, `legResolution.ts`) are separated from the
tools deliberately: they hold every decision this feature could get *confidently wrong*, and
they are far cheaper to test exhaustively as functions than through an HTTP round-trip.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **A fifth tool**, beyond the spec's FR-001 "exactly four" | FR-013 exposes a jurisdiction filter, so the agent supplies scoping codes, so Principle V **requires** a discovery tool. The codes are unguessable across US and non-US jurisdictions (R7) | *Drop the filter* — loses a filter FR-013 asks for and a risk manager obviously wants. *Learn contexts from the profile tool* — reveals only jurisdictions the customer **already has settings in**, so an agent could never ask about a jurisdiction the customer bets in unconfigured, which is the exact case FR-018's second outcome exists for. *A hardcoded jurisdiction table* — now **prohibited** by v1.2.0: it fails confidently as jurisdictions are added. Register amendment landed as v1.2.0 |
| **Changing an existing `core` behaviour**: `403` from `upstream`/retryable to `forbidden`/not-retryable | Principle I mandates it, and the current mapping is a **live retry loop** the moment the QBS authorization flag flips (R10) | Leaving it is not "no change" — it is shipping a known retry loop into a domain where `403` is reachable. This is the one existing test the amendment-acceptance gate permits editing, because the behaviour is what the amendment changes. Recorded as a **defect correction**, not accommodation |
| **Changing an existing `core` behaviour**: logging a path **template** instead of the interpolated path | The account identifier is in the path. Principle V (v1.1.0) names it personal data and requires the template. Today's `gmaClient` logs the real path (R13) | *A denylist/redaction on the existing field* — the module's own rationale explains why an allowlist beats a denylist: a new leak path cannot appear by being forgotten. The template is **byte-identical** for every catalogue call, so the catalogue's log lines and tests are unaffected |
| **Up to 13 upstream hops** for one composite call | The leg → override join has no shortcut: the two trees meet only through the event, and GMA exposes no operation that returns both (R5). The thirteenth is `GET /crs/contexts`, which v1.2.0 makes mandatory rather than optional: without it, derivation becomes the primary matcher and fails *confidently* | *Skip the event hop and match on names* — names are not identifiers, and catalogue names carry `\|delimiters\|`. *Resolve nothing and return raw legs* — that is the capability the domain exists for, and an agent cannot do the join itself. Bounded by configuration and **reported** when reached (FR-023), never silently truncated |
| **Duplicating overrides across legs** | FR-019: an override covering several legs appears on **each** leg it covers | A normalised override list plus per-leg references would be smaller and would require the model to perform a join to answer "is this leg restricted?". A model doing a join in-context is a model that gets it wrong |

**None of these is a shortcut.** Two are the design conforming to constitution v1.1.0 rather
than to code written before it; one is a governance amendment the spec already anticipated; two
are the composite's irreducible cost.

## Deliberate deviations, with owner and removal condition

Recorded here because Compliance review requires a temporary deviation to carry both, and
because a clean plan should not disguise where it is most likely to be wrong.

| Deviation | Mitigation | Removal condition | Owner |
|---|---|---|---|
| **R9** — assumes `leg.event.entityIds.rampId` prefixed with `urn:sbk:pc:e:gpd:` is the v5 event id. Evidence: a production front-end does exactly this join (`gbpbmui-tool/src/utils/linkManager.ts:51,88`). Not confirmed by any schema | Try `rampId`, then `gbpId`; an unresolvable leg is a **named unresolved leg** with the result marked incomplete — never "no overrides apply". A wrong choice makes **every** leg report `notResolvedIdentifierUnusable`, which is immediately visible | Confirm which `entityIds` member is the GBP catalogue id, or observe one real leg resolving | Feature implementer, before release |
| **R14** — assumes QBS `riskInfo.liabilityGroup` (a bare `String`) is CRS `LiabilityGroup.description`, not `.code` | FR-020's verdict is three-valued: try `description`, then `code`, and report `differs` with **both** values visible when neither matches | Confirm which field the applied value corresponds to | Feature implementer, before release |
| **R8** — unknown whether a default-only jurisdiction is **omitted** from a customer's configuration list. Confirmed unverifiable from this workspace: it is CRS behaviour, and CRS is a separate service | FR-018's second outcome states the fact and refuses to conclude "defaults applied". With R7 the tool can additionally say whether the jurisdiction exists in the **platform** context list, without asserting what absence means | Ask the owner of the customer-risk system. If omission is confirmed, FR-018's second outcome may then assert defaults | Feature implementer — a human conversation, not a code change |

## Follow-up actions (outside this plan's scope)

1. ~~**Amend the constitution (MINOR, 1.1.0 → 1.2.0)**~~ — **Done 2026-09-08.** The surface
   register's `customer` row now carries `GET /crs/contexts` and names `POST /qbs/graphql`
   rather than a path variable. Four verified facts and two binding consequences were added
   to "Deployed GMA customer & bet surfaces". No principle text changed.
2. **Close R9 and R14** via quickstart Validation 4 before release.
3. **Ask a human about R8.** It is the one open question a code change cannot answer.
4. `TODO(PREFAB_MIGRATION)` remains deferred and unchanged: still local-only, still blocking
   for any non-local deployment.
5. **Note for a later slice**: GMA itself logs the full CRS URL and request body at `INFO`
   (`CrsHttpRequestsController:128-134`). That is GMA's exposure, not this server's, and
   Principle I forbids compensating for upstream behaviour — but this feature's privacy
   guarantee covers **this server's** logs only, and someone should know that.
