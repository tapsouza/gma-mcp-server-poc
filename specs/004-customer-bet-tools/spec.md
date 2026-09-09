# Feature Specification: Customer Risk & Bet Tools (FanDuel)

**Feature Directory**: `specs/004-customer-bet-tools`

**Feature Branch**: `004-customer-bet-tools`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Suggest new tools that can be created, putting information
together from both customer risk endpoints (crs) and bet information endpoints (qbs)"

**Interpretation**: A second capability domain — **customer** — alongside the existing
catalogue domain. It exposes a customer's risk configuration, their betting activity, their
betting metrics, and one genuinely composite capability that joins a single bet's applied
risk figures to the customer risk settings that were in scope for it, plus a discovery
capability listing the jurisdiction contexts the others can be scoped to. Scoped to **FanDuel
only** and **read-only**. The composite capability is the reason the domain exists; the
others are the independent readouts and the scoping vocabulary it is built from.

## Clarifications

### Session 2026-09-08

Resolved by interview before this spec was written. Recorded because several answers rule
out designs that look more obvious than the one chosen.

- Q: Who is this for, and what is the entry point? → A: **Both** traders/risk analysts and
  risk managers. Two entry points, deliberately: a **bet** ("why did this bet get this
  limit?") and an **account** ("what is this customer's configuration?").
- Q: Does the composite capability *correlate* or *attribute*? → A: **Correlate**, plus one
  safely-checkable derivation (the agreement test, FR-020). It MUST NOT reconstruct how a
  limit was computed. Named `get_bet_risk_context`, not `explain_bet_limit`, because the
  name is what the consuming agent honours in its prose.
- Q: How is the brand named on a customer capability? → A: **It isn't.** FanDuel is the only
  brand in scope; the meaningful scoping unit is the **state/jurisdiction context**.
- Q: How is a customer risk context matched to a catalogue jurisdiction? → A: Attempt the
  derivation, and **degrade honestly** when it fails. Four distinguishable outcomes
  (FR-018), never a guess.
- Q: Do recent bets belong inside the risk profile capability? → A: **No** — separate
  capabilities. They answer different questions and fail independently.
- Q: Where do betting metrics live? → A: **Their own capability**, with filters exposed,
  because the aggregation choice reshapes the answer and is the operator's judgment.
- Q: How are multi-leg bets handled? → A: **Resolve every distinct event**, per-leg
  settings, capped. Configured values for every leg; **no** causal attribution of the
  bet-level applied figures to any one leg.
- Q: Is this slice read-only? → A: **Yes** — and the request mechanics cannot be relied on to
  enforce it, because two of the three reads are issued the same way a write would be.
  Enforced instead by FR-024 and FR-025.

## User Scenarios & Testing *(mandatory)*

The direct consumer is an **AI agent** acting for a **human operator** — a trader, risk
analyst, or risk manager. Both matter: the agent consumes the capabilities, and the human
must never be misled by what the agent reports. The stakes are higher than in the catalogue
domain: these answers concern an identified customer's money and their trading
restrictions.

### User Story 1 - Read a customer's risk configuration (Priority: P1)

A risk manager reviewing an account asks their agent what the customer's risk configuration
is. The agent returns the configuration **for every jurisdiction the customer has one in** —
each with its own stake factor, liability group, in-running delay, payout limits, winnings
cap, and any hierarchy-level overrides, each override carrying the full named catalogue path
it applies to.

**Why this priority**: It is the thinnest slice that delivers standalone value in the new
domain, and it proves the two things the rest of the domain depends on — that a
customer-scoped answer can be produced with per-jurisdiction fidelity, and that a surface
with no partial-failure signal of its own can still carry an honest completeness verdict. It
is also the only capability here that is a single step, so it retires the least risk per unit
of value and must come first.

**Independent Test**: Fully testable on its own by requesting a known account's
configuration and asserting that every jurisdiction context is returned separately with its
overrides and their named catalogue paths, plus the outcome for an unknown account.

**Acceptance Scenarios**:

1. **Given** an account with configuration in three jurisdictions, **When** the agent
   requests the risk profile, **Then** it receives **three** separate configurations, none
   merged or flattened, each identified by its jurisdiction.
2. **Given** a configuration containing a hierarchy-level override, **When** the agent
   receives it, **Then** the override carries its catalogue level, its identifier, **and**
   the human-readable names of that entity and its ancestors.
3. **Given** an account identifier that does not exist, **When** the agent requests the
   profile, **Then** it receives a clear "not found" outcome and no fabricated defaults.
4. **Given** an operator whose identity is expired, **When** the agent requests the profile,
   **Then** it receives an authentication failure a human can act on.
5. **Given** any successful result, **When** the agent receives it, **Then** a structured
   completeness verdict is present, including when the result is fully complete.

---

### User Story 2 - Find a customer's recent bets (Priority: P2)

An analyst investigating behaviour asks for a customer's recent bets, or looks up one bet by
its identifier or the receipt a customer quoted. The agent returns a **risk-shaped** view of
each bet: identifiers, when it was placed, status, type, jurisdiction, the applied risk
figures, the wager amounts, and per leg the selection/market/event/competition/sport names
with their identifiers.

**Why this priority**: It is the second-most independently valuable capability and the one
an analyst reaches for most often. It is P2 rather than P1 because it introduces the
upstream surface whose failure mode is the most dangerous in this domain — a technically
successful response that is partially unpopulated (FR-011) — so it should land after the
completeness machinery has been proven once by Story 1.

**Independent Test**: Testable on its own by searching by account, by bet identifier, and by
receipt identifier, and asserting the projection's shape, the ordering caveat, and the
partially-unpopulated-response path.

**Acceptance Scenarios**:

1. **Given** an account with many bets, **When** the agent searches by account, **Then** it
   receives at most a fixed number of bets (default 20), ordered most-recent-first, **and** a
   statement that the selection is the first page returned upstream and may not be the
   globally most recent.
2. **Given** a bet receipt identifier a customer quoted, **When** the agent searches by it,
   **Then** it receives the matching bet without the operator having to convert it to an
   internal identifier first.
3. **Given** an identifier matching nothing, **When** the agent searches, **Then** it
   receives an explicit "nothing matched" outcome — not an error, and not a caveat.
4. **Given** an upstream response that succeeded overall but left some requested information
   unpopulated, **When** the agent receives the result, **Then** the result is marked
   **incomplete** and names what was unavailable. It MUST NOT be presented as complete.
5. **Given** an operator who lacks permission for this kind of query, **When** the agent
   attempts it, **Then** it receives an error identifying the cause as **insufficient
   permission** — distinct from an authentication failure and marked as not worth retrying.
6. **Given** any returned bet, **When** the agent receives it, **Then** the bet carries no
   staff-authored notes about the customer.

---

### User Story 3 - Understand the risk context behind one bet (Priority: P3)

An analyst has a bet — a limit looked wrong, a customer complained, a ticket landed — and
asks why. The agent returns the bet's **applied** risk figures side by side with the customer
risk settings that were **in scope** for it: the configuration for the bet's jurisdiction,
and per leg, the overrides covering that leg's catalogue position. Where a configured value
and an applied value are directly comparable, the agent is told whether they **agree**.

**Why this priority**: This is the capability the domain exists for and the only one that
cannot be assembled by an agent from the others — it requires resolving each leg's catalogue
position, which no single upstream surface exposes. It is last because it depends on both
preceding stories' machinery, has the widest failure surface, and carries the highest cost of
being wrong: a confidently-wrong explanation of a trading limit.

**Independent Test**: Testable on its own for a single-leg bet, a multi-leg bet, a bet whose
jurisdiction has no configuration, and a bet whose jurisdiction cannot be matched —
asserting in each case what is claimed and, more importantly, what is not.

**Acceptance Scenarios**:

1. **Given** a single-leg bet whose jurisdiction matches one of the customer's
   configurations, **When** the agent requests the risk context, **Then** it receives the
   applied figures, that jurisdiction's configuration, the leg's resolved catalogue path,
   the overrides in scope for it, **and** an agreement verdict per comparable field.
2. **Given** a configured stake factor that differs from the applied one, **When** the agent
   receives the result, **Then** the difference is reported as a structured verdict with both
   values present — not left for the agent to infer.
3. **Given** a multi-leg bet, **When** the agent receives the result, **Then** each leg
   carries its own resolved catalogue path and in-scope overrides, **and** the result states
   explicitly that the applied figures are bet-level and cannot be attributed to any single
   leg.
4. **Given** a bet placed in a jurisdiction the customer has no configuration for, **When**
   the agent receives the result, **Then** it is told **that specific fact**, and receives all
   the configurations that do exist. It MUST NOT be told the customer is on default settings.
5. **Given** a bet whose jurisdiction cannot be matched to a configuration at all, **When**
   the agent receives the result, **Then** that outcome is reported as **distinct** from
   scenario 4, so a systematic matching failure is not mistaken for a fact about the customer.
6. **Given** an identifier matching more than one bet, **When** the agent requests the risk
   context, **Then** it receives all candidates, **no** joined result, and no wasted
   resolution work.
7. **Given** a bet where the customer's configuration could not be retrieved, **When** the
   agent receives the result, **Then** the result names the **missing section** rather than
   only naming failed instances, and is marked incomplete.
8. **Given** a bet with more distinct events than the configured resolution limit, **When**
   the agent receives the result, **Then** the unresolved legs are named explicitly and the
   result is marked incomplete.

---

### User Story 4 - Read a customer's betting metrics (Priority: P4)

A risk manager asks how a customer has been performing — stakes, margins, bet counts, and
behavioural indicators — optionally narrowed to a period, bet types, placement statuses,
jurisdictions, or a part of the catalogue hierarchy, and aggregated the way the question
requires.

**Why this priority**: Genuinely useful for an account review but the most independent
capability here — it joins nothing, and its absence blocks no other story. It is last because
its filters are its value, and specifying them well matters more than shipping them early.

**Independent Test**: Testable on its own by requesting metrics with and without each filter
and asserting the aggregation requested is the aggregation returned, plus each invalid-filter
outcome.

**Acceptance Scenarios**:

1. **Given** an account and a required aggregation choice, **When** the agent requests
   metrics, **Then** it receives the metrics aggregated that way, with lifetime and total
   figures alongside.
2. **Given** no aggregation choice, **When** the agent attempts the request, **Then** it
   receives an argument error naming the choices available — the system MUST NOT pick one.
3. **Given** an invalid filter combination, **When** the agent attempts it, **Then** it
   receives an argument error precise enough to self-correct, naming the specific problem.
4. **Given** a jurisdiction filter, **When** the agent supplies one, **Then** the same
   honesty about jurisdiction matching applies as in Story 3.

---

### Edge Cases

- **A customer has configuration in several jurisdictions with different restrictions.**
  Normal, not exceptional. Merging them is prohibited: a customer restricted on one sport in
  one state and unrestricted in another must not be reported as either.
- **A bet's jurisdiction is not among the customer's configured jurisdictions.** Observed in
  real sample data on the first bet examined. Must be reported as a specific fact, never as
  "no restrictions".
- **A jurisdiction cannot be matched to a configuration at all.** Known to occur for at
  least one non-US jurisdiction whose identifiers do not follow the derivable pattern. Must
  be distinguishable from the case above.
- **Upstream reports success but leaves data unpopulated.** One surface here signals partial
  failure *inside* an otherwise-successful response. Treating it as success is the single
  worst defect this feature could ship.
- **One section of a composite answer is unavailable while every source consulted answered.**
  Distinct from instance-level failure and must be reported distinctly — otherwise the agent
  is told to retry with different scoping, which cannot help.
- **Operator authenticated but not authorised for an operation.** Must be a distinct,
  non-retryable outcome; retrying is guaranteed to fail and wastes the operator's time.
- **A bet with many legs across many events.** Resolution work grows with leg count; must be
  bounded, and hitting the bound must be visible rather than silently truncating.
- **The same event appearing on several legs.** Must be resolved once, not once per leg.
- **One leg's catalogue position fails to resolve while others succeed.** The other legs'
  findings must survive, with the failed leg named.
- **An account identifier or bet identifier that is malformed.** Must produce a correctable
  argument error **without repeating the value back**, since these identify a person.
- **An agent attempting to supply its own query, query fragment, or upstream path.** Must be
  impossible by construction — a read-only guarantee that depends on the agent's good
  behaviour is not a guarantee.

## Requirements *(mandatory)*

### Functional Requirements

Requirements FR-001 – FR-030 below are additional to, and MUST NOT weaken, the identity,
completeness, and operational requirements already ratified for this system.

**Scope**

- **FR-001**: The capability set MUST be exactly five: read a customer's risk configuration;
  find a customer's bets; read a customer's betting metrics; read the risk context behind one
  bet; and **list the jurisdiction contexts** the other capabilities can be scoped to. It MUST
  NOT be derived mechanically from any upstream interface.

  *Amended 2026-09-08 (was "exactly four").* The fifth is not a convenience: FR-013 has the
  caller supply jurisdiction codes as a metrics filter, and the ratified constitution requires
  a discovery tool for any scoping vocabulary an agent is expected to supply. The codes are
  provably unguessable — `NJ` and `PA` are two-letter, but Ontario's is `NXTCANBS` against a
  catalogue jurisdiction of `urn:i:FD:CA-ON` — and a hardcoded table is **prohibited**, because
  it would fail *confidently* as jurisdictions are added. So the four-capability set was not
  buildable as specified. See plan.md *Complexity Tracking*, research.md R7, and constitution
  v1.2.0, which registered `GET /crs/contexts` to permit it.
- **FR-002**: All five capabilities MUST be grouped in a single domain, so that logic shared
  between the risk-configuration and bet-context capabilities stays inside that domain and
  does not migrate into the shared foundation.
- **FR-003**: The feature MUST target FanDuel only. It MUST NOT expose a brand argument, and
  MUST NOT be described as supporting other brands.
- **FR-004**: The system MUST NOT expose staff-authored notes about customers in this slice.

**Customer risk configuration**

- **FR-005**: Users MUST be able to retrieve a customer's risk configuration by account
  identifier.
- **FR-006**: The result MUST report each jurisdiction's configuration **separately**. It
  MUST NOT merge, average, or otherwise collapse configurations across jurisdictions.
- **FR-007**: Each hierarchy-level override MUST carry the human-readable names of the
  catalogue entity it applies to and that entity's ancestors, so an operator can read it
  without a second lookup.

**Customer bets**

- **FR-008**: Users MUST be able to find bets by account identifier, by bet identifier, or by
  bet receipt identifier, exactly one of which is required per request.
- **FR-009**: The information returned per bet MUST be a curated, fixed projection chosen for
  risk work. It MUST NOT be the upstream surface's full detail.
- **FR-010**: The result MUST be limited to a fixed maximum number of bets (default 20),
  ordered most-recent-first, and MUST state that the selection is the first page returned
  upstream and may not be the globally most recent set (see Assumptions).
- **FR-011**: When an upstream response is technically successful but reports errors within
  itself and leaves requested information unpopulated, the result MUST be marked
  **incomplete** and MUST name what was unavailable.
- **FR-012**: An identifier matching no bet MUST be reported as "nothing matched" — not an
  error, and not an incomplete result.

**Betting metrics**

- **FR-013**: Users MUST be able to retrieve a customer's betting metrics, narrowable by
  period, bet type, placement status, jurisdiction, and catalogue hierarchy position.
- **FR-014**: The aggregation choice MUST be supplied by the caller and MUST NOT be defaulted
  by the system, because it determines the shape and meaning of the answer.
- **FR-015**: The system MUST NOT be built on any upstream operation marked deprecated,
  including where a deprecated variant of a needed operation exists alongside a current one.

**Bet risk context (the composite)**

- **FR-016**: Users MUST be able to obtain, for one bet, its applied risk figures together
  with the customer risk settings that were in scope for it, keyed by bet identifier or bet
  receipt identifier.
- **FR-017**: The system MUST NOT compute, reconstruct, or imply how any applied limit was
  derived. It presents applied values and in-scope configured values; the causal step is the
  human's.
- **FR-018**: The system MUST report which jurisdiction's configuration governed the bet as
  one of four distinguishable outcomes: **matched** (naming it); **no configuration exists
  for the bet's jurisdiction**; **the jurisdiction could not be matched to a configuration**;
  and **the bet's jurisdiction could not be determined**. In every non-matched case it MUST
  return all configurations that do exist, and MUST NOT assert that default settings applied.
- **FR-019**: Each leg MUST carry its own resolved catalogue path and the overrides in scope
  for that leg. Overrides covering several legs MUST appear on each leg they cover.
- **FR-020**: Where a configured value and an applied value are directly comparable, the
  system MUST report a three-valued verdict — **consistent**, **differs**, or **not
  comparable** — with both values present. **Not comparable** MUST be the default, emitted
  whenever the governing configuration is unresolved, either value is absent, or the bet has
  more than one leg and the applied value is bet-level.
- **FR-021**: For a bet with more than one leg, the system MUST state explicitly that the
  applied risk figures are bet-level and cannot be attributed to any single leg.
- **FR-022**: When one bet identifier matches more than one bet, the system MUST return all
  candidates, resolve none, and perform no further resolution work.
- **FR-023**: The number of catalogue positions resolved per bet MUST be bounded by
  deployment configuration. Distinct positions MUST be resolved once each regardless of how
  many legs reference them. Exceeding the bound MUST name the unresolved legs and mark the
  result incomplete.

**Read-only guarantee**

- **FR-024**: No capability MAY accept a query, query fragment, field selection, or operation
  name as input. The requests issued upstream MUST be fixed within the system. *(The request
  mechanics cannot serve as the guard: two of the three read operations here are issued the
  same way a write would be, so read-only-ness cannot be inferred from how a call is made.)*
- **FR-025**: No capability MAY accept an upstream path or path fragment as input, so that a
  catch-all upstream proxy cannot be reached with a caller-chosen target.

**Completeness, errors, and privacy**

- **FR-026**: The completeness verdict MUST distinguish **which sources failed to answer**
  from **which sections of a composite answer are unavailable**, and MUST require both to be
  empty before a result is marked complete. Both MUST be present in the result as structured
  data, because they call for different agent behaviour.
- **FR-027**: The jurisdiction-matching outcome (FR-018) MUST NOT be expressed as
  incompleteness. A result whose sources all answered fully is complete even when the
  governing jurisdiction is unresolved.
- **FR-028**: The system MUST report **insufficient permission** as an outcome distinct from
  an authentication failure, and MUST mark it not retryable.
- **FR-029**: The system MUST NOT record an account identifier, bet identifier, bet receipt
  identifier, customer name, or any customer financial value in any log, trace, or diagnostic
  field. Diagnostics MUST remain sufficient to determine which capability ran, what outcome
  each step produced, and how long it took.
- **FR-030**: The system MUST NOT repeat an account, bet, or receipt identifier back in any
  error message. An argument error MUST describe the expected form; a not-found MUST state
  that nothing matched — neither echoes the value.

### Key Entities

- **Customer risk configuration**: A customer's risk settings **within one jurisdiction** —
  stake factor, liability group, in-running delay, payout limits, winnings cap, eligibility,
  and any hierarchy-level overrides. A customer holds several, one per jurisdiction they have
  settings in. There is no single global configuration.
- **Jurisdiction context**: The state or territory a configuration or a bet belongs to. The
  meaningful scoping unit throughout this feature, replacing the brand-instance scoping used
  by the catalogue domain.
- **Hierarchy override**: A risk setting applied to part of the catalogue rather than to the
  whole configuration — carrying the catalogue level, the entity, its ancestors' names, and
  the settings it overrides.
- **Bet (risk projection)**: The curated view of a placed bet — identifiers, placement time,
  status, type, jurisdiction, applied risk figures, wager amounts, and legs.
- **Leg**: One selection within a bet, carrying the catalogue entities it refers to and,
  once resolved, its position in the catalogue hierarchy.
- **Applied risk figures**: The risk values the upstream pricing system actually used for a
  bet — stake factor, liability group, maximum bet, and cumulative measures. Bet-level, not
  per-leg. Their derivation is not available to this system.
- **Agreement verdict**: The comparison between one configured value and its applied
  counterpart: consistent, differs, or not comparable — always with both values shown.
- **Jurisdiction-matching outcome**: Which of the customer's configurations governed a bet,
  or the specific reason none could be identified. Not a form of incompleteness.
- **Betting metrics**: Aggregated behavioural and commercial measures for a customer over a
  filtered set of bets, shaped by the caller's chosen aggregation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In **100%** of results where any source failed or any section of a composite
  answer was unavailable, both facts are present as structured data and the result is marked
  incomplete. Zero cases where an answer missing a section reads as whole.
- **SC-002**: In **100%** of cases where an upstream response succeeds while reporting
  internal errors, the result is marked incomplete. Zero cases presented as complete.
- **SC-003**: In **100%** of cases where the governing jurisdiction cannot be identified, the
  result says so and returns every configuration that exists. Zero cases where one
  jurisdiction's settings are attributed to a bet placed in another.
- **SC-004**: The four jurisdiction-matching outcomes are each exercised by an automated test,
  and a matching failure is never reported as a fact about the customer.
- **SC-005**: An operator's question about one bet's risk context is answered in **one** agent
  call, with no manual identifier conversion and no knowledge of upstream structure.
- **SC-006**: A multi-leg bet's result never attributes bet-level applied figures to a single
  leg, verified by an automated test for a bet spanning several catalogue positions.
- **SC-007**: Zero occurrences of an account identifier, bet identifier, receipt identifier,
  customer name, or customer financial value in any log, trace, or error message, verified by
  automated inspection.
- **SC-008**: An agent given an invalid argument corrects itself and succeeds on a subsequent
  attempt without human help, for each of: missing aggregation choice, invalid filter
  combination, no identifier supplied, more than one identifier supplied.
- **SC-009**: An agent receiving an insufficient-permission outcome does **not** retry the
  same operation, verified by an automated test.
- **SC-010**: No capability can be made to issue a write, verified by automated inspection
  proving no caller-supplied value reaches an upstream query or path.
- **SC-011**: Every distinguishable upstream outcome for every operation these capabilities
  depend on is covered by a fixture, including a technically-successful-but-partially-failed
  response and an insufficient-permission response.
- **SC-012**: Adding this domain requires **zero changes** to the existing catalogue
  capabilities' behaviour, demonstrated by the existing automated tests passing unchanged
  after the shared foundation gains its new outcome distinctions.
- **SC-013**: A bet with many legs resolves each distinct catalogue position **once**, and a
  bet exceeding the configured bound names its unresolved legs rather than truncating
  silently.

## Assumptions

Each is a reasonable default or a fact observed during the interview. The three marked
**UNVERIFIED** are load-bearing and carry an owner and a removal condition, as required for a
recorded deviation.

- **Governance precedes implementation.** The ratified constitution currently fixes the
  upstream surface to the catalogue interface and the capability set to three tools, and its
  completeness model has no representation for a missing section of a composite answer, for a
  successful-but-partially-failed response, or for insufficient permission. This feature
  therefore requires a governance amendment **before** implementation, landing as its own
  change.
- **The upstream system already resolves override names.** The customer-risk retrieval path
  enriches each hierarchy override with its full named catalogue chain, so the
  risk-configuration capability is a single step and needs no catalogue calls of its own.
- **A bet reports its own jurisdiction**, so the composite capability needs no scoping
  argument — everything is derived from the bet identifier.
- **A leg's catalogue position is only obtainable via its event.** Legs carry sport,
  competition, event, market, and selection, but not the catalogue levels the risk overrides
  use; the event is the only bridge, and it is mandatory rather than an optimisation.
- **UNVERIFIED — upstream bet ordering.** It is assumed the first page of bet results
  approximates most-recent-first. Nothing in the upstream interface exposes a sort option,
  and the upstream system's own consumers sort after retrieval. **Mitigation**: results are
  sorted after retrieval and the caveat in FR-010 is stated unconditionally. **Removal
  condition**: confirm the upstream default ordering, or find a sort option; then drop the
  caveat or push the sort upstream. **Owner**: feature implementer, before release.
- **UNVERIFIED — applied liability group matches the configured description.** The applied
  liability group appears to be the configured group's *description*, not its code, based on a
  single observation. **Mitigation**: the comparison is three-valued, so an unexpected shape
  reports `differs` with both values visible rather than being silently wrong. **Removal
  condition**: confirm which field the applied value corresponds to. **Owner**: feature
  implementer, before release.
- **UNVERIFIED — whether unconfigured jurisdictions are omitted.** It is not known whether a
  jurisdiction with purely default settings is absent from a customer's configuration list, or
  whether absence means something else. **Mitigation**: FR-018 states the fact and refuses to
  conclude "defaults applied". **Removal condition**: confirm with the owner of the
  customer-risk system; if omission is confirmed, the outcome may then assert defaults.
  **Owner**: feature implementer — worth asking a human, not inferring.
- **Jurisdiction identifiers are mostly derivable but not always.** Deriving a configuration's
  jurisdiction from a catalogue jurisdiction identifier works for US states, including
  numbered variants, and provably fails for at least one non-US jurisdiction. This is why
  FR-018 has four outcomes rather than two.
- **A customer has few jurisdiction configurations, not dozens.** Observed: three. Returning
  all of them is therefore inexpensive and needs no pagination.
- **A human is present at request time**, carrying a live credential. There is no unattended
  path.
- **Correctness is proven against a controlled upstream**, because a live system cannot be
  made to produce partial failure, insufficient permission, or timeout on demand.
- **This slice is read-only and local**, consistent with the existing slices. Writes —
  amending risk settings, deleting notes — are out of scope and are not made easier by
  anything here.
- **Deferred to a later slice**: the capability comparing where a customer bets against where
  they are restricted; the comparison of actual against expected risk settings; and the
  customer-notes surface, whose distinct partial-success contract deserves its own treatment.
