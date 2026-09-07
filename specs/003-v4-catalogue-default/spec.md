# Feature Specification: v4 Catalogue Surface by Default

**Feature Directory**: `specs/003-v4-catalogue-default`

**Feature Branch**: `002-local-cli-agent` (current working branch; no new branch created)

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "The current implementation uses v5 path of gma only. I want it to
use v4 as default and only search for v5 if said specifically. You can take a look at
../gma-service/ to learn more about this endpoint before specifying anything"

**Interpretation**: The three existing catalogue capabilities are hard-wired to the upstream
system's **newest** catalogue interface generation. This feature makes the **older, more widely
adopted** generation the default one queried, and makes the newer generation reachable only when
something explicitly asks for it. Nothing about which capabilities exist, what they return, or
how completeness is reported changes. This is a change of **which upstream generation answers**,
not a change of what the tools do.

## Findings from `../gma-service` *(read before specifying; these constrain the whole spec)*

Read on 2026-09-07 from `gma-api/src/main/resources/static/`. Recorded here because one of them
makes a naive reading of the request impossible to satisfy.

| Fact | Detail |
|---|---|
| Both generations are live, side by side | `api_catalogue_v4.yaml` (declares itself version `4.0.0`) and `api_catalogue.yaml` (`5.0.0`) are both served, both listed in the upstream README as current, and both exempted from auth on the same allowlist. |
| Neither generation is marked deprecated | Zero `deprecated: true` operations in either file. The two `deprecated` mentions in the newer file describe *enum values*, not operations. |
| The older generation is a **subset** | 14 paths / 21 operations, versus 22 paths / 30 operations. Every older path has a same-named counterpart in the newer one. |
| **The name search does not exist on the older generation** | The `searchByName` operation appears **only** on the newer generation, added recently (upstream commit "Add name based search endpoint"). The older generation has **no** by-name search of any kind. **This is the blocking finding — see FR-004 and the Assumptions.** |
| The partial-failure contract is identical | Both declare `200` / `206` with `successfulConfigSources` / `failedConfigSources` / `errors[{configSource, message}]`, and the same `400` / `401` / `404` / `500` set on the same operations. |
| The instance-narrowing contract is identical | Same required `instancesList` query parameter, same URN item shape, on the same operations. |
| The three capabilities' non-search operations exist on both | instance listing, and retrieval-by-identifier for all three supported entity types, plus one-level child listing — same paths, same response wrappers (`SuperclassResponseSuccess`, `SubclassResponse`, `EventTypeResponse`, `EntitiesResponse`), same nesting of ancestry and children. |
| Small shape differences exist and are read-through-safe | The newer generation adds an optional field to the instance record, moves one identifier map inside a settings object on one entity type, and renames one *filter* field on an operation none of the three capabilities use. None of these touch the identifier, name, ancestry, or child fields the capabilities actually read. |
| Upstream's own versioning stance | The upstream project documents URL-path versioning whose stated requirement is that "previous version operations must be available on new version". Generations are additive; the older one is not a legacy stub. |

## User Scenarios & Testing *(mandatory)*

The direct consumer is an **AI agent** acting for a **human operator**; the human is the one who
must not be misled. Two additional stakeholders appear in this feature: the **operator of the
deployment**, who decides which generation is default, and the **engineer** who will later add a
capability that only the newer generation can serve.

### User Story 1 - Existing capabilities answer from the older generation by default (Priority: P1)

An operator asks their agent the same catalogue questions as before. Without changing anything
about how they ask, the answers are now assembled from the older, more widely adopted upstream
generation. The results look the same: same identifiers, same names, same ancestry, same
completeness statement.

**Why this priority**: This is the entire point of the feature. It is also the only story that
can regress existing behaviour, so it must be provable first and in isolation.

**Independent Test**: Fully testable on its own by exercising each existing capability against a
controlled upstream and asserting that (a) the older generation was the one consulted, and (b)
the agent-facing result is unchanged in shape and content from the current behaviour.

**Acceptance Scenarios**:

1. **Given** a deployment with no generation explicitly requested anywhere, **When** the agent
   lists brand instances, **Then** the older generation is consulted and the result carries the
   same instance codes, names, and completeness statement it would have before this change.
2. **Given** a known entity identifier and type, **When** the agent retrieves that entity,
   **Then** the older generation is consulted and the entity's identifier, name, and ancestry
   chain are unchanged from the current behaviour.
3. **Given** an entity that resolves to exactly one match, **When** its immediate children are
   retrieved, **Then** the older generation is consulted for that step too, and completeness is
   still aggregated across both steps.
4. **Given** the older generation reports a partial outcome, **When** any capability returns,
   **Then** the completeness statement is produced exactly as it is today — same outcome
   vocabulary, same named failed instances, same relay instruction. The generation in use MUST
   NOT change how completeness is derived or expressed.
5. **Given** an outcome that maps to an error — authentication, argument, not-found, upstream
   failure, or timeout with nothing usable — **When** it arrives from the older generation,
   **Then** it is classified into exactly the same error class as it is today.

---

### User Story 2 - A capability the older generation cannot serve still works (Priority: P1)

The by-name search **does not exist** on the older generation. An operator asking "find the
Premier League event type" must still get an answer, and must never be told the capability is
unavailable, and must never be silently given a *different* kind of answer than they asked for.

**Why this priority**: Also P1, because it is not optional and not deferrable. Making the older
generation the blanket default without addressing this would delete the single most valuable
existing capability. This story is what makes Story 1 shippable rather than a regression.

**Independent Test**: Testable on its own by invoking the by-name search on a deployment whose
default is the older generation and asserting a correct, complete answer is returned, together
with a record of which generation actually served it.

**Acceptance Scenarios**:

1. **Given** a deployment defaulting to the older generation, **When** the agent searches by
   name, **Then** the search succeeds and returns the same resolution outcomes as today
   (one resolved entity, several candidates, nothing matched, or too broad).
2. **Given** that same search, **When** it completes, **Then** the operator-facing result MUST
   NOT be degraded, truncated, or replaced by an "unsupported" error on the grounds that the
   default generation lacks the operation.
3. **Given** that the search was served by a generation other than the deployment's default,
   **When** the result is produced, **Then** that fact is recorded in diagnostics so an operator
   can tell which generation answered, without the agent's answer being cluttered by it.
4. **Given** a search that is served by the newer generation and a follow-up child retrieval
   that the default generation can serve, **When** both steps complete, **Then** completeness is
   aggregated across the two steps exactly as it is today, regardless of the generations
   involved.

---

### User Story 3 - An operator pins the generation for a deployment (Priority: P2)

The operator of a deployment decides which generation its capabilities query, and changes that
decision without a code change and without a new build. Doing so takes effect for every request
that deployment serves.

**Why this priority**: P2 because Stories 1 and 2 already deliver the requested behaviour with a
sound default. This story is what makes the default *a choice* rather than a new hard-coding — it
is the difference between having moved the hard-wiring and having removed it.

**Independent Test**: Testable on its own by starting the system with each supported setting and
asserting which generation each capability consults, plus asserting the startup behaviour for an
unsupported or malformed setting.

**Acceptance Scenarios**:

1. **Given** no generation setting is supplied, **When** the system starts, **Then** it starts
   successfully and the older generation is the default.
2. **Given** the setting names the newer generation, **When** the system starts, **Then** every
   capability that can be served by the newer generation is served by it.
3. **Given** the setting names an unsupported or malformed generation, **When** the system
   starts, **Then** it refuses to start and names the offending setting, rather than starting and
   failing at first request or silently falling back to a default.
4. **Given** any supported setting, **When** an agent invokes a capability, **Then** the agent
   MUST NOT be able to influence which generation is consulted. Generation selection is
   operational, never an agent-supplied argument.

---

### User Story 4 - An engineer adds a capability only the newer generation offers (Priority: P3)

An engineer builds a future capability over an operation that exists **only** on the newer
generation. They declare that requirement once, at the capability, and it is honoured on every
deployment regardless of that deployment's default.

**Why this priority**: Lowest, because it delivers no operator-visible value today. It is
included because it is the shape the user's "only search for v5 if said specifically" asks for,
and because Story 2 is its first instance — the by-name search is already exactly this case.
Designing it as one mechanism rather than a special case for search is what stops the next
newer-only operation from becoming a second exception.

**Independent Test**: Testable on its own by declaring a capability as requiring the newer
generation, running it on a deployment defaulting to the older one, and asserting the newer
generation was consulted and the result is unaffected.

**Acceptance Scenarios**:

1. **Given** a capability declared as requiring the newer generation, **When** it runs on a
   deployment defaulting to the older one, **Then** the newer generation is consulted for that
   capability's steps and no other capability's default changes.
2. **Given** a capability with no such declaration, **When** it runs, **Then** the deployment's
   default generation is consulted.
3. **Given** a capability requiring the newer generation, **When** a deployment already defaults
   to the newer generation, **Then** behaviour is identical and the declaration is a no-op rather
   than a conflict.

---

### Edge Cases

- **A capability's steps span both generations** (by-name search on the newer generation,
  child retrieval on the default older one). Completeness must aggregate across both steps
  identically to a single-generation traversal; the generation boundary must not reset,
  soften, or duplicate the verdict.
- **An identifier obtained from one generation is used against the other.** Identifiers are
  upstream URNs and the two generations address the same entities, so this must work. If it
  ever does not, the outcome must be a plain not-found rather than a confusing empty success.
- **The default generation lacks the operation a capability needs and the capability has not
  declared a requirement.** This must be caught before any request is served, not discovered as
  a runtime failure against a live upstream.
- **A response field the two generations shape differently.** Only fields the capabilities
  actually read matter; reading must succeed on both generations, and a field present on only
  one must never be presented as absent-and-meaningful on the other.
- **A partial outcome on one generation and a full outcome on the other, within one
  capability.** The whole result is incomplete, per the existing aggregation rule.
- **An unsupported generation setting at startup.** Refuse to start; never silently fall back.
- **An agent that tries to pass a generation as an argument.** Rejected as an unknown argument;
  generation is never agent-selectable.
- **The upstream adds an operation to the older generation that previously existed only on the
  newer one** (as could happen for by-name search). Moving a capability back to the default must
  be a declaration change, not a rewrite.

## Requirements *(mandatory)*

Requirement numbering is **local to this feature** and restarts at FR-001. It does **not** continue
001's sequence, so several ids collide with a different requirement of the same number in
[001's spec](../001-catalogue-mcp-tools/spec.md) — this feature's FR-003 is about generation
resolution, 001's is about rejecting an invalid identity.

**Citation convention across all artefacts of this feature**: a bare `FR-nnn` / `SC-nnn` always
means *this* spec. A requirement inherited from an earlier feature is written with its feature
prefix — `001-FR-020` (no credential in logs), `001-FR-023a` (per-invocation identity),
`001-FR-014` (return all candidates, never auto-pick), `001-FR-003` (auth failure
distinguishable). The colliding ids are FR-003, FR-008, FR-014, and FR-018; the prefix is what
keeps them apart.

### Functional Requirements

**Default generation**

- **FR-001**: The system MUST consult the **older** upstream catalogue generation by default for
  every capability that the older generation is able to serve.
- **FR-002**: The system MUST consult the **newer** generation only when it is explicitly
  selected — either by the deployment's configured default, or by a capability that has declared
  it requires the newer generation. It MUST NOT be reached by accident, by fallback, or by an
  agent's request.
- **FR-003**: The upstream generation MUST NOT be hard-coded at the point of each call. There
  MUST be exactly one place that decides which generation a given call uses, so that the default
  can be changed without editing any capability.

**The capability the older generation cannot serve**

- **FR-004**: Because the by-name search operation **does not exist** on the older generation
  (see Findings), the by-name search capability MUST continue to be served by the newer
  generation, and MUST NOT be removed, degraded, or replaced with an error when the deployment
  default is the older generation.
- **FR-005**: That exception MUST be expressed as a **declared, per-capability requirement**
  rather than as a special case in the calling code, so that any future capability needing the
  newer generation declares the same way.
- **FR-006**: A capability whose required generation cannot serve one of its steps MUST be
  detected before any request is served — at startup — rather than failing at first use.
- **FR-007**: The system MUST NOT invent, emulate, or approximate a missing upstream operation
  on the generation that lacks it. Where an operation is absent, the answer is to use the
  generation that has it, not to synthesise it from other operations.

**Behaviour preservation**

- **FR-008**: The agent-facing capability set MUST be unchanged by this feature: same
  capabilities, same inputs, same output shapes. No input or output field may be added, removed,
  or renamed as a consequence of the generation change.
- **FR-009**: The completeness statement MUST be derived and expressed identically regardless of
  which generation answered — same signal source, same outcome vocabulary, same aggregation
  across steps, same relay instruction. The generation in use MUST NOT be a factor in how
  completeness is computed.
- **FR-010**: Every outcome class the system distinguishes today — usable data with a caveat,
  nothing matched, an argument error the agent can self-correct, an authentication failure
  needing a human, an upstream failure yielding nothing usable, a not-found, a too-broad query —
  MUST continue to be produced from the equivalent upstream outcome on whichever generation
  answered.
- **FR-011**: Instance narrowing MUST behave identically on both generations: an explicit
  narrowing is honoured, an absent one falls back to the configured default set, and a
  contradictory one is an argument error.
- **FR-012**: The upstream generation in use MUST NOT appear in any agent-facing input schema,
  output field, or capability description. Upstream interface mechanics stay hidden from the
  model.

**Operational control**

- **FR-013**: The deployment's default generation MUST be settable through deployment
  configuration, MUST default to the older generation when unset, and MUST NOT be settable by a
  consuming agent.
- **FR-014**: An unsupported or malformed generation setting MUST cause the system to refuse to
  start, naming the offending setting, rather than starting or silently falling back.
- **FR-015**: Diagnostics MUST record, per upstream call, which generation was consulted, so an
  operator can tell which generation served an answer. This MUST NOT introduce any credential or
  personal data into diagnostics.

**Verification**

- **FR-016**: For each operation a capability depends on, controlled-upstream test doubles MUST
  exist for **every generation that offers that operation**, covering every upstream outcome
  **that generation declares for it**. A capability MUST NOT be considered done for a generation
  it has no doubles for.
  *(Scoped this way because a blanket "both generations, every outcome" is unsatisfiable: the
  by-name search exists on only one generation, and even there it declares no partial-success
  outcome. Demanding a double for an outcome the upstream never returns would mean asserting
  fiction — the same trap the existing fixture library already avoids for that operation.)*
- **FR-017**: There MUST be an automated test proving that, with default configuration, each
  capability consults the older generation — and one proving the by-name search consults the
  newer generation on that same default deployment.
- **FR-018**: There MUST be an automated test proving completeness aggregation is correct for a
  capability whose steps span **both** generations.

### Key Entities

- **Upstream catalogue generation**: One published generation of the upstream catalogue
  interface. Two exist, both current, both non-deprecated; the older is a strict subset of the
  newer for the operations these capabilities use, with the by-name search the one exception.
- **Generation selection**: The single decision, per upstream call, of which generation to
  consult. Derived from the deployment's configured default and any per-capability declared
  requirement. Never derived from an agent's input.
- **Per-capability generation requirement**: A declaration attached to a capability stating that
  it needs a specific generation because an operation it depends on exists only there.
- **Operation availability**: Which generations offer a given upstream operation. What makes the
  by-name search exception a checkable fact rather than a comment.

Entities from the existing catalogue feature — catalogue entity, brand instance, completeness
statement, resolution outcome, operator identity — are unchanged by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With default configuration, **100%** of upstream calls made by capabilities the
  older generation can serve go to the older generation. Zero calls to the newer generation
  except those explicitly required.
- **SC-002**: **Zero** change to the agent-facing capability surface: capability names, input
  fields, and output fields are byte-identical before and after, verified automatically.
- **SC-003**: **100%** of results still carry a completeness statement, and every outcome class
  is exercised on **both** generations by automated tests, each producing the same outcome class
  it produces today.
- **SC-004**: The by-name search succeeds on a deployment defaulting to the older generation, in
  **100%** of cases, with no degradation of any resolution outcome.
- **SC-005**: Changing a deployment's default generation requires **zero** source changes and
  **zero** rebuilds — configuration only.
- **SC-006**: A malformed or unsupported generation setting prevents startup in **100%** of
  cases, and no request is ever served against an unintended generation.
- **SC-007**: An engineer can add a capability requiring the newer generation by making **one**
  declaration, touching no shared calling code and no other capability.
- **SC-008**: A capability whose steps span both generations reports completeness identically to
  an equivalent single-generation traversal, proven by an automated test.
- **SC-009**: An operator can determine which generation answered any given request from
  diagnostics alone, with **zero** occurrences of credentials or personal data introduced.
- **SC-010**: **Zero** upstream code changes and **zero** upstream configuration changes are
  required by this feature.

## Assumptions

Each is a reasonable default drawn from reading `../gma-service` on 2026-09-07, from the ratified
constitution, or from the existing catalogue feature — not an invention.

- **"v4" and "v5" mean the two live catalogue generations** described in the Findings, and the
  request is about which of them answers, not about changing what the capabilities do.
- **The by-name search must keep working.** The user asked for the older generation as default;
  they did not ask to lose the by-name search, and the older generation cannot serve it. Keeping
  it on the newer generation is the only reading that satisfies both the request and the
  capability set. This is treated as the first instance of the general "explicitly requires the
  newer generation" mechanism the user described, rather than as a carve-out.
- **The older generation is not deprecated.** Confirmed: no deprecated operations in either
  spec, both listed as current upstream. So defaulting to the older generation does not violate
  the constitutional prohibition on building on deprecated upstream operations.
- **Both generations remain available** for the duration of this feature. If the older one were
  withdrawn, the default would become a configuration change, not a rewrite — which is the
  point of FR-003 and FR-013.
- **The two generations address the same entities with the same identifiers**, so an identifier
  obtained from one is usable against the other. Supported by both generations documenting the
  same identifier format and the same example identifiers for the same entity types.
- **Response-shape differences between generations do not affect the fields these capabilities
  read.** Verified field by field for the operations in use; the differences are an added
  optional instance field, one identifier map relocated inside a settings object, and a renamed
  filter field on an unused operation.
- **The partial-failure signal is the same on both generations** — the same HTTP status codes and
  the same per-instance success/failure lists — so the existing single place that derives
  completeness needs no second representation.
- **Generation selection is operational, like the upstream base target.** It is therefore
  configuration, never an agent argument, by the same reasoning that keeps the upstream target
  out of the agent's hands.
- **No new capability is introduced.** The newer generation's additional operations remain out
  of scope; this feature only changes which generation the existing three capabilities use.
- **Verification stays against a controlled upstream.** A live upstream cannot be made to
  produce partial failure or timeout on demand, so both generations are proven against test
  doubles, with live checks a manual pre-release step.
