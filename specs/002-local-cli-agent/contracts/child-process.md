# Contract: Child Process

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

How the harness spawns and supervises the catalogue server. Every claim here was verified by
reading installed source; see research.md R1 and R4.

---

## What is spawned

```text
node dist/index.js
```

Built by `npm run build`, which `npm run agent` runs first (FR-001). `PATH` is inherited by the
transport's default allowlist, which is what lets `node` resolve.

---

## Transport

`StdioClientTransport` from `@modelcontextprotocol/sdk` — **not** `@ai-sdk/mcp`'s
`Experimental_StdioMCPTransport` — passed to `createMCPClient` as a custom transport.

**Why**: FR-012 requires the child's stderr be captured and shown when startup fails. The AI SDK's
transport keeps its `ChildProcess` in a private field with no accessor, so a piped stderr stream is
unreachable. The MCP SDK's transport exposes it
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:115-120`):

```js
get stderr() {
    if (this._stderrStream) return this._stderrStream;
    return this._process?.stderr ?? null;
}
```

**Why the substitution is legal**: `@ai-sdk/mcp` accepts any custom transport structurally —
`isCustomMcpTransport` checks only for callable `start`, `send`, and `close`
(`src/tool/mcp-transport.ts`). `StdioClientTransport` has all three (`stdio.js:60,143,179`) plus the
`onmessage`/`onerror`/`onclose` handlers the interface reads.

---

## Environment

An **explicit allowlist**, plus whatever the transport inherits by default:

| Passed | Condition |
| --- | --- |
| `GMA_BASE_URL` | always |
| `GMA_DEFAULT_INSTANCES` | always |
| `OKTA_ISSUER` | always |
| `GMA_USER_TOKEN` | always — set to the **resolved** credential, whatever its source |
| `LOG_LEVEL` | always — `warn` unless overridden |
| `GMA_TIMEOUT_MS` | if set |
| `GMA_MAX_CANDIDATES` | if set |

**Never passed**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
`AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`, `OKTA_CLIENT_ID`, `AGENT_MODEL_ID`. The server's audited
input set is the point of `src/core/config.ts` and this feature does not widen it (FR-011).
Asserted by suite C, not left to convention.

**The transport inherits** `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` and nothing else —
verified identical in both candidate transports (research.md R4). Everything else must be passed
deliberately, which is why FR-010 validates before spawning: otherwise `loadConfig()` throws and
the child exits `78` with its explanation on a stream nobody is reading.

Note: passing `getDefaultEnvironment()` explicitly is unnecessary — the SDK spreads it in
unconditionally. Harmless but redundant.

---

## stderr

`stderr: 'pipe'`, read into a **bounded ring buffer**:

| When | Behaviour | Requirement |
| --- | --- | --- |
| Spawn or connect fails | Dump the buffer — this is where `Refusing to start: Missing required configuration: OKTA_ISSUER` lives | FR-012, SC-006 |
| `--verbose` | Echo live as it arrives | FR-012, Story 2 AC-4 |
| Otherwise | Retain silently | FR-012, Story 2 AC-3 |

Neither `inherit` nor `ignore` is acceptable: `inherit` lets server logs scribble over the prompt
mid-typing (which is why `LOG_LEVEL` also defaults to `warn`), and `ignore` makes the single most
likely first failure completely silent.

Bounded rather than unbounded because a long `debug`-level session would otherwise grow without
limit for output nobody reads; bounded keeps the most recent lines — the ones explaining a failure
that just happened.

---

## Child exit codes

From `src/index.ts:27-38`, unchanged by this feature:

| Code | Meaning | Harness behaviour |
| --- | --- | --- |
| `78` | `EX_CONFIG` — missing/invalid configuration; stderr carries `Refusing to start: …` naming the variable | Dump the buffer, exit `70`. FR-010 means this should already have been caught earlier. |
| `1` | Any other startup failure | Dump the buffer, exit `70` |

Suite C asserts the `78` path end-to-end: remove a required variable, spawn, and confirm the
harness surfaces the buffered line **naming the variable**. `test/protocol/smoke.test.ts` cannot
cover this — it uses `InMemoryTransport` (line 29), so there is no child process, no pipe, and no
environment to get wrong.

---

## Capability discovery

`await mcpClient.tools()` — schema discovery, no schemas declared in the harness (FR-003). Expected
result: exactly three tools (`list_instances`, `find_catalogue_entity`, `get_catalogue_entity`),
matching what `test/protocol/smoke.test.ts:58` pins server-side.

Cost accepted: tool inputs are untyped at compile time in the harness. Irrelevant — the harness
never inspects them, it forwards them.

---

## Lifecycle

| Event | Behaviour |
| --- | --- |
| Startup | Validate config → resolve credential → spawn → discover. Config failure never reaches the spawn (FR-010). |
| Auth failure mid-turn | Refresh, tear down, respawn, re-discover, retry the turn **once** (FR-023) |
| Child exits mid-session | Tell the engineer; do not accept input the harness cannot answer (Edge Cases) |
| `/exit` or Ctrl-D | Close the client, terminate the child, leave no orphan (Story 1 AC-6) |

**Respawn is the only mechanism for token rotation**, not a design preference: a child's
environment is immutable after spawn, and stdio carries no per-request identity channel —
`src/core/identity.ts:115-125` reads `extra?.authInfo?.token` first, and `authInfo` is populated
only when the transport performed OAuth, which stdio never does. The file states this directly:
stdio "has no HTTP request to carry a bearer".

The conversation survives because it lives in the harness (FR-006), not the child.
