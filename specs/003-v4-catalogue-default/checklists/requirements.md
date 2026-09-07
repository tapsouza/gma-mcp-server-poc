# Specification Quality Checklist: v4 Catalogue Surface by Default

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
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

**Iteration 1 (2026-09-07)** — three items initially failed; all three were fixed in the spec
before this checklist was finalised.

1. *"No implementation details"* — **failed, then resolved by scoping.** The first draft named
   upstream URL paths (`/v5/searchByName`), upstream operation ids, and upstream response field
   names throughout the requirements and scenarios. Those were removed from every requirement,
   scenario, and success criterion, which now speak only of "the older generation", "the newer
   generation", "the by-name search capability", and so on.

   What deliberately remains is the **Findings from `../gma-service`** section, which does carry
   precise upstream facts — file names, declared versions, operation and status counts, response
   field names. This is a **considered exception**, on three grounds: the user explicitly
   instructed that the upstream endpoint be studied before specifying; the single fact that
   shapes the entire feature (the by-name search exists on only one generation) is not credible
   without its evidence; and the project's ratified constitution sets the precedent by recording
   verified upstream interface facts the same way. These are facts about an **external
   dependency**, not design decisions about this system — no requirement depends on reading
   them, and a stakeholder can skip the section and still understand the feature.

2. *"Requirements are testable"* — **failed, then fixed.** An early draft said the search
   capability "should fall back" to the newer generation. "Fall back" is untestable and, worse,
   wrong: fallback implies an attempt-then-recover flow that would produce a spurious upstream
   error. Replaced with FR-005's **declared per-capability requirement**, plus FR-006's
   requirement that a mismatch be caught at startup, and FR-002's explicit prohibition on
   reaching the newer generation by fallback.

3. *"Scope is clearly bounded"* — **failed, then fixed.** The first draft left it open whether
   the newer generation's extra operations became fair game. Now closed explicitly by FR-008 (the
   capability surface is unchanged) and by the final Assumption (no new capability is introduced).

**No [NEEDS CLARIFICATION] markers were needed.** The one question that could have blocked —
what to do about a capability the default generation cannot serve — was answerable from the
repository rather than the user: the user's own phrasing ("only search for v5 if said
specifically") already describes the mechanism, and Story 2 is simply its first instance. Asking
would have been asking the user to re-derive a fact already in their codebase.

**One risk worth carrying into planning**, recorded here rather than as a spec requirement
because it is a design concern, not a behaviour: FR-003 (one place decides the generation) and
FR-009 (completeness derivation is generation-independent) pull in the same direction and should
stay that way. If planning ends up with generation logic inside the completeness derivation, or
inside individual capabilities, both requirements have been violated even if every test passes.

## Notes

- All items pass. The spec is ready for `/speckit-clarify` (optional here — no open questions) or
  `/speckit-plan`.
