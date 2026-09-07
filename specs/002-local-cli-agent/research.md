# Research: Local CLI Agent Harness

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

**Purpose**: Resolve every `NEEDS CLARIFICATION` in `plan.md`'s Technical Context, and settle the
three open questions the design brief (`docs/agent-cli-brief.md` §5) deliberately left open.

Every finding below was verified by **reading installed source or package metadata**, not by
recalling documentation. Where a claim could not be verified locally it is labelled
`UNVERIFIED` and carries a decision that holds either way.

---

## R1 — Which MCP client library bridges the server's tools to the model

**Decision**: `@ai-sdk/mcp` `^2.0.45` for the client, **but constructed with the MCP SDK's own
`StdioClientTransport`** from `@modelcontextprotocol/sdk` (already a production dependency),
not with `@ai-sdk/mcp`'s bundled `Experimental_StdioMCPTransport`.

**Rationale**: The brief assumed `@ai-sdk/mcp`'s own stdio transport. Reading its source shows
it cannot satisfy FR-012, which requires capturing the child's stderr and showing it when
startup fails:

`$TMPDIR/aisdk/package/src/tool/mcp-stdio/mcp-stdio-transport.ts`:

```ts
export class StdioMCPTransport implements MCPTransport {
  private process?: ChildProcess;      // private, no accessor
  // ...no `stderr` getter, no `pid` getter
}
```

Its `StdioConfig` does accept `stderr?: IOType | Stream | number`, which is forwarded to
`spawn`'s `stdio[2]`. So `stderr: 'pipe'` *would* pipe — but the resulting stream is
unreachable, because `process` is private and nothing exposes it. Passing a `Stream` we own is
the only way to read it, which means constructing and plumbing a `PassThrough` ourselves.

The MCP SDK's transport already solves exactly this
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:115-120`):

```js
get stderr() {
    if (this._stderrStream) return this._stderrStream;
    return this._process?.stderr ?? null;
}
```

It creates a `PassThrough` when `stderr: 'pipe'` is requested, and also exposes `pid`.

**This substitution is safe because `MCPTransport` is structural, and the SDK checks it
structurally.** `$TMPDIR/aisdk/package/src/tool/mcp-transport.ts`:

```ts
export function isCustomMcpTransport(transport): transport is MCPTransport {
  return 'start' in transport && typeof transport.start === 'function'
      && 'send'  in transport && typeof transport.send  === 'function'
      && 'close' in transport && typeof transport.close === 'function';
}
```

`StdioClientTransport` has `start()`, `send()`, and `close()` (verified at
`stdio.js:60,143,179`), plus the `onmessage`/`onerror`/`onclose` handlers the interface reads.
It therefore passes as a custom transport.

**Alternatives considered**:

| Option | Rejected because |
| --- | --- |
| `@ai-sdk/mcp`'s `Experimental_StdioMCPTransport` as-is | Cannot read the child's stderr — FR-012 unimplementable without plumbing our own `PassThrough`, which is strictly more code than reusing the SDK transport that already does it |
| Pass a self-made `PassThrough` as `stderr` to the AI SDK transport | Works, but re-implements what the MCP SDK transport gives free, and still leaves `pid` unavailable |
| Drive the MCP SDK `Client` directly and hand-declare tools to the model | Violates FR-003 (server is the single source of truth); reintroduces the schema drift the brief rejects |

**Consequence for the plan**: the agent depends on **both** packages. That is not duplication —
`@ai-sdk/mcp` supplies discovery and the tool-set adapter, `@modelcontextprotocol/sdk` supplies
the transport. Both are already in `package.json` or added as a devDependency.

---

## R2 — How an MCP `isError: true` result surfaces (resolves brief §5.3)

**Decision**: It is **returned as a value, not thrown**. The agent MUST inspect each tool result
to implement FR-023's auth-recovery path. No wrapper around the discovered tools is needed —
inspection happens where results are observed.

**Rationale**: Read directly from `$TMPDIR/aisdk/package/src/tool/mcp-client.ts:1251-1271`:

```ts
const execute = async (args, options): Promise<unknown> => {
  options?.abortSignal?.throwIfAborted();
  const result = await self.callTool({ name, arguments: args, options: {...} });

  if (result.isError) {
    return result;                     // ← returned, NOT thrown
  }

  if (outputSchema != null) {
    return self.extractStructuredContent(result, outputSchema, name);
  }
  return result;
};
```

The brief flagged this as "best resolved empirically on first run". It was resolvable by
reading the installed source, and the answer is the second of the brief's two hypotheses: the
error becomes ordinary tool output the model merely reads. So:

- The model **will** see the `[auth]` text and may narrate it. That is fine and even desirable.
- The **agent** must also see it, because only the agent can refresh the token and respawn.
- Detection is by inspecting `result.isError` together with the `[auth]` prefix that
  `test/protocol/smoke.test.ts:200` pins on the server side.

**Where inspection happens**: `streamText` exposes `onToolExecutionEnd({ toolCall, toolOutput })`
and emits `tool-result` parts on `fullStream`. The trace lines FR-005 requires are produced from
the same stream, so auth detection costs no extra machinery — it is one branch in code that
already exists.

**Alternatives considered**: wrapping every discovered tool in a result-inspecting proxy. Correct
but unnecessary given the stream already carries results, and it would add a layer between the
server's schemas and the model for no gain.

---

## R3 — Bedrock model id (resolves brief §5.2)

**Decision**: default `AGENT_MODEL_ID` to **`us.anthropic.claude-sonnet-5`**. The brief's
`us.anthropic.claude-sonnet-4-5-20250929-v1:0` is a valid id but names a previous-generation
model.

**Rationale**: `@ai-sdk/amazon-bedrock@5.0.76`'s `AmazonBedrockChatModelId` union
(`dist/index.d.ts:60`) lists current-generation Claude ids **without** a date/revision suffix
alongside the older dated ones:

```
'us.anthropic.claude-sonnet-5' | 'us.anthropic.claude-fable-5'
| 'us.anthropic.claude-opus-4-8' | 'us.anthropic.claude-opus-4-7'
| 'us.anthropic.claude-opus-4-6-v1' | 'us.anthropic.claude-sonnet-4-6-v1'
| 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'   ← the brief's default; still listed
| ... | (string & {})
```

Both work; the union ends in `(string & {})`, so any string is accepted and an unlisted id is
not a type error. `us.` is the cross-region inference profile prefix for US regions.

**This does not make model access a code concern.** FR-009 requires the id to come from
configuration precisely because Bedrock model access is granted per AWS account: a `403` on the
default is fixed by setting `AGENT_MODEL_ID`, and the failure message must say so (FR-009,
SC-014). The default is a starting guess, and remains one.

**Credential reading**: the provider reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`, and `AWS_REGION` from the environment, and `AWS_BEARER_TOKEN_BEDROCK` takes
precedence over SigV4 when set. Documented behaviour worth knowing: if both keys are passed as
**literal constructor arguments**, `AWS_SESSION_TOKEN` is *not* picked up unless `sessionToken`
is also passed explicitly. The brief already reached the right conclusion for the right reason —
use the default `amazonBedrock` instance and let it read the environment, so rotating SSO
credentials work.

Note the export is **`amazonBedrock`**, not `bedrock` (`@ai-sdk/amazon-bedrock` docs).

---

## R4 — The child environment really is stripped (confirms the brief)

**Decision**: The agent MUST pass an explicit env allowlist. Confirmed, and it applies to
**both** candidate transports.

**Rationale**: `@modelcontextprotocol/sdk`'s `DEFAULT_INHERITED_ENV_VARS`
(`dist/esm/client/stdio.js`) is, on non-Windows:

```js
['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']
```

and `start()` spawns with `env: { ...getDefaultEnvironment(), ...this._serverParams.env }`.
`@ai-sdk/mcp`'s `getEnvironment()` uses the identical list. So without an explicit `env`,
`GMA_BASE_URL` / `GMA_DEFAULT_INSTANCES` / `OKTA_ISSUER` all arrive `undefined`,
`loadConfig()` throws a `config` `ToolError`, and `src/index.ts:31` exits `78` with the
explanation on stderr.

Two consequences, both already in the spec:

- FR-010 (validate before spawning) is what turns that into a readable agent-side message.
- FR-012 (capture stderr) is what makes the child's own explanation visible when it does happen
  anyway — and R1 is why the transport choice matters.

**Note on `getDefaultEnvironment()`**: the brief suggests passing it alongside the allowlist. It
is unnecessary — the SDK spreads it in unconditionally. Passing it explicitly is harmless but
redundant; the allowlist alone suffices. `PATH` is inherited either way, which is what lets
`node` resolve.

---

## R5 — Turn loop shape and history

**Decision**: `streamText` from `ai@^7`, with `stopWhen`, iterating `fullStream` for trace
lines, and appending **`result.responseMessages`** to a mutable history array.

> **Correction, found during implementation (2026-09-07).** This finding originally
> specified `(await result.response).messages`. In the installed `ai@7.0.93` that accessor
> is **deprecated and carries only the FINAL step** — "Additional response information from
> the last step" (`node_modules/ai/dist/index.d.ts:2758-2764`). On a turn that invokes a
> capability — step 1 emits the tool call and its result, step 2 emits the prose — it
> therefore drops the tool-result message, silently breaking FR-006 and disabling SC-003
> while the harness kept running and looking correct. `responseMessages` is documented as
> "the accumulated response messages of all steps", and is what the implementation uses.
>
> Caught by `agent/test/recovery.test.ts`'s assertion that a `tool`-role message reaches
> history — exactly the regression class that test exists for.
>
> A second correction from the same session: a V4 `finishReason` is an **object**
> `{ unified, raw }`, not a string, and the SDK gates tool execution on
> `finishReason.unified` (`dist/index.js:3327`, `8488`). A test stub supplying a bare
> string yields a turn where the tool is never executed and no `tool-result` part is ever
> emitted — a stub that looks right and asserts nothing.

**Rationale**: `streamText`'s accumulated response messages carry assistant turns **and**
tool-result messages. That is precisely what FR-006 requires: without the tool-result
messages in history, "the Premier League one" cannot resolve against the previous turn's
`candidates`, and the disambiguation contract (SC-003) cannot be exercised at all.

For trace lines (FR-005), `fullStream` emits typed parts — `tool-call` (`{toolCallId, toolName,
input}`) and `tool-result` (`{toolCallId, toolName, input, output}`) — interleaved with `text`
and step framing. One `switch` over `part.type` produces both the streaming answer and the
per-invocation trace, and is also where R2's auth inspection lands.

`stopWhen` accepts `isStepCount(n)` / `hasToolCall(...)`. A step cap is required so a
misbehaving turn cannot loop indefinitely.

**Version pinning**: `ai@7.0.93` is `latest`. `@ai-sdk/mcp@2.0.45` is `latest`;
`@ai-sdk/amazon-bedrock@5.0.76` is `latest`. All three peer-depend on
`zod@^3.25.76 || ^4.1.8`, and the repo has `zod@^4.5.4` — **compatible**. `@ai-sdk/mcp` and
`@ai-sdk/amazon-bedrock` both pin `@ai-sdk/provider@4.0.10` and
`@ai-sdk/provider-utils@5.0.36` exactly, so they are a matched set.

`@ai-sdk/mcp@2.0.45` also carries an `ai-v6` dist-tag at `1.0.78`. `UNVERIFIED`: whether
`@ai-sdk/mcp@2.x` requires `ai@7.x` specifically. It declares no peer dependency on `ai` at all,
so the pairing is by convention. Install `ai@^7` with `@ai-sdk/mcp@^2` and let the type-check
confirm; a mismatch surfaces at compile time, not at runtime.

---

## R6 — Where the harness lives, and why `src/` cannot host it

**Decision**: new top-level `agent/`, excluded from the root `tsconfig`, from vitest coverage,
and with its own vitest config. `test/unit/architecture.test.ts` keeps walking `src/` only.

**Rationale**: the architecture test asserts properties an interactive REPL necessarily
violates. Read from `test/unit/architecture.test.ts`:

| Assertion | Line | The harness needs |
| --- | --- | --- |
| `uses console nowhere` | 146 | terminal output |
| `writes to stdout only from the entrypoint` (in fact: *nowhere* under `src/`) | 152 | prompt + streaming answer |
| `reads process.env in exactly two places` — asserts the sorted list equals `['core/config.ts','core/identity.ts']` | 54 | AWS + Okta + model config |
| `declares no module-level mutable binding` | 34 | conversation state |
| `contains no hardcoded GMA or OKTA host` — any `https://` literal fails | 76 | Okta device endpoints |

The env assertion is an **exact equality** on a sorted list, so any third reader under `src/`
fails it. And `vitest.config.ts` gates `src/**` at ≥90% line / ≥85% branch with `src/core/**` at
≥95% line — thresholds the constitution (Development Workflow & Quality Gates) forbids lowering:
"Lowering a threshold requires the amendment procedure below; it is never a fix for a failing
build."

Placing the harness outside `src/` is therefore not a convenience. It is the only option that
does not either weaken a constitutional gate or amend the constitution for a development tool.

**Alternatives considered**:

| Option | Rejected because |
| --- | --- |
| `src/agent/` with architecture-test exemptions | Turns five structural invariants into five exemptions; the test's value is that it has no exemptions |
| Amend the constitution to scope gates more narrowly | A governance change to accommodate a local dev tool inverts the priority; the constitution explicitly wins over convenience |
| A separate repository | Loses the `dist/` build dependency that guarantees the harness never drives a stale server (FR-001) |

---

## R7 — Device authorization grant against Okta

**Decision**: implement OAuth 2.0 Device Authorization Grant (RFC 8628) against
`{OKTA_ISSUER}/v1/device/authorize` and `{OKTA_ISSUER}/v1/token`, with `OKTA_CLIENT_ID` from
configuration.

**Rationale**: this is the flow that matches FR-017's requirement — a link and a short code the
engineer completes in a browser, with no terminal input afterwards. Okta supports it on custom
authorization servers, which is what GMA uses (constitution: "per-environment custom
authorization server").

It works with **no GMA change** because the constitution records (verified 2026-09-03) that
**no audience validator exists anywhere in GMA** — `SecurityFilterFactory.java:35-70` checks
issuer, signature, expiry, then `groups ∩ authority.group`. A token minted by a *new* native app
under the *same* per-environment authorization server is therefore accepted.

**This is a documented dependency on a verified fact, not an assumption we control.** If GMA
ever adds audience validation, FR-017 breaks. The spec records this (Assumptions), and the
constitution requires re-verification if GMA's cookbook changes.

**Polling state machine** — the states FR-018 must distinguish, per RFC 8628 §3.5:
`authorization_pending` (keep waiting), `slow_down` (increase interval), `access_denied` (stop,
user refused), `expired_token` (stop, tell them to restart). Plus the client-side deadline from
`expires_in`, so it cannot spin forever.

**Alternatives considered**:

| Option | Rejected because |
| --- | --- |
| Authorization code + PKCE with a loopback listener | Needs a local HTTP server and a browser redirect; the brief's requirement is explicitly a printed link, and device grant needs no listener |
| Client credentials | Mints a service identity, violating Principle I (pass-through identity) outright |
| Resource-owner password grant | Deprecated, and puts the engineer's password through the harness |

---

## R8 — Token cache, and why a foreign issuer must be rejected

**Decision**: `~/.gma-agent/token.json`, mode `0600`, holding `access_token`, `refresh_token`,
`expires_at`, `issuer`, `clientId`. A cache whose `issuer` ≠ configured `OKTA_ISSUER` is
**rejected, not refreshed**.

**Rationale**: outside the repository, so FR-020's "impossible to commit" holds structurally
rather than by `.gitignore` discipline. `0600` because it holds a live credential.

Rejection-on-mismatch (FR-019) matters more than it first appears. The constitution's Principle I
states a token "is valid against exactly one GMA environment", and the issuer is per-environment
(dev/stg/prd each have a distinct authorization server id). Refreshing a QA-issued cache while
configured against another environment yields a token that *is* valid — just not here — so GMA
answers `401`, which the harness would read as "credential expired" and try to recover from,
looping. Rejecting up front converts a confusing loop into one clear message.

---

## R9 — Why expiry forces a respawn rather than a token swap

**Decision**: on an `[auth]`-tagged tool result, refresh the token, tear down and respawn the
MCP client, retry the turn **once**.

**Rationale**: two facts combine to leave no alternative.

1. **A child process's environment is immutable after spawn.** The parent cannot rewrite
   `GMA_USER_TOKEN` in a running child.
2. **stdio carries no per-request identity channel.** `src/core/identity.ts:115-125` reads
   transport identity first (`extra?.authInfo?.token`) and falls back to the environment — and
   `authInfo` is populated only when the transport performed OAuth, which stdio never does. The
   file says so explicitly: stdio "has no HTTP request to carry a bearer".

So the only way to give the server a new token is to give it a new process. Conversation history
survives because FR-006 keeps it in the harness, not the server.

**Retry exactly once** (FR-023): a persistent auth failure must not loop. One retry distinguishes
"credential aged out mid-session" from "this credential will never work".

---

## R10 — Test strategy under the constitution

**Decision**: `agent/vitest.config.ts` with its own `include` glob and **no coverage
thresholds**. Run via `test:agent`, which builds first. `npm test` stays byte-for-byte what it
is today.

**Rationale**: the constitution's coverage gates govern `src/` and must not be diluted (R6). Two
separate vitest configs is the mechanism that keeps `npm test` — the command the constitution
describes — unchanged, which SC-011 requires be verifiable by comparison.

Three suites, matching FR-027:

| Suite | Mechanism | Why it cannot be covered elsewhere |
| --- | --- | --- |
| **A. Credential precedence** | injected clock + injected `fetch`, no network | Pure logic; the foreign-issuer rejection (R8) has no other test home |
| **B. Device flow state machine** | `msw` (already a devDependency) | `slow_down`, `access_denied`, `expired_token` **cannot be provoked on demand against real Okta** — the same argument the constitution makes for GMA fixtures |
| **C. Child spawn handshake** | real process, real pipes (needs `dist/`) | `test/protocol/smoke.test.ts` uses `InMemoryTransport` (line 29) — there is no child process, no pipe, and no environment to get wrong, so exit-78 and the env allowlist are structurally untestable there |

**Explicitly excluded**: an end-to-end test making a real Bedrock call (FR-028). It would prove
SC-002 and SC-003 — the caveat actually reaching a human — but it is non-deterministic, costs
tokens per run, and needs AWS credentials in CI. The constitution keeps live GMA out of CI for
the same reasons: "token management is human-in-the-loop and failure modes cannot be forced
against a live BFF." It belongs in the quickstart as a manual step, which is where
`quickstart.md` puts it.

---

## R11 — FR-035, the one open clarification

**Status**: unresolved in the spec; **the plan does not depend on it.**

FR-035 asks whether the command set extends beyond clear/exit/help to include printing the
conversation, direct capability invocation, and forced re-authentication. The plan's design puts
command dispatch behind one seam (`agent/repl/commands.ts` in the structure below), so each
command is an independent addition. Building the minimal set first forecloses nothing.

`/speckit-tasks` should generate tasks for clear, exit, and help only, and treat the other three
as a follow-up until the question is answered.

---

## Summary of corrections to the design brief

The brief is the authoritative design record and was right on every architectural decision. Three
factual corrections, all found by reading installed source:

| Brief says | Correct position | Impact |
| --- | --- | --- |
| §3.3 use `@ai-sdk/mcp`'s stdio transport with `stderr: 'pipe'`, ring-buffered | That transport keeps its child private and exposes no stderr accessor. Use `@modelcontextprotocol/sdk`'s `StdioClientTransport`, which has one, and pass it to `createMCPClient` as a custom transport (structurally accepted) | R1 — changes which package supplies the transport |
| §3.1 default model `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Valid but previous-generation. Default to `us.anthropic.claude-sonnet-5` | R3 — one string |
| §5.3 how an `isError` result surfaces is "unknown, resolve empirically" | Resolved by reading source: **returned, not thrown** (`mcp-client.ts:1262`). The model sees it as text; the agent must inspect `result.isError` | R2 — removes an unknown from the design |

One brief suggestion is redundant rather than wrong: passing `getDefaultEnvironment()` alongside
the allowlist (§3.3). The SDK spreads it in unconditionally.
