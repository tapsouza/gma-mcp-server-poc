<!--
SYNC IMPACT REPORT
Version change: 1.0.1 → 1.0.2
Rationale: PATCH. Principle II's outcome mapping was written from the design plan's
description of a `status.code` envelope. Reading the actual v5 catalogue OpenAPI spec
showed that surface signals partial success by HTTP status instead. The principle's
RULES are unchanged — every result still carries a mandatory structured completeness
verdict, `complete` still requires unqualified success, multi-hop aggregation is still
required. Only the upstream signal being mapped is corrected, so no previously
compliant code becomes non-compliant. Also defers the Prefab scaffold obligation while
development is local-only.

History:
  - 1.0.0 initial ratification (previous file was the unpopulated scaffold).
  - 1.0.1 PATCH: deployed GMA auth configuration verified against sbv2_gmafd_chef,
    correcting the issuer and GAHS claims and Principle I's rationale.
  - 1.0.2 PATCH: this amendment (see below).

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
- `complete` MUST be `true` only when every hop reported unqualified success
  (HTTP `200` on the v5 catalogue surface).
- A tool making N GMA calls MUST merge every hop: `complete` is the AND of all hops;
  the reported outcome is the worst hop outcome by precedence
  `TIMEOUT_PARTIAL` > `TOO_BROAD` > `PARTIAL` > `COMPLETE`;
  `failedInstances` and `errors` are the union across hops.
- GMA outcome → MCP outcome mapping is fixed and MUST be implemented in exactly one
  place. On the **v5 catalogue surface** the upstream signal is the **HTTP status
  code**, not a body field (see "Deployed GMA partial-failure contract" below):

  | GMA outcome | MCP outcome |
  |---|---|
  | HTTP `200` | result, `complete: true` |
  | HTTP `206` | result + structured caveat listing `failedInstances` |
  | too broad (derived from result cardinality) | result framed as "too broad — narrow by …" |
  | transport timeout with partial data | result + caveat |
  | transport timeout with no data | tool error |
  | HTTP `400` | tool error (agent self-corrects its arguments) |
  | HTTP `404` | tool error, `kind: "notFound"` |
  | HTTP `500` | tool error |
  | HTTP `401` | tool error, `kind: "auth"` |

- Where a GMA surface **does** expose a `status.code` envelope (the older `api.yaml`
  family, via `common.yaml`), a tool built on it MUST map that envelope's codes onto
  the same outcome vocabulary above. The internal `Completeness` type is the single
  representation regardless of which upstream surface produced it.

- Tool descriptions MUST instruct the agent to relay partial-data caveats to the
  user.

**Rationale**: This is the single correctness trap that matters most in a
risk/trading context. A confidently-wrong "here is the full catalogue" built from
three of five brand instances is worse than an error.

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
- Tool input and output schemas MUST be clean, LLM-facing definitions. GMA DTOs,
  HTTP shapes, and envelope internals MUST NOT leak into a tool schema.
- Operational values MUST NOT be tool arguments — see Principle V.
- New tools MUST NOT be built on GMA endpoints marked `deprecated: true`.

**Rationale**: A generated surface floods tool selection and pushes HTTP mechanics
into the model's context. A small curated surface is what makes agents reliable.

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
- `instances` MAY be an optional per-tool override, defaulting to the configured
  value. A `list_instances` tool MUST exist so agents can discover valid brand codes
  rather than guess them.
- Tokens, credentials, and PII MUST NEVER be logged, traced, or included in error
  messages. Logs carry tool name, GMA operation/path, per-hop upstream outcome,
  resolution outcome, and latency.
- The server MUST emit W3C `traceparent` to GMA so GMA's existing Micrometer +
  OpenTelemetry pipeline continues the trace with no GMA change.

**Rationale**: Letting an agent choose prod-versus-QA is an accident waiting to
happen; letting a token reach a log is an incident. Both are prevented by
configuration boundaries, not by care.

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
- **v1 API surface**: the v5 catalogue API (`api_catalogue.yaml`) — `GET /v5/instances`,
  `POST /v5/searchByName`, `GET /v5/{superclasses|subclasses|eventTypes}/{id}`,
  `GET /v5/subclasses/{id}/eventTypes`, `GET /v5/eventTypes/{id}/events`. The
  deprecated `search.yaml` market operations MUST NOT be used.
- **v1 tool surface**: exactly three tools — `list_instances`,
  `find_catalogue_entity`, `get_catalogue_entity`. Expanding the surface is
  governed by Principle IV, not by convenience.
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

### Deployed GMA authentication (verified 2026-09-03)

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
  exposes a `status.code` envelope, they are that envelope's codes. A tool MUST NOT
  ship without its fixtures. Hand-crafting a fixture from the OpenAPI schema is
  acceptable when the real response cannot be captured; the fixture MUST record that
  it was hand-crafted.
- **Must-cover cases (blocking)**: single-match auto-resolve; multi-match candidates;
  zero-match; partial-success caveat surfaced at top level; too-broad → narrow hint;
  multi-hop aggregation where one partial hop flags the whole result; argument error
  and upstream failure → tool error; `401` → auth-flagged error; timeout with partial
  data vs timeout with none. Each MUST be covered by a test naming the case.
- **Coverage gates (blocking, CI-enforced)**: minimum 90% line and 85% branch
  coverage across `src/`, with `core/` held to 95% line. Lowering a threshold
  requires the amendment procedure below; it is never a fix for a failing build.
- **Test layers**: unit tests for resolution, disambiguation, caveat aggregation, and
  status mapping; integration tests exercising each tool against a mocked GMA; a thin
  MCP-protocol smoke test proving schemas resolve and one call round-trips.
- **Live GMA is manual and pre-release, never CI**: token management is
  human-in-the-loop and failure modes cannot be forced against a live BFF.
- **Review**: every change MUST be reviewed against the Core Principles. A reviewer
  MUST specifically confirm that no tool result lost its `completeness` field, that no
  token or PII reached a log, and that no `core → domain` or `domain → domain` import
  was introduced.
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

**Version**: 1.0.2 | **Ratified**: 2026-09-03 | **Last Amended**: 2026-09-03
