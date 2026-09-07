# GMA MCP Server

An MCP server that exposes a small, curated set of **GMA (GBP Management API) catalogue tools**
to AI agents, so an agent can answer catalogue questions on behalf of a human operator without
knowing GMA's structure.

Two properties define this server, and both are non-negotiable:

1. **The operator's identity is passed through unaltered.** The server holds no credentials of
   its own, mints nothing, caches nothing. GMA's own authorization therefore applies to the real
   human, not to a shared service identity.
2. **No result can be mistaken for complete when it is not.** GMA assembles one answer from
   several brand instances, any of which may fail independently. Every result therefore carries a
   structured `completeness` verdict — present even on full success — and every tool description
   instructs the agent to relay a caveat to the user. A confidently-wrong "here is the full
   catalogue" built from three of five instances is worse than an error.

Governance lives in [`.specify/memory/constitution.md`](./.specify/memory/constitution.md); the
feature specification is in [`specs/001-catalogue-mcp-tools/`](./specs/001-catalogue-mcp-tools/).

## The three tools

The surface is hand-curated, never generated from GMA's API. Three tools, deliberately.

### `list_instances`

Lists the brand instances (`PP`, `BF`, …) that queries can be scoped to, so an agent never has to
guess or hardcode a code.

**Input**: none. **Output**: `{ instances: [{ code, id, name }], completeness }`.

### `find_catalogue_entity`

The main capability. Finds a catalogue entity by partial, case-insensitive name and returns it
**with its immediate children** (one level).

**Input**: `{ name, instances? }`. **Output** is discriminated on `kind`:

| `kind`       | Meaning                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `resolved`   | Exactly one match — returned with `children`, one level down                              |
| `candidates` | Several matched. **All** are returned and **none** is chosen; the agent must ask the user |
| `none`       | Nothing matched. This is not an error                                                     |
| `tooBroad`   | Too many matched to be useful — returns `matchCount` and `narrowBy`                       |

"Never collapse several plausible answers into one" is enforced by the type system: `resolved` and
`candidates` are variants of a discriminated union, so a result carrying both is unrepresentable
rather than merely discouraged.

### `get_catalogue_entity`

Retrieves an entity by `type` and `id` — typically an id a human picked from a `candidates` list.

**Input**: `{ type: 'superclass' | 'subclass' | 'eventType', id, instances? }`.
**Output**: `{ entity, completeness }`.

## Which upstream generation answers

GMA publishes **two current** catalogue generations, v4 and v5. Neither has a deprecated
operation, and upstream's own documentation treats both as current.

**v4 is the default.** v5 is reached only where a capability declares a per-operation requirement
for it, and that requirement is checked **at startup**: an operation a capability needs on a
generation that does not offer it makes the process refuse to start, naming the capability, the
operation, and the generations that do offer it. There is deliberately **no fallback** — a
try-v4-then-v5 design emits a request that really fails, pollutes upstream error metrics, and makes
a configuration mistake indistinguishable from an outage.

Exactly one such requirement exists today: **v4 has no by-name search of any kind**, so
`find_catalogue_entity` searches on v5 while listing children on the v4 default. One tool call, two
generations, one aggregated completeness verdict. That is why requirements are declared per
**operation** rather than per capability — a capability-wide pin would drag the child listing onto
v5 too and defeat the point for the tool that matters most.

None of this is visible to the model. No tool schema, description, or output mentions a generation,
a version, or a path, and an agent cannot select one: the choice is the operator's, made once via
`GMA_CATALOGUE_GENERATION`. Diagnostics do carry it — every upstream call logs
`generation=v4`/`v5` alongside the logical `operation` id — so an operator can always tell which
generation answered.

`core/surface.ts` is the single place any of this lives: one table of the six logical operations,
which generations offer each, and each one's path template. Tools hold pre-resolved handles and
therefore **cannot** name a path or a generation, which an architecture test enforces by asserting
no versioned path literal exists anywhere else.

## Running it locally

Requires **Node.js 22 LTS**.

```bash
npm install
cp .env.example .env      # then fill in the values
npm run build
npm run dev               # stdio transport
```

To drive it by hand:

```bash
export GMA_USER_TOKEN="<your OKTA access token>"
npx @modelcontextprotocol/inspector node dist/index.js
```

### Environment configuration

Every operational value comes from the environment. None may be supplied by an agent, and none is
embedded in the build. **Missing required configuration makes the process refuse to start** rather
than fail at the first request.

| Variable                   | Required   | Default | Notes                                                                                                                                                     |
| -------------------------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GMA_BASE_URL`             | yes        | —       | Which GMA to call. Deliberately **not** a tool argument: environment selection is deployment's job, never the agent's                                     |
| `GMA_DEFAULT_INSTANCES`    | yes        | —       | Comma-separated codes used when a tool supplies no `instances`                                                                                            |
| `OKTA_ISSUER`              | yes        | —       | GMA's issuer is a **per-environment** authorization server, so a token is valid against exactly one GMA environment. Never widen this                     |
| `GMA_TIMEOUT_MS`           | no         | `30000` | Per-request timeout                                                                                                                                       |
| `GMA_MAX_CANDIDATES`       | no         | `25`    | Above this match count, a search reports `tooBroad`                                                                                                       |
| `GMA_CATALOGUE_GENERATION` | no         | `v4`    | Which upstream catalogue generation answers: `v4` or `v5`. An unrecognised value refuses startup rather than defaulting silently. Never an agent argument |
| `LOG_LEVEL`                | no         | `info`  | `debug` \| `info` \| `warn` \| `error`                                                                                                                    |
| `GMA_USER_TOKEN`           | stdio only | —       | The operator's token. stdio has no HTTP request to carry a bearer, so it comes from the environment — **development only**                                |

## Trying it with an agent

`npm run agent` starts a local conversational harness that spawns this server over stdio,
discovers its three capabilities at runtime, and drives them with a Bedrock-hosted model. Ask a
question in English and watch which capability the model chose and what arguments it passed.

```bash
npm run agent              # ask questions; /help lists the commands
npm run agent -- --verbose # additionally echo the server's own diagnostics live
```

It needs the three server variables above, plus `AWS_REGION` and AWS credentials with access to at
least one Bedrock Claude model. Either paste a token into `GMA_USER_TOKEN` or set `OKTA_CLIENT_ID`
and sign in from the terminal by opening a link. `AGENT_MODEL_ID` overrides the model when the
default is not one the AWS account can invoke. `.env.example` documents all of them.

```bash
npm run test:agent  # the harness's own suites (builds dist/ first — it spawns a real child)
npm run test:all    # both suites
```

**Why it exists.** `test/protocol/smoke.test.ts` proves a tool _result_ carries its `completeness`
verdict. It cannot prove that a real model, reading the real tool descriptions, **relays that
caveat to a human** or **declines to choose between ambiguous candidates**. Those are properties of
the final natural-language turn, and the harness is the only thing that exercises them. Its system
prompt is deliberately minimal and says nothing about caveats or candidates, so what gets measured
is the adequacy of _this server's_ tool descriptions rather than the harness's coaching.

Both verifications are **manual** — a real model is non-deterministic, costs tokens per run, and
would need AWS credentials in CI, the same reasons live GMA stays out of the suite. The procedure
is in
[`specs/002-local-cli-agent/quickstart.md`](./specs/002-local-cli-agent/quickstart.md). If either
fails, that is a finding about the tool descriptions under `src/domains/catalogue/**` — **not** a
reason to add caveat instructions to the harness prompt, which would make the output look correct
while hiding an inadequacy a third-party agent would hit in production.

The harness lives in `agent/`, **outside** the constitutional gates that govern `src/` — see
[_Scope of this slice_](#scope-of-this-slice--read-before-extending).

## Testing

```bash
npm test              # unit + integration + MCP protocol smoke
npm run test:coverage # enforces the constitutional coverage gates
npm run lint          # ESLint (incl. the module-boundary rule) + Prettier
```

The suite is entirely offline: it runs against a fixture library and a mocked GMA, because partial
failure and timeouts cannot be provoked on demand against a live BFF. Coverage thresholds
(≥90% line / ≥85% branch overall, ≥95% line for `core/`) are constitutional and **fail the
build** — a shortfall is fixed with tests, never by lowering a threshold.

- [`test/MUST-COVER.md`](./test/MUST-COVER.md) — the blocking must-cover matrix, mapping each
  required case to the test that names it
- [`test/fixtures/README.md`](./test/fixtures/README.md) — fixture provenance; all are
  hand-crafted from the OpenAPI schema, and say so

Live GMA validation is a **manual, pre-release step** and never part of CI: it needs a human token
and cannot force failure modes. See
[`specs/001-catalogue-mcp-tools/quickstart.md`](./specs/001-catalogue-mcp-tools/quickstart.md).

## Layout

```text
src/
├── index.ts              # entrypoint — validates config, then starts stdio
├── server/
│   ├── register.ts       # transport-agnostic tool registration
│   ├── stdio.ts          # stdio wiring (thin, by design)
│   └── health.ts         # identity-free health signal
├── core/                 # SHARED — must not import from domains/
│   ├── config.ts         # env config + fail-fast startup validation
│   ├── surface.ts        # the ONLY place an upstream path or generation appears
│   ├── identity.ts       # per-invocation token extraction; no globals
│   ├── gmaClient.ts      # typed GMA calls; forwards token + traceparent
│   ├── completeness.ts   # HTTP outcome → verdict; multi-hop aggregation
│   ├── errors.ts         # the single HTTP/transport → ToolError mapping
│   └── telemetry.ts      # tracing + allowlist logger
└── domains/catalogue/    # the three tools, their schemas, and traversal
```

Two boundaries are enforced by machinery rather than by reviewer vigilance, because a rule that
can be forgotten will be:

- **`eslint-rules/module-boundaries.js`** fails the build if `core/` imports from `domains/`, or
  if one domain imports another. It resolves each import against the file's real path, so a
  relative path with no literal `domains` segment cannot slip past it.
- **The logger uses a field allowlist, not a redaction denylist** (`core/telemetry.ts`). An
  unlisted field is never emitted, so a new field cannot leak by being forgotten. Span attributes
  go through the same allowlist, since a span is as much an egress path as a log line.

## Scope of this slice — read before extending

Deliberately **out of scope**, each deferred with a reason recorded in the spec:

- **Remote/HTTP transport** and the MCP OAuth resource-server handshake. stdio only for now. The
  swap is additive: tools are registered independently of transport, and identity is already
  per-invocation — which is the one part that would _not_ have been additive if deferred. Two
  concurrent identities in one process are already asserted not to bleed
  (`test/integration/identityIsolation.test.ts`).
- **Deployment to any shared environment.** This slice is done when it runs on a developer
  machine against non-production GMA with the suite green.
- **The organisation's Prefab scaffold.** Explicitly deferred while development is local-only —
  nothing is deployed, so its pipeline/TLS/monitoring value is unrealised. It remains a **blocking
  prerequisite for any non-local deployment** (`TODO(PREFAB_MIGRATION)`). What keeps that
  affordable is that env-config discipline is kept regardless, so adoption later is a
  configuration exercise rather than a rewrite.
- **Traversal deeper than one level**, and **any fourth tool**. Expanding the surface is governed
  by the constitution's Principle IV, not by convenience.
- **The `agent/` harness is a local development tool, not part of the delivered service.** It lives
  outside the source tree the architecture and coverage gates govern, is never deployed, and none
  of its dependencies ship: nothing in `agent/` carries the guarantees `src/` does, and the
  server's own `npm test` and its coverage thresholds are unchanged by it.

### One thing to be precise about

GMA's fine-grained field-level filtering (GAHS) is **switched off in every deployed environment**,
verified 2026-09-03. This server must therefore **not** be described as delivering per-user
field-level filtering. It delivers exactly the authorization GMA enforces, which today is
group-level. Pass-through means it will deliver field-level filtering unchanged if that is ever
enabled — and no change to this server will be needed, or permitted, to compensate for it.
