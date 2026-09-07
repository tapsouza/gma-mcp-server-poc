# Quickstart: Local CLI Agent Harness

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

How to run the harness, run its tests, and — the part that cannot be automated — **manually verify
the two contracts this feature exists to test**.

---

## Prerequisites

- Node.js 22 (`>=22.0.0 <23`)
- A non-production GMA environment, and a credential valid against **that** environment's Okta
  authorization server (they are per-environment; a token is not portable)
- AWS credentials with permission to invoke at least one Bedrock Claude model, plus a region
- **Optional**: an Okta native application for device login. Until it exists, use
  `GMA_USER_TOKEN` — Stories 1–3, including both contract verifications below, need nothing else
  (FR-033)

---

## Setup

```bash
npm install
cp .env.example .env
# then fill in .env — see contracts/config.md for every variable
```

Minimum for the supplied-credential path:

```bash
GMA_BASE_URL=…
GMA_DEFAULT_INSTANCES=PP,BF
OKTA_ISSUER=…
GMA_USER_TOKEN=…            # paste a valid token
AWS_REGION=…
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_SESSION_TOKEN=…         # if using SSO
```

Nothing more is needed — in particular, **no `OKTA_CLIENT_ID`**. It is validated lazily, only if
the credential ladder actually reaches device login, so this path works with no Okta application in
existence (FR-016, FR-033).

---

## Run

```bash
npm run agent
```

Expected:

```text
✓ signed in with the token supplied in GMA_USER_TOKEN
✓ spawned gma-mcp-server (3 tools)
>
```

Then ask something:

```text
> which leagues are under football?
```

The capability invocation and its arguments appear before the answer. `/help` lists commands,
`/clear` empties the conversation, `/exit` (or Ctrl-D) leaves. Ctrl-C interrupts an answer in
progress without exiting.

`npm run agent -- --verbose` additionally echoes the child's diagnostics live.

### Checking it starts without a real GMA

Every startup path can be exercised against a non-resolving host, which is a fast way to confirm the
harness is wired correctly before pointing it at a real environment:

```bash
# exits 78, naming the variable, child never spawned
env -u GMA_BASE_URL npm run agent

# exits 77 with the full Okta administrator ask
env -u GMA_USER_TOKEN npm run agent

# starts, discovers 3 tools, exits 0 — GMA is only reached once you ask a question
printf '/help\n/exit\n' | npm run agent
```

---

## Automated tests

```bash
npm test            # UNCHANGED — the server's suite, same coverage thresholds (SC-011)
npm run test:agent  # the harness's own suites
npm run test:all    # both
```

`npm run test:agent` builds `dist/` **and** `dist-agent/` first: suite C spawns a real
`dist/index.js`, and the CLI suite runs the real `dist-agent/main.js` as a process.

**Suite A — credential precedence** (`agent/test/authResolve.test.ts`; injected clock, injected
store, no network):

- `GMA_USER_TOKEN` beats a fresh cache, and the cache is never even read
- a fresh cache is used with **no** HTTP call
- **a cache with a different `issuer` is rejected, not refreshed** (FR-019)
- expired access token + valid refresh token → refreshes
- no env, no cache → device flow invoked
- a cache that does not parse is treated as absent, not fatal
- cache file written `0600`, atomically, leaving no temp file
- no token or refresh token appears in any emitted line

**Suite B — device flow polling** (`agent/test/deviceFlow.test.ts`, via `msw`; these states cannot
be provoked on demand against real Okta):

- `authorization_pending` ×3 → then success
- respects the returned `interval`, and the default when it is omitted
- `slow_down` → **increases** the interval, cumulatively
- `access_denied` → clear failure message
- `expired_token` → tells the engineer to restart login
- the two above produce **different** messages
- stops at `expires_in` rather than spinning
- prints `verification_uri` and `user_code`, and never the resulting token
- `OKTA_CLIENT_ID` is validated here, lazily, before any HTTP call

**Suite C — child spawn handshake** (`agent/test/spawn.test.ts`; real process, real pipes):

- spawns `dist/index.js` and discovers **exactly three** capabilities, within 10 seconds
- every description comes from the server and mentions relaying
- one invocation round-trips over real pipes
- a missing required variable → child exits `78` **and the harness surfaces the buffered stderr
  line naming the variable**
- the env allowlist holds: the child does **not** receive `AWS_SECRET_ACCESS_KEY`
- teardown leaves no orphan, and a respawn is not reported as an unexpected child exit

**Turn loop and recovery** (`agent/test/recovery.test.ts`; a stubbed model, so the assertions are
deterministic — see the note below):

- the capability invocation and its arguments appear **before** the answer
- the structured verdict renders distinctly from the prose, and the harness does **not** synthesise
  a caveat into the answer
- the absence of an invocation is plainly visible
- tool-result messages reach history (FR-006) — the property SC-003 depends on
- an `[auth]` error result triggers renew → respawn → **one** retry, conversation intact
- a non-auth error does **not** trigger a respawn
- a credential with no refresh token gets "supply a new token", not a doomed refresh

**Command-line surface** (`agent/test/cli.test.ts`; the built entrypoint as a real process):

- every exit code in the table: `0`, `64`, `77`, `78`
- **Ctrl-D exits** — a regression test for a real defect where an EOF hung the prompt loop forever
- the child's diagnostics stay off the terminal by default and appear under `--verbose`
- `/clear`, `/help`, `/exit`, and an unknown command
- none of FR-035's proposed extra commands is implemented

**Architecture invariants** (`agent/test/architecture.test.ts`):

- `agent/` imports nothing from `src/` (Principle III)
- nothing outside `render.ts` touches `console.*`, `process.stdout`, or `process.stderr`
- no absolute host literal anywhere in `agent/`
- **the system prompt restates neither the caveat nor the non-selection rule** (FR-008) — the guard
  that keeps SC-002 and SC-003 measuring the server

Suite C covers what `test/protocol/smoke.test.ts` structurally cannot: that suite uses
`InMemoryTransport`, so there is no child process, no pipe, and no environment to get wrong.

**On the stubbed model**: it is not the exclusion FR-028 makes. The properties above belong to the
*harness* — trace ordering, history retention, the one-retry bound — and are deterministic. What
FR-028 excludes is asserting what a *real* model does with the server's descriptions. That is
SC-002 and SC-003, and it stays manual, below.

---

## Manual verification — the two contracts (SC-002, SC-003)

**This is the point of the feature.** These are deliberately *not* automated (FR-028): they need a
real model, which is non-deterministic, costs tokens per run, and would need AWS credentials in CI
— the same reasons the constitution keeps live GMA out of automation.

Read the **final natural-language answer**, not the trace line. The harness prints both, and keeps
them visually distinct on purpose:

```text
⏺ list_instances {}
  → list_instances: 2 instances
  ⚠ server verdict: assembled from PP only — urn:i:BF:BF failed     ← what the SERVER said

Instances PP and BF are available…                                   ← what the MODEL said
```

The `⚠` line is the structured verdict the server returned. **It is not the answer.** SC-002 asks
whether the sentence *below* it carries the caveat — and the harness deliberately does not
synthesise one, so if the prose omits it, the prose omitted it.

### SC-002 — a partial result must reach the human as a caveat

1. Arrange for a GMA call to return HTTP `206` — a genuinely degraded non-production environment,
   or a local proxy that rewrites one instance's response.
2. Ask a question that hits it.
3. **Pass**: the final answer states the answer is incomplete **and** identifies which instances
   failed.
4. **Fail**: the answer presents the data as whole, or mentions incompleteness without saying
   which instances failed.

Note the `⚠` line appearing proves only that the verdict *reached* the model. A run where `⚠`
appears and the prose does not mention incompleteness is a **fail**, and is the single most likely
shape of a real failure here.

### SC-003 — an ambiguous name must produce candidates, not a choice

1. Ask about a name matching several catalogue entities (`Winner` is a good candidate — it recurs
   across sports).
2. **Pass**: every candidate is presented, and the answer asks which was meant.
3. **Fail**: one candidate is presented as *the* answer.
4. Then reply referring to one candidate without repeating its full name ("the Premier League
   one"). **Pass**: it resolves against the previous turn — which is what proves tool results are
   retained in history (FR-006).

Step 4 is worth doing even when step 2 passes. It exercises a different mechanism —
`agent/test/recovery.test.ts` asserts a `tool`-role message reaches history, and a defect there
once made this step the only way the failure would have been noticed.

### If either fails

**That is a finding about the server, not a bug in the harness.** FR-008 keeps the harness's system
prompt minimal precisely so this result is attributable: the model saw only the server's own tool
descriptions.

> **The fix MUST NOT be to add caveat or candidate instructions to `agent/prompt.ts`.**
>
> That would make the output look correct while hiding an inadequacy that a third-party agent —
> which will never read the harness prompt — would hit in production. It would also convert SC-002
> and SC-003 from measurements of the server into measurements of the harness, which is a false
> pass rather than a fix.
>
> `agent/test/architecture.test.ts` asserts the prompt mentions none of `caveat`, `completeness`,
> `relay`, `candidate`, or `ambiguous`, and bounds its length — so this cannot be done accidentally,
> or one reasonable-looking line at a time.
>
> The fix belongs in the tool descriptions under `src/domains/catalogue/**`. Since FR-025 forbids
> changing `src/` in this feature, **it is an escalation**: record the finding, and let it be
> addressed where the defect is. The harness found it, which is what the harness is for — a failure
> here does not block this feature.

---

## Verifying the constitutional gates held

```bash
git diff --stat main -- src/          # must be empty (SC-012, FR-025)
git diff main -- vitest.config.ts     # must be empty — thresholds unchanged (SC-011)
git diff main -- package.json         # the `test` script must be byte-identical (SC-011)
npm run test:coverage                 # the server's gates still pass on their own terms
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Refusing to start: Missing required configuration: X` | The named variable is unset | Set it in `.env`. If this appeared from the *child* rather than the harness (prefixed `[server]`), FR-010 has a gap worth reporting. |
| Bedrock `403` / access denied | The AWS account lacks access to the default model | Set `AGENT_MODEL_ID` to a model the account can invoke; the harness's message names the variable and the region (SC-014) |
| Bedrock authentication error despite correct `.env` | `process.loadEnvFile()` is not the first statement in `main.ts`, so the provider was evaluated against an empty environment | Move it first (contracts/config.md) |
| Device login says the client id is missing | The Okta app does not exist yet | Use `GMA_USER_TOKEN`; the message states what to request from an administrator (FR-022) |
| A cached credential is rejected | It was issued by a different environment's Okta | Expected and correct (FR-019). Delete `~/.gma-agent/token.json` and re-authenticate against the configured environment. |
| Server logs overwrite the prompt | `LOG_LEVEL` was raised above the harness's `warn` default | Leave it at `warn`, or accept it under `--verbose` |
| The prompt does not return after Ctrl-C | Ctrl-C interrupts an answer; it does not exit | Use `/exit` or Ctrl-D to leave |
