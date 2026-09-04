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

| Variable                | Required   | Default | Notes                                                                                                                                 |
| ----------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GMA_BASE_URL`          | yes        | —       | Which GMA to call. Deliberately **not** a tool argument: environment selection is deployment's job, never the agent's                 |
| `GMA_DEFAULT_INSTANCES` | yes        | —       | Comma-separated codes used when a tool supplies no `instances`                                                                        |
| `OKTA_ISSUER`           | yes        | —       | GMA's issuer is a **per-environment** authorization server, so a token is valid against exactly one GMA environment. Never widen this |
| `GMA_TIMEOUT_MS`        | no         | `30000` | Per-request timeout                                                                                                                   |
| `GMA_MAX_CANDIDATES`    | no         | `25`    | Above this match count, a search reports `tooBroad`                                                                                   |
| `LOG_LEVEL`             | no         | `info`  | `debug` \| `info` \| `warn` \| `error`                                                                                                |
| `GMA_USER_TOKEN`        | stdio only | —       | The operator's token. stdio has no HTTP request to carry a bearer, so it comes from the environment — **development only**            |

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

### One thing to be precise about

GMA's fine-grained field-level filtering (GAHS) is **switched off in every deployed environment**,
verified 2026-09-03. This server must therefore **not** be described as delivering per-user
field-level filtering. It delivers exactly the authorization GMA enforces, which today is
group-level. Pass-through means it will deliver field-level filtering unchanged if that is ever
enabled — and no change to this server will be needed, or permitted, to compensate for it.
