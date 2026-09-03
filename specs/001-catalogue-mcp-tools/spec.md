# Feature Specification: Catalogue MCP Tools (v1 Vertical Slice)

**Feature Directory**: `specs/001-catalogue-mcp-tools`

**Feature Branch**: `main` (no feature branch; scaffolding-stage repo)

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "Let's start the work on this repo"

**Interpretation**: The repository has a ratified constitution and a design plan
(`docs/gma-mcp-server-plan.md`) but no source code. "Start the work" is therefore scoped
to the **v1 vertical slice the plan defines**: the three catalogue tools that prove the
whole pipeline end-to-end (identity pass-through → upstream call → envelope parsing →
completeness caveat → agent-facing result). Growth beyond that slice is explicitly out
of scope here.

## Clarifications

### Session 2026-09-03

- Q: Which transport should this first slice support, and should request-scoped identity be a hard requirement from the start? (FR-023) → A: Local (stdio) only, **and** identity MUST be passed per tool invocation rather than read from process-global state, so the later remote migration is additive rather than a refactor.
- Q: What counts as "done" for this slice in terms of where it runs? (FR-024) → A: Local development only, but with the organisation's standard service scaffold adopted **now**, so deployment later is a configuration step rather than a migration.
- Q: When a name matches exactly one entity, how deep should the tool traverse before returning? (FR-025) → A: One level of children (the matched entity plus its immediate children).

**Why local-first is safe here**: the transport swap is mechanical because tool definitions
are independent of how requests arrive. What is *not* mechanical is retrofitting
request-scoped identity — with a single local user it is natural to hold one credential for
the process lifetime, and that becomes a cross-user data-leak risk the moment two
concurrent remote callers exist. Requiring per-invocation identity from the start (FR-023a)
removes that risk, leaving the remote transport and its authorization handshake as purely
additive work.

## User Scenarios & Testing *(mandatory)*

The direct consumer of this feature is an **AI agent** acting on behalf of a **human
operator** (trading, risk, or bet-operations staff). Both matter: the agent consumes the
tools, and the human is the one who must never be misled by what the agent reports.

### User Story 1 - Discover which brand instances exist (Priority: P1)

An operator asks their agent a catalogue question. Before the agent can sensibly narrow a
query, it needs to know which brand instances the upstream system can be asked about. The
agent calls a discovery capability and receives the list of valid instance codes, together
with a statement of whether that list is complete.

**Why this priority**: This is the thinnest possible slice that still exercises the entire
pipeline — caller identity is forwarded, the upstream envelope is parsed, and a
completeness statement is produced. If this works, every architectural risk in the design
has been retired once. It also removes the agent's need to guess instance codes, which is
a precondition for the other two stories being usable rather than trial-and-error.

**Independent Test**: Fully testable on its own by invoking the discovery capability with
a valid operator identity and asserting the returned instance codes and completeness
statement. Delivers standalone value: an agent can answer "which brands can I ask about?"

**Acceptance Scenarios**:

1. **Given** a valid operator identity and an upstream system reporting full success,
   **When** the agent requests the instance list, **Then** it receives the instance codes
   and a completeness statement marking the result complete.
2. **Given** an upstream system where some instances failed, **When** the agent requests
   the instance list, **Then** it receives the instances that did succeed **and** a
   completeness statement naming the failed instances and marking the result incomplete.
3. **Given** an expired or invalid operator identity, **When** the agent requests the
   instance list, **Then** it receives an error identifying the cause as authentication,
   distinguishable from a data or argument error, so a human can re-authenticate.
4. **Given** an upstream system that returns nothing usable, **When** the agent requests
   the instance list, **Then** it receives an error rather than an empty list presented as
   a complete answer.

---

### User Story 2 - Find a catalogue entity by name, with disambiguation (Priority: P2)

An operator refers to a catalogue entity the way a person does — by name, e.g. "find the
Premier League event type". The agent searches by that name. If exactly one entity
matches, the agent receives it **together with its immediate children** — one level down,
e.g. a matched sub-grouping arrives with its event types. If several entities match, the
agent receives **all** the candidates and does not pick one. If the query is too broad to
answer, the agent is told which field to narrow.

**Why this priority**: This is the capability that makes the server worth building — it is
where an agent stops needing to know the upstream system's structure. It is P2 rather than
P1 only because it is the most machinery-dependent story: it depends on the same identity,
envelope, and completeness foundations proven by P1, and adds resolution and multi-step
traversal on top.

**Independent Test**: Testable on its own against a controlled upstream by asserting each
resolution outcome — one match, several matches, no match, too-broad — and asserting that
completeness is aggregated across every step taken.

**Acceptance Scenarios**:

1. **Given** a name matching exactly one entity, **When** the agent searches, **Then** it
   receives that resolved entity plus its immediate children, and a completeness statement
   aggregated across **both** the search step and the child-retrieval step.
2. **Given** a name matching several entities, **When** the agent searches, **Then** it
   receives the full candidate list, **no** entity marked as resolved, and enough
   distinguishing detail per candidate for a human to choose between them.
3. **Given** a name matching no entity, **When** the agent searches, **Then** it receives
   an empty result that is clearly "nothing matched" and not an error and not a caveat.
4. **Given** a query too broad for the upstream system to answer, **When** the agent
   searches, **Then** it receives no resolved entity plus an explicit statement of which
   field to narrow by.
5. **Given** a multi-step resolution where any one step returned partial data, **When**
   the agent receives the result, **Then** the whole result is marked incomplete and the
   caveat names every instance that failed at any step.
6. **Given** an operator who wants only certain instances considered, **When** the agent
   supplies that narrowing, **Then** only those instances are consulted; **and** when the
   agent supplies no narrowing, a configured default set is used without the agent having
   to know it.

---

### User Story 3 - Retrieve a known catalogue entity's details (Priority: P3)

The operator or agent already holds an entity identifier — typically taken from the
candidate list in Story 2, or from a link, ticket, or earlier conversation. The agent
retrieves that entity's details directly, without searching.

**Why this priority**: Lowest of the three because it delivers least value in isolation —
it presupposes an identifier obtained elsewhere. It is nonetheless required to close the
loop from Story 2: when a human picks from a candidate list, the agent needs a way to act
on that choice.

**Independent Test**: Testable on its own by requesting a known entity type and identifier
and asserting the returned details and completeness statement, plus the behaviour for an
unknown identifier.

**Acceptance Scenarios**:

1. **Given** a valid entity type and identifier, **When** the agent requests it, **Then**
   it receives that entity's details plus a completeness statement.
2. **Given** an identifier that does not exist, **When** the agent requests it, **Then**
   it receives a clear "not found" outcome rather than an empty success.
3. **Given** an entity type outside the supported set, **When** the agent requests it,
   **Then** it receives an argument error precise enough for the agent to correct itself
   without a human.

---

### Edge Cases

- **Partial upstream failure on every story.** Some brand instances answer, others do not.
  The result must carry data *and* an unmissable caveat. This is normal operation, not an
  error condition.
- **Partial failure at one step of a multi-step traversal.** The final result must be
  marked incomplete even though the last step succeeded.
- **Upstream timeout with some data already gathered** → result plus caveat. **Timeout
  with nothing usable** → error. The two must not be conflated.
- **Query too broad.** Must produce actionable narrowing guidance, not a truncated list
  silently presented as the whole answer.
- **Identity expires mid-session.** Must surface as an authentication error a human can
  act on, never as "no results found".
- **Operator lacks permission for some fields.** The agent sees exactly what the human is
  entitled to see; the feature makes no attempt to detect, reconstruct, or flag that
  filtering.
- **Agent supplies an unknown instance code.** Must be an argument error that names the
  discovery capability from Story 1 as the way to obtain valid codes.
- **Agent supplies contradictory narrowing** (e.g. an instance list that is empty, or
  entirely unknown codes) → argument error, not a silent full-scope query.
- **Required operational configuration missing at startup** → the service must refuse to
  start rather than begin serving requests against an unknown or default upstream target.
- **Two invocations with different identities in one process.** Each must be forwarded with
  its own identity and see only its own operator's data. This cannot occur in the local
  slice, but is asserted now so the behaviour is already correct when remote access is added
  (FR-023a).

## Requirements *(mandatory)*

### Functional Requirements

**Identity and access**

- **FR-001**: The system MUST forward the calling operator's identity to the upstream
  system unaltered, so that the upstream system's own authorization applies to the real
  operator rather than to a shared identity.
- **FR-002**: The system MUST NOT create, exchange, cache, store, or log operator
  credentials, and MUST NOT hold an identity of its own for the upstream system.
- **FR-003**: The system MUST reject a request whose identity is absent, expired, or
  issued by an authority other than the one configured for its environment, and MUST
  report that outcome as an authentication failure distinguishable from all other errors.
- **FR-004**: The system MUST NOT attempt to detect, reconstruct, or compensate for
  field-level filtering applied by the upstream system on the operator's behalf.

**Data completeness (applies to every capability)**

- **FR-005**: Every successful result MUST carry a structured, machine-readable
  completeness statement as a top-level element, present even when the result is fully
  complete, and never expressed only as prose.
- **FR-006**: A result MUST be marked complete only when the upstream system reported
  unqualified success. Any qualified outcome MUST be marked incomplete.
- **FR-007**: A completeness statement MUST name which instances failed and carry any
  error detail the upstream system reported per instance.
- **FR-008**: When a capability takes multiple steps, the completeness statement MUST
  aggregate every step: incomplete if any step was incomplete, reporting the most severe
  outcome encountered, and listing the union of all failures across steps.
- **FR-009**: Each capability's description MUST instruct the consuming agent to relay
  completeness caveats to the human operator.
- **FR-010**: The system MUST distinguish, as separate outcomes: usable data with a
  caveat; nothing matched; an argument error the agent can correct itself; an
  authentication failure needing a human; and an upstream failure yielding nothing usable.

**Capabilities**

- **FR-011**: Users MUST be able to discover the valid brand instance codes, so no
  consumer has to guess or hardcode them.
- **FR-012**: Users MUST be able to find a catalogue entity by a partial, case-insensitive
  name across the supported entity types.
- **FR-013**: When a name matches exactly one entity, the system MUST resolve it and
  traverse one level further to include its immediate children (depth fixed by FR-025),
  aggregating completeness across every step taken.
- **FR-014**: When a name matches more than one entity, the system MUST return all
  candidates with distinguishing detail and MUST NOT select one. Collapsing several
  plausible answers into one is prohibited.
- **FR-015**: When a query is too broad for the upstream system to answer, the system MUST
  return no resolution plus an explicit statement of which field to narrow by.
- **FR-016**: Users MUST be able to retrieve a supported catalogue entity's details by
  entity type and identifier.
- **FR-017**: Consumers MUST be able to narrow any query to specific brand instances, and
  MUST get a sensible configured default when they do not, without needing to know that
  default.

**Operational boundaries**

- **FR-018**: The system MUST take its upstream target, accepted identity authority,
  default instances, and timeouts from deployment configuration only. None of these MAY be
  supplied by a consuming agent, and none MAY be embedded in the built artefact.
- **FR-019**: The system MUST refuse to start when required configuration is absent,
  rather than starting and failing at first request.
- **FR-020**: The system MUST NOT record operator credentials or personal data in logs,
  traces, or error messages. Diagnostics MUST be sufficient to determine, per request,
  which capability ran, what upstream outcome each step produced, how a name resolved, and
  how long it took.
- **FR-021**: The system MUST expose a health signal usable by automated monitoring
  without a caller identity.
- **FR-022**: The exposed capability set MUST be limited to the three above. It MUST NOT
  be derived mechanically from the upstream system's full interface, and MUST NOT be built
  on upstream operations marked deprecated.

**Scope boundaries** *(resolved 2026-09-03 — see Clarifications)*

- **FR-023**: The system MUST be reachable by an agent running as a local process on the
  same machine as the operator. Remote network access is **out of scope for this slice**.
- **FR-023a**: The operator's identity MUST be supplied per tool invocation and MUST NOT be
  read from process-global or module-level state, even though this slice serves a single
  local operator. This is testable: two invocations carrying different identities within one
  process MUST each be forwarded with their own identity, with no bleed between them.
  *(Rationale: this is the only part of the local→remote path that is not additive.
  Retrofitting it later would be a cross-cutting refactor whose failure mode is one
  operator seeing another's data.)*
- **FR-023b**: The tool definitions MUST NOT depend on how a request arrived, so that adding
  a transport later requires no change to any tool. Verified by the tool set being
  registered independently of transport wiring.
- **FR-024**: This slice is done when it runs on a developer machine against a
  non-production upstream with the full automated test suite passing. Deploying to any
  shared environment is out of scope.
- **FR-024a**: ~~The repository MUST adopt the organisation's standard service scaffold
  within this slice.~~ **Superseded 2026-09-03 — scaffold deferred.** Nothing is deployed in
  this slice, so the scaffold's value (org pipeline, TLS, monitoring) is unrealised while its
  layout constraints would shape code for a deployment that does not exist. Adoption remains a
  blocking prerequisite for any non-local deployment (constitution v1.0.2,
  `TODO(PREFAB_MIGRATION)`). What preserves the original intent is FR-024b: env-config
  discipline is kept regardless, so later adoption stays a configuration exercise rather than
  a rewrite. See [research.md](./research.md) R6.
- **FR-024b**: Even though nothing is deployed in this slice, all operational values MUST
  already be read from environment configuration with startup validation (FR-018, FR-019).
  No upstream target, identity authority, or default instance list may be embedded in code
  or defaulted silently.
- **FR-025**: When a name resolves to exactly one entity, the system MUST return that entity
  together with its **immediate children** (one level), and MUST NOT traverse deeper in this
  slice. Completeness MUST be aggregated across both steps.
  *(One level is the shallowest depth that still exercises multi-hop completeness
  aggregation — the correctness behaviour this slice exists to prove — while keeping
  too-broad and partial-failure exposure bounded.)*

### Key Entities

- **Catalogue entity**: A named node in the upstream catalogue hierarchy. The supported
  types form a containment chain — the broadest grouping contains sub-groupings, which
  contain event types, which contain individual events. Each has an identifier, a name,
  and a type.
- **Brand instance**: One brand-specific upstream source that a query may be answered
  from. Identified by a short code. A single logical answer is assembled from several
  instances, any of which may fail independently — which is why completeness exists.
- **Completeness statement**: The mandatory, structured verdict attached to every result:
  whether it is complete, the most severe outcome encountered, which instances succeeded,
  which failed, and what each failure reported.
- **Resolution outcome**: The result of interpreting a name — either one resolved entity,
  a set of candidates with none chosen, nothing matched, or too-broad with narrowing
  guidance.
- **Operator identity**: The human's credential, passed through unaltered and never
  stored. Determines both whether a request is permitted and which fields it may see.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In **100%** of results derived from a partial upstream outcome, the
  incompleteness and the specific failed instances are present in the result as structured
  data. Zero cases where partial data can be read as complete. *(This is the criterion the
  feature exists to satisfy; it is verified against a controlled upstream that can produce
  every outcome on demand.)*
- **SC-002**: In **100%** of cases where a name is genuinely ambiguous, every plausible
  candidate is returned and none is auto-selected.
- **SC-003**: All six upstream outcome classes — full success, partial success, too broad,
  timeout with data, timeout without data, outright failure — plus authentication failure
  are each exercised by an automated test for every capability, and each produces the
  outcome class defined in FR-010.
- **SC-004**: An operator's question about a single unambiguous named entity is answered in
  **one** agent tool call, with no manual identifier lookup and no knowledge of the
  upstream system's structure.
- **SC-005**: An agent that has never been told the valid brand codes can obtain them and
  then issue a correctly narrowed query, without guessing and without a failed attempt.
- **SC-006**: Zero occurrences of operator credentials or personal data in any log, trace,
  or error message, verified by automated inspection.
- **SC-007**: A misconfigured deployment fails at startup in **100%** of cases, and never
  serves a request against an unintended upstream target.
- **SC-008**: An agent given an invalid argument corrects itself and succeeds on a
  subsequent attempt without human intervention, for each of: unknown instance code,
  unsupported entity type, unknown identifier.
- **SC-009**: A newly onboarded engineer can add one further capability to this surface
  without modifying any shared foundation, demonstrating the slice is a template for
  growth and not a one-off.
- **SC-010**: Adding remote network access later requires **zero changes** to any tool
  definition and **zero changes** to how identity reaches a tool — demonstrated now by an
  automated test proving two different identities are handled independently within a single
  process (FR-023a), and by tools being registered independently of transport (FR-023b).
- **SC-011**: A single-match query returns the matched entity and its immediate children in
  **one** agent tool call, with completeness aggregated across both steps — so a partial
  failure in either step marks the whole result incomplete.

## Assumptions

Recorded because the feature description was a single sentence; each is a reasonable
default drawn from the ratified constitution and the design plan, not an invention.

- **The slice is the plan's v1**: exactly three capabilities over the catalogue domain.
  Additional domains, cross-domain bundles, and autonomous/headless agents are out of
  scope — the last is explicitly deferred pending a real use-case.
- **A human is present at request time.** Every request carries a live human credential.
  There is no unattended path in this slice.
- **The upstream system requires no change.** Verified during constitution ratification:
  its identity model accepts a forwarded operator credential as-is.
- **Authorization is currently group-level, not field-level.** Also verified: the upstream
  system's fine-grained field filtering is switched off in every deployed environment. The
  feature therefore must not be described as delivering per-user field-level filtering,
  though pass-through means it will deliver it unchanged if that filtering is enabled later.
- **Identity authorities are per-environment**, so a credential is valid against exactly
  one environment and environments are not interchangeable. Environment selection is an
  operational concern, never an agent's choice.
- **The upstream system is treated purely as an external dependency** reached over its
  published interface, as its existing front-end does. No shared internals.
- **Correctness is proven against a controlled upstream**, because a live upstream cannot
  be made to produce partial failure or timeout on demand. Live validation is a manual
  pre-release step, not an automated gate.
- **"Too broad" has a concrete upstream threshold** (a maximum result size, configured
  upstream at 200), so the too-broad path can be provoked deterministically in tests.
- **Automated deployment inherits organisation defaults** for pipeline, transport
  security, and monitoring from the standard service scaffold, whenever it is adopted —
  this feature does not invent them, and does not adopt the scaffold either (FR-024a
  superseded).
- **Local-first is a sequencing choice, not a permanent one.** Remote access is expected
  later. It is deferred because the authorization handshake it requires is additive work,
  whereas the one non-additive concern — per-invocation identity — is mandated now
  (FR-023a). No other design decision in this slice assumes a single caller.
- **The upstream catalogue interface is stable** for the duration of this slice, and its
  current version is the one to build against; its deprecated predecessor is not.
