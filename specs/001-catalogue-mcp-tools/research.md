# Phase 0 Research: Catalogue MCP Tools

**Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All Technical Context unknowns are resolved below. One finding **materially corrects** both
`docs/gma-mcp-server-plan.md` and the constitution's Principle II table; it is R1 and should
be read first.

---

## R1 — GMA v5 signals partial success by HTTP status, NOT by a `status.code` envelope

**Decision**: Model upstream completeness on the **v5 catalogue contract as it actually is**:
HTTP `206 Partial Content` carrying `successfulConfigSources` / `failedConfigSources` /
`errors[]`. Do **not** build the client around a `status.code` enum field.

**Evidence** (`gma-service/gma-api/src/main/resources/static/api_catalogue.yaml`):

- Every v5 collection operation declares exactly these responses:
  `200` (30×), `206` (28×), `400` (28×), `401` (30×), `404` (27×), `500` (30×).
- `200` → `EntityResponseSuccess`, requiring only `successfulConfigSources`.
- `206` → `EntityResponsePartialSuccess`, requiring `successfulConfigSources`,
  `failedConfigSources`, and `errors[]`, where each `Error` is
  `{ configSource: urn, message: string }`.
- `api_catalogue.yaml` contains **zero** references to `common.yaml` (verified by grep), and
  the `status` / `TOO_MANY_EVENTS` envelope lives **only** in `common.yaml` and
  `brand-api.yaml` — i.e. it belongs to the older `api.yaml` / v3-era surface, not v5.
- The `Status` enum (`gma-commons/.../dto/Status.java`) does exist in GMA's Java code, but
  v5 catalogue responses do not expose it.

**Consequences**:

| Plan / constitution said | v5 actually does |
|---|---|
| `status.code` enum with 6 values | HTTP status code: `200` / `206` / `400` / `401` / `404` / `500` |
| `successfulInstances` / `failedInstances` | `successfulConfigSources` / `failedConfigSources` |
| `Error { instance, message }` | `Error { configSource, message }` |
| `TOO_MANY_EVENTS` as a response code | **Not present in v5 at all** — see R2 |
| `REQUEST_TIMEOUT` as a response code | **Not present in v5** — a timeout is a transport failure the client must handle itself |

**Why this does not weaken the design**: the *shape* of the signal changed, not its meaning.
Partial multi-instance failure is still first-class and still machine-readable, so the
internal `Completeness` type and every completeness rule (FR-005 – FR-008) survive intact.
Only the parsing layer differs. The constitution's Principle II mapping table needs a PATCH
amendment to match reality — flagged as a follow-up, not silently ignored.

**Alternatives considered**: (a) Build to the documented `status.code` envelope anyway —
rejected, it does not exist on this surface and every fixture would be fiction.
(b) Use the older `api.yaml`/`search.yaml` surface that *does* carry the envelope — rejected,
those market operations are `deprecated: true` and the constitution forbids building on them
(FR-022).

---

## R2 — "Too broad" is not an upstream response code on v5; it must be derived

**Decision**: Treat too-broad as a **client-side derivation**, not a parsed upstream code.
For this slice, `find_catalogue_entity` returns a narrowing hint when the match count exceeds
a configured threshold (`GMA_MAX_CANDIDATES`, default 25) — not because upstream said so.

**Evidence**: `TOO_MANY_EVENTS` is produced deep inside GMA's IPMA provider
(`IpmaCatalogSearchClient.java:306` — sets a flag when `events.total() > events.size()`,
bounded by `search.maxEvents=200` from `attributes/common.rb:65`), but it surfaces on the
older envelope, not on a v5 catalogue response. `POST /v5/searchByName` declares only
`200 / 400 / 401 / 500` — notably **not even 206**.

**Consequence for FR-015 and SC-003**: the too-broad path is still required and still
testable, but it is a *tool-level* behaviour driven by result cardinality. This is arguably
better: it is deterministic and does not depend on an upstream flag we cannot provoke.

**Note on FR-025 depth**: since one-level traversal for a matched sub-grouping goes to
`/v5/subclasses/{id}/eventTypes` (event **types**, not events), the 200-event cap is not
reachable in this slice at all. Confirms one level as the low-risk depth.

**Alternatives considered**: Traverse to `/v5/eventTypes/{id}/events` to reach real
`TOO_MANY_EVENTS` behaviour — rejected, out of scope per FR-025 and it would make the
common path fragile.

---

## R3 — `searchByName` returns hierarchy triples, not flat entities

**Decision**: Map each `SearchByNameResult` to a candidate that **retains its full path**.

**Evidence**: `SearchByNameResponse` is `{ results: SearchByNameResult[] }`, where each
result is `{ superclass?: Entity, subclass?: Entity, eventType?: Entity }` and `Entity` is
`{ id: urn, name: string }`. The most specific populated field identifies the matched entity;
the others are its ancestors.

**Why this matters for FR-014**: the requirement demands "distinguishing detail" per
candidate. The ancestor chain *is* that detail — two event types both named "Winner" are
distinguished by their superclass/subclass. Flattening to `{id, name}` would discard exactly
what a human needs to choose. Derive `type` from which field is populated.

**Also note**: `searchByName` takes `instancesList` in its **request body**, whereas GET
operations take it as a **query parameter**. The client must handle both.

---

## R4 — Language, runtime, and MCP SDK

**Decision**: TypeScript on Node.js 22 LTS, `@modelcontextprotocol/sdk`, `zod` for schemas.

**Rationale**: Fixed by constitution ("Technology & Platform Constraints"), independently
sound — MCP is TS-first. `zod` is the SDK's idiomatic schema library, giving one definition
for both runtime validation and the LLM-facing tool schema. Node 22 LTS is supported through
2027, comfortably past this slice.

**Request-scoped identity (FR-023a)**: the SDK passes a per-request `extra` argument to every
tool handler, carrying request metadata. Identity is read from there and threaded explicitly
as a parameter into the client. No module-level token variable, no async-local storage
needed. This is the mechanism that makes FR-023a satisfiable without ceremony — and it is
identical under stdio and HTTP, which is what makes the later transport addition additive
(FR-023b).

**Alternatives considered**: Java to share GMA DTOs — rejected by the constitution and by
intent, since Principle IV deliberately hides GMA's shapes. Python — weaker Streamable HTTP
story, and the team is TypeScript.

---

## R5 — Testing stack and the fixture library

**Decision**: `vitest` for all layers; `msw` for HTTP interception; `c8`/vitest coverage
enforcing the constitution's gates (90% line / 85% branch overall, 95% line for `core/`).

**Rationale**: One runner across unit, integration, and protocol smoke keeps a single
coverage report, which matters because the gate is constitutional. `msw` intercepts at the
network layer, so the client is exercised including its header construction — the thing
FR-001 and FR-023a most need proven. Nock is a viable alternative but msw's handler model
expresses per-instance partial failure more naturally.

**Fixture library, revised by R1**: one fixture per *HTTP outcome* per operation, replacing
the planned per-`status.code` set:

| Fixture | Represents |
|---|---|
| `200-success` | all config sources succeeded |
| `206-partial` | some `failedConfigSources` with `errors[]` |
| `400-bad-request` | malformed arguments → agent self-corrects |
| `401-unauthorized` | identity expired/invalid → human re-auth |
| `404-not-found` | unknown identifier |
| `500-server-error` | nothing usable |
| `timeout` (simulated) | transport-level, no HTTP response at all |

The last is deliberately not an HTTP fixture — with `REQUEST_TIMEOUT` absent from v5, a
timeout manifests as an aborted request, so it is simulated via a delayed msw handler plus an
abort signal. This preserves the spec's distinction between "timeout with partial data" and
"timeout with nothing usable" (FR-010).

---

## R6 — Prefab scaffold: deferred (supersedes FR-024a)

**Decision** *(revised 2026-09-03)*: **Do not adopt** the Prefab TypeScript template in this
slice. Initialise a plain TypeScript project instead.

**Rationale**: the template's value is the org pipeline, env-config plumbing, TLS, and
monitoring — all of which serve a *deployment*. This slice deploys nothing (FR-024), so that
value is unrealised while its layout constraints would shape code for a deployment that does
not exist. A secondary factor: the Prefab MCP server was unreachable from this environment
(`[Errno -5] No address associated with hostname`), so its variables and generated layout
could not be inspected — adopting it would have meant guessing.

**What keeps this affordable**: the obligations the template would otherwise carry are
enforced directly by constitution Principle V regardless of scaffold — configuration comes
from the environment, startup fails fast when it is missing (FR-019), and no operational
value is hardcoded or agent-supplied (FR-018, FR-024b). Keeping that discipline while local
is precisely what makes later adoption a configuration exercise rather than a rewrite.

**Still binding**: adopting the scaffold remains a **blocking prerequisite for any non-local
deployment**, recorded in constitution v1.0.2 as `TODO(PREFAB_MIGRATION)`. FR-024a in the
spec is superseded by this decision for the duration of the slice.

**Alternatives considered**: (a) Adopt it now anyway — rejected, it front-loads deployment
concerns and could not be inspected. (b) Adopt a hand-rolled approximation of it — rejected,
that is the worst of both: invented conventions with none of the inheritance.

## R7 — Observability

**Decision**: OpenTelemetry SDK for tracing, emit W3C `traceparent` on every GMA call, and a
structured JSON logger with an explicit field allowlist.

**Rationale**: An allowlist rather than a redaction denylist is the design decision that
makes SC-006 ("zero credentials in logs") provable rather than aspirational — a new field
cannot leak by being forgotten, because unlisted fields are never emitted. A test asserts the
`Authorization` header value appears in no log or span attribute.

**Correcting the plan's expectation**: the plan claims trace correlation with GMA is "free".
Verified otherwise — GMA's `management.tracing.enabled` is `false` by default
(`attributes/common.rb:33`) and enabled **only in dev** (`attributes/dev.rb:40`); prod uses
Datadog. Emitting `traceparent` remains correct and costs nothing, but end-to-end correlation
should not be promised for this slice. Local-only scope makes this a non-issue now.

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Upstream partial-failure contract | HTTP 206 + `*ConfigSources` (**R1** — corrects plan) |
| Too-broad signal | Client-derived from cardinality (**R2** — corrects plan) |
| Search result shape | Hierarchy triples; ancestors are the distinguishing detail (**R3**) |
| Language / runtime / SDK | TypeScript, Node 22 LTS, MCP SDK + zod (**R4**) |
| Request-scoped identity mechanism | Per-request handler argument, threaded explicitly (**R4**) |
| Test stack + fixtures | vitest + msw; fixtures keyed by HTTP outcome (**R5**) |
| Scaffold | **Deferred** — plain TS project; still blocking for later deployment (**R6**) |
| Observability | OTel + allowlist logger; prod trace correlation not free (**R7**) |
