---

description: "Task list for the Local CLI Agent Harness"
---

# Tasks: Local CLI Agent Harness

**Input**: Design documents from `specs/002-local-cli-agent/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **Required.** FR-027 mandates three automated suites, and FR-028 explicitly excludes a
fourth (real-model end-to-end). Test tasks below are therefore not optional — they are the
feature's own requirements.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: `[US1]`–`[US5]`, mapping to spec.md's user stories
- Exact file paths in every task

## Path Conventions

All new code lives under `agent/`, with build output in `dist-agent/`. **No file under `src/` may
change** (FR-025, SC-012) — this is the binding constraint on every task below. `test/` is likewise
untouched (FR-026, SC-011).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Stand up `agent/` outside the constitutional fence, without disturbing the server's
gates.

- [X] T001 Create the directory skeleton `agent/`, `agent/auth/`, `agent/mcp/`, `agent/repl/`, `agent/test/` per plan.md's Project Structure
- [X] T002 Add devDependencies `ai@^7.0.93`, `@ai-sdk/mcp@^2.0.45`, `@ai-sdk/amazon-bedrock@^5.0.76` to `package.json` — devDependencies, not dependencies, because the harness is not part of the served artefact (FR-034)
- [X] T003 Create `agent/tsconfig.json` extending `../tsconfig.json` (keeping every strict option) with `rootDir: "."`, `outDir: "../dist-agent"`, and `include: ["**/*.ts"]`
- [X] T004 Add `"agent"` and `"dist-agent"` to the root `tsconfig.json` `exclude` array — the server's build must not compile the harness
- [X] T005 [P] Create `agent/vitest.config.ts` with `include: ['agent/test/**/*.test.ts']` and **no `coverage.thresholds` block** — the constitutional gates govern `src/` and must not be diluted (FR-026)
- [X] T006 [P] Add `'dist-agent/**'` to the `ignores` array in `eslint.config.js`
- [X] T007 [P] Add `dist-agent/` and `.gma-agent/` to `.gitignore`
- [X] T008 Add scripts to `package.json` exactly as specified in `contracts/cli.md`: `agent`, `test:agent`, `test:all` — and **leave the existing `test` script byte-identical** (FR-026, SC-011)
- [X] T009 Verify `agent/**` is excluded from server coverage by confirming `vitest.config.ts`'s `coverage.include` remains `['src/**/*.ts']` — no edit expected; this task is a check, and any needed change is a finding to report

**Checkpoint**: `npx tsc -p agent/tsconfig.json` compiles an empty project; `npm test` still passes
unchanged.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The three seams every story depends on — output redaction, configuration validation,
and the credential ladder's shape.

**⚠️ CRITICAL**: No user story work can begin until this phase completes.

- [X] T010 Implement `agent/repl/render.ts` as the **single chokepoint for every terminal write**, with an allowlist-based redaction helper — mirroring the reasoning in `src/core/errors.ts`'s `safeUpstreamDetail` (a new leak path cannot appear by being forgotten). Export the line writers the rest of the harness uses; nothing else in `agent/` may call `console.*` or `process.stdout.write` directly (FR-014, SC-008)
- [X] T011 [P] Define the `AgentConfig` interface in `agent/config.ts` with every field and source from data-model.md §1 — **deliberately excluding AWS credentials**, so they cannot be forwarded to the child by accident (FR-011)
- [X] T012 Implement `loadAgentConfig(env)` in `agent/config.ts` validating in the order data-model.md §1 specifies: the three child-required values first (`GMA_BASE_URL`, `GMA_DEFAULT_INSTANCES`, `OKTA_ISSUER`), then `AWS_REGION`, then optionals with defaults (`AGENT_MODEL_ID` → `us.anthropic.claude-sonnet-5`, `LOG_LEVEL` → `warn`). Each failure message names the specific variable (FR-010, SC-005)
- [X] T013 Leave `oktaClientId` **unvalidated** by `loadAgentConfig` — it is checked lazily only when the credential ladder reaches device login, so the supplied-token path works with no Okta app in existence (FR-016, FR-033)
- [X] T014 [P] Define `OperatorCredential` in `agent/auth/resolve.ts` per data-model.md §2, including the `source: 'env' | 'cache' | 'refresh' | 'device'` discriminant that determines whether expiry is recoverable
- [X] T015 Implement `resolveCredential({ config, now, fetch, store })` in `agent/auth/resolve.ts` with **step 1 only** — `GMA_USER_TOKEN` present → use verbatim, `source: 'env'`, no HTTP call, no cache read. Steps 2–4 delegate to injected collaborators added in US4. Clock and `fetch` are injected so the suite needs no network (FR-015, FR-027)
- [X] T016 Implement the no-credential-available path in `agent/auth/resolve.ts`: when no token can be obtained and device login is unavailable, emit the FR-022 message stating exactly what to request from an Okta administrator (native application, Device Authorization + Refresh Token grants, same custom authorization server as `OKTA_ISSUER`, access policy permitting device authorization, `groups` claim) plus the `GMA_USER_TOKEN` interim route, and exit `77` (Story 4 AC-10)
- [X] T017 Create `agent/prompt.ts` holding the minimal system prompt **alone**: name the domain, point at the discovered capabilities, instruct the model to follow each capability's own description. It MUST NOT restate the caveat-relaying or non-selection rules (FR-008). Add a file comment explaining that growing this file invalidates SC-002 and SC-003
- [X] T018 Create `agent/main.ts` with `process.loadEnvFile('.env')` as the **literal first statement**, before any import that reads the environment at module scope — the Bedrock provider reads `AWS_*` when evaluated, and importing it earlier yields an authentication error pointing nowhere near the cause (contracts/config.md)
- [X] T019 [P] Write `agent/test/architecture.test.ts` asserting that no file under `agent/` imports from `src/` (Principle III), and that no file under `agent/` except `agent/repl/render.ts` contains `console.` or `process.stdout` (FR-014)

**Checkpoint**: config validation and the redaction chokepoint are testable; the credential ladder
resolves an env-supplied token.

---

## Phase 3: User Story 1 — Ask the catalogue a question in plain language (Priority: P1) 🎯 MVP

**Goal**: One command starts the harness, spawns the server, discovers three capabilities, and
answers natural-language questions with every capability invocation visible.

**Independent Test**: With `GMA_USER_TOKEN` set, run `npm run agent`, ask a question about a known
entity against non-production GMA, confirm a natural-language answer arrives, that the invocation
was shown *before* it, and that a follow-up referring to the prior turn resolves.

### Tests for User Story 1

- [X] T020 [P] [US1] Write the spawn-handshake test in `agent/test/spawn.test.ts`: spawn a real `dist/index.js` and assert **exactly three** capabilities are discovered (`list_instances`, `find_catalogue_entity`, `get_catalogue_entity`), matching what `test/protocol/smoke.test.ts:58` pins server-side
- [X] T021 [US1] Add to `agent/test/spawn.test.ts`: one capability invocation round-trips over real pipes and returns a result carrying `completeness`
- [X] T022 [US1] Add to `agent/test/spawn.test.ts`: the env allowlist holds — the spawned child does **not** receive `AWS_SECRET_ACCESS_KEY` (FR-011). Assert on the child's observable behaviour or its received environment, not on the allowlist constant, so the test would catch a leak rather than restate the intent
- [X] T023 [P] [US1] Write `agent/test/authResolve.test.ts` covering the step-1 cases: `GMA_USER_TOKEN` wins over a fresh cache, and no HTTP call is made when it is present (FR-015)

### Implementation for User Story 1

- [X] T024 [US1] Implement `agent/mcp/spawn.ts` constructing `StdioClientTransport` from `@modelcontextprotocol/sdk` (**not** `@ai-sdk/mcp`'s `Experimental_StdioMCPTransport` — research.md R1) with `command: 'node'`, `args: ['dist/index.js']`, `stderr: 'pipe'`, and the explicit env allowlist from contracts/child-process.md
- [X] T025 [US1] In `agent/mcp/spawn.ts`, pass the transport to `createMCPClient` from `@ai-sdk/mcp` as a custom transport — accepted because `isCustomMcpTransport` checks structurally for callable `start`/`send`/`close` (research.md R1)
- [X] T026 [US1] Implement capability discovery via `await mcpClient.tools()` in `agent/mcp/spawn.ts`. Declare **no** schemas in the harness — the server is the single source of truth for names, arguments, and descriptions (FR-003)
- [X] T027 [US1] Implement `agent/mcp/session.ts` owning the `ChildSession` from data-model.md §6: transport, client, discovered tools, and a bounded stderr ring buffer. Expose spawn and teardown; teardown must leave no orphan process (Story 1 AC-6)
- [X] T028 [US1] Implement the turn loop in `agent/repl/loop.ts` using `streamText` from `ai`, with the `amazonBedrock` provider (note: **`amazonBedrock`**, not `bedrock`) reading `AWS_*` from the environment, the model id from `config.modelId`, and a `stopWhen` step cap so a misbehaving turn cannot loop indefinitely (FR-004, research.md R5)
- [X] T029 [US1] In `agent/repl/loop.ts`, iterate `fullStream` and switch on `part.type`: stream `text` progressively (FR-004), and on `tool-call` emit a trace line showing the capability name and its arguments **before** the answer, then on `tool-result` a short outcome line (FR-005). One trace block per invocation, in order, never summarised (Story 1 AC-3)
- [X] T030 [US1] In `agent/repl/loop.ts`, append `(await result.response).messages` to the `Conversation` array each turn — including tool-result messages, which is what lets a follow-up resolve "the Premier League one" against the previous turn's candidates (FR-006, Story 1 AC-4). Add a comment recording that dropping them silently disables SC-003
- [X] T031 [US1] Implement command dispatch in `agent/repl/commands.ts` handling exactly `/clear`, `/help`, and `/exit` — plus Ctrl-D as exit. Anything not starting with `/` is a question for the model. **Add nothing further until FR-035 is answered** (contracts/cli.md)
- [X] T032 [US1] Implement the readline prompt loop in `agent/main.ts`: validate config, resolve the credential, spawn, discover, print the two startup lines (`✓ signed in as …`, `✓ spawned gma-mcp-server (3 tools)`) via `render.ts`, then accept input. Startup must complete within 10 seconds (Story 1 AC-1)
- [X] T033 [US1] Handle Ctrl-C mid-answer in `agent/main.ts`: stop the output, return to the prompt, leave the child healthy, and do **not** exit the harness (Edge Cases)
- [X] T034 [US1] Handle a turn that makes no capability invocation so the absence is plainly visible — it must never be ambiguous whether the server was consulted (Story 1 AC-7)

**Checkpoint**: `npm run agent` answers a real question end-to-end. **This is the MVP** — it already
replaces the MCP Inspector workflow and makes Story 3's verification possible.

---

## Phase 4: User Story 2 — Diagnose a broken setup from the harness's own output (Priority: P2)

**Goal**: A missing value or a refusing child produces a message naming the cause, not silence.

**Independent Test**: Remove one required variable, run the harness, assert the message names it and
the child was never spawned. Separately force the child to refuse and assert its own explanation is
shown.

### Tests for User Story 2

- [X] T035 [P] [US2] Add to `agent/test/spawn.test.ts`: with a required variable removed from the child's environment, the child exits `78` **and the harness surfaces the buffered stderr line naming the variable** (FR-012, SC-006). This is the case `test/protocol/smoke.test.ts` structurally cannot cover — it uses `InMemoryTransport` (line 29), so there is no child process, no pipe, and no environment to get wrong
- [X] T036 [P] [US2] Write a config-validation test in `agent/test/config.test.ts`: each required variable, when absent, produces a message naming that variable, and validation returns before any spawn is attempted (FR-010, SC-005)
- [X] T037 [P] [US2] Add to `agent/test/config.test.ts`: no credential or credential fragment appears in any message produced on any failure path (FR-014, SC-008)

### Implementation for User Story 2

- [X] T038 [US2] Implement the bounded stderr ring buffer in `agent/mcp/spawn.ts`, reading the transport's `stderr` stream (available because of the T024 transport choice). Bounded rather than unbounded so a long `debug`-level session cannot grow without limit, while always retaining the most recent lines — the ones explaining a failure that just happened (data-model.md §6)
- [X] T039 [US2] Dump the ring buffer when spawn or connect fails, then exit `70` — this is where `Refusing to start: Missing required configuration: OKTA_ISSUER` lives (FR-012, SC-006)
- [X] T040 [US2] Add the `--verbose` flag in `agent/main.ts`, echoing the child's stderr live through `render.ts` as it arrives (FR-012, Story 2 AC-4)
- [X] T041 [US2] Ensure buffered (non-verbose) stderr never writes to the terminal during normal operation, so server output cannot corrupt the prompt mid-typing (FR-012, Story 2 AC-3)
- [X] T042 [US2] Wire the exit codes from contracts/cli.md in `agent/main.ts`: `0` clean, `64` usage, `77` no credential obtainable, `78` configuration invalid (child never spawned), `70` child failed to spawn or connect. `78` deliberately matches the child's own `EX_CONFIG` (`src/index.ts:31`)
- [X] T043 [US2] Handle the child exiting mid-session in `agent/mcp/session.ts`: tell the engineer and stop accepting input the harness cannot answer (Edge Cases)
- [X] T044 [P] [US2] Report an unusable configured model as a configuration problem naming `AGENT_MODEL_ID` and how to change it, rather than an unexplained failure (Edge Cases, SC-014)
- [X] T045 [P] [US2] Report an unreachable or rate-limited model service without discarding the conversation, so the engineer may retry (Edge Cases)

**Checkpoint**: every failure mode in contracts/cli.md's exit-code table produces a message naming
its cause.

---

## Phase 5: User Story 3 — Confirm the server's two non-negotiable contracts survive the final turn (Priority: P2)

**Goal**: Make SC-002 and SC-003 observable and attributable. **This is why the feature exists.**

**Independent Test**: Provoke a partial upstream result and read the *final natural-language answer*
for the caveat; separately ask about an ambiguous name and read whether all candidates are
presented.

**Note**: This story is verified **manually** (FR-028). An automated real-model test is explicitly
out of scope: it is non-deterministic, costs tokens per run, and needs AWS credentials in CI — the
same reasons the constitution keeps live GMA out of automation. The tasks here make the manual
verification reliable and repeatable.

### Implementation for User Story 3

- [X] T046 [P] [US3] Add a test to `agent/test/architecture.test.ts` asserting `agent/prompt.ts` does **not** contain caveat-relaying or candidate-selection instructions — a regression guard on FR-008, since coaching the model would silently turn SC-002 and SC-003 into measurements of the harness rather than the server (Story 3 AC-3)
- [X] T047 [US3] Ensure the trace line for a partial result shows the structured verdict distinctly from the model's prose, so an engineer can tell at a glance whether the model *relayed* the caveat or merely received it (FR-005)
- [X] T048 [US3] Write the SC-002 procedure into `specs/002-local-cli-agent/quickstart.md`'s manual section — already drafted; verify it is executable as written against a real environment and correct it where it is not
- [X] T049 [US3] Write the SC-003 procedure into the same section, including the follow-up reference step ("the Premier League one") that proves tool results are retained in history (FR-006)
- [X] T050 [US3] Document the escalation rule prominently: if either contract fails, the defect is in the server's capability descriptions under `src/domains/catalogue/**`, and the fix MUST NOT be to add caveat instructions to the harness prompt — that would make output look correct while hiding an inadequacy a third-party agent would hit in production. Since FR-025 forbids changing `src/` here, it is an escalation (FR-025, Story 3 AC-4)

**Checkpoint**: an engineer can run both verifications and attribute the result to the server.

---

## Phase 6: User Story 4 — Sign in from the terminal by opening a link (Priority: P3)

**Goal**: No credential in hand? Print a link and a code, authenticate in a browser, proceed. Reuse
the stored credential on later runs.

**Independent Test**: The polling state machine — pending, slow-down, denied, expired, success — is
fully testable against a controlled endpoint with no browser and no real identity provider. The
browser step is manual.

**Dependency**: needs Phase 2's ladder skeleton. Independent of US2 and US3.

### Tests for User Story 4

- [X] T051 [P] [US4] Write `agent/test/deviceFlow.test.ts` with `msw` (existing devDependency): `authorization_pending` ×3 → then success, and the returned `interval` is respected between polls (FR-018)
- [X] T052 [US4] Add to `agent/test/deviceFlow.test.ts`: `slow_down` **increases** the interval — ignoring it risks the identity provider rate-limiting the login (FR-018)
- [X] T053 [US4] Add to `agent/test/deviceFlow.test.ts`: `access_denied` and `expired_token` produce **distinct** messages — collapsing them tells the engineer the wrong thing to do next (FR-018)
- [X] T054 [US4] Add to `agent/test/deviceFlow.test.ts`: polling stops at `expires_in` regardless of what the endpoint says, so a misbehaving server cannot make the harness spin forever (FR-018)
- [X] T055 [US4] Add to `agent/test/deviceFlow.test.ts`: `verification_uri` and `user_code` are printed (Story 4 AC-1). These states are the reason this suite exists — **none can be provoked on demand against real Okta**, the same argument the constitution makes for GMA fixtures
- [X] T056 [P] [US4] Add to `agent/test/authResolve.test.ts`: a fresh cache is used with **no** HTTP call made (FR-015 step 2)
- [X] T057 [US4] Add to `agent/test/authResolve.test.ts`: **a cache whose `issuer` differs from the configured `OKTA_ISSUER` is rejected, not refreshed** (FR-019). Its refresh token would mint a token valid against a *different* GMA environment — accepted by that Okta, rejected by this GMA as `401`, which the harness would misread as expiry and loop on
- [X] T058 [US4] Add to `agent/test/authResolve.test.ts`: an expired access token with a valid refresh token refreshes (FR-015 step 3); and with neither env token nor cache, the device flow is invoked (step 4)
- [X] T059 [US4] Add to `agent/test/authResolve.test.ts`: the cache file is written mode `0600`, and no token or refresh token appears in any emitted line (FR-020, FR-014)

### Implementation for User Story 4

- [X] T060 [P] [US4] Implement `agent/auth/store.ts` reading and writing `~/.gma-agent/token.json` per data-model.md §3: fields `access_token`, `refresh_token`, `expires_at`, `issuer`, `client_id`; mode `0600`; written atomically (temp file + rename) so two concurrent sessions cannot leave a half-written file; a read that fails to parse is treated as absent rather than fatal
- [X] T061 [US4] Implement `agent/auth/deviceFlow.ts` step 1: `POST {OKTA_ISSUER}/v1/device/authorize` with `client_id` and `scope=openid profile offline_access`. Derive the endpoint from the configured issuer — the path is an RFC 8628 protocol constant, but **no host may be hardcoded** (FR-021, plan.md Complexity Tracking)
- [X] T062 [US4] Display `verification_uri` and `user_code` through `render.ts`, optionally opening the browser at `verification_uri_complete`. Printing the link is the requirement; opening it is a convenience (FR-017)
- [X] T063 [US4] Implement the polling state machine in `agent/auth/deviceFlow.ts` against `POST {OKTA_ISSUER}/v1/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, handling every transition in data-model.md's diagram: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, success, and the client-side `expires_in` deadline (FR-018)
- [X] T064 [US4] Implement refresh in `agent/auth/deviceFlow.ts` using a stored `refresh_token`, writing the result back through `agent/auth/store.ts`
- [X] T065 [US4] Wire ladder steps 2–4 into `agent/auth/resolve.ts`: valid-and-matching cache → `source: 'cache'`; cache with a refresh token → refresh, `source: 'refresh'`; otherwise device flow, `source: 'device'`. **Step 1 must still short-circuit before step 2 is read** — an env token wins over a fresher cache (FR-015)
- [X] T066 [US4] Implement the issuer-mismatch rejection in `agent/auth/resolve.ts` with a message naming the mismatch, and ensure the credential is neither used nor renewed (FR-019, SC-009)
- [X] T067 [US4] Validate `OKTA_CLIENT_ID` lazily at the point device login is reached, falling back to the T016 administrator message when it is absent (FR-022, Story 4 AC-10)

**Checkpoint**: an engineer with no credential can sign in via a link; a later run within the
credential's lifetime needs zero identity-provider interaction (SC-010).

---

## Phase 7: User Story 5 — Keep working when a credential expires mid-session (Priority: P4)

**Goal**: An expiring credential is recovered transparently, with the conversation intact.

**Independent Test**: Drive the harness with a credential accepted once then rejected as expired;
assert the turn ultimately succeeds and an earlier turn still influences the answer.

**Dependency**: needs US4 (refresh requires a stored refresh credential).

### Tests for User Story 5

- [X] T068 [P] [US5] Add a recovery test to `agent/test/spawn.test.ts` (or a new `agent/test/recovery.test.ts`): a tool result with `isError` and text beginning `[auth]` triggers refresh, teardown, respawn, re-discovery, and one retry — and the conversation array is unchanged across the respawn (FR-023, SC-007)
- [X] T069 [US5] Add: the retry is attempted **at most once** per turn, so a persistently failing credential cannot loop (FR-023, Story 5 AC-5)
- [X] T070 [US5] Add: a credential with `source: 'env'` — which carries no refresh token — produces a "supply a new token" message rather than a doomed refresh attempt (Story 5 AC-4, Edge Cases)

### Implementation for User Story 5

- [X] T071 [US5] Implement auth-failure detection in `agent/repl/loop.ts` by inspecting each tool result for `isError` together with the `[auth]` prefix. **The result is returned, not thrown** — `@ai-sdk/mcp`'s `execute` does `if (result.isError) return result` (research.md R2) — so detection is a branch in the `fullStream` handling that already exists for trace lines, not a wrapper around the discovered tools. The `[auth]` prefix is pinned server-side by `test/protocol/smoke.test.ts:200`
- [X] T072 [US5] Implement refresh-and-respawn in `agent/mcp/session.ts`: refresh the credential, tear down the client and transport, spawn a new child with the new token in its environment, re-discover capabilities. **Respawn is the only available mechanism** — a child's environment is immutable after spawn, and stdio carries no per-request identity channel (`src/core/identity.ts:115-125`: `authInfo` is populated only when the transport performed OAuth, which stdio never does)
- [X] T073 [US5] Retry the interrupted turn once from the preserved `Conversation`, without the engineer retyping the question (FR-023, Story 5 AC-1)
- [X] T074 [US5] Print notice lines through `render.ts` while recovery is in progress — it must never be silent (FR-023, Story 5 AC-3)
- [X] T075 [US5] Handle failed renewal: say so plainly, direct the engineer to sign in again, and stop retrying (Story 5 AC-4)

**Checkpoint**: a session survives credential expiry with history intact.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T076 [P] Add `OKTA_CLIENT_ID`, `AGENT_MODEL_ID`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` to `.env.example`, and re-document `GMA_USER_TOKEN` as **optional**. Keep the file's existing discipline without exception: every value illustrative, no real host, no real client id, no token, no key (FR-031)
- [X] T077 Add a `## Trying it with an agent` section to the root `README.md`, positioned after "Running it locally" — where a reader looking for "how do I try this" already starts. Cover running the harness, what to configure, and the manual verification procedure (FR-029, SC-016)
- [X] T078 Add one line to the README's *Scope of this slice* recording that the harness is a local development tool living **outside** the project's constitutional gates, so no reader mistakes it for part of the delivered service (FR-030)
- [X] T079 [P] Verify SC-012 by running `git diff --stat main -- src/` and confirming it is **empty**. Any output is a finding to escalate, not to fix by editing `src/` (FR-025)
- [X] T080 [P] Verify SC-011 by confirming `git diff main -- vitest.config.ts` is empty and that the `test` script in `package.json` is unchanged — the default suite and its thresholds must be byte-identical
- [X] T081 [P] Run `npm run lint` and resolve any findings in `agent/**` without weakening a rule
- [X] T082 Run `npm run test:all` and confirm both suites pass (FR-026, SC-013)
- [X] T083 Walk `quickstart.md` end to end on a clean checkout, following only the documentation, and confirm SC-001 (under two minutes to first answer) and SC-016 (documentation alone suffices) hold. Correct the document where it does not
- [ ] T084 Perform the manual SC-002 and SC-003 verifications from `quickstart.md` against a real environment and **record the outcome in the pull request**. A failure is a finding about the server's capability descriptions and must be escalated per T050 — it does not block this feature, which is the instrument that found it

  **Status: NOT DONE — requires credentials this implementation session does not have.** It needs a
  real non-production GMA reachable, a token valid against that environment's Okta, and AWS
  credentials with Bedrock model access. Everything the procedure depends on is verified and in
  place: startup, discovery of exactly three capabilities, the trace format that separates the
  server's verdict from the model's prose, and tool-result retention in history. **This is the one
  remaining step, and it must be run by a human with those credentials before the PR merges.** The
  procedure is executable as written — its `npm run agent` invocations and expected output were
  checked against the built harness (T083).

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 1 (Setup)
   └─▶ Phase 2 (Foundational) ── BLOCKS EVERYTHING
          ├─▶ Phase 3 (US1, P1) ── MVP
          │      ├─▶ Phase 4 (US2, P2)   — needs the spawn path from US1
          │      └─▶ Phase 5 (US3, P2)   — needs a working turn from US1
          └─▶ Phase 6 (US4, P3)          — independent of US1's turn loop
                 └─▶ Phase 7 (US5, P4)   — needs US4's refresh credential
                        └─▶ Phase 8 (Polish)
```

### Story dependencies

| Story | Depends on | Why |
| --- | --- | --- |
| US1 (P1) | Foundational | Nothing else — this is the MVP |
| US2 (P2) | US1 | Diagnoses the spawn path US1 builds |
| US3 (P2) | US1 | Observed *through* a working turn |
| US4 (P3) | Foundational only | The ladder skeleton exists; independent of the turn loop |
| US5 (P4) | US4 | Refresh needs a stored refresh credential |

US4 can be built **in parallel with US1** by a second person — it touches only `agent/auth/**` and
`agent/test/authResolve.test.ts` / `deviceFlow.test.ts`.

### Parallel opportunities

**Phase 1**: T005, T006, T007 together (three different config files).

**Phase 2**: T011, T014, T019 together. T010 first, since T016/T017 write through it.

**Phase 3**: T020 and T023 together (different test files). Then T024 → T025 → T026 in sequence
(same file, ordered), while T028 can start in parallel on `agent/repl/loop.ts`.

**Phase 4**: T035, T036, T037 together; T044 and T045 together.

**Phase 6**: T051 and T056 together (different files); T060 in parallel with T061.

**Phase 8**: T076, T079, T080, T081 all parallel.

---

## Implementation Strategy

### MVP scope

**Phases 1–3 (T001–T034).** That delivers a harness that spawns the server, discovers its
capabilities, and answers questions with every invocation visible — which already replaces the MCP
Inspector workflow the quickstart currently relies on, and already makes the Story 3 verification
performable by hand.

### Recommended increments

1. **Phases 1–3** — MVP. Usable, with `GMA_USER_TOKEN`.
2. **Phase 5 (US3)** next, ahead of US2. It is the reason the feature exists, and it needs only a
   working turn. Running the two verifications early means a defect in the server's descriptions is
   found while there is still time to act on it.
3. **Phase 4 (US2)** — diagnostics. Improves every subsequent session.
4. **Phases 6–7 (US4, US5)** — device login and recovery. Both depend on an Okta application that
   does not yet exist; FR-033 is what keeps them from blocking anything.
5. **Phase 8** — documentation and gate verification.

### Two rules that hold throughout

- **`src/` is not editable in this feature** (FR-025). If a task appears to require it, stop and
  escalate — that is a finding worth having, not an obstacle to route around.
- **Do not coach the model** (FR-008). `agent/prompt.ts` stays minimal even if SC-002 or SC-003
  fail. A passing result obtained by restating the rules in the harness prompt is a false pass,
  because a third-party agent will never read that prompt.

### Open question

**FR-035** — whether the interactive command set extends beyond `/clear`, `/exit`, and `/help` to
include printing the conversation, invoking a capability directly with hand-written arguments, and
forcing re-authentication. T031 builds the three; command dispatch sits behind one seam so each
addition is independent. **No task below assumes an answer.**
