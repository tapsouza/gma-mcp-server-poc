# GMA MCP Server — Implementation Plan

> A standalone Model Context Protocol (MCP) server that exposes GMA's capabilities
> to AI agents. GMA (GBP Management API) is the BFF frontdoor to ~15 back-end
> services; this MCP server becomes *another consumer* of that frontdoor — the way
> the front-end is — so future projects and agents can rely on GMA data without
> re-implementing GMA plumbing.

This document is the output of a design interview. It captures **every decision**,
**why**, and a **step-by-step implementation path**. It is scoped to a thin v1
vertical slice (catalogue search + retrieve) that proves the whole pipeline
end-to-end, then templatises for growth.

---

## 1. Design decisions (the whole tree, resolved)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Topology | **Standalone server**, GMA as HTTP client | GMA is a BFF; the MCP server is just another HTTP consumer. Keeps GMA's build (Jacoco 95% line, Checkstyle, PMD) uncontaminated; independent deploy/scaling; free choice of language. |
| 2 | Transport | **Both, HTTP-first** (Streamable HTTP for prod, stdio for local dev) | Remote HTTP serves the "single source many consumers" goal; stdio is ~free with the SDK and invaluable for local dev/debug. |
| 3 | Internal structure | **Modular monolith**: `core` + domain modules; per-domain MCP endpoints | One thing to build/deploy/operate with a shared auth+client layer, while each *agent* sees a small, coherent tool list. |
| 4 | Identity model | **Pass-through**, human-in-the-loop first | GMA does per-user field-stripping via GAHS. A service account would break that. Pass-through preserves GMA's entire authz model with zero GMA change. |
| 5 | Token transport (HTTP) | **Standard MCP OAuth** (server = resource server) | Spec-blessed, keeps the server stateless/credential-free, future MCP hosts "just work". |
| 6 | Tool strategy | **Curated, task-oriented** tools | Small, LLM-friendly tool surface. Auto-generating all of GMA's API would flood tool-selection and leak HTTP shape at the model. |
| 7 | Tool ↔ GMA mapping | **Task-oriented** (collapse calls) with **hybrid resolve-or-disambiguate** | Ergonomic for agents; the discipline below keeps it safe. |
| 8 | GMA client | **Envelope-aware** | Parses GMA's `status` envelope (per-instance success/failure) so partial data is never presented as complete. |
| 9 | Status mapping | Partial = **result + structured caveat**; `BAD_REQUEST`/`FAILURE` = tool error; `401` = flagged auth error | Multi-instance partial failure is normal operation for a BFF, not an error — but the caveat must be unmissable. |
| 10 | Language | **TypeScript** | MCP spec is TS-first, best Streamable-HTTP support; owned by a TS team; no value in sharing Java DTOs (we deliberately hide them). |
| 11 | Environment routing | **Env-config** (one deploy per GMA env); GMA base URL never a tool arg | Agents must not choose prod-vs-QA; it's an operational concern. Uses the org's existing per-brand deployment config convention. |
| 12 | Instances param | **Config default + optional per-tool override + `list_instances` tool** | Naive queries just work; power users narrow; agents can discover valid brand codes. |
| 13 | Observability | **OTel-instrumented**; propagate `traceparent` to GMA | GMA already runs Micrometer + OpenTelemetry (OTLP), so trace correlation is free. |
| 14 | Testing | **Unit + mocked-GMA integration** + thin **MCP-protocol smoke**; live-GMA manual | Correctness-critical logic (resolution, disambiguation, caveat) is deterministically testable against fixtures covering every status code. |
| 15 | Repo & scaffold | **New repo**, scaffolded via **Prefab TS template** | Consistent with standalone/TS-team/env-config decisions; inherits org pipeline, TLS, monitoring. |
| 16 | v1 surface | **v4/v5 `api_catalogue.yaml`** (avoid deprecated `search.yaml` market ops) | README flags v4/v5 as the current catalogue surface; don't build new tools on `deprecated: true` endpoints. |
| 17 | v1 tools | **3 tools**: `list_instances`, `find_catalogue_entity`, `get_catalogue_entity` | Small, coherent, proves the full pipeline without flooding the model. |

### Architectural invariants (hard rules, not conventions)

1. **`core` never imports a domain; domains never import each other.** Shared logic
   lives in `core`. This keeps a future "split to separate deployables" a mechanical
   day-long extraction rather than a rewrite. (We are *not* planning to split — but
   the invariant costs nothing and preserves the option.)
2. **A tool may collapse multiple GMA calls into one, but never multiple plausible
   answers into one.** Traversal is the tool's job; judgment stays with the model/human.
3. **The data-completeness caveat is a mandatory, structured, top-level field on
   every tool result** — never prose-only, never omitted.
4. **All environment/brand-specific values come from deployment env-config** — never
   hardcoded, never agent-supplied for operational values (base URL, default instances,
   OKTA config, timeouts).
5. **Never log the token or PII.** Identity travels as the user's bearer; logs get
   status codes and resolution outcomes, not credentials.

---

## 2. How GMA works (the constraints that shaped this)

Verified by reading the GMA codebase:

- **Auth**: Spring `oauth2ResourceServer().jwt()`. JWT is validated for **issuer**
  (`spring.security.oauth2.resourceserver.jwt.issuer-uri=https://flutteruki.okta.com`)
  and signature/expiry. **No audience validator** is configured. Access requires a
  `groups` claim containing the configured `authority.group` (default `PPB`).
  → *Raw pass-through of a same-issuer, valid-group user token works without token
  exchange.* (`SecurityFilterFactory.java`, `JwtAuthoritiesConverter.java`.)
- **Identity**: username is read from the JWT `name` claim
  (`JwtAuthenticationExtractor.java`).
- **Fine-grained authz (GAHS)**: for every request, GMA forwards the **raw token**
  (`source.getTokenValue()`) to GAHS and **strips** fields the user can't see/edit —
  it never returns 403. Pass-through naturally satisfies GAHS (same bearer forwarded).
  → *The MCP server does NOT try to detect stripping; the agent correctly sees exactly
  what the human user is entitled to.*
- **Multi-instance aggregation**: catalogue responses are "aggregated by instance" and
  wrapped in a `status` envelope:

  ```yaml
  status:
    code: SUCCESS | PARTIAL_SUCCESS | FAILURE | TOO_MANY_EVENTS | REQUEST_TIMEOUT | BAD_REQUEST
    successfulInstances: [ ... ]
    failedInstances:     [ ... ]
  # plus Error { instance, message }
  ```

  → *This is the machine-readable partial-failure contract the client parses.*
- **Tracing**: GMA already uses **Micrometer Tracing + OpenTelemetry (OTLP)** and a
  `request.id` MDC key. → *If the MCP server emits standard W3C `traceparent`, GMA
  continues the trace natively — no GMA change.*
- **v1 surface (v5 `api_catalogue.yaml`)** operations the v1 tools map onto:
  - `GET /v5/instances` (`searchInstances`)
  - `POST /v5/searchByName` (`searchByName`) — case-insensitive name substring over
    superclass / subclass / event type
  - `GET /v5/superclasses/{id}` · `GET /v5/subclasses/{id}` · `GET /v5/eventTypes/{id}`
  - drill-down: `GET /v5/subclasses/{id}/eventTypes`, `GET /v5/eventTypes/{id}/events`

### Does GMA need to change?

**Essentially no.** No auth change (pass-through works), no tracing change (OTel is
already there). The only GMA-side items are **verification/confirmation**, not code:

1. Confirm the deployed (prod) issuer matches and no environment profile adds an
   audience validator we didn't read.
2. Confirm prod GMA runs with `okta.auth.enabled=true` and
   `gahs.authorization.enabled=true` (local defaults are `false`).
3. (Optional, later) If deep Splunk pivots are wanted, confirm GMA echoes/propagates
   an inbound correlation id alongside `traceparent`.

---

## 3. Target architecture

```
┌────────────────┐     MCP over Streamable HTTP        ┌──────────────────────────┐
│  Agent / MCP   │  Authorization: Bearer <user OKTA>  │      GMA MCP Server       │
│    host        │ ──────────────────────────────────► │  (TypeScript, this repo)  │
│ (human-in-loop)│                                      │                           │
└────────────────┘                                      │  endpoints:               │
                                                         │   /mcp/catalogue  ◄── v1  │
                                                         │   /healthcheck            │
                                                         │                           │
                                                         │  ┌─────────────────────┐  │
                                                         │  │ domain: catalogue   │  │
                                                         │  │  tools:             │  │
                                                         │  │   list_instances    │  │
                                                         │  │   find_catalogue_…  │  │
                                                         │  │   get_catalogue_…   │  │
                                                         │  └──────────┬──────────┘  │
                                                         │             │ uses        │
                                                         │  ┌──────────▼──────────┐  │
                                                         │  │ core                │  │
                                                         │  │  GmaClient (envelope│  │
                                                         │  │   -aware, OTel)     │  │
                                                         │  │  auth pass-through  │  │
                                                         │  │  config, errors     │  │
                                                         │  └──────────┬──────────┘  │
                                                         └─────────────┼─────────────┘
                                                                       │ HTTPS + same bearer
                                                                       │ + traceparent
                                                                       ▼
                                                            ┌──────────────────────┐
                                                            │  GMA (BFF)  →  IPMA / │
                                                            │  CRS / QBS / … + GAHS │
                                                            └──────────────────────┘
```

### Repository layout

```
gma-mcp-server/
├─ src/
│  ├─ index.ts                 # entrypoint: pick transport (http|stdio), mount endpoints
│  ├─ server/
│  │  ├─ http.ts               # Streamable HTTP transport + MCP OAuth resource-server
│  │  ├─ stdio.ts              # stdio transport (local dev)
│  │  └─ endpoints.ts          # mounts one MCP server per domain (/mcp/<domain>)
│  ├─ core/                    # SHARED — no domain imports allowed here
│  │  ├─ gmaClient.ts          # envelope-aware GMA HTTP client (+ OTel, +traceparent)
│  │  ├─ gmaStatus.ts          # status.code parsing → { data, completeness } type
│  │  ├─ auth.ts               # extract caller bearer, forward raw to GMA
│  │  ├─ config.ts             # env-config: GMA_BASE_URL, GMA_DEFAULT_INSTANCES, OKTA…
│  │  ├─ errors.ts             # GMA status/HTTP → MCP result|error mapping
│  │  ├─ completeness.ts       # Completeness aggregation across hops
│  │  └─ telemetry.ts          # OTel setup, structured logging (token/PII-safe)
│  └─ domains/
│     └─ catalogue/
│        ├─ index.ts           # registers the 3 tools on the catalogue MCP server
│        ├─ tools/
│        │  ├─ listInstances.ts
│        │  ├─ findCatalogueEntity.ts   # hero: searchByName → disambiguate → drill
│        │  └─ getCatalogueEntity.ts
│        ├─ traversal.ts       # v5 tree-walk helpers (owned by this domain)
│        └─ schemas.ts         # clean, LLM-facing input/output zod schemas
├─ test/
│  ├─ fixtures/gma/            # one fixture per status.code, per operation
│  ├─ unit/                    # resolution, disambiguation, caveat, status mapping
│  ├─ integration/             # tools vs mocked GMA (msw / nock)
│  └─ protocol/                # thin MCP Inspector / test-client smoke
├─ Dockerfile / prefab-generated deploy config
├─ package.json
└─ README.md
```

---

## 4. Core contracts (write these first)

### 4.1 The envelope-aware result type

Every `core` GMA call returns data **plus** a completeness descriptor. Tools never
see a bare payload.

```ts
// core/gmaStatus.ts
export type GmaStatusCode =
  | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'
  | 'TOO_MANY_EVENTS' | 'REQUEST_TIMEOUT' | 'BAD_REQUEST';

export interface Completeness {
  complete: boolean;                 // true only for SUCCESS
  code: GmaStatusCode;
  successfulInstances: string[];
  failedInstances: string[];
  errors: { instance?: string; message?: string }[];
}

export interface GmaResult<T> {
  data: T | null;
  completeness: Completeness;        // ALWAYS present (invariant #3)
}
```

### 4.2 Status → MCP mapping (single source of truth)

| GMA outcome | MCP outcome | Notes |
|---|---|---|
| `SUCCESS` | result, `complete: true` | no caveat |
| `PARTIAL_SUCCESS` | **result** + structured caveat | list `failedInstances` |
| `TOO_MANY_EVENTS` | **result** framed "too broad — narrow by …" | feeds disambiguation |
| `REQUEST_TIMEOUT` + partial data | **result** + caveat | treat like PARTIAL_SUCCESS |
| `REQUEST_TIMEOUT` + no data | **tool error** | nothing usable |
| `BAD_REQUEST` | **tool error** | agent supplied bad args → self-correct |
| `FAILURE` | **tool error** | nothing usable |
| HTTP `401` | **tool error**, `kind: "auth"` | token expired/invalid → human re-auth |

### 4.3 Multi-hop completeness aggregation

A task-oriented tool making N GMA calls merges every hop's `Completeness`:

- `complete` = AND of all hops.
- `code` = worst of all hop codes (precedence: `FAILURE`/`BAD_REQUEST` > `TIMEOUT` >
  `TOO_MANY_EVENTS` > `PARTIAL_SUCCESS` > `SUCCESS`).
- `failedInstances` / `errors` = union across hops.

The tool result surfaces the merged caveat at top level, and **tool descriptions
instruct the agent to relay partial-data caveats to the user.**

### 4.4 Hybrid resolve-or-disambiguate

```
result = searchByName(query)
matches = result.data.matches
if matches.length == 0        -> return { resolved: null, candidates: [], completeness }
if matches.length == 1        -> drill down + return { resolved, completeness(merged) }
if matches.length  > 1        -> return { resolved: null, candidates: [...], completeness }
if result.code == TOO_MANY_EVENTS -> return { resolved: null, candidates: [],
                                              hint: "narrow by <field>", completeness }
```

Never auto-pick from >1 plausible match.

---

## 5. Step-by-step implementation

### Phase 0 — Confirm GMA assumptions (no code)
1. Confirm prod GMA issuer + that no profile adds an audience validator.
2. Confirm prod runs `okta.auth.enabled=true`, `gahs.authorization.enabled=true`.
3. Capture **real sample responses** from `/v5/instances`, `/v5/searchByName`,
   `/v5/{…}/{id}` for the fixture library (incl. a `PARTIAL_SUCCESS` example if
   obtainable; otherwise hand-craft from the schema).

### Phase 1 — Scaffold the repo
4. `check_repo_name` for the slug (e.g. `gma-mcp-server`), then scaffold via the
   **Prefab TS template** (`get_template_variables` → confirm values →
   `create_service`). Inherit org pipeline, env-config, TLS, monitoring, Buildkite.
5. Add MCP TypeScript SDK + `zod` + an HTTP client + OTel SDK + a mocking lib
   (`msw`/`nock`) + a test runner (`vitest`).
6. Wire `index.ts` to select transport from env (`MCP_TRANSPORT=http|stdio`) and,
   for http, mount `/mcp/catalogue` + `/healthcheck`.

### Phase 2 — Build `core` (shared, domain-agnostic)
7. `config.ts`: read `GMA_BASE_URL`, `GMA_DEFAULT_INSTANCES`, OKTA issuer/metadata,
   timeouts — all from env-config. Fail fast if required vars missing.
8. `auth.ts`: extract the caller's bearer from the MCP request context; expose it to
   the client for **raw forwarding** to GMA. Never store it.
9. `gmaClient.ts`: typed GET/POST to GMA; attaches `Authorization: Bearer <caller>`
   and W3C `traceparent`; parses the `status` envelope into `GmaResult<T>`.
10. `gmaStatus.ts` / `completeness.ts` / `errors.ts`: implement §4.1–4.3.
11. `telemetry.ts`: OTel tracer + structured logger (tool name, GMA ops/paths,
    per-hop `status.code`, resolution outcome, latency). **Redact token/PII.**

### Phase 3 — Build the catalogue domain (v1 slice)
12. `schemas.ts`: clean LLM-facing schemas (do NOT expose GMA DTOs). Each output
    schema carries the top-level `completeness` field.
13. `list_instances` → `GET /v5/instances`. Discovery tool; returns valid brand codes.
14. `get_catalogue_entity` → `GET /v5/{superclasses|subclasses|eventTypes}/{id}` by
    `{type, id}`. Thin retrieve.
15. `find_catalogue_entity` (hero) → `POST /v5/searchByName` → hybrid disambiguate
    (§4.4) → drill down via `/v5/subclasses/{id}/eventTypes`,
    `/v5/eventTypes/{id}/events`. Accepts optional `instances` override; defaults to
    `GMA_DEFAULT_INSTANCES`. Aggregates completeness across every hop.
16. `domains/catalogue/index.ts`: register the 3 tools with descriptions that
    (a) explain the hybrid/candidate behaviour and (b) instruct the agent to relay
    caveats.

### Phase 4 — Testing (see §6)
17. Build the fixture library (one per `status.code` per operation).
18. Unit-test resolution/disambiguation/caveat/status-mapping.
19. Integration-test the 3 tools against mocked GMA.
20. Thin MCP-protocol smoke test (schemas + one end-to-end call via a test client).

### Phase 5 — Ship
21. Health check, OTel export to the shared collector, dashboards/alerts by tool +
    `status.code`.
22. Deploy one instance per GMA environment (`gma-mcp-qa` → QA GMA, `gma-mcp-prd` →
    prod GMA) via env-config.
23. Manual live-GMA validation with a real human OKTA token.

---

## 6. Testing strategy

- **Backbone: unit + mocked-GMA integration.** Deterministic, fast, and — crucially —
  able to simulate **every** `status.code`, which live GMA cannot.
- **Fixture library** covering `SUCCESS`, `PARTIAL_SUCCESS`, `FAILURE`,
  `TOO_MANY_EVENTS`, `REQUEST_TIMEOUT`, `BAD_REQUEST` for each v5 operation. This is
  the asset that makes the partial-failure design testable.
- **Must-cover cases**: single-match auto-resolve; multi-match candidates; zero-match;
  `PARTIAL_SUCCESS` caveat surfaced at top level; `TOO_MANY_EVENTS` → narrow hint;
  multi-hop caveat aggregation (one hop partial → whole result flagged);
  `BAD_REQUEST`/`FAILURE` → tool error; `401` → auth-flagged error.
- **Thin MCP-protocol smoke** (MCP Inspector / test client): tool schemas resolve and
  one real tool call round-trips.
- **Live GMA = manual/pre-release**, not CI (token management + can't force failures).

---

## 7. Growth path (after v1)

- **Add a domain** = new folder under `domains/`, new tools on a new `/mcp/<domain>`
  endpoint, reusing `core`. Nothing from v1 is rewritten.
- **Composite tools** (span multiple GMA APIs) are allowed and expected: a tool calls
  any GMA path through the shared `core` client — this is *not* cross-domain coupling
  (which is one domain importing another's code). File each composite tool under the
  single domain that best represents its **use-case**.
- **Persona endpoints** (e.g. `/mcp/trading-agent`) — add when a real agent needs a
  curated cross-domain bundle. Cheap: they just *reference* existing tools.
- **Separate deployables** — not a goal, but preserved as a mechanical option by
  invariant #1 (package `core` as a shared lib, split one endpoint into its own
  process). Only do this under real ownership/scaling pressure.

---

## 8. Open items / future work (explicitly deferred)

- **Headless / autonomous agents.** No human at request time → no user token.
  Requires OKTA token-exchange (on-behalf-of) or a GAHS-registered agent identity.
  Deferred until a headless use-case is real; pass-through + human-in-the-loop is v1.
- **Additional domains** (customer/risk, betops, etc.) — after the catalogue slice
  proves the pipeline.
- **`find_*` heuristics** — promote smarter natural-language resolution only if agents
  are observed fumbling the traversal.

---

## 9. Summary

Build a **standalone TypeScript MCP server** (new repo, Prefab-scaffolded) that speaks
**Streamable HTTP** with **standard MCP OAuth**, forwards the **human user's OKTA token
straight through** to GMA (preserving GMA's per-user GAHS authz with **no GMA code
change**), and exposes **three task-oriented catalogue tools** built on GMA's **v5
catalogue API**. A **modular monolith** structure (shared `core` + domain modules,
per-domain endpoints) keeps each agent's tool list small and makes future growth
additive. The **envelope-aware client** and **mandatory structured completeness caveat**
ensure agents never present multi-instance partial data as complete — the one
correctness trap that matters most in a risk/trading context.
