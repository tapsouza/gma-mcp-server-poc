<!--
SYNC IMPACT REPORT
Version change: 1.1.0 → 1.2.0
Rationale: MINOR. One operation is added to the surface register and one register entry
is narrowed to the path that was actually verified. Nothing is removed, no principle
changes, and no previously compliant code becomes non-compliant — the catalogue row is
untouched and no tool exists yet on the customer row.

The motivating case is `specs/004-customer-bet-tools`, whose plan (Phase 0 research R7)
established that the feature cannot satisfy Principle V without a jurisdiction-context
discovery tool: Principle V requires a discovery tool for any scoping vocabulary an agent
is expected to supply, the feature's metrics capability takes jurisdiction codes as a
filter, and those codes are NOT derivable — `NJ`, `PA`, `CO` are observed, but Ontario's
context is `NXTCANBS` against a catalogue jurisdiction of `urn:i:FD:CA-ON`. Principle IV
forbids calling an operation absent from the register, so the tool that fixes this was
itself unbuildable. `GET /crs/contexts` returns exactly that list and is now registered.

The second change is a correction, not an expansion: the register said
`POST /qbs/{path}`, which is the controller's mapping shape rather than a path a tool may
call. The verified path is `POST /qbs/graphql`, and naming it is strictly narrower — a
register entry that admits a caller-chosen `{path}` sits awkwardly beside Principle IV's
rule that a read-only tool MUST NOT accept an upstream path, since the register would
appear to license the very thing the principle forbids.

Migration path: none required. No code calls either operation today.

History:
  - 1.0.0 initial ratification (previous file was the unpopulated scaffold).
  - 1.0.1 PATCH: deployed GMA auth configuration verified against sbv2_gmafd_chef,
    correcting the issuer and GAHS claims and Principle I's rationale.
  - 1.0.2 PATCH: Principle II's mapping re-keyed from a `status.code` envelope to HTTP
    status codes after reading the v5 spec; Prefab scaffold obligation deferred.
  - 1.1.0 MINOR: second completeness axis, `forbidden`, customer identifiers as personal
    data, per-domain surface register (see below).
  - 1.2.0 MINOR: this amendment — `GET /crs/contexts` registered; `POST /qbs/{path}`
    narrowed to `POST /qbs/graphql`.

Modified principles (1.2.0): none. No principle text changes.

Modified sections (1.2.0):
  - Technology & Platform Constraints, surface register — the `customer` row gains
    `GET /crs/contexts` and its `POST /qbs/{path}` entry becomes `POST /qbs/graphql`.
  - "Deployed GMA customer & bet surfaces" — two verified facts added: the QBS path and
    the existence of the context list. Nothing previously recorded is changed.

Verified 2026-09-08 against the GMA source and `@flutter-global/gma-client`, for the
1.2.0 amendment:
  - `GET /crs/contexts` returns `ContextEntity { contextName, contextId, contextCode }`
    (`gma-client` `fetchCrsContexts` → `${url}/crs/contexts`; type at
    `endpoints/account/types.d.ts:350`). `contextCode` is the value a jurisdiction filter
    takes, so it is looked up rather than derived.
  - The QBS path is `/qbs/graphql`. `gqlBetManagement` in `gma-client` selects
    `'/qbs/graphql'`, and a scan of its bundle yields only `/qbs/graphql` and
    `/qbs/export` under that prefix. `POST /qbs/{pathToQbs}` is the controller's
    `@PostMapping` shape (`QbsHttpRequestsController:82`), not a menu for callers.
  - `spring.controller.crs.enabled` and `spring.controller.qbs.enabled` are packaged
    `false` (`application.properties:90`, `:135`) but `default_unless … = true` in
    `attributes/common.rb:72` and `:86`, unoverridden — so both controllers are ON in
    every deployed environment, as `okta.auth.enabled` is.
  - `spring.controller.qbs.multiple.instances.enabled` is `false` and is set NOWHERE in
    all-chef-fdg, so the `?instance=` parameter is not required and MUST NOT be sent:
    `QbsProxyService:39-47` rejects a null instance only when multi-instance is enabled.

Modified principles (1.1.0):
  - I. Pass-Through Identity — added the `403` rule: authenticated-but-unauthorised is a
    distinct, NON-retryable outcome (`kind: "forbidden"`), never conflated with `401`.
    Retrying a `403` cannot succeed and wastes the operator's time. Pass-through itself
    is unchanged.
  - II. Mandatory Completeness Caveat (NON-NEGOTIABLE) — added the SECOND AXIS:
    `unavailableComponents`, naming sections of a composite answer that could not be
    retrieved. `complete` now requires BOTH axes empty. Added mapping rows for
    body-level partial failure inside a `200` (a GraphQL-style `errors[]`), HTTP `207`,
    HTTP `403`, and HTTP `424`. Added the rule that a resolution or matching outcome is
    NOT incompleteness and MUST NOT be folded into this verdict.
  - IV. Curated Task-Oriented Tools — added the READ-ONLY rules: a read-only tool MUST
    NOT accept a query, query fragment, field selection, or operation name, and MUST NOT
    accept an upstream path or path fragment. Added the rule that a tool MUST NOT assert
    an upstream default it has not verified. Surface-expansion guidance moved here from
    a frozen list in Technology & Platform Constraints.
  - V. Config-Driven Ops & Safe Observability — customer, account, bet, and receipt
    identifiers are named as personal data: never logged, traced, or echoed in an error
    message, including in the path field of a log line. `instances` generalised to
    "scoping override" since scoping is per-domain (brand instance for catalogue,
    jurisdiction context for customer).

Modified sections (1.1.0):
  - Technology & Platform Constraints — the frozen "v1 API surface" / "v1 tool surface"
    entries are replaced by a per-domain surface register, so adding a domain updates a
    table rather than requiring the surface list to be rewritten. Adding a domain to the
    register is MINOR; the register records what each domain may call.
  - Development Workflow & Quality Gates — fixture library extended to the newly
    distinguishable outcomes; must-cover cases gained the composite-answer,
    forbidden-not-retried, read-only-by-construction, and unverified-assumption cases.

Added sections (1.1.0): "Deployed GMA customer & bet surfaces (verified 2026-09-08)"
  under Technology & Platform Constraints.

Modified principles (1.0.2):
  - II. Mandatory Completeness Caveat — mapping table re-keyed from `status.code`
    values to HTTP status codes for the v5 surface; aggregation precedence restated in
    the surface-independent outcome vocabulary (TIMEOUT_PARTIAL > TOO_BROAD > PARTIAL >
    COMPLETE); added a rule that a surface which DOES expose a `status.code` envelope
    maps onto the same vocabulary rather than introducing a second representation.
  - IV. Curated Task-Oriented Tools — `TOO_MANY_EVENTS` rule generalised to "too-broad",
    which may be upstream-reported or tool-derived from cardinality (v5 does not report it).
  - V. Config-Driven Ops & Safe Observability — log/alert fields say "upstream outcome"
    rather than `status.code`.

Modified sections (1.0.2):
  - Development Workflow & Quality Gates — fixture library re-keyed to distinguishable
    upstream outcomes (HTTP statuses on v5, plus a simulated transport timeout);
    must-cover cases restated in the same vocabulary and gained the timeout-with-data
    vs timeout-with-none pair.
  - Technology & Platform Constraints — Prefab scaffold obligation DEFERRED while
    local-only; still blocking for any non-local deployment.

Modified principles (1.0.1):
  - I. Pass-Through Identity — rationale corrected: GAHS field-stripping is NOT
    currently active in any deployed environment (see below). Normative rules
    unchanged. Added the per-environment issuer constraint.

Added sections (1.0.2): "Deployed GMA partial-failure contract (verified 2026-09-03)"
  under Technology & Platform Constraints.

Added sections (1.0.1): none (Technology & Platform Constraints gained a verified
  "Deployed GMA authentication (verified)" subsection)

Removed sections: none

Templates & commands: no changes required. `/speckit-plan`, `/speckit-tasks`,
and `/speckit-analyze` read this constitution at runtime.

Verified 2026-09-08 against the GMA source, for the 1.1.0 amendment:
  - `/crs/**` is a raw forwarding proxy (CrsHttpRequestsController) declared in NO
    OpenAPI spec: `/crs/accounts/{accountId}` has no documented status set at all. Its
    completeness therefore CANNOT be derived from a declared contract, which is why
    Principle II gains a rule for surfaces publishing no partial-failure signal.
  - `GET /crs/accounts/{accountId}` and `.../expectedRiskSettings` are intercepted
    (CrsHttpRequestsController:213, :232) and enriched by
    CustomerRiskCatalogEnrichmentService, which fills each hierarchy override with its
    full named ancestor chain. GMA already performs that resolution; a tool MUST NOT
    duplicate it with its own catalogue calls.
  - `POST /qbs/{path}` returns `403` when the operator lacks permission for the
    requested GraphQL operation (QbsHttpRequestsController:96, :138), gated by
    `spring.controller.qbs.custom.authorization.enabled`, whose packaged default is
    `false` (application.properties:142). The `403` path is reachable but not active in
    the packaged default. It is mapped regardless: a flag flip MUST NOT turn a distinct
    outcome into a retry loop.
  - QBS returns HTTP `200` carrying GraphQL `errors[]` with requested fields left
    unpopulated; GMA's own BetSearchClient logs a warning and returns the partial result
    (BetSearchClient.java:52). A `200` is therefore NOT sufficient evidence of a complete
    answer on that surface.
  - `207` is declared on `notes-api.yaml:36` and `bulk-actions-api.yaml:29`; `424` on
    `notes-api.yaml:93` and `bulk-actions-api.yaml:54`. Neither appears on the CRS
    account path. Both are mapped now so the first tool to meet one has no discretion.
  - `GET /accounts/{accountId}/metrics` is `deprecated: true`
    (customer-metrics.yaml:29); the `POST` variant is current. Principle IV's
    deprecation rule binds this choice.

Verified 2026-09-03 against ../all-chef-fdg/sbv2_gmafd_chef and the GMA source:
  - okta.auth.enabled=true in all deployed envs (attributes/common.rb:120,
    default_unless, unoverridden) → the oktaAuthentication filter chain is active.
  - No audience validator exists anywhere in GMA (no JwtDecoder, OAuth2TokenValidator,
    AudienceValidator or JwtValidators outside tests). Issuer + signature + expiry only.
  - Issuer is per-environment and is NOT flutteruki.okta.com as the plan states:
    dev  https://fanduel.okta.com/oauth2/ausjlqxei9qSs2IwZ5d7
    stg  https://fanduel.okta.com/oauth2/ausuwff4gwnqsRIWZ5d7
    prd  https://fanduel.okta.com/oauth2/ausmnnjobetSCWwLW5d7
    (attributes/{dev,stg,prd}.rb → application.properties.erb:214). The
    flutteruki.okta.com value in application.properties:13 is a packaged default,
    overridden in every deployed environment.
  - gahs.authorization.enabled is set NOWHERE in the entire all-chef-fdg repo and is
    absent from application.properties.erb, the only properties template Chef
    deploys. The packaged default (application.properties:19) is false. Therefore
    GAHS fine-grained authorization is OFF in all deployed environments, and
    MethodSecurityConfig (@ConditionalOnProperty havingValue="true") does not load.

Deferred items / follow-up TODOs:
  - TODO(GMA_CONFIG_LOADING): It could not be established from the cookbook how
    Spring loads the Chef-rendered /var/app/gma-service/config/application.properties.
    The systemd unit (initd springboot-scriptless.service.erb) execs the jar with no
    spring.config.location, no --spring.config.* flag and no EnvironmentFile, and
    gma-service.conf.erb sets only JAVA_OPTS; peer cookbooks (sbv2_bochfd_chef,
    sbv2_spbfd_chef) pass spring.config.location explicitly. This does not change the
    GAHS conclusion (unset in Chef, false when packaged — off either way), but it does
    mean the effective value of any Chef-only property is unconfirmed. Worth a human
    check before relying on Chef to carry a property.
  - TODO(PREFAB_MIGRATION): This repository was created ad hoc, not via the Prefab
    TS template. Adoption is DEFERRED while development is local-only (decided
    2026-09-03) and remains blocking for any non-local deployment. See "Technology &
    Platform Constraints".
-->

# GMA MCP Server Constitution
<!-- Governs the standalone TypeScript MCP server that exposes GMA (GBP Management
     API) capabilities to AI agents. Scope: this repository, from POC through
     production. -->

## Core Principles

### I. Pass-Through Identity (NON-NEGOTIABLE)

The caller's OKTA bearer token MUST be forwarded to GMA unmodified. GMA performs
per-user field-stripping via GAHS using the raw token it receives, so any
substitution breaks authorization silently rather than loudly.

- The server MUST NOT mint, exchange, cache, or persist tokens, and MUST NOT hold
  credentials of its own for GMA.
- The server MUST NOT attempt to detect, reconstruct, or compensate for GAHS
  field-stripping. An agent sees exactly what its human user is entitled to see.
- HTTP transport MUST act as a standard MCP OAuth resource server; stdio transport
  MUST take the bearer from the local environment and is for development only.
- GMA's OKTA issuer is a **per-environment custom authorization server**, so a token
  is valid against exactly one GMA environment. The accepted issuer MUST therefore
  come from environment configuration (Principle V) and MUST NOT be hardcoded. A
  deployment MUST NOT accept tokens from an issuer other than its configured one.
- HTTP `401` from GMA MUST surface as a tool error tagged `kind: "auth"` so a human
  can re-authenticate. It MUST NOT be retried with different credentials.
- HTTP `403` from GMA MUST surface as a tool error tagged `kind: "forbidden"` and MUST
  be marked NOT retryable. It means the identity is valid but lacks permission for the
  operation, which is a different human action — request access, not sign in again — and
  a retry cannot succeed. It MUST NOT be conflated with `401`, and MUST NOT be reported
  as an upstream failure, which would invite a retry loop.
- Any identity model other than pass-through (service account, token exchange,
  registered agent identity) MUST NOT be introduced without a written record — in
  this repository — of how per-user GAHS authorization is preserved. That record is
  reviewed case-by-case and does not require a constitutional amendment.

**Rationale**: Pass-through preserves GMA's entire authorization model with zero GMA
code change. A service account would collapse every user's view into one privileged
view.

Note the current state precisely, because it is easy to overclaim: as verified on
2026-09-03, GMA's deployed environments enforce **coarse-grained** authorization only
— a valid token from the environment's issuer whose `groups` claim intersects that
environment's `authority.group` list. GAHS fine-grained field-stripping is **not
active in any deployed environment** (`gahs.authorization.enabled` is unset in Chef
and defaults to `false`). So today, pass-through is what makes the coarse group check
apply to the real user instead of to a shared identity.

The stronger argument is forward-looking and is why this principle is
NON-NEGOTIABLE: when GAHS is switched on, GMA strips fields rather than returning
`403`. Any non-pass-through identity would then produce over-disclosure with **no
error anywhere** — a silent authorization failure. A design that is merely correct
today but becomes silently wrong the day a flag flips is not acceptable in a
risk/trading context.

### II. Mandatory Completeness Caveat (NON-NEGOTIABLE)

Multi-instance partial failure is normal operation for a BFF, not an exception.
Partial data MUST NEVER be presentable as complete.

- Every `core` GMA call MUST return `GmaResult<T>` carrying a `Completeness`
  descriptor. Tools MUST NEVER receive a bare payload.
- Every tool result MUST carry `completeness` as a structured, top-level field. It
  MUST NOT be prose-only and MUST NOT be omitted, including on full success.
- `Completeness` has **two independent failure axes**, and `complete` MUST be `true`
  only when **both** are empty and every hop reported unqualified success:
  1. `failedInstances` — sources that did not answer. *Is this list missing rows?*
  2. `unavailableComponents` — named sections of a composite answer that could not be
     retrieved, even though every source consulted answered. *Is this record missing a
     section?*
- The two axes MUST both be present in a tool's output schema and MUST NOT be merged.
  They demand different agent behaviour: a failed instance invites a narrowed retry, a
  missing component tells the agent to state what is absent. A composite tool that
  reports a missing section as a failed instance instructs the agent to retry with
  different scoping, a correction that cannot work — so the agent retries indefinitely.
- A tool assembling an answer from several sources MUST name every section it could not
  retrieve. A composite answer missing a section MUST NEVER be `complete: true`.
- A tool making N GMA calls MUST merge every hop: `complete` is the AND of all hops;
  the reported outcome is the worst hop outcome by precedence
  `TIMEOUT_PARTIAL` > `TOO_BROAD` > `PARTIAL` > `COMPLETE`;
  `failedInstances`, `unavailableComponents` and `errors` are the union across hops.
- GMA outcome → MCP outcome mapping is fixed and MUST be implemented in exactly one
  place. On the **v5 catalogue surface** the upstream signal is the **HTTP status
  code**, not a body field (see "Deployed GMA partial-failure contract" below):

  | GMA outcome | MCP outcome |
  |---|---|
  | HTTP `200`, no body-level errors | result, `complete: true` |
  | HTTP `200` whose body reports errors and leaves requested data unpopulated | result + caveat, `complete: false` — see below |
  | HTTP `206` | result + structured caveat listing `failedInstances` |
  | HTTP `207` | result + structured caveat, treated as `206` is |
  | a needed section unavailable while every source answered | result + caveat naming it in `unavailableComponents` |
  | too broad (derived from result cardinality) | result framed as "too broad — narrow by …" |
  | transport timeout with partial data | result + caveat |
  | transport timeout with no data | tool error |
  | HTTP `400` | tool error (agent self-corrects its arguments) |
  | HTTP `401` | tool error, `kind: "auth"` |
  | HTTP `403` | tool error, `kind: "forbidden"`, NOT retryable |
  | HTTP `404` | tool error, `kind: "notFound"` |
  | HTTP `424` | tool error, `kind: "upstream"`, retryable — a dependency of GMA failed |
  | HTTP `500` | tool error |

- **A success status is not by itself evidence of a complete answer.** Where a surface
  can return a success status while reporting errors inside the response body — a
  GraphQL `errors[]` alongside partially unpopulated `data` is the case in hand — a tool
  MUST inspect the body and MUST mark the result incomplete when it reports errors. A
  tool MUST NOT infer completeness from the status code alone on such a surface.
- Where a surface publishes **no** partial-failure signal at all — a raw forwarding
  proxy with no declared contract — a tool MUST NOT invent one. It reports either a
  complete answer or a tool error, and where that surface contributes one section of a
  composite answer, its failure MUST be reported through `unavailableComponents`.
- Where a GMA surface **does** expose a `status.code` envelope (the older `api.yaml`
  family, via `common.yaml`), a tool built on it MUST map that envelope's codes onto
  the same outcome vocabulary above. The internal `Completeness` type is the single
  representation regardless of which upstream surface produced it.
- **A resolution, matching, or disambiguation outcome is NOT incompleteness** and MUST
  NOT be folded into this verdict. When every source answered fully but the tool could
  not determine which of several retrieved records applies, the result is `complete`
  and the ambiguity is reported as its own structured field (Principle IV). Marking
  such a result incomplete trains the agent to caveat data that is in fact whole, which
  devalues every genuine caveat.
- Tool descriptions MUST instruct the agent to relay partial-data caveats to the
  user.

**Rationale**: This is the single correctness trap that matters most in a
risk/trading context. A confidently-wrong "here is the full catalogue" built from
three of five brand instances is worse than an error. The second axis exists because
the first cannot express the composite case: a customer's applied bet limit returned
without the risk settings it should be compared against is a *plausible-looking half
answer*, and under a one-axis verdict every source answered, so it would be reported
as complete. In a risk context that is the same failure as the original one, arriving
through a different door.

### III. Modular Boundaries

The server is a modular monolith with enforced one-way dependencies.

- `core/` MUST NOT import from `domains/`. Domains MUST NOT import from each other.
- Shared logic — GMA client, status parsing, completeness aggregation, auth
  extraction, config, telemetry, error mapping — MUST live in `core/`.
- Each domain MUST expose its own MCP endpoint at `/mcp/<domain>`, so each agent
  sees a small, coherent tool list.
- A tool MAY call any GMA path through the shared `core` client, including paths
  outside its domain's primary API. That is composition, not coupling; coupling is
  one domain importing another's code. File a composite tool under the single domain
  that best represents its use-case.
- Adding a domain MUST be additive: a new folder, a new endpoint, no rewrite of
  existing domains.

**Rationale**: The boundary costs nothing to maintain and keeps "split into separate
deployables" a mechanical extraction rather than a rewrite. Splitting is not a goal;
preserving the option is.

### IV. Curated Task-Oriented Tools

The tool surface is hand-curated for the model, never generated from GMA's API.

- Tools MUST be task-oriented and MAY collapse multiple GMA calls into one.
- A tool MUST NEVER collapse multiple plausible answers into one. Traversal is the
  tool's job; judgment belongs to the model and the human.
- Resolution MUST follow hybrid resolve-or-disambiguate: zero matches returns
  `resolved: null` with an empty candidate list; exactly one match MAY drill down and
  return the resolved entity; more than one match MUST return `resolved: null` plus
  the candidates. Auto-picking from more than one plausible match is prohibited.
- A **too-broad** query MUST return no resolution plus a hint naming the field to
  narrow by. Too-broad MAY be determined by the upstream system where it reports one,
  or derived by the tool from result cardinality where it does not (the v5 catalogue
  surface does not report it).
- Where a tool must decide **which of several retrieved records applies** to the answer,
  the outcome MUST be a structured, model-facing field enumerating the distinguishable
  cases — including the case where the tool's own matching logic failed, kept separate
  from the case where the records genuinely contain no applicable entry. Collapsing
  those two makes a systematic matching defect indistinguishable from a fact about the
  data, and the defect then cannot be observed.
- A tool MUST NOT assert an upstream behaviour it has not verified — default ordering,
  the meaning of an absent record, or which of two fields an upstream value corresponds
  to. Where such an assumption is load-bearing and unverified, the tool MUST state the
  limitation in its result and the assumption MUST be recorded with an owner and a
  removal condition (see Compliance review).
- A tool declared read-only MUST be read-only **by construction**, not by convention:
  - It MUST NOT accept a query, query fragment, field selection, or operation name as
    input. Requests issued upstream MUST be fixed in the server.
  - It MUST NOT accept an upstream path or path fragment as input, so a catch-all
    upstream proxy cannot be reached with a caller-chosen target.
  - The request mechanics MUST NOT be relied on as the guard, because a read operation
    may be issued the same way a write would be.
  These MUST be enforced by an automated assertion, not by review alone.
- Tool input and output schemas MUST be clean, LLM-facing definitions. GMA DTOs,
  HTTP shapes, and envelope internals MUST NOT leak into a tool schema.
- Operational values MUST NOT be tool arguments — see Principle V.
- New tools MUST NOT be built on GMA endpoints marked `deprecated: true`, including
  where a deprecated variant of a needed operation exists alongside a current one.
- The tool surface MAY grow, and growth is governed by this principle rather than by a
  frozen list: each domain's permitted GMA operations are recorded in the surface
  register under Technology & Platform Constraints. Adding a domain or an operation to
  that register is a MINOR amendment; a tool MUST NOT call an operation absent from it.

**Rationale**: A generated surface floods tool selection and pushes HTTP mechanics
into the model's context. A small curated surface is what makes agents reliable. The
read-only rules are structural because a guarantee that depends on the agent's good
behaviour is not a guarantee: an agent that can supply its own query can supply a
mutation, and the only reliable defence is that no caller-supplied value ever reaches
a query or a path.

### V. Configuration-Driven Operations & Safe Observability

Operational concerns belong to deployment, never to the agent, and never to a log
line.

- GMA base URL, default instances, OKTA issuer/metadata, and timeouts MUST come from
  deployment environment configuration. They MUST NOT be hardcoded and MUST NOT be
  agent-supplied.
- The GMA base URL MUST NOT be a tool argument. Environment selection is achieved by
  deploying one instance per GMA environment (for example `gma-mcp-qa` → QA GMA,
  `gma-mcp-prd` → prod GMA).
- Missing required configuration MUST fail fast at startup, not at first request.
- A per-tool **scoping override** MAY exist, defaulting to the configured value, and its
  vocabulary is the domain's own — brand instances for the catalogue, jurisdiction
  contexts for customer data. A discovery tool MUST exist for any scoping vocabulary an
  agent is expected to supply, so codes are looked up rather than guessed. A scoping
  argument MUST NOT be typed as a list where the domain admits only one value, because
  a list tells the model a fan-out is possible when it is not.
- Bounds on work a tool performs on the caller's behalf — result caps, traversal depth,
  the number of upstream hops a composite may make — MUST come from configuration, and
  reaching a bound MUST be reported in the result. Silent truncation is prohibited.
- Tokens, credentials, and PII MUST NEVER be logged, traced, or included in error
  messages. Logs carry tool name, GMA operation/path, per-hop upstream outcome,
  resolution outcome, and latency.
- **Customer identifiers are personal data.** An account identifier, bet identifier, bet
  receipt identifier, customer name, and any customer financial value MUST NEVER appear
  in a log, a trace, a diagnostic field, or an error message. Where such an identifier
  appears in a request path, the logged operation MUST be the path *template*, never the
  interpolated path. An error MUST describe the expected form of a rejected identifier
  without echoing the value, and a not-found MUST state that nothing matched.
- Where per-customer correlation is genuinely required, it MUST be introduced as a
  deliberate, documented decision — never as a default, and never via a digest of a
  low-entropy identifier, which is reversible by anyone holding the customer list and so
  delivers the disclosure risk while appearing safe.
- The server MUST emit W3C `traceparent` to GMA so GMA's existing Micrometer +
  OpenTelemetry pipeline continues the trace with no GMA change.

**Rationale**: Letting an agent choose prod-versus-QA is an accident waiting to
happen; letting a token reach a log is an incident. Both are prevented by
configuration boundaries, not by care. Customer identifiers are named explicitly
because they are the join key to a named person's bets, notes, and finances, and
because in a gambling operator's logs they additionally reveal *that a specific
customer is under investigation* — which makes a log line a regulatory exposure rather
than an operational convenience. The correlation that debugging actually needs is
per-session, and `traceparent` already provides it without naming anyone.

## Technology & Platform Constraints

- **Language and runtime**: TypeScript. The MCP specification is TypeScript-first
  with the best Streamable HTTP support, and this is a TypeScript-owned service.
  Sharing GMA's Java DTOs is explicitly undesirable — Principle IV hides them.
- **Transport**: Streamable HTTP is the production transport; stdio exists for local
  development and debugging only. Both MUST expose the same tools from the same
  domain modules.
- **GMA integration**: HTTP only, as an ordinary consumer of the BFF, exactly as the
  front-end is. This server MUST NOT be built into or deployed as part of GMA, and
  MUST NOT require a GMA code change.
- **Surface register**: a tool MUST NOT call a GMA operation absent from this register.
  Adding a domain or an operation here is a MINOR amendment (Principle IV).

  | Domain | Permitted GMA operations | Scoping vocabulary |
  |---|---|---|
  | `catalogue` | `GET /v5/instances`; `POST /v5/searchByName`; `GET /v5/{superclasses\|subclasses\|eventTypes}/{id}`; `GET /v5/subclasses/{id}/eventTypes`; `GET /v5/eventTypes/{id}/events`; `GET /v5/events/{id}` | brand instance (`instancesList`, or `sources` where the operation declares that name) |
  | `customer` | `GET /crs/contexts`; `GET /crs/accounts/{accountId}`; `POST /accounts/{accountId}/metrics`; `POST /qbs/graphql` restricted to the server's own fixed bet-search documents; `GET /v5/events/{id}` | jurisdiction context |

  The QBS entry names `POST /qbs/graphql` specifically. GMA's controller is mapped as
  `POST /qbs/{pathToQbs}`, but a register entry containing a path variable would appear to
  license a caller-chosen upstream target, which Principle IV forbids outright. The
  registered operation is the single verified path, and the document sent to it is fixed in
  the server.

  `GET /crs/contexts` is the customer domain's scoping-discovery operation. Principle V
  requires a discovery tool wherever an agent supplies a scoping value, and jurisdiction
  context codes are NOT derivable from a catalogue jurisdiction (see the verified table
  below), so they MUST be looked up rather than guessed or maintained in a hardcoded table.

  The deprecated `search.yaml` market operations MUST NOT be used, nor
  `GET /accounts/{accountId}/metrics`, which is marked deprecated in favour of the
  `POST` variant.
- **Per-operation parameter names MUST NOT be assumed uniform.** The v5 surface names
  its instance parameter `instancesList` on some operations and `sources` on others; a
  client MUST carry the name per call rather than hardcoding one globally.
- **Tool surface**: hand-curated per domain, sized so each agent sees a small coherent
  list. Growth is governed by Principle IV, not by convenience.
- **Read-only domains**: a domain declared read-only MUST satisfy Principle IV's
  structural read-only rules. Writes — bet manipulation, risk-setting amendment, note
  deletion — are outside every currently ratified domain and MUST NOT be reachable,
  including incidentally through a proxy operation that would accept them.
- **Scaffold obligation** *(deferred 2026-09-03 — local-only development)*:
  production deployment MUST run from a repository scaffolded via the org's Prefab
  TypeScript template, inheriting the org pipeline, environment config, TLS, and
  monitoring. This repository was not created that way, and adopting the template is
  **explicitly deferred** while work is local-only: nothing is deployed, so the
  template's value is unrealised and its layout constraints would shape code for a
  deployment that does not yet exist.
  This remains a **blocking prerequisite for any non-local deployment** and is tracked
  as `TODO(PREFAB_MIGRATION)`. Deferring it is affordable only because the obligations
  the template would otherwise carry are enforced directly by Principle V regardless of
  scaffold: configuration comes from the environment, startup fails fast when it is
  missing, and no operational value is hardcoded. Keeping that discipline while local is
  what makes later adoption a configuration exercise rather than a rewrite.
- **Deployment**: one deployed instance per GMA environment. A `/healthcheck`
  endpoint MUST exist. Traces MUST export to the shared collector, with dashboards
  and alerts keyed by tool name and upstream outcome.

### Deployed GMA partial-failure contract (verified 2026-09-03)

Verified by reading `gma-api/src/main/resources/static/api_catalogue.yaml`. Recorded
because the design plan (`docs/gma-mcp-server-plan.md`) described a different contract,
and Principle II was originally written from that description.

| Fact | Value |
|---|---|
| Partial success signal | HTTP **`206`** (declared on 28 v5 operations) |
| Full success | HTTP `200` (30 operations) |
| Other declared statuses | `400` (28), `401` (30), `404` (27), `500` (30) |
| Instance fields | `successfulConfigSources` / `failedConfigSources` |
| Per-instance error | `Error { configSource, message }` |
| `status.code` envelope | **absent from v5** — `api_catalogue.yaml` has zero references to `common.yaml` |
| `TOO_MANY_EVENTS` / `REQUEST_TIMEOUT` | **not present on v5**; they belong to the older `api.yaml` family |

Consequences that bind this project:

- The v5 client MUST derive completeness from the **HTTP status code**, and MUST NOT
  parse a `status.code` body field on that surface.
- Upstream `configSource` naming MUST be translated to the project's `instance`
  vocabulary at the client boundary, so tool-facing types stay consistent (Principle IV).
- Too-broad MUST be derived from result cardinality on this surface (Principle IV).
- A transport timeout has no HTTP response, so it MUST be handled as a client-side
  condition and distinguished by whether any hop already produced usable data.
- The internal `Completeness` type is surface-independent: a future domain built on a
  `status.code` surface maps onto the same vocabulary rather than introducing a second
  representation.

### Deployed GMA customer & bet surfaces (verified 2026-09-08)

Verified by reading the GMA source and OpenAPI specs, and against one real customer-risk
response and one real bet-search response from a non-production environment. Recorded
because these three surfaces behave **unlike** the v5 catalogue surface Principle II was
first written for, and the differences are the reason this amendment exists.

| Fact | Value |
|---|---|
| CRS account path | `/crs/**` is a raw forwarding proxy; `/crs/accounts/{accountId}` is declared in **no** OpenAPI spec and publishes no partial-failure signal |
| CRS override enrichment | GMA already resolves each hierarchy override's full named ancestor chain (`CustomerRiskCatalogEnrichmentService`, intercepted at `CrsHttpRequestsController:213`) |
| CRS scoping | `contexts[]`, one entry **per jurisdiction**; a customer has several, each with its own settings and overrides |
| Jurisdiction context list | `GET /crs/contexts` returns `{ contextName, contextId, contextCode }` per jurisdiction — the vocabulary a scoping filter takes, discoverable rather than derivable |
| QBS path | `POST /qbs/graphql` (the controller's mapping is `POST /qbs/{pathToQbs}`, but `graphql` is the only search path in use; `export` is the other) |
| QBS partial failure | HTTP **`200`** carrying GraphQL `errors[]` with requested fields unpopulated (`BetSearchClient.java:52`) |
| QBS authorization | `403` per GraphQL operation (`QbsHttpRequestsController:96`), gated by a flag whose packaged default is `false` |
| QBS instance parameter | `?instance=` is required only when `spring.controller.qbs.multiple.instances.enabled` is true, which is `false` and set nowhere in Chef |
| Metrics | `POST /accounts/{accountId}/metrics` is current; the `GET` variant is `deprecated: true` |
| `207` / `424` | declared on `notes-api.yaml` and `bulk-actions-api.yaml`; **not** on the CRS account path |
| Catalogue vocabularies | risk overrides use `SUPERCLASS`/`SUBCLASS`/`EVENT_TYPE`/`MARKET_TYPE`; bet legs use `SPORT`/`COMPETITION`/`EVENT`/`MARKET`/`SELECTION` — **different trees**, and a leg carries no risk-side level |

Consequences that bind this project:

- A tool on the CRS account path MUST NOT synthesise a partial-failure verdict it has no
  signal for. It reports a complete answer or a tool error, and its failure inside a
  composite MUST be reported via `unavailableComponents` (Principle II).
- A tool on QBS MUST inspect the response body for reported errors and MUST NOT treat a
  `200` as evidence of completeness (Principle II).
- A customer's risk configuration MUST NOT be flattened across jurisdictions. Merging
  them would report a customer restricted in one state and unrestricted in another as
  neither.
- A tool MUST NOT duplicate GMA's override-name enrichment with its own catalogue calls.
- Joining a bet leg to a risk override requires resolving the leg's **event** to obtain
  its risk-side catalogue position; the two vocabularies do not otherwise meet. This hop
  is mandatory, not an optimisation.
- Deriving a jurisdiction context identifier from a catalogue jurisdiction identifier
  works for US states but **provably fails** for at least one non-US jurisdiction
  (`urn:i:FD:CA-ON` against a context observed as `NXTCANBS`). A tool MUST therefore
  treat matching as fallible and report the failure distinctly (Principle IV), and MUST
  prefer the context list from `GET /crs/contexts` over its own derivation. Derivation is
  a fallback, never the primary mechanism, and a hardcoded jurisdiction table is
  prohibited: it would fail *confidently* as jurisdictions are added.
- The QBS `?instance=` parameter MUST NOT be sent while multi-instance routing is
  disabled, and an instance MUST NOT be exposed as a tool argument in any case — it is a
  routing concern, not a scoping vocabulary, and Principle V keeps it in configuration.
- Applied risk figures are computed by GMA's downstream pricing and risk engine, whose
  formula is not exposed. A tool MUST NOT reconstruct or imply how a limit was derived;
  it MAY place applied and configured values side by side and compare them directly.



Verified against `../all-chef-fdg/sbv2_gmafd_chef` and the GMA source. These are
facts about the system as deployed, not aspirations; they MUST be re-verified if GMA's
cookbook changes, and this constitution corrected if they drift.

| Fact | Value | Source |
|---|---|---|
| Okta auth | enabled in every deployed env | `attributes/common.rb:120` (`default_unless`, unoverridden) |
| Audience validator | none exists | no `JwtDecoder` / `OAuth2TokenValidator` / `AudienceValidator` outside tests |
| Token checks | issuer + signature + expiry, then `groups` ∩ `authority.group` | `SecurityFilterFactory.java:35-70` |
| Issuer | per-env custom authz server under `fanduel.okta.com` | `attributes/{dev,stg,prd}.rb` → `application.properties.erb:214` |
| GAHS fine-grained authz | **OFF in every deployed env** | `gahs.authorization.enabled` unset across all of `all-chef-fdg`; packaged default `false` |

Consequences that bind this project:

- The MCP server MUST read its accepted issuer from environment configuration. The
  value `https://flutteruki.okta.com` in `application.properties:13` — and repeated in
  `docs/gma-mcp-server-plan.md` §2 — is a packaged default that no deployed
  environment uses. It MUST NOT be relied on.
- Because no audience validator exists, a valid same-issuer token with the right
  group is accepted by GMA. This is what makes pass-through work, and it is also why
  the server MUST NOT widen its accepted issuer set.
- Because GAHS is currently off, the server MUST NOT be documented, described in a
  tool description, or presented to users as delivering per-user field-level
  filtering. It delivers exactly the authorization GMA enforces, which is currently
  group-level.
- If GAHS is enabled later, no change to this server is required, and none MUST be
  made to compensate for it (Principle I).

## Development Workflow & Quality Gates

Testing is fixture-driven and coverage-gated. Test-first is not mandated: tests and
implementation MAY land in the same change.

- **Fixture library (blocking)**: a fixture MUST exist for every distinguishable
  upstream outcome, for every GMA operation a tool depends on. On the v5 catalogue
  surface those outcomes are HTTP `200`, `206`, `400`, `401`, `404`, `500`, plus a
  simulated transport timeout (which has no HTTP response at all). On a surface that
  exposes a `status.code` envelope, they are that envelope's codes. On a surface that can
  report errors inside a success response, a **success-carrying-errors** fixture is
  mandatory and is the single most important one on that surface. Where an operation can
  return `403`, `207`, or `424`, each MUST have a fixture. A tool MUST NOT ship without
  its fixtures. Hand-crafting a fixture from the OpenAPI schema is acceptable when the
  real response cannot be captured; the fixture MUST record that it was hand-crafted, and
  for a surface with no declared contract at all it MUST record what it was derived from.
- **Must-cover cases (blocking)**: single-match auto-resolve; multi-match candidates;
  zero-match; partial-success caveat surfaced at top level; too-broad → narrow hint;
  multi-hop aggregation where one partial hop flags the whole result; argument error
  and upstream failure → tool error; `401` → auth-flagged error; timeout with partial
  data vs timeout with none. Each MUST be covered by a test naming the case.
  For composite and read-only tools, additionally: a success response carrying reported
  errors marked incomplete; a composite answer missing one section reported through
  `unavailableComponents` and never `complete: true`; `403` producing a non-retryable
  `forbidden` error that the agent does not retry; every distinguishable
  matching/resolution outcome, including the tool's own matching failure kept separate
  from a genuine absence; a bound reached reported rather than silently truncated;
  duplicate work deduplicated before fan-out; and an automated assertion that no
  caller-supplied value can reach an upstream query or path.
- **Privacy assertion (blocking)**: an automated check MUST prove that no customer
  identifier, customer name, or customer financial value appears in any log field, trace
  field, or error message.
- **Amendment acceptance (blocking)**: when this constitution's shared types gain a new
  member or axis, the existing domains' tests MUST pass **unmodified**. A change that
  requires editing an existing domain's tests to accommodate a shared-type addition is
  not additive, and the amendment's MINOR classification is then wrong.
- **Coverage gates (blocking, CI-enforced)**: minimum 90% line and 85% branch
  coverage across `src/`, with `core/` held to 95% line. Lowering a threshold
  requires the amendment procedure below; it is never a fix for a failing build.
- **Test layers**: unit tests for resolution, disambiguation, caveat aggregation, and
  status mapping; integration tests exercising each tool against a mocked GMA; a thin
  MCP-protocol smoke test proving schemas resolve and one call round-trips.
- **Live GMA is manual and pre-release, never CI**: token management is
  human-in-the-loop and failure modes cannot be forced against a live BFF.
- **Review**: every change MUST be reviewed against the Core Principles. A reviewer
  MUST specifically confirm that no tool result lost its `completeness` field, that
  neither completeness axis was dropped or merged into the other, that no token, PII, or
  customer identifier reached a log, that no read-only tool gained a caller-supplied
  query or path, and that no `core → domain` or `domain → domain` import was introduced.
- **Static analysis and formatting** MUST run in CI and MUST pass before merge.

## Governance

This constitution supersedes ad hoc practice, prior informal agreements, and
convenience. Where the implementation plan in `docs/gma-mcp-server-plan.md` and this
constitution disagree, this constitution wins; the plan is a design record, not a
governing document.

**Amendment procedure**

1. Propose the change in a pull request that edits this file and nothing else.
2. State the principle affected, the concrete motivating case, and the migration path
   for code that currently complies.
3. Amendments to a principle marked NON-NEGOTIABLE require explicit maintainer
   approval recorded in the pull request.
4. On merge, update the version, the Last Amended date, and the Sync Impact Report at
   the top of this file.

**Versioning policy** — semantic versioning of governance:

- **MAJOR**: a principle is removed, or redefined in a way that makes previously
  compliant code non-compliant.
- **MINOR**: a principle or section is added, or existing guidance is materially
  expanded.
- **PATCH**: clarification, wording, or typo fixes with no change in meaning.

**Compliance review**

- Every pull request MUST be verifiable against these principles; a reviewer may
  block on a principle violation alone.
- Complexity MUST be justified in the pull request description. Absent
  justification, the simpler alternative wins.
- A deliberate, temporary deviation MUST be recorded in the pull request with an
  owner and a removal condition. Undocumented deviations are defects.
- `AGENTS.md` / `CLAUDE.md` in this repository carry runtime development guidance and
  MUST NOT contradict this constitution.

**Version**: 1.2.0 | **Ratified**: 2026-09-03 | **Last Amended**: 2026-09-08
