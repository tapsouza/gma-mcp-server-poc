# Feature Brief: Local CLI Agent (`npm run agent`)

**Status**: Brief — input for `/speckit-specify`. Not a specification.

**Date**: 2026-09-07

**Purpose**: Capture the design decisions reached in a grilling session so `/specify` can
turn them into a spec without re-litigating them. Every "Decision" below is settled.
Every "Open" is genuinely unresolved and should surface as a clarification or an
assumption in the spec.

---

## 1. What is being built

A command-line agent that spawns this repository's MCP server as a **child process over
stdio**, discovers its three catalogue tools, and drives them with an LLM so a human can
ask catalogue questions in natural language:

```text
$ npm run agent
✓ signed in as thiago.souza@fanduel.com
✓ spawned gma-mcp-server (3 tools)

> which leagues are under football?

⏺ find_catalogue_entity { name: "football" }
  → resolved: Football (12 children)

Football has 12 subclasses: Premier League, La Liga, …

⚠ Note: assembled from PP only — BF failed.

> _
```

### Why it exists

The server's two non-negotiable properties (README) are only half-proven by the existing
test suite. `test/protocol/smoke.test.ts` proves a *tool result* carries its
`completeness` verdict. It cannot prove that a real LLM, reading the real tool
descriptions, **relays that caveat to the human** or **declines to pick between
candidates**. Those are properties of the final natural-language turn, and this agent is
how they get exercised.

Secondary value: it is a far better manual harness than
`npx @modelcontextprotocol/inspector`, which the quickstart currently relies on.

### What it is not

- **Not part of the served artefact.** It is a local development harness.
- **Not a deployment step.** `TODO(PREFAB_MIGRATION)` remains untouched and still blocks
  any non-local deployment.
- **Not a change to the server.** No file under `src/` needs to change for this feature.
  If the implementation finds it does, that is a finding worth escalating, not a licence
  to edit.

---

## 2. Constraint that shapes everything: the `src/` fence

`test/unit/architecture.test.ts` walks every `.ts` file under `src/` and asserts, among
other things:

| Assertion | Where |
| --- | --- |
| no `console.*` anywhere | `architecture.test.ts` — "uses console nowhere" |
| nothing writes to `process.stdout` | "writes to stdout only from the entrypoint" |
| `process.env` read in **exactly two** files (`core/config.ts`, `core/identity.ts`) | "reads process.env in exactly two places" |
| no top-level `let` / `var` | "declares no module-level mutable binding" |
| no `https://` literal in source | "contains no hardcoded GMA or OKTA host" |

`vitest.config.ts` additionally gates `src/**` at ≥90% line / ≥85% branch, `src/core/**`
at ≥95% line — thresholds the constitution forbids lowering.

An interactive REPL needs `console`, stdout, `readline`, mutable conversation state, and
an Okta URL. It violates five of those assertions.

> **Decision — placement.** The agent lives in a new top-level `agent/` directory,
> excluded from the root `tsconfig`, from ESLint, and from vitest coverage. The
> architecture test keeps walking `src/` only. The server's constitutional guarantees
> stay provable; the client is explicitly outside them.

```text
gma-mcp-server-poc/
├── src/           # unchanged — gates unchanged
├── agent/         # new
│   ├── main.ts
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── test/
├── test/          # unchanged
└── dist-agent/    # build output, gitignored
```

---

## 3. Decisions

### 3.1 Stack

| Decision | Value | Rationale |
| --- | --- | --- |
| LLM orchestration | **Vercel AI SDK** (`ai`, `@ai-sdk/mcp`) | User's choice. |
| Provider | **Amazon Bedrock** (`@ai-sdk/amazon-bedrock`) | User's choice; matches org AWS access. |
| Model id | `AGENT_MODEL_ID` env var, default `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model access is granted per-AWS-account. An env var makes a 403 a config fix, not a code edit. |
| AWS auth | default `amazonBedrock` instance reading `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` from env | Zero extra dependencies. Because the keys come *from the environment* rather than as literal constructor arguments, the provider also picks up `AWS_SESSION_TOKEN` automatically — which matters for rotating SSO credentials. |
| Turn loop | `streamText` with `stopWhen`, plus tool-call trace lines | Token-by-token output, and each tool call announced as it fires. Seeing *which* tool it chose and *what arguments* it passed is the point of a harness. |
| History | unbounded `messages` array, `/reset` command | `response.messages` returns assistant turns **and** tool-result messages, which is what lets "the Premier League one" resolve against the previous turn's `candidates`. Without history the disambiguation contract cannot be exercised at all. |

**Implementation note.** `process.loadEnvFile('.env')` (Node 22 builtin) must be the
**first statement** in `main.ts`, before the Bedrock provider module is evaluated, or the
provider reads an empty environment.

### 3.2 Tool bridging

> **Decision.** `await mcpClient.tools()` — schema *discovery*, no schemas declared in
> the agent.

The server is the single source of truth for tool names, JSON Schema, and descriptions.
Those descriptions are load-bearing: `register.ts` and each tool carry the "you MUST
relay the caveat" instruction that `smoke.test.ts` asserts on. Re-declaring schemas in
the agent would create a second source of truth that drifts — and drift means the
agent's model sees a description the server no longer has.

Cost accepted: tool inputs are untyped at compile time in the agent. Irrelevant, because
the agent never inspects them; it forwards them.

### 3.3 Spawning the child

`StdioClientTransport` **does not inherit the parent environment**. Verified in
`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`:
`DEFAULT_INHERITED_ENV_VARS` is `['HOME','LOGNAME','PATH','SHELL','TERM','USER']` on
non-Windows. So `GMA_BASE_URL`, `OKTA_ISSUER`, `GMA_DEFAULT_INSTANCES`, and
`GMA_USER_TOKEN` all arrive `undefined`, `loadConfig()` throws, and `src/index.ts` exits
`78` — with the explanation on a stderr stream nobody is reading.

> **Decision — env.** The agent loads `.env` itself, validates the four required values,
> and passes an **explicit allowlist** to the child alongside `getDefaultEnvironment()`.
> A missing value fails in the *agent*, with a readable message, before the child is ever
> spawned. AWS credentials are deliberately withheld — the GMA server has no business
> holding them, and its audited input set is the whole point of `core/config.ts`.

> **Decision — stderr.** `stderr: 'pipe'`, ring-buffered. Dumped when spawn or connect
> fails (this is where `Refusing to start: Missing required configuration: OKTA_ISSUER`
> lives), and echoed live under `--verbose`. Not `inherit`, because at `LOG_LEVEL=info`
> server logs scribble over the prompt mid-typing; not `ignore`, because then the most
> likely first failure is silent.

Child `LOG_LEVEL` defaults to `warn` for the same reason.

### 3.4 Authentication: Okta device authorization grant

The requirement is a CLI login that prints a link the user opens to authenticate properly
against Okta. The **OAuth 2.0 Device Authorization Grant** is that flow, and Okta
supports it on custom authorization servers — which is what GMA uses.

**Why this is viable without any GMA change**: the constitution records (verified
2026-09-03) that **no audience validator exists anywhere in GMA** — it checks issuer,
signature, expiry, then `groups` ∩ `authority.group`. A token minted by a *new* Okta
native app under the *same* per-environment authorization server is therefore accepted.

**Flow**:

1. `POST {OKTA_ISSUER}/v1/device/authorize` with `client_id` and
   `scope=openid profile offline_access`.
2. Display `verification_uri` and `user_code` (optionally open the browser at
   `verification_uri_complete`).
3. Poll `POST {OKTA_ISSUER}/v1/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` at the returned `interval`,
   handling `authorization_pending`, `slow_down`, `access_denied`, `expired_token`.

> **Decision — resolution ladder.** In strict precedence order, mirroring
> `core/identity.ts` (transport-supplied identity wins over environment):
>
> 1. `GMA_USER_TOKEN` in the environment → use it verbatim, skip login entirely
> 2. `~/.gma-agent/token.json` → use if unexpired **and** its recorded issuer matches
>    the configured `OKTA_ISSUER`
> 3. cached `refresh_token` → refresh
> 4. device authorization flow → browser
>
> Step 1 keeps the agent usable before the Okta app exists, and keeps working with
> whatever token is already being pasted for the MCP Inspector.

> **Decision — cache.** `~/.gma-agent/token.json`, mode `0600`, holding
> `access_token`, `refresh_token`, `expires_at`, `issuer`, `clientId`. Outside the repo,
> so it cannot be committed. **A cache whose `issuer` does not match current
> configuration MUST be rejected, not refreshed** — tokens are not portable across GMA
> environments, and silently reusing a QA token against another environment produces a
> confusing 401 instead of a clear error.

> **Decision — expiry.** Okta access tokens live ~1 hour, and **a child process's
> environment is immutable after spawn** — the parent cannot rotate `GMA_USER_TOKEN` in
> a running child, and stdio has no per-request auth channel (`authInfo` populates only
> when the transport performed OAuth, which stdio never does). Therefore: on a tool
> result tagged `[auth]` (which `core/errors.ts` guarantees for a GMA 401), refresh the
> token, tear down and respawn the MCP client, and retry the turn. Conversation history
> survives because it lives in the agent, not the server. The user sees two notice lines.

> **Decision — client id.** From `OKTA_CLIENT_ID`; endpoints derived from the existing
> `OKTA_ISSUER`. Never hardcoded — it is a per-environment operational value, and the
> repo's Principle V discipline applies even outside the fence. When it is absent, print
> exactly what to request from an Okta administrator (see §5.1) plus the
> `GMA_USER_TOKEN` fallback.

### 3.5 System prompt

> **Decision.** Minimal. Name the domain, point at the tools, and instruct the model to
> follow each tool's own description — specifically its instructions about relaying
> completeness caveats and not choosing between candidates.

This is deliberate and is the whole experimental value of the harness. Restating the
caveat and candidate rules in the agent's own prompt would produce better-behaved output
while **masking whether the server's tool descriptions are adequate on their own**. A
third-party agent will never read this prompt. If the caveat gets dropped, that is a real
defect in the server's descriptions and we want to see it.

### 3.6 Build and scripts

```jsonc
"agent":      "npm run build && tsc -p agent/tsconfig.json && node dist-agent/main.js",
"test":       "vitest run",                                        // unchanged
"test:agent": "npm run build && vitest run -c agent/vitest.config.ts",
"test:all":   "npm test && npm run test:agent"
```

`agent/tsconfig.json` extends the root config (keeping the strict options), with
`rootDir: agent`, `outDir: dist-agent`. Root `tsconfig` excludes `agent` and
`dist-agent`; ESLint ignores `dist-agent`; vitest coverage excludes `agent/**`.

`agent` depends on `npm run build` because the agent spawns `dist/index.js` — this
guarantees you are never driving a stale server.

### 3.7 Tests

> **Decision.** `agent/vitest.config.ts`, own `include` glob, **no coverage thresholds**
> — the constitutional gates govern `src/` and must not be diluted. Run via
> `test:agent`, which builds first so the spawn suite has `dist/`. `npm test` stays
> exactly what the constitution describes.

Three suites, all three wanted:

**A. Token resolution ladder** — pure logic, injected clock and injected `fetch`, no
network:

- env `GMA_USER_TOKEN` wins over a fresh cache
- a fresh cache is used with no HTTP call made
- **a cache with a different `issuer` is rejected** (not portable across GMA envs)
- expired access token + valid refresh token → refreshes
- no env, no cache → device flow invoked
- cache file written `0600`
- no token or `refresh_token` appears in any emitted line

**B. Device flow polling state machine** — `msw` (already a devDependency):

- `authorization_pending` ×3 → then success
- respects the returned `interval` between polls
- `slow_down` → increases the interval
- `access_denied` → fails with a clear message
- `expired_token` → tells the user to restart login
- stops at `expires_in` rather than spinning
- prints `verification_uri` and `user_code`

These are the paths that **cannot be triggered on demand against real Okta** — the same
argument the constitution makes for GMA fixtures.

**C. Child spawn handshake** — real process, real pipes (needs `dist/`):

- spawns `dist/index.js` and discovers exactly three tools
- one tool call round-trips over real pipes
- a missing required env var → child exits `78` **and the agent surfaces the buffered
  stderr line naming the variable**
- the env allowlist holds: the child does **not** receive `AWS_SECRET_ACCESS_KEY`

C covers what `test/protocol/smoke.test.ts` structurally cannot, because that suite uses
`InMemoryTransport` — there is no child process, no pipe, and no environment to get wrong.

**Explicitly excluded**: an end-to-end test making a real Bedrock call. It would prove
the caveat actually gets relayed, but it costs tokens per run, is non-deterministic, and
needs AWS credentials in CI — the same reasons the constitution keeps live GMA out of CI.
It belongs in the quickstart as a manual step.

### 3.8 Documentation

> **Decision.** A new `## Trying it with an agent` section in the **root README**, after
> "Running it locally". Plus one line in *Scope of this slice* recording that the agent
> is a local development harness living outside the constitutional gates.

The root README's "Running it locally" currently ends at the MCP Inspector; a reader
looking for "how do I try this" starts there.

---

## 4. Configuration summary

New values, all read by the **agent** only. None reaches the child except where noted.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `OKTA_CLIENT_ID` | for device login | — | Okta native app client id. Not needed when `GMA_USER_TOKEN` is supplied. |
| `AGENT_MODEL_ID` | no | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model id. |
| `AWS_REGION` | yes | — | Read by the Bedrock provider. |
| `AWS_ACCESS_KEY_ID` | yes | — | Never passed to the child. |
| `AWS_SECRET_ACCESS_KEY` | yes | — | Never passed to the child. |
| `AWS_SESSION_TOKEN` | if SSO | — | Never passed to the child. |
| `GMA_USER_TOKEN` | no | — | Now **optional** — short-circuits device login. Passed to the child. |

Unchanged and still required, validated by the agent then passed to the child:
`GMA_BASE_URL`, `GMA_DEFAULT_INSTANCES`, `OKTA_ISSUER`. Optional pass-throughs:
`GMA_TIMEOUT_MS`, `GMA_MAX_CANDIDATES`, `LOG_LEVEL` (agent defaults the child to `warn`).

`.env.example` should gain the new values, keeping its existing discipline: every value
illustrative, no real host, no real client id, no token.

---

## 5. Open questions

These are unresolved and should surface as clarifications or stated assumptions.

### 5.1 An Okta admin request is a blocking prerequisite (external dependency)

Device login needs an Okta app that **does not exist yet**:

- type: **Native Application** (Okta: "Device Authorization is only supported for use
  with a native application")
- grant types: **Device Authorization** *and* **Refresh Token**
- on the **same custom authorization server** as `OKTA_ISSUER` — one app per GMA
  environment, since issuers are per-environment
- that server's **default Access Policy rule must permit Device Authorization**
  (Security → API → server → Access Policies)
- its tokens must carry the **`groups` claim**, because GMA checks
  `groups` ∩ `authority.group`

Until this exists, only the `GMA_USER_TOKEN` fallback path works. **The spec should treat
device login and the fallback as separately shippable**, so the feature is not blocked on
an admin ticket.

### 5.2 Which Bedrock model ids the AWS account can actually invoke

Bedrock model access is granted per-account and requested in the console. `AGENT_MODEL_ID`
makes this a configuration fix, but the default in this brief is a guess.

### 5.3 How an MCP `isError: true` result surfaces through `mcpClient.tools()`

The `[auth]` refresh-and-respawn path (§3.4) needs to *detect* an auth failure. Unknown
whether `@ai-sdk/mcp` turns an MCP error result into a thrown tool error the loop can
catch, or into plain text the model merely reads. If the latter, the discovered tools need
a thin wrapper that inspects each result before returning it.

Best resolved empirically on first run rather than designed around. Note that
`smoke.test.ts` pins the server side of this: an error result has
`isError: true`, `structuredContent` **undefined**, and a `content[0].text` prefixed
`[auth]` / `[notFound]` / `[argument]` / `[upstream]`.

### 5.4 Whether `/reset` alone is enough session control

`/reset` clears history. Possibly also wanted: `/history` to print it, `/raw <tool> <json>`
to call a tool directly and bypass the model, `/login` to force re-authentication. All
additive; none blocking.

---

## 6. Success criteria

The feature is done when:

1. `npm run agent` signs a user in via a link printed on the CLI, spawns the server, and
   answers a natural-language catalogue question against non-production GMA.
2. A partial (HTTP 206) upstream result causes the **caveat to reach the human in the
   final natural-language turn** — with a minimal system prompt, i.e. driven by the
   server's own tool descriptions.
3. A multi-candidate match causes the agent to **present all candidates and ask**, never
   to pick one.
4. A missing required env var produces a message naming the variable, in the agent,
   before the child is spawned.
5. An expired Okta token mid-session is recovered transparently, with history intact.
6. `npm test` is **byte-for-byte the same suite it is today**, with the same thresholds.
7. `npm run test:agent` passes all three suites.
8. No file under `src/` has changed.
