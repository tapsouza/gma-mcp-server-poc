# Data Model: Local CLI Agent Harness

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

Entities the harness owns, their fields, validation rules, and the two state machines worth
drawing. Nothing here describes GMA data — the harness reads the server's structured results and
never re-models them (FR-003).

---

## 1. AgentConfig

Validated **once, before the child is spawned** (FR-010). A missing or invalid value stops the
harness with a message naming that value; the child is never started (SC-005).

| Field | Source | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `gmaBaseUrl` | `GMA_BASE_URL` | yes | — | absolute http(s) URL |
| `defaultInstances` | `GMA_DEFAULT_INSTANCES` | yes | — | ≥1 non-empty comma-separated code |
| `oktaIssuer` | `OKTA_ISSUER` | yes | — | absolute http(s) URL |
| `oktaClientId` | `OKTA_CLIENT_ID` | only for device login | — | non-empty when device login is needed (FR-022) |
| `modelId` | `AGENT_MODEL_ID` | no | `us.anthropic.claude-sonnet-5` | non-empty |
| `awsRegion` | `AWS_REGION` | yes | — | non-empty |
| `suppliedToken` | `GMA_USER_TOKEN` | no | — | when present, non-empty after trim |
| `childLogLevel` | `LOG_LEVEL` | no | `warn` | one of `debug`/`info`/`warn`/`error` |
| `verbose` | `--verbose` flag | no | `false` | — |

**Deliberately absent**: AWS credentials. They are read by the Bedrock provider straight from the
environment and never enter this object, so they cannot be forwarded to the child by accident
(FR-011). The absence is the mechanism.

**Validation ordering is load-bearing.** The three values the *child* requires are validated
first, because a failure there is the most likely first experience of the feature and must
produce the clearest message. `oktaClientId` is validated **conditionally** — only once the
credential ladder reaches step 4 — so the supplied-token path works with no Okta app in
existence (FR-016, FR-033).

---

## 2. OperatorCredential

The engineer's credential, resolved by precedence. Passed to the child unchanged.

| Field | Type | Notes |
| --- | --- | --- |
| `accessToken` | string | Never logged, never rendered, never echoed (FR-014) |
| `refreshToken` | string? | Absent on the supplied-token path — which is why that path cannot recover from expiry |
| `expiresAt` | epoch ms? | Unknown on the supplied-token path |
| `issuer` | string? | The authority that minted it |
| `source` | `'env' \| 'cache' \| 'refresh' \| 'device'` | Which ladder rung produced it |

`source` is not decoration. It determines what the harness can do on expiry: only `cache`,
`refresh`, and `device` carry a refresh token, so only they can drive FR-023's recovery. A
credential with `source: 'env'` that expires mid-session produces a clear "supply a new token"
message rather than a doomed refresh attempt (Edge Cases).

### Resolution ladder (FR-015)

Strict precedence, mirroring `src/core/identity.ts` — supplied identity outranks anything cached:

```
1. GMA_USER_TOKEN present         → use verbatim, source 'env'.  No HTTP call. No cache read.
2. cache valid AND issuer matches → use, source 'cache'.         No HTTP call.
3. cache has refreshToken         → refresh, source 'refresh'.   Writes cache.
4. otherwise                      → device flow, source 'device'. Writes cache.
```

Two rules that are easy to get wrong and are therefore asserted by tests (suite A):

- **Step 1 short-circuits before step 2 is even read.** An env token wins over a *fresher* cache.
- **A cache whose `issuer` ≠ `AgentConfig.oktaIssuer` is rejected, not refreshed** (FR-019). Its
  refresh token would mint a token valid against a *different* GMA environment — accepted by
  that Okta, rejected by this GMA as `401`, which the harness would misread as expiry and try to
  recover from. Rejecting up front turns a loop into one message.

---

## 3. CredentialStore

One file: `~/.gma-agent/token.json`, mode `0600`.

| Field | Type | Purpose |
| --- | --- | --- |
| `access_token` | string | Current credential |
| `refresh_token` | string | Enables step 3 and FR-023 recovery |
| `expires_at` | epoch ms | Compared against an **injected** clock, so suite A needs no waiting |
| `issuer` | string | Checked against configuration on every read (FR-019) |
| `client_id` | string | Which Okta app minted it |

**Invariants**:

- Outside the repository, so FR-020 holds structurally rather than by `.gitignore` discipline.
- Written `0600` — asserted by test, not assumed.
- Written atomically (temp file + rename), so two concurrent harness sessions cannot leave a
  half-written file (Edge Cases).
- A read that fails to parse is treated as absent, not fatal — the ladder falls through to device
  login.

---

## 4. DiscoveredCapability

Obtained from the server at runtime via `client.tools()`. The harness **declares none of this**
(FR-003).

| Field | Origin | Why it matters |
| --- | --- | --- |
| `name` | server | `list_instances`, `find_catalogue_entity`, `get_catalogue_entity` |
| `inputSchema` | server | Forwarded to the model untouched; the harness never inspects arguments |
| `description` | server | **Load-bearing.** Carries the relay-the-caveat and don't-choose instructions that `test/protocol/smoke.test.ts:77` asserts. SC-002 and SC-003 measure exactly this text. |

The harness holds no copy of any of it. That is the whole point: a second source of truth would
drift, and drift means the model sees a description the server no longer has.

---

## 5. Conversation

The session's accumulated turns — **including tool results**, not just prose (FR-006).

| Field | Type | Notes |
| --- | --- | --- |
| `messages` | model-message array | Appended from `(await result.response).messages` each turn |

Why tool results must be retained, stated once because it is the requirement most likely to be
"optimised" away: when a turn returns several candidates, the follow-up "the Premier League one"
resolves only if the previous turn's `candidates` payload is still in history. Drop the tool
results and the disambiguation contract (SC-003) cannot be exercised at all — the harness would
still run, and would silently stop testing the thing it exists to test.

It lives in the harness, not the server. That is what lets it survive the respawn in FR-023.

Unbounded within a session; `/clear` empties it. No persistence between sessions (Out of Scope).

---

## 6. ChildSession

One spawned server process and its transport.

| Field | Type | Notes |
| --- | --- | --- |
| `transport` | `StdioClientTransport` | From `@modelcontextprotocol/sdk` — chosen for its `stderr` getter (research.md R1) |
| `mcpClient` | `MCPClient` | From `@ai-sdk/mcp`, wrapping the transport |
| `tools` | discovered tool set | Re-discovered after every respawn |
| `stderrBuffer` | bounded ring buffer | Dumped on spawn/connect failure; echoed live under `--verbose` (FR-012) |

**Why a ring buffer rather than an unbounded log**: a long session at `LOG_LEVEL=debug` would
otherwise grow without limit for output nobody reads. Bounded means the *most recent* lines — the
ones explaining a failure that just happened — are always the ones retained.

---

## State machine: device authorization polling (FR-018)

```
                 ┌──────────────────────────────┐
                 │  POST /v1/device/authorize   │
                 └──────────────┬───────────────┘
                                │ verification_uri, user_code,
                                │ interval, expires_in
                                ▼
                    ┌───────────────────────┐
        ┌──────────▶│       WAITING         │
        │           └───────┬───────────────┘
        │                   │ POST /v1/token
        │                   ▼
        │        ┌──────────────────────┐
        │        │  authorization_pending │──▶ wait `interval`, poll again
        ├────────┴──────────────────────┘
        │        ┌──────────────────────┐
        └────────│      slow_down       │──▶ INCREASE interval, poll again
                 └──────────────────────┘
                 ┌──────────────────────┐
                 │       success        │──▶ RESOLVED (write cache 0600)
                 └──────────────────────┘
                 ┌──────────────────────┐
                 │    access_denied     │──▶ FAILED: "access was denied"
                 └──────────────────────┘
                 ┌──────────────────────┐
                 │    expired_token     │──▶ FAILED: "start login again"
                 └──────────────────────┘
                 ┌──────────────────────┐
                 │  expires_in elapsed  │──▶ FAILED: deadline, stop polling
                 └──────────────────────┘
```

Four properties the tests must pin (suite B), because **none can be provoked on demand against
real Okta** — the same argument the constitution makes for GMA fixtures:

1. `authorization_pending` is not an error; it is the normal case.
2. `slow_down` must *increase* the interval. Ignoring it risks Okta rate-limiting the login.
3. `access_denied` and `expired_token` are distinct outcomes with distinct messages — collapsing
   them tells the engineer the wrong thing to do next.
4. Polling stops at `expires_in` regardless of what the server says, so a misbehaving endpoint
   cannot make the harness spin forever.

---

## State machine: session lifecycle with auth recovery (FR-023)

```
  START
    │  validate config (FR-010) ─── invalid ──▶ EXIT 78, naming the value, child NOT spawned
    ▼
  resolve credential (ladder above) ── unavailable ──▶ EXIT 77, explaining the Okta ask (FR-022)
    │
    ▼
  spawn child ── fails ──▶ dump stderr buffer (FR-012) ──▶ EXIT 70
    │
    ▼
  discover capabilities ──▶ READY ◀────────────────────────┐
    │                                                       │
    │  turn                                                 │ respawn + retry once
    ▼                                                       │
  streamText ──▶ trace lines (FR-005) ──▶ answer            │
    │                                                       │
    └── tool result isError && text starts '[auth]' ─────────┤
             │                                              │
             │ refreshable (source ≠ 'env')                 │
             ├── yes ──▶ notify, refresh, teardown, ────────┘
             │                                        (at most ONE retry per turn)
             └── no ───▶ notify: supply a new token; stay READY
```

Three things this diagram is asserting:

- **Detection is by inspecting the tool result**, because `@ai-sdk/mcp` *returns* an
  `isError` result rather than throwing (research.md R2). The `[auth]` prefix is pinned
  server-side by `test/protocol/smoke.test.ts:200`.
- **Respawn, not token swap.** A child's environment is immutable after spawn, and stdio carries
  no per-request identity channel (`src/core/identity.ts:115-125` — `authInfo` is populated only
  when the transport performed OAuth, which stdio never does). There is no third option.
- **At most one retry per turn** (FR-023). A credential that will never work must not loop.
  The `Conversation` survives because it is held here, not in the child.
