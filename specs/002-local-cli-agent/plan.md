# Implementation Plan: Local CLI Agent Harness

**Branch**: `002-local-cli-agent` | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-local-cli-agent/spec.md`

**Design record**: `docs/agent-cli-brief.md` — settled decisions, read as an input. Three factual
corrections to it are recorded in [research.md](./research.md) (see its closing table).

---

## Summary

Build a conversational command-line harness that spawns the existing catalogue MCP server as a
child process over stdio, discovers its three capabilities at runtime, and drives them with a
Bedrock-hosted model so an engineer can ask catalogue questions in English and watch which
capability the model chose.

The point is not convenience. `test/protocol/smoke.test.ts` proves a tool *result* carries its
`completeness` verdict; it cannot prove that a real model, reading the real tool descriptions,
**relays that caveat to a human** or **declines to pick between candidates**. Those are properties
of the final natural-language turn, and nothing exercises them today. The harness does — and it
does so with a deliberately minimal system prompt (FR-008), so what is being measured is the
adequacy of the server's own descriptions rather than the harness's coaching.

**Technical approach**: a new top-level `agent/` directory, outside the source tree the
architecture and coverage gates govern. `ai@^7`'s `streamText` drives the loop; `@ai-sdk/mcp`
discovers the tool set; `@modelcontextprotocol/sdk`'s `StdioClientTransport` spawns the child —
chosen over the AI SDK's own stdio transport because only it exposes the child's stderr, which
FR-012 requires (research.md R1). Credentials resolve by precedence, with an Okta device
authorization grant as the interactive path and the existing `GMA_USER_TOKEN` as a
separately-shippable fallback (FR-033). No file under `src/` changes.

---

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js 22 (`>=22.0.0 <23`, per `package.json` engines).
`process.loadEnvFile()` — a Node 22 builtin — removes any need for a dotenv dependency.

**Primary Dependencies** (all resolved and version-verified in research.md R5):

| Package | Version | Role |
| --- | --- | --- |
| `ai` | `^7.0.93` | `streamText`, `stopWhen`, `fullStream` |
| `@ai-sdk/mcp` | `^2.0.45` | `createMCPClient`, `client.tools()` — runtime schema discovery |
| `@ai-sdk/amazon-bedrock` | `^5.0.76` | `amazonBedrock` provider (note: **not** `bedrock`) |
| `@modelcontextprotocol/sdk` | `^1.30.0` *(existing)* | `StdioClientTransport` — spawn + stderr access |
| `zod` | `^4.5.4` *(existing)* | Satisfies all three peers (`^3.25.76 \|\| ^4.1.8`) |

All three new packages pin `@ai-sdk/provider@4.0.10` and `@ai-sdk/provider-utils@5.0.36`
exactly — a matched set. They are **devDependencies**: the harness is not part of the served
artefact (FR-034).

**Storage**: `~/.gma-agent/token.json`, mode `0600` — outside the repository so FR-020's
"impossible to commit" holds structurally. Conversation history is in-memory only, per session.

**Testing**: `vitest@^5` via `agent/vitest.config.ts` — separate config, own `include` glob,
**no coverage thresholds**. `msw@^2.15` (existing devDependency) for the device-flow suite.
`npm test` remains byte-for-byte unchanged (FR-026, SC-011).

**Target Platform**: developer machine, macOS or Linux. Not deployed (FR-032, FR-034).

**Project Type**: local CLI development harness driving an existing MCP server over stdio.

**Performance Goals**: startup — sign-in reported, child spawned, three capabilities discovered
— in under 10 seconds (Story 1 AC-1); clean checkout to first answer under two minutes (SC-001).
Model latency is the provider's, not ours.

**Constraints**:

- **No file under `src/` may change** (FR-025, SC-012). This is the binding constraint.
- `npm test` and its coverage thresholds unchanged (FR-026, SC-011).
- Model identifier from configuration, never hardcoded (FR-009); `OKTA_CLIENT_ID` likewise
  (FR-021).
- AWS credentials **never** reach the child (FR-011, verified by test).
- Zero credential material in any output, any mode, any failure path (FR-014, SC-008).
- One retry maximum on auth recovery (FR-023) — a persistent failure must not loop.

**Scale/Scope**: one engineer, one session, one child process. ~10 source files under `agent/`,
three test suites. No concurrency beyond the child process itself.

**Open clarification**: FR-035 (which interactive commands beyond clear/exit/help). The design
puts command dispatch behind one seam, so each is an independent addition —
**the plan does not depend on the answer** (research.md R11).

---

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1 — see the bottom of this section.*

Assessed against `.specify/memory/constitution.md` v1.0.2. The harness is an MCP **client**, so
several principles govern it only indirectly; each is assessed on what it actually constrains
here rather than waved through.

| Principle | Applies? | Assessment |
| --- | --- | --- |
| **I. Pass-Through Identity** (NON-NEGOTIABLE) | **Yes — directly** | ✅ The harness obtains the *human's own* credential and passes it through unaltered. It mints no service identity and holds no credential of its own for GMA. The device grant produces a token for the engineer, under the same per-environment authorization server the server is configured to accept (FR-017). The precedence ladder (FR-015) mirrors `core/identity.ts`: transport/env-supplied identity outranks anything cached. **The one novel act is caching** — see the Complexity Tracking entry below, which is why it is recorded rather than assumed benign. |
| **II. Mandatory Completeness Caveat** (NON-NEGOTIABLE) | **Yes — this feature exists to test it** | ✅ The harness adds no completeness logic and constructs no verdict; it consumes them. FR-008 forbids the harness from restating the caveat rule, so SC-002 measures the server's descriptions. This is the strongest possible alignment: the feature is an instrument for the principle. |
| **III. Modular Boundaries** | Indirectly | ✅ Nothing under `src/` changes, so no `core → domain` or `domain → domain` import can be introduced. `agent/` imports **only** the MCP SDK's client transport — never `src/core/**` or `src/domains/**`. Enforced by an architecture test in suite C (see below). |
| **IV. Curated Task-Oriented Tools** | Indirectly | ✅ The tool surface is discovered, not declared (FR-003), so the harness cannot expand or reshape it. It cannot collapse candidates either — that judgement stays with the model and the human, which SC-003 verifies. |
| **V. Config-Driven Ops & Safe Observability** | **Yes — directly** | ✅ Every operational value comes from the environment: `OKTA_CLIENT_ID`, `AGENT_MODEL_ID`, AWS region/credentials, plus the three the child needs. Nothing hardcoded (FR-021). Missing values fail fast **before** the child is spawned (FR-010) — stricter than the principle asks. No credential in any log line (FR-014). ⚠️ One deliberate deviation: Okta endpoint paths are derived from the configured `OKTA_ISSUER`, but the harness will contain `/v1/device/authorize` and `/v1/token` **path** literals. Those are RFC-8628/Okta protocol constants, not operational values — no host is ever hardcoded. Recorded in Complexity Tracking. |
| **Development Workflow & Quality Gates** | **Yes — directly** | ✅ Fixture-driven where fixtures are the only way to force a state (device-flow error codes, research.md R10). Must-cover cases named per test. **Coverage gates untouched**: `agent/**` is excluded from `src/` coverage and carries no thresholds of its own, so `npm test` stays exactly what the constitution describes (SC-011). ✅ Live Bedrock stays out of CI (FR-028), matching the constitution's own reasoning about live GMA. |
| **Technology & Platform Constraints** | Yes | ✅ TypeScript. stdio, which the constitution designates "for local development and debugging only" — exactly this use. GMA is reached only through the existing server; the harness never calls GMA directly. ✅ `TODO(PREFAB_MIGRATION)` untouched (FR-032): nothing is deployed, so the deferral is unaffected. |

**Gate result: PASS**, with two deviations recorded in Complexity Tracking below. Neither
weakens a NON-NEGOTIABLE principle, and neither requires an amendment.

### One point worth stating plainly

The constitution's gates apply to `src/`. Placing the harness in `agent/` is **not** a way to
escape them — it is the only option that leaves them provable. `test/unit/architecture.test.ts`
asserts, among other things, that `process.env` is read in *exactly* two files, as a sorted-list
equality (line 54). An interactive REPL needs a third reader, terminal output, module-level
mutable state, and an Okta URL — five violations (research.md R6). The alternatives were to
add five exemptions to a test whose value is that it has none, or to amend the constitution to
accommodate a development tool. Both invert the priority the constitution sets: it "supersedes
ad hoc practice, prior informal agreements, and convenience."

What keeps this honest rather than convenient is FR-030: the documentation must record that the
harness lives outside the constitutional guarantees, so no reader mistakes it for part of the
service.

### Post-Phase-1 re-check

Re-evaluated after `data-model.md`, `contracts/`, and `quickstart.md`. **Still PASS.** The Phase 1
design introduced no new principle interaction:

- No new dependency on `src/` — the contract surface is the discovered tool set plus the child's
  documented exit behaviour, both existing.
- The credential store's shape (data-model.md) confirms the Principle I deviation is bounded to
  the harness's own file and never touches the server's audited input set.
- `quickstart.md`'s manual procedure is what discharges SC-002 and SC-003 outside CI, consistent
  with the constitution's live-GMA stance.

---

## Project Structure

### Documentation (this feature)

```text
specs/002-local-cli-agent/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — 11 findings, all unknowns resolved
├── data-model.md        # Phase 1 — entities, states, validation
├── quickstart.md        # Phase 1 — run + manual verification of SC-002/SC-003
├── contracts/
│   ├── cli.md           # Command-line surface, interactive commands, exit codes
│   ├── config.md        # Every environment variable, validation, forwarding rules
│   └── child-process.md # Spawn contract: env allowlist, stderr, exit codes
├── checklists/
│   └── requirements.md  # Spec quality checklist (15/16; FR-035 open)
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
gma-mcp-server-poc/
├── src/                          # UNCHANGED — gates unchanged (FR-025, SC-012)
├── test/                         # UNCHANGED — npm test byte-identical (FR-026, SC-011)
├── agent/                        # NEW — outside the constitutional fence
│   ├── main.ts                   # Entrypoint. loadEnvFile() FIRST, before any import
│   │                             #   that reads env at module scope.
│   ├── config.ts                 # Validate agent + child config; fail before spawn (FR-010)
│   ├── auth/
│   │   ├── resolve.ts            # Precedence ladder (FR-015) — pure, injected clock + fetch
│   │   ├── deviceFlow.ts         # RFC 8628 poll state machine (FR-017, FR-018)
│   │   └── store.ts              # ~/.gma-agent/token.json, 0600, issuer check (FR-019, FR-020)
│   ├── mcp/
│   │   ├── spawn.ts              # StdioClientTransport + env allowlist + stderr ring buffer
│   │   └── session.ts            # Spawn/teardown/respawn lifecycle (FR-023)
│   ├── repl/
│   │   ├── loop.ts               # streamText turn loop; trace lines from fullStream (FR-005)
│   │   ├── commands.ts           # Command dispatch seam — clear/exit/help (FR-035 open)
│   │   └── render.ts             # ALL terminal output. Single credential-redaction chokepoint
│   ├── prompt.ts                 # The minimal system prompt (FR-008) — kept alone and small
│   ├── tsconfig.json             # extends ../tsconfig.json; rootDir agent, outDir dist-agent
│   ├── vitest.config.ts          # own include glob; NO coverage thresholds (FR-026)
│   └── test/
│       ├── authResolve.test.ts   # Suite A — precedence, foreign-issuer rejection, 0600
│       ├── deviceFlow.test.ts    # Suite B — pending/slow_down/denied/expired via msw
│       ├── spawn.test.ts         # Suite C — real child, 3 tools, exit 78, env allowlist
│       └── architecture.test.ts  # agent/ imports nothing from src/ (Principle III)
└── dist-agent/                   # Build output — gitignored
```

**Structure Decision**: a new top-level `agent/`, excluded from the root `tsconfig` (`exclude`
gains `agent`, `dist-agent`), from ESLint's ignore list (`dist-agent`), and from vitest coverage
(`agent/**`). Justified in full at research.md R6 and in the Constitution Check above.

Three placements inside `agent/` are load-bearing rather than cosmetic:

- **`render.ts` owns every write to the terminal.** FR-014 and SC-008 demand zero credential
  material in any output, in any mode, including failure paths. That is provable with one
  chokepoint and unprovable with output scattered across ten files. The redaction is an
  allowlist, matching the reasoning already used in `src/core/errors.ts`'s `safeUpstreamDetail`.
- **`prompt.ts` holds the system prompt alone.** FR-008 forbids restating the caveat and
  non-selection rules. Keeping it in its own small file makes a violation visible in review and
  assertable by a test — if it grows, someone is coaching the model and SC-002 stops measuring
  the server.
- **`auth/resolve.ts` is pure, with injected clock and `fetch`.** That is what makes suite A run
  with no network and no real Okta, per FR-027.

---

## Phase 0 — Research (complete)

See [research.md](./research.md). Eleven findings; every Technical Context unknown resolved, and
all three of the brief's open questions settled — two by reading installed source rather than
deferring to first run.

Headlines:

- **R1** — the AI SDK's stdio transport cannot expose the child's stderr (its `process` field is
  private, no accessor). Use the MCP SDK's `StdioClientTransport`, which has a `stderr` getter,
  and pass it as a custom transport — accepted because `isCustomMcpTransport` checks structurally
  for `start`/`send`/`close`. **This changes which package spawns the child.**
- **R2** — resolves brief §5.3: an MCP `isError` result is **returned, not thrown**
  (`mcp-client.ts:1262`). The model reads it as text; the agent must inspect it to drive
  auth recovery. No tool wrapper needed — the stream already carries results.
- **R3** — resolves brief §5.2: default to `us.anthropic.claude-sonnet-5`. The brief's dated id
  is valid but previous-generation.
- **R4** — confirms the env-stripping claim: `DEFAULT_INHERITED_ENV_VARS` is
  `['HOME','LOGNAME','PATH','SHELL','TERM','USER']` in **both** candidate transports.
- **R9** — a child's environment is immutable after spawn and stdio carries no per-request
  identity channel (`core/identity.ts:115-125`), so respawn is the *only* mechanism for token
  rotation. Not a design preference.

---

## Phase 1 — Design & Contracts (complete)

- **[data-model.md](./data-model.md)** — six entities with fields, validation rules, and the two
  state machines that matter (device-flow polling; session lifecycle including auth recovery).
- **[contracts/cli.md](./contracts/cli.md)** — the command-line surface: invocation, flags,
  interactive commands, trace-line format, exit codes.
- **[contracts/config.md](./contracts/config.md)** — every environment variable: required or not,
  default, validated by whom, and **whether it is forwarded to the child**. The forwarding column
  is the FR-011 contract.
- **[contracts/child-process.md](./contracts/child-process.md)** — the spawn contract: exact env
  allowlist, stderr handling, and the child's documented exit codes (`78` = config, per
  `src/index.ts:31`).
- **[quickstart.md](./quickstart.md)** — setup, run, the three automated suites, and the **manual
  procedure discharging SC-002 and SC-003** — the two criteria FR-028 deliberately keeps out of
  automation.

---

## Complexity Tracking

Two deliberate deviations. Both are recorded per the constitution's compliance-review rule
("A deliberate, temporary deviation MUST be recorded ... with an owner and a removal condition"),
and neither weakens a NON-NEGOTIABLE principle.

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| **The harness caches a token to disk** (`~/.gma-agent/token.json`), where Principle I says the *server* "MUST NOT mint, exchange, cache, or persist tokens" | Principle I binds the **server**, whose audited input set is the point of `core/config.ts`. The harness is the *client* — it stands in for the human, and a client that re-authenticates every hour with no cache makes FR-023's mid-session recovery impossible (a refresh token must persist to be used). The server still holds nothing. | **No cache, device login every session**: forfeits refresh entirely, so an expiring credential ends the session and Story 5 cannot be built. **In-memory only**: survives no restart, so an engineer re-authenticates on every `npm run agent`. Bounded by: the file lives outside the repo, is `0600`, records its issuer, and is rejected on mismatch (FR-019). **Removal condition**: none — this is inherent to a CLI client. It is recorded because "the client may cache" is a real distinction from "the server may not", and that distinction should be explicit rather than assumed. |
| **Okta endpoint path literals** (`/v1/device/authorize`, `/v1/token`) in `agent/auth/deviceFlow.ts`, where Principle V forbids hardcoded operational values | These are RFC 8628 / Okta **protocol** constants, not operational values — they are identical in every environment. The operational part, the host and authorization-server id, comes from `OKTA_ISSUER` and is never hardcoded. The architecture test's rule (no `https://` literal) is honoured: no host appears in `agent/` either. | **Two more env vars for the paths**: configuration noise for values that never differ, and a misconfiguration surface where none need exist. **Fetch Okta's `.well-known` discovery document**: correct and arguably better, but adds a network round-trip and a failure mode before login, for a path pair that is fixed by specification. **Removal condition**: adopt discovery if a GMA environment ever presents non-standard endpoint paths. |

---

## What could still go wrong

Stated plainly, because a plan that claims no residual risk is not being honest about a feature
whose whole purpose is to discover something.

1. **The two contracts may fail.** SC-002 and SC-003 might not hold — the model may drop the
   caveat or pick a candidate. **That is a finding, not a plan defect.** FR-008 exists to make the
   result attributable to the server's tool descriptions. If it fails, the fix is in
   `src/domains/catalogue/**` descriptions and must be escalated, not patched by coaching the
   harness prompt (which FR-025 forbids anyway).
2. **The device-grant Okta app does not exist.** FR-033 makes the two credential paths
   independently shippable precisely so this cannot block the feature. Stories 1–3 — including
   both contract tests — need only `GMA_USER_TOKEN`.
3. **`@ai-sdk/mcp@2.x` ↔ `ai@7.x` pairing is by convention**, not by declared peer dependency
   (research.md R5, marked UNVERIFIED). A mismatch surfaces at type-check, not at runtime, and is
   a version bump to fix.
4. **Bedrock model access may 403.** By design this is a configuration fix (FR-009, SC-014). The
   failure message must name `AGENT_MODEL_ID`.
