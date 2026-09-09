# Specification Quality Checklist: Customer Risk & Bet Tools (FanDuel)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-08
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — all resolved by interview before drafting
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation Notes

### Iteration 1 (2026-09-08)

Two implementation leaks found and fixed:

1. **Request mechanics named directly.** The read-only clarification and FR-024 named a
   specific transport verb. Rewritten to describe the property — "two of the three read
   operations are issued the same way a write would be" — which is what a reviewer needs to
   understand *why* the guard has to be structural, without pinning the spec to a protocol.
2. **Upstream interface called an "API surface"** in Assumptions. Reworded to "upstream
   surface", consistent with the vocabulary used by the earlier specs in this repository.

Two grep hits remain and are intentional: the verbatim user input (required by the template,
and the only place the upstream system's abbreviations appear) and a lowercase "get" inside
prose.

Numbering verified contiguous: FR-001 – FR-030, SC-001 – SC-013, no gaps.

### Clarifications resolved (Session 2026-09-08)

All eight were resolved by interview before drafting, so no marker reached the spec. The five
that changed the design materially:

| Question | Answer | What it ruled out |
|----------|--------|-------------------|
| Correlate or attribute? | **Correlate** + one checkable comparison | Reconstructing how a limit was computed — the system has no access to the formula |
| How is brand named? | **It isn't** — jurisdiction is the scoping unit | A brand argument, which would have been meaningless for a single-brand feature |
| How is a jurisdiction matched? | Attempt it, **degrade honestly**, four outcomes | Deriving it and trusting the result; also ruled out a maintained lookup table, whose staleness fails *confidently* |
| Bets inside the risk profile? | **No** — separate capabilities | One large composite that fails as a unit |
| Multi-leg bets? | Per-leg configured values, **no** causal attribution | Picking the most specific override and implying it won |

### Points a reviewer should press on

Listed because they are where this spec is most likely to be wrong, and a clean checklist
should not disguise that:

1. **Three UNVERIFIED assumptions**, each with an owner and removal condition. The third —
   whether a jurisdiction with default-only settings is simply absent from a customer's
   configuration list — is the one worth a human conversation rather than a code change. If
   omission is confirmed, FR-018's second outcome can make a stronger, more useful statement.
   Until then it deliberately states less than an operator might want.
2. **FR-018 has four outcomes where two would have looked sufficient.** This is not
   defensive over-specification: the sample data examined during the interview hit the
   "no configuration for this jurisdiction" case on the first bet looked at, and a known
   non-US jurisdiction hits the "could not be matched" case. Folding them would make a
   systematic matching bug indistinguishable from a fact about a customer.
3. **FR-026 adds a second axis to the completeness verdict**, and FR-027 deliberately keeps
   the jurisdiction-matching outcome *out* of it. The distinction is behavioural: a missing
   section may be worth retrying, an unresolved jurisdiction never is. A reviewer should
   confirm they agree these are different signals before the plan encodes them.
4. **FR-010's ordering caveat is stated unconditionally**, which will read as over-cautious
   if upstream ordering turns out to be recency. That is the intended trade: an operator who
   believes they are seeing the most recent bets and is not would draw a wrong conclusion
   about a customer's activity.

### Constitution alignment

Originally checked against `.specify/memory/constitution.md` v1.0.2, when every row below
needing an amendment was an open blocker. **All are now resolved** — v1.1.0 (2026-09-08) landed
the principle changes and v1.2.0 (2026-09-08) landed the surface-register row.

| Principle | Covered by | Status |
|-----------|-----------|--------|
| I. Pass-Through Identity | Inherited unchanged; Story 1 scenario 4 | ✅ v1.1.0 added the authenticated-but-unauthorised outcome (`forbidden`, NOT retryable) that FR-028 needs |
| II. Mandatory Completeness Caveat | FR-011, FR-026, FR-027; SC-001, SC-002 | ✅ v1.1.0 added the second completeness axis (`unavailableComponents`) and the success-carrying-errors mapping row |
| III. Modular Boundaries | FR-002; SC-012 | ✅ No amendment needed. Single domain chosen *because* two capabilities share logic that must not reach the shared foundation |
| IV. Curated Task-Oriented Tools | FR-001, FR-009, FR-015, FR-022 | ✅ v1.1.0 replaced the frozen three-tool surface with a per-domain register; v1.2.0 added `GET /crs/contexts` to it |
| V. Config-Driven Ops & Safe Observability | FR-023, FR-029, FR-030; SC-007 | ✅ v1.1.0 named customer identifiers as personal data and required the logged path to be a template |

**Governance blocker: CLEARED.** The feature could not be implemented under v1.0.2. Two
amendments have since landed, each as its own change per the amendment procedure:

- **v1.1.0** — the principle changes (second completeness axis, `forbidden`, customer
  identifiers as personal data, per-domain surface register).
- **v1.2.0** — `GET /crs/contexts` registered, `POST /qbs/{path}` narrowed to
  `POST /qbs/graphql`. Required because Phase 0 research established that Principle V's
  discovery-tool rule makes a fifth capability mandatory: jurisdiction codes are not
  derivable (`NXTCANBS` for Ontario), so they must be looked up. This is the one place the
  plan **exceeds** FR-001's "exactly four".

Implementation is unblocked.

## Notes

- **All 16 items pass** as of 2026-09-08, and the governance blocker above is now **cleared**
  (constitution v1.2.0). `/speckit-plan` has run; the feature is ready for `/speckit-tasks`.
- Scope is bounded: one domain, FanDuel only, read-only, local. The spec says four
  capabilities; the plan delivers **five**, the extra one being the jurisdiction-context
  discovery tool Principle V requires — recorded in the plan's Complexity Tracking rather than
  silently absorbed.
- Three further capabilities are named as explicitly deferred so the boundary is visible
  rather than implied.
