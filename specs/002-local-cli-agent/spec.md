# Feature Specification: Local CLI Agent Harness

**Feature Directory**: `specs/002-local-cli-agent`

**Feature Branch**: `main` (no feature branch; local-only development stage)

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "I want to create an agent for this server, look at the
specifications at `docs/agent-cli-brief.md`"

**Interpretation**: The repository now has a working MCP server exposing three catalogue
capabilities, proven by an automated suite. What that suite cannot prove is whether a real
language model, reading only the server's own capability descriptions, actually *relays* a
partial-data caveat to the human and actually *refuses* to pick between ambiguous
candidates — both non-negotiable properties of this project. Those are properties of the
final natural-language turn, and nothing currently exercises that turn. This feature builds
the conversational command-line harness that does, and in doing so replaces the generic
protocol inspector the quickstart currently leans on.

**Design record**: `docs/agent-cli-brief.md` captures the settled design decisions (runtime
placement, orchestration approach, credential flow, test strategy) reached before this spec
was written. This specification states *what* must be true and *why*; the brief is the
authoritative record of *how*, and `/speckit-plan` should read it as an input rather than
re-deciding those points.

---

## User Scenarios & Testing *(mandatory)*

The user of this feature is an **engineer working on this repository**. That is a different
audience from feature 001, whose user is an AI agent acting for a trading/risk operator.
Here the engineer is both the operator of the harness and the person whose judgement the
harness informs: they are trying to find out whether the server behaves correctly when an
unmodified language model is the one reading it.

### User Story 1 - Ask the catalogue a question in plain language (Priority: P1)

An engineer with a valid operator credential already in hand starts the harness with a
single command. It signs them in, starts the catalogue server as a child process, discovers
its capabilities, and gives them a prompt. They type a question in ordinary English. They
watch which capability the model chose and what arguments it passed, then read the answer.
They ask a follow-up that refers back to the previous answer, and it is understood.

**Why this priority**: This is the smallest thing that is useful on its own and it is the
foundation every other story stands on. Today the only way to exercise the server by hand
is a generic protocol inspector where the engineer must hand-author arguments — which means
the model's *choice* of capability and arguments, the thing most likely to be wrong in
practice, is never observed at all. Delivering only this story already replaces that
workflow.

**Independent Test**: Fully testable alone: start the harness with a credential supplied
from the environment, ask a question about a known catalogue entity against a non-production
upstream, and confirm a natural-language answer arrives, that the capability invocation was
shown before the answer, and that a follow-up referring to the prior turn resolves against
it.

**Acceptance Scenarios**:

1. **Given** a complete local configuration and a valid operator credential in the
   environment, **When** the engineer starts the harness, **Then** it reports the identity
   in use and reports that the server started with its three capabilities discovered, in
   under 10 seconds, and presents a prompt.
2. **Given** a running harness, **When** the engineer asks a question answerable by one
   capability, **Then** the harness displays the capability name and the arguments chosen
   *before* the answer, and then a natural-language answer.
3. **Given** a question that needs two capability invocations, **When** the engineer asks
   it, **Then** each invocation is displayed as it happens, in order.
4. **Given** a completed turn that returned several candidates, **When** the engineer
   replies with a phrase referring to one of them rather than repeating its full name,
   **Then** the harness resolves the reference against the previous turn.
5. **Given** an ongoing conversation, **When** the engineer issues the reset command,
   **Then** prior turns no longer influence subsequent answers and the harness stays
   running.
6. **Given** a running harness, **When** the engineer exits, **Then** the child server
   process is terminated and no orphan process remains.
7. **Given** a request the model attempts to answer without the catalogue, **When** the
   turn completes, **Then** capability invocations (or their absence) are still visible to
   the engineer, so it is never ambiguous whether the server was consulted.

---

### User Story 2 - Diagnose a broken setup from the harness's own output (Priority: P2)

An engineer whose local configuration is incomplete or whose credential has gone stale runs
the harness. Instead of an opaque failure, they get a message naming the exact value that is
missing or wrong, before anything else is started, and if the child server refuses to start
they see the server's own explanation rather than silence.

**Why this priority**: Without this, the most likely first experience of the feature is a
silent or misattributed failure. The child server deliberately fails fast on missing
configuration (feature 001, FR-019), but it explains itself on a diagnostic stream that
nothing is reading, so the visible symptom is an unexplained exit. This story is second
only because story 1 is what makes the harness worth diagnosing.

**Independent Test**: Testable alone by removing one required configuration value and one
credential in turn, running the harness, and asserting the message names the specific
missing value; and by forcing the child server to refuse to start and asserting its
explanation is shown.

**Acceptance Scenarios**:

1. **Given** a required configuration value is absent, **When** the engineer starts the
   harness, **Then** it stops with a message naming that specific value, and the child
   server is never started.
2. **Given** the child server refuses to start, **When** the harness detects this, **Then**
   the server's own diagnostic output explaining why is shown to the engineer.
3. **Given** normal operation, **When** the child server emits routine diagnostic output,
   **Then** that output does not interleave with or corrupt the engineer's prompt.
4. **Given** the engineer wants to see everything, **When** they enable verbose mode,
   **Then** the child server's diagnostic output is shown as it happens.
5. **Given** any failure or verbose output, **When** it is displayed, **Then** no credential
   or credential fragment appears in it.

---

### User Story 3 - Confirm the server's two non-negotiable contracts survive the final turn (Priority: P2)

An engineer provokes a partial upstream result and a genuinely ambiguous name, and observes
what the human-facing answer actually says. If the caveat is dropped, or the model picks one
candidate and presents it as *the* answer, that is a defect in the server's capability
descriptions and this is how it becomes visible.

**Why this priority**: This is the reason the feature exists. It cannot be P1 because it is
observed *through* story 1 rather than beside it, but it is the outcome that justifies the
work: the existing suite proves a capability *result* carries its completeness verdict, and
can never prove the verdict reaches a human. Marking it lower than P1 is a sequencing
statement, not a statement about importance.

**Independent Test**: Testable once story 1 exists, by pointing the harness at an upstream
that produces a partial result and asking a question that triggers it, then reading the final
natural-language answer for the caveat; and separately by asking about a name that matches
several entities and reading whether all candidates are presented.

**Acceptance Scenarios**:

1. **Given** an upstream that returns a partial result, **When** the engineer asks a
   question that hits it, **Then** the final natural-language answer states that the answer
   is incomplete and identifies which instances failed.
2. **Given** a name matching several catalogue entities, **When** the engineer asks about it
   by that name, **Then** the answer presents every candidate and asks which was meant, and
   does not proceed as though one had been chosen.
3. **Given** the harness's own instruction to the model, **When** it is inspected, **Then**
   it does not restate the caveat-relaying or non-selection rules itself, so that what is
   being observed is the adequacy of the server's own descriptions.
4. **Given** either contract is not honoured in the final answer, **When** the engineer
   observes this, **Then** the observed behaviour is attributable to the server's capability
   descriptions rather than to the harness's instruction.

---

### User Story 4 - Sign in from the terminal by opening a link (Priority: P3)

An engineer with no credential in hand runs the harness. It prints a short code and a link.
They open the link in a browser, authenticate through the organisation's normal identity
flow, and the harness proceeds. Subsequent runs reuse the stored credential without asking
again.

**Why this priority**: It removes the last manual step and the last reason to have a
long-lived credential pasted into a local file. It is P3 because it depends on an identity
application that does not yet exist and must be requested from an administrator, and because
the supplied-credential path in story 1 already makes the harness fully usable in the
meantime.

**Independent Test**: The interactive flow's state machine — pending, retry-slower, denied,
expired, and success — is testable against a controlled identity endpoint with no browser and
no real identity provider. The end-to-end browser step is a manual verification.

**Acceptance Scenarios**:

1. **Given** no credential is available from any source, **When** the engineer starts the
   harness, **Then** it displays a verification link and a user code and waits.
2. **Given** the engineer completes authentication in the browser, **When** the harness next
   polls, **Then** it proceeds to start the server without further input.
3. **Given** the engineer has not yet completed authentication, **When** the harness polls,
   **Then** it waits the interval the identity provider asked for, and does not poll faster.
4. **Given** the identity provider asks the harness to slow down, **When** it next polls,
   **Then** the interval increases.
5. **Given** the engineer denies the request, **When** the harness polls, **Then** it stops
   with a message saying access was denied.
6. **Given** the code expires before the engineer completes authentication, **When** the
   harness polls, **Then** it stops and tells the engineer to start login again, rather than
   polling indefinitely.
7. **Given** a stored credential from a previous run that is still valid **and** was issued
   by the identity authority currently configured, **When** the engineer starts the harness,
   **Then** it is reused with no login prompt and no request to the identity provider.
8. **Given** a stored credential issued by a *different* identity authority than the one
   configured, **When** the engineer starts the harness, **Then** it is rejected with a clear
   message and not used or renewed.
9. **Given** a credential is stored, **When** it is written, **Then** it is readable only by
   its owner, stored outside the repository, and never appears in the repository's history.
10. **Given** the identity application has not yet been created, **When** the engineer starts
    the harness without a supplied credential, **Then** the harness explains exactly what to
    request from an administrator and how to use the supplied-credential path instead.

---

### User Story 5 - Keep working when a credential expires mid-session (Priority: P4)

An engineer in a long session hits an authentication failure because their credential has
aged out. The harness renews it, restarts the server, retries the question, and continues —
with the conversation so far intact.

**Why this priority**: Operator credentials are short-lived (roughly an hour) and the child
server's environment cannot be changed once it is running, so without this the engineer must
restart and lose the conversation. It is last because it depends on story 4 (renewal requires
a stored renewal credential) and because restarting is a tolerable workaround until then.

**Independent Test**: Testable by driving the harness with a credential that is accepted once
and then rejected as expired, and asserting the turn ultimately succeeds and earlier turns
still influence the answer.

**Acceptance Scenarios**:

1. **Given** a mid-session authentication failure, **When** it occurs, **Then** the harness
   renews the credential, restarts the server, and retries the same question without the
   engineer retyping it.
2. **Given** recovery has happened, **When** the engineer asks a question that depends on an
   earlier turn, **Then** the earlier turn is still available.
3. **Given** recovery is in progress, **When** it happens, **Then** the engineer is told —
   it is never silent.
4. **Given** renewal itself fails, **When** it does, **Then** the harness says so plainly and
   directs the engineer to sign in again, rather than retrying indefinitely.
5. **Given** an authentication failure is recovered, **When** the retry is issued, **Then** it
   is attempted at most once for that turn, so a persistent failure cannot loop.

---

### Edge Cases

- **A required configuration value is missing** — surfaced by the harness, naming the value,
  before the server is started (Story 2).
- **The child server exits during startup** — its own explanation is shown, not just an exit
  status (Story 2).
- **The child server exits mid-session** — the engineer is told, and the harness either
  restarts it or exits cleanly rather than accepting input it cannot answer.
- **A stored credential belongs to a different environment** — rejected, not renewed;
  credentials are not portable between upstream environments and silently reusing one
  produces a misleading authorization failure instead of a clear message.
- **A supplied credential is already expired** — the failure is reported as an authentication
  problem naming the credential source, and, where renewal is impossible for that source, the
  engineer is told to supply a new one.
- **The engineer has no permission to use the configured language model** — reported as a
  configuration problem naming the model identifier and how to change it, not as an
  unexplained failure.
- **The language model service is unreachable or rate-limited** — reported without losing the
  conversation, and the engineer may retry.
- **The model asks for a capability that does not exist, or passes invalid arguments** — the
  resulting error is visible to the engineer and available to the model to self-correct.
- **The upstream returns nothing for a name** — the answer says so; it does not fabricate an
  entity.
- **The engineer interrupts mid-answer** — partial output stops, the harness returns to the
  prompt, and the child server is not left in a broken state.
- **Two harness instances run at once** — neither corrupts the other's stored credential.
- **The engineer asks something the catalogue cannot answer** — answered honestly as out of
  scope rather than by a guess dressed as catalogue data.

---

## Requirements *(mandatory)*

### Functional Requirements

**Conversational harness**

- **FR-001**: A single documented command MUST start the harness, and that command MUST
  ensure the server being driven is built from the current source, so an engineer can never
  unknowingly test a stale server.
- **FR-002**: The harness MUST start the catalogue server as a child process on the local
  machine and communicate with it over the local development transport. It MUST NOT require
  a network-reachable deployment.
- **FR-003**: The harness MUST discover the server's capabilities, their argument
  definitions, and their descriptions **from the server at runtime**. It MUST NOT contain
  its own copy of any capability's name, arguments, or description, so the server remains the
  single source of truth and cannot drift from what the model is shown.
- **FR-004**: The harness MUST accept free-text questions and produce natural-language
  answers, with output appearing progressively rather than only when the whole answer is
  ready.
- **FR-005**: For every capability invocation the model makes, the harness MUST display the
  capability name and the arguments passed, before the resulting answer. This visibility is
  the primary purpose of the harness and MUST NOT be reduced to a summary.
- **FR-006**: The harness MUST retain the full conversation, including capability results,
  so that a follow-up question can refer to a previous answer — specifically, so that
  choosing among candidates offered in an earlier turn is possible. Without retained results
  the disambiguation behaviour cannot be exercised at all.
- **FR-007**: The harness MUST provide a way to clear the conversation without restarting,
  and a way to exit that terminates the child server.
- **FR-008**: The instruction the harness gives the model MUST be minimal: it may name the
  domain and point at the discovered capabilities and tell the model to follow each
  capability's own description. It MUST NOT restate the rules about relaying incompleteness
  or about not choosing between candidates. *(Rationale: restating them would produce
  better-looking output while hiding whether the server's own descriptions are sufficient.
  A third-party agent will never see this instruction, so neither may the harness rely on
  it.)*
- **FR-009**: The identifier of the language model used MUST come from configuration with a
  documented default, so that a lack of access to one model is a configuration change rather
  than a code change.

**Configuration and isolation**

- **FR-010**: The harness MUST validate every configuration value it and the server require
  **before** starting the server, and MUST stop with a message naming the specific missing
  or invalid value.
- **FR-011**: The harness MUST pass to the child server an explicit, enumerated set of
  configuration values. It MUST NOT pass its own credentials for the language model service
  to the child, and the child's audited configuration surface MUST NOT be widened by this
  feature.
- **FR-012**: The harness MUST capture the child server's diagnostic output rather than
  letting it write directly to the terminal, MUST show it when starting or connecting fails,
  and MUST offer an opt-in mode that shows it as it happens. Routine server output MUST NOT
  corrupt the engineer's prompt.
- **FR-013**: The harness MUST default the child server to a quiet diagnostic level, and that
  level MUST remain configurable.
- **FR-014**: No credential, credential fragment, or renewal credential may appear in any
  output the harness produces, in any mode, including failure paths.

**Identity**

- **FR-015**: The harness MUST resolve an operator credential using a strict, documented
  precedence: a credential supplied through the environment wins; otherwise a valid stored
  credential; otherwise renewal of a stored credential; otherwise interactive login. This
  mirrors the server's own rule that a caller-supplied identity outranks environment
  configuration.
- **FR-016**: The supplied-credential path MUST work with no interactive login capability
  present at all, so the harness is usable before the identity application required by
  FR-017 exists.
- **FR-017**: The harness MUST support an interactive terminal login that displays a link and
  a short code for the engineer to complete in a browser, and MUST then obtain a credential
  without further terminal input. The credential MUST be issued by the identity authority the
  server is configured to accept, and MUST carry the group membership the upstream checks.
- **FR-018**: The interactive login MUST honour the identity provider's pacing instructions,
  MUST distinguish "still waiting", "slow down", "denied", and "expired" and report each
  distinctly, and MUST stop at the provider's stated deadline rather than polling
  indefinitely.
- **FR-019**: A stored credential MUST record which identity authority issued it, and MUST be
  rejected — not renewed — when that authority differs from the configured one. *(Credentials
  are valid against exactly one upstream environment; silently reusing one produces a
  confusing authorization failure instead of a clear error.)*
- **FR-020**: Stored credentials MUST live outside the repository, MUST be restricted to their
  owner, and MUST be impossible to commit.
- **FR-021**: The identity application's client identifier MUST come from configuration and
  MUST NOT be embedded in source, consistent with this project's rule that operational values
  are never hardcoded.
- **FR-022**: When interactive login is unavailable because its configuration is absent, the
  harness MUST print exactly what to request from an identity administrator, and MUST point at
  the supplied-credential path as the interim route.
- **FR-023**: On an authentication failure during a turn, the harness MUST renew the credential,
  restart the child server, and retry that turn once, preserving the conversation. It MUST tell
  the engineer this is happening. If renewal is impossible, it MUST say so and stop retrying.
  *(A running child's configuration cannot be changed, and the local transport carries no
  per-request identity channel, so restart is the only available mechanism.)*

**Boundaries against the existing server**

- **FR-024**: The harness MUST live in its own top-level location, outside the source tree the
  project's architectural and coverage rules govern, and MUST be excluded from those rules'
  scope. *(The server's rules forbid direct console output, direct standard-output writes,
  environment reads outside two named files, module-level mutable state, and literal external
  hosts. An interactive harness needs all five. Placing it outside keeps the server's
  guarantees provable rather than weakening them.)*
- **FR-025**: No file in the server's source tree may change as part of this feature. If the
  implementation finds a change is needed, that is a finding to escalate, not a licence to
  edit.
- **FR-026**: The project's existing default test command MUST remain exactly the suite it is
  today, with the same coverage thresholds. The harness MUST be tested by a separate command,
  and MUST NOT contribute to, or dilute, the server's coverage gates.
- **FR-027**: The harness's own automated tests MUST cover, without a network or a real
  identity provider: the credential precedence rules including rejection of a
  foreign-authority stored credential; the interactive login state machine including pacing,
  denial, and expiry; and a real child-process startup proving capabilities are discovered
  over real pipes, that a missing configuration value produces the server's own explanation,
  and that excluded credentials do not reach the child.
- **FR-028**: An automated test making a real call to a language model service is explicitly
  **out of scope**. *(It is non-deterministic, costs money per run, and needs credentials in
  continuous integration — the same reasons this project keeps a live upstream out of
  automation.)* The behaviours it would prove — Story 3's two contracts — MUST instead be
  documented as a manual verification procedure.

**Documentation**

- **FR-029**: The repository's main documentation MUST gain a section, positioned where a
  reader already looks for "how do I try this", explaining how to run the harness, what to
  configure, and how to perform the manual verification in FR-028.
- **FR-030**: The documented scope of the project MUST record that the harness is a local
  development tool living outside the project's constitutional guarantees, so no reader
  mistakes it for part of the delivered service.
- **FR-031**: The example configuration file MUST gain every new value, keeping its existing
  discipline: illustrative values only, no real host, no real identifier, no credential.
- **FR-032**: This feature MUST NOT introduce any deployment step and MUST NOT alter the
  project's existing blocking prerequisite for non-local deployment.

**Scope boundaries**

- **FR-033**: The interactive login path (FR-017–FR-022) and the supplied-credential path
  (FR-016) MUST be independently deliverable, so no part of this feature is blocked waiting
  on an identity application that does not yet exist.
- **FR-034**: The harness MUST NOT be part of the delivered service artefact, MUST NOT be
  required to run it, and MUST NOT be a dependency of any deployment.
- **FR-035**: The set of interactive commands the harness offers MUST be limited to clearing
  the conversation, exiting, and requesting help. [NEEDS CLARIFICATION: should this feature
  also include printing the conversation, invoking a capability directly with hand-written
  arguments to bypass the model, and forcing re-authentication — or are those a follow-up?]

### Key Entities

- **Harness session**: One run of the command-line tool. Owns the conversation, the resolved
  credential, and the lifetime of exactly one child server process.
- **Conversation**: The accumulated turns of a session, including the results of capability
  invocations, not just the prose. It lives in the harness, not the server, which is what lets
  it survive a server restart during credential recovery.
- **Discovered capability**: A capability description obtained from the server at runtime —
  name, argument definition, and human-readable description. The description is load-bearing:
  it is what tells the model to relay incompleteness and not to choose between candidates.
- **Operator credential**: The human's short-lived credential, resolved by precedence, passed
  to the child server unchanged, never logged, and never stored inside the repository. It
  records the identity authority that issued it, because it is valid against exactly one
  upstream environment.
- **Credential store**: A single per-user location outside the repository, restricted to its
  owner, holding the current credential, its renewal credential, its expiry, its issuing
  authority, and the identity application it belongs to.
- **Configuration surface**: The named values an engineer must set. Existing values the
  server already requires — upstream base location, default instance list, identity authority
  — are validated by the harness and forwarded. New values belong to the harness alone: the
  identity application's client identifier (needed only for interactive login), the language
  model identifier (optional, with a default), and the language model service's region and
  credentials (never forwarded to the child). The previously required supplied credential
  becomes optional, because interactive login can now produce one.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An engineer with a valid credential goes from a clean checkout to a
  natural-language answer about a real catalogue entity in **one command and under two
  minutes**, with no hand-authored capability arguments at any point.
- **SC-002**: In **100%** of turns where the underlying result is partial, the final
  natural-language answer states the incompleteness and names the failed instances — achieved
  with a minimal instruction to the model, i.e. driven by the server's own capability
  descriptions rather than by the harness. *(This is the criterion the feature exists to
  satisfy.)*
- **SC-003**: In **100%** of turns where a name matches several entities, the answer presents
  every candidate and asks which was meant; **zero** cases where one is silently chosen.
- **SC-004**: For **every** capability invocation in a session, the engineer can see which
  capability ran and with what arguments — verified by inspecting a transcript of a session
  containing multi-invocation turns.
- **SC-005**: A missing required configuration value produces a message naming that value in
  **100%** of cases, and the child server is started in **zero** of them.
- **SC-006**: When the child server refuses to start, the reason it gives is visible to the
  engineer in **100%** of cases — never an exit status alone.
- **SC-007**: A credential expiring mid-session is recovered without the engineer retyping
  their question, and a follow-up depending on an earlier turn still works — demonstrating the
  conversation survived a server restart.
- **SC-008**: **Zero** occurrences of a credential, credential fragment, or renewal credential
  in any output the harness produces, across every mode and every failure path, verified by
  automated inspection.
- **SC-009**: A stored credential from a different upstream environment is rejected with a
  message naming the mismatch in **100%** of cases, and is never used or renewed.
- **SC-010**: Interactive login completes in **one browser visit** with no terminal input
  beyond starting the harness, and a subsequent run within the credential's lifetime requires
  **zero** identity-provider interaction.
- **SC-011**: The project's default test command runs the **identical** set of tests, with
  **identical** coverage thresholds, before and after this feature. Verified by comparison.
- **SC-012**: **Zero** files in the server's source tree differ as a result of this feature.
- **SC-013**: The harness's own test command passes, covering credential precedence, the
  interactive login state machine, and real child-process startup — all with **no** network
  access and **no** real identity provider.
- **SC-014**: A lack of access to the configured language model is resolved by changing
  configuration only, with **zero** code changes.
- **SC-015**: The harness is fully usable with a supplied credential while the identity
  application required for interactive login does not yet exist — so **zero** part of the
  feature is blocked on an external administrative request.
- **SC-016**: An engineer following the documentation alone, without reading this
  specification or the design brief, can run the harness and perform the manual verification
  of SC-002 and SC-003.

---

## Assumptions

Recorded because several points in the design brief were explicitly left open, and because a
few reasonable defaults were chosen rather than asked about.

- **The harness is a development tool, not part of the product.** It is not deployed, not
  shipped, and not required to run the server. This is why it may live outside the project's
  architectural and coverage guarantees — the alternative would be to weaken guarantees that
  exist for the served artefact.
- **The server needs no change.** The design brief asserts this and the specification requires
  it (FR-025). If implementation contradicts it, that is a finding worth escalating, because it
  would mean the server's capability descriptions or error reporting are inadequate for a real
  agent — which is itself the discovery this feature is built to make.
- **The identity application required for interactive login does not yet exist** and must be
  requested from an administrator: a native-application registration on the same
  per-environment identity authority the server accepts, permitted to use the device-based
  grant and to issue renewal credentials, whose credentials carry the group membership the
  upstream checks. Until it exists only the supplied-credential path works, which is why
  FR-033 requires the two paths to be independently deliverable.
- **Interactive login is viable with no upstream change**, because the upstream validates
  issuer, signature, expiry, and group membership, and performs no audience validation
  (verified during constitution ratification, 2026-09-03). A credential minted by a new
  application under the same authority is therefore accepted. If audience validation is ever
  introduced upstream, this assumption fails and FR-017 must be revisited.
- **The default language model identifier is a guess.** Access to a specific model is granted
  per account, so the default in the design brief is unverified. FR-009 makes this a
  configuration fix rather than a defect.
- **How an error result surfaces through the orchestration layer is unknown** and is best
  settled by running it rather than designing around it. FR-023 states the required outcome —
  an authentication failure triggers renewal, restart, and one retry — and deliberately does
  not prescribe the detection mechanism. If errors arrive as plain text the model merely reads,
  the implementation will need to inspect results before returning them; that is a planning
  decision, not a change to this specification.
- **Correctness of the two contracts is verified manually, not automatically.** Proving them
  requires a real language model, which is non-deterministic and costs money per run. This
  mirrors the project's existing decision to keep a live upstream out of automation.
  Consequently SC-002 and SC-003 are manual pre-release checks, and their absence from
  automation is a deliberate, documented gap rather than an oversight.
- **One engineer at a time per machine.** The credential store is per-user, and concurrent
  sessions must not corrupt it, but no multi-user or shared-machine scenario is in scope.
- **A browser is available on the engineer's machine** for interactive login. The link is
  printed so it can be opened manually; opening it automatically is a convenience, not a
  requirement.
- **The conversation is unbounded within a session.** No truncation or summarisation strategy
  is in scope; an engineer who hits a limit clears the conversation. Retaining capability
  results is non-negotiable (FR-006) because dropping them removes the ability to exercise
  disambiguation at all.
- **Verbose diagnostics are opt-in.** The default is quiet, because server diagnostics
  interleaved with an interactive prompt make the harness unpleasant to use, which would defeat
  its purpose as the preferred manual tool.

## Dependencies

- **Feature 001 (catalogue capabilities) is complete and its server runs locally.** This
  feature drives that server and adds nothing to it.
- **A non-production upstream environment** the engineer's credential is valid against, and
  which can be made to produce a partial result for the manual verification in SC-002.
- **Access to a language model service**, with credentials and a region available in the
  engineer's local environment, and permission to invoke at least one suitable model.
- **An identity application registration** (external, administrative) — required for Story 4
  and Story 5 only. Stories 1–3 have no such dependency, which is the point of FR-033.

## Out of Scope

- Any deployment, packaging, or distribution of the harness. It is run from a checkout.
- Any change to the server's source, capability surface, or configuration contract.
- Automated testing against a real language model service (FR-028).
- Remote or network transport between harness and server; the harness starts the server
  locally.
- Multi-user, shared-machine, or unattended/headless operation. A human is present for every
  session.
- Conversation persistence between sessions.
- Support for language model providers other than the one chosen in the design brief.
