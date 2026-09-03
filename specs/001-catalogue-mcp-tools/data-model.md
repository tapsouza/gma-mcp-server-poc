# Phase 1 Data Model: Catalogue MCP Tools

**Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

These are the **internal, LLM-facing** models. Per constitution Principle IV, GMA DTOs and
HTTP shapes never appear in a tool schema — the upstream shapes in [research.md](./research.md)
are translated at the client boundary and go no further.

---

## 1. `Completeness` — the mandatory verdict

Attached to every tool result as a top-level field, present even on full success
(FR-005, FR-006). This is the type Principle II exists to protect.

| Field | Type | Rule |
|---|---|---|
| `complete` | `boolean` | `true` **only** when every hop returned HTTP 200 |
| `outcome` | `Outcome` | Worst outcome across all hops (precedence below) |
| `successfulInstances` | `string[]` | Union of `successfulConfigSources` across hops |
| `failedInstances` | `string[]` | Union of `failedConfigSources` across hops |
| `errors` | `InstanceError[]` | Union of per-instance errors across hops |
| `caveat` | `string \| null` | Human-readable sentence; `null` iff `complete` |

`InstanceError`: `{ instance: string, message: string }` — renamed from upstream
`configSource` at the boundary so the tool vocabulary stays consistent.

### `Outcome` enum

Derived from HTTP status (R1), **not** parsed from a body field:

| Value | Source | `complete` |
|---|---|---|
| `COMPLETE` | HTTP 200 | `true` |
| `PARTIAL` | HTTP 206 | `false` |
| `TOO_BROAD` | client-derived from cardinality (R2) | `false` |
| `TIMEOUT_PARTIAL` | abort with some hops already successful | `false` |

Severity precedence for aggregation (worst wins):
`TIMEOUT_PARTIAL` > `TOO_BROAD` > `PARTIAL` > `COMPLETE`

Terminal failures (400/401/404/500, timeout with nothing usable) are **not** `Outcome`
values — they are `ToolError`s and never carry a Completeness (FR-010).

### Aggregation rules (FR-008)

Given hops `h₁…hₙ`:
- `complete` = AND of all `hᵢ.complete`
- `outcome` = max by severity precedence
- `successfulInstances` / `failedInstances` / `errors` = set union, deduplicated
- `caveat` = generated from `outcome` + `failedInstances` when not complete

**Invariant** (unit-tested): `complete === true` ⟺ `outcome === 'COMPLETE'` ⟺
`failedInstances.length === 0`. Any state violating this is a bug, not a representable value.

---

## 2. `CatalogueEntity`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | URN, e.g. `urn:i:PP:PP` — opaque to the agent |
| `name` | `string` | Human-readable |
| `type` | `EntityType` | `'superclass' \| 'subclass' \| 'eventType'` |
| `ancestors` | `Ancestor[]` | Path from broadest to nearest parent; `[]` for a superclass |

`Ancestor`: `{ id, name, type }`.

Containment chain: `superclass` → `subclass` → `eventType` (→ `event`, out of scope per
FR-025). `type` is derived from which field `searchByName` populated (R3).

**Why `ancestors` is not optional**: it is the "distinguishing detail" FR-014 requires. Two
event types named "Winner" are separable only by their path.

---

## 3. `BrandInstance`

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | Short code, e.g. `PP` — what a human says |
| `id` | `string` | URN, e.g. `urn:i:PP:PP` — what GMA wants |
| `name` | `string` | e.g. `PaddyPower` |

**Design note**: agents and humans think in short codes; GMA requires URNs. `list_instances`
returns both so the agent can pass either, and the client maps code → URN. An unmapped code
is a `ToolError` of kind `argument` naming `list_instances` as the fix (FR-017, SC-008).

---

## 4. `ResolutionOutcome` — discriminated union

The type that encodes "never collapse several plausible answers into one" (FR-014) as a
structural guarantee: `resolved` and `candidates` cannot both be populated.

| Variant | Shape | When |
|---|---|---|
| `resolved` | `{ kind: 'resolved', entity, children }` | exactly 1 match |
| `candidates` | `{ kind: 'candidates', candidates: CatalogueEntity[] }` | >1 match |
| `none` | `{ kind: 'none' }` | 0 matches — not an error (FR-010) |
| `tooBroad` | `{ kind: 'tooBroad', matchCount, narrowBy: string[] }` | count > threshold (R2) |

`children` is one level down per FR-025 — for a matched `subclass`, its event types.

---

## 5. `ToolError`

| Field | Type | Notes |
|---|---|---|
| `kind` | `ErrorKind` | Drives who must act |
| `message` | `string` | Actionable; never contains a credential or PII (FR-020) |
| `retryable` | `boolean` | `false` for `auth` and `argument` |

`ErrorKind` → source → who acts:

| Kind | HTTP | Who acts |
|---|---|---|
| `auth` | 401 | **Human** re-authenticates (FR-003) |
| `argument` | 400, or local validation | **Agent** self-corrects (SC-008) |
| `notFound` | 404 | Agent reports absence |
| `upstream` | 500, timeout with no data | Retry or escalate |
| `config` | startup only | **Operator** — process refuses to start (FR-019) |

---

## 6. `GmaResult<T>` — the client's only return type

```
GmaResult<T> = { data: T | null, completeness: Completeness }
```

`core` never returns a bare payload (FR-005). Terminal failures are thrown/returned as
`ToolError` and never as a `GmaResult`, so a tool cannot accidentally present a failure as
data. This single type is what makes the completeness invariant enforceable by the type
checker rather than by reviewer vigilance.

---

## 7. `Config` — startup-validated

| Field | Env var | Validation |
|---|---|---|
| `gmaBaseUrl` | `GMA_BASE_URL` | required, absolute https URL |
| `defaultInstances` | `GMA_DEFAULT_INSTANCES` | required, non-empty list |
| `oktaIssuer` | `OKTA_ISSUER` | required, absolute URL (per-env, R1/constitution) |
| `requestTimeoutMs` | `GMA_TIMEOUT_MS` | optional, default 30000, positive int |
| `maxCandidates` | `GMA_MAX_CANDIDATES` | optional, default 25, positive int |
| `logLevel` | `LOG_LEVEL` | optional, default `info` |

Parsed and validated **once at startup**; missing or invalid required values cause a
`config` error and refusal to start (FR-019, FR-024b). No value is agent-supplied (FR-018).

---

## Entity relationship summary

```
Config ──(1)── GmaClient ──returns──> GmaResult<T>
                                          │
                                          ├── data: T
                                          └── completeness: Completeness
                                                              │
                                                              ├── outcome: Outcome
                                                              └── errors: InstanceError[]

BrandInstance ──scopes──> every query
CatalogueEntity ──has──> Ancestor[]  (the distinguishing detail)
ResolutionOutcome ──one of──> resolved | candidates | none | tooBroad
ToolError ──replaces──> GmaResult on terminal failure
```

**Identity is deliberately absent from every model above.** It is a per-invocation parameter
threaded from the request handler into the client call, never a field on a stored object
(FR-002, FR-023a). Nothing in this data model can hold a credential.
