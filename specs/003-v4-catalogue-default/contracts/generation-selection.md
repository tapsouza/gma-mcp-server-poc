# Phase 1 Contracts: Generation Selection

**Date**: 2026-09-07 | **Types**: [data-model.md](../data-model.md) | **Research**: [research.md](../research.md)

This feature exposes **no new external interface**. The MCP tool surface is unchanged — same three
tools, same names, same input and output schemas, byte-identical
([001's tool contract](../../001-catalogue-mcp-tools/contracts/tools.md) still holds in full). That
is FR-008 and SC-002, and it is the point.

What *is* a contract, and is documented here, is the **operator-facing and internal-declaration
surface** the feature adds:

1. the configuration variable an operator sets,
2. the operation-availability table the code encodes,
3. the per-operation pin a capability declares,
4. the diagnostics an operator reads to tell which generation answered.

---

## 1. Operator contract — `GMA_CATALOGUE_GENERATION`

| | |
|---|---|
| **Variable** | `GMA_CATALOGUE_GENERATION` |
| **Accepted** | exactly `v4` or `v5` |
| **Required** | no |
| **Default** | `v4` when unset or empty |
| **Read** | once, at startup |
| **Agent-settable** | **never** — absent from every tool schema (FR-013, Story 3 scenario 4) |

| Value | Behaviour |
|---|---|
| *unset* / empty | every operation that v4 offers goes to v4; pinned operations go to their pin |
| `v4` | identical to unset |
| `v5` | every operation goes to v5; the `searchByName` pin becomes a no-op (Story 4 scenario 3) |
| anything else | **startup fails** with a `config` error naming the variable and accepted values (FR-014) |

`.env.example` gains a documented entry. It stays commented out, because the default is the
intended value.

### Startup failure output

Both failures below prevent the process from starting; neither contains a credential (001-FR-020).

**Invalid value:**

```
[config] Invalid configuration: GMA_CATALOGUE_GENERATION must be one of: v4, v5.
```

**Unsatisfiable pin or default** (FR-006 — e.g. the `searchByName` pin removed while the default
is `v4`). Constructed by an `unsatisfiableGeneration(...)` factory in `core/errors.ts`, which is
the single place `ToolError`s are built:

```
[config] Capability "catalogue" requires operation "searchByName" on generation "v4",
but that operation exists only on: v5. Set GMA_CATALOGUE_GENERATION=v5, or pin this
operation to a generation that offers it.
```

The message names the capability, the operation, the effective generation, and the generations
that do offer it — enough to fix without reading source.

---

## 2. Internal contract — the operation availability table

`core/surface.ts` holds one frozen `OperationDescriptor` per `CatalogueOperation`
([data-model.md §3](../data-model.md)). This table is the sole encoding of research R1 and the
sole place any upstream path appears.

| Operation | Method | Available on | Instances passed in |
|---|---|---|---|
| `listInstances` | GET | v4, v5 | *(absent — unscoped)* |
| `searchByName` | POST | **v5 only** | request body |
| `getSuperclass` | GET | v4, v5 | query |
| `getSubclass` | GET | v4, v5 | query |
| `getEventType` | GET | v4, v5 | query |
| `subclassEventTypes` | GET | v4, v5 | query |

Four invariants are asserted by a unit test over the table rather than left to review — see
[data-model.md §3](../data-model.md). The load-bearing one is that each path's first segment
matches the generation key it sits under, which catches the copy-paste error this table invites.

### Client contract

`GmaClient` methods take a `ResolvedOperation` plus path parameters instead of a path string:

```ts
call<T>(
  op: ResolvedOperation,
  params: Readonly<Record<string, string>>,   // interpolated into the template, encoded here
  body: unknown | undefined,                  // POST only
  options: GmaCallOptions                     // token, instances, signal, hop, tool
): Promise<GmaResult<T>>
```

`options.token` remains a **required, explicit** parameter, unchanged (Principle I, 001-FR-023a).
Path-parameter encoding moves here from the two tool modules that currently repeat it.

`instancesIn` decides where `instances` goes — query string or request body — so that asymmetry
lives in the table rather than in a tool. It is **absent** for `listInstances`, which takes no
instance scoping at all.

---

## 3. Domain declaration contract

A domain declares which operations it uses and which of them are pinned. The catalogue domain:

```ts
export const CATALOGUE_OPERATIONS = [
  'listInstances', 'searchByName', 'getSuperclass',
  'getSubclass', 'getEventType', 'subclassEventTypes'
] as const;

export const CATALOGUE_PINS = Object.freeze({
  searchByName: 'v5'   // v4 has no by-name search at all (research.md R1)
});
```

**Adding a future capability that needs v5** is exactly one line in `CATALOGUE_PINS` — no change
to any shared calling code and no change to any other capability (FR-005, SC-007).

**Removing the `searchByName` pin** makes startup fail on a v4-default deployment, by design. That
is FR-006 having teeth rather than being a comment.

---

## 4. Diagnostics contract

Per upstream call, one log line carries:

| Field | Example | Status |
|---|---|---|
| `generation` | `v4` | **new** — satisfies FR-015, SC-009 |
| `operation` | `listInstances` | **re-keyed** — was `GET /v5/instances` (R7) |
| `path` | `/v4/instances` | unchanged name, now the resolved template |
| `tool`, `status`, `outcome`, `hop`, `latencyMs`, … | | unchanged |

`generation` is added to `LOG_FIELD_ALLOWLIST`, which is the only egress path for both logs and
span attributes — so one addition covers both, and nothing else becomes loggable.

**Breaking change to log output**, made deliberately and recorded so it is not mistaken for a
regression: `operation` is no longer an HTTP-and-path string. Any dashboard or alert keyed on
`GET /v5/instances` must be re-keyed to `operation=listInstances` **and optionally**
`generation=v4`. The benefit is that a generation change no longer splits a metric series in two.

A tool error's agent-visible text changes with it — from
`GMA returned HTTP 404 for GET /v5/eventTypes/{id}` to
`GMA returned HTTP 404 for getEventType` — which moves *toward* FR-012 (upstream mechanics hidden
from the model), not away from it.

---

## 5. What is explicitly NOT in any contract

| Not exposed | Because |
|---|---|
| `generation` as a tool input | FR-012, FR-013 — operational, never agent-selectable |
| `generation` in any tool output | FR-012 — the model has no use for it and must not condition on it |
| A generation in any tool description | FR-012 |
| A path, method, or upstream field name in a tool schema | Principle IV — unchanged from 001 |
| A base-URL or generation override per call | Principle V, FR-003 |
| Any change to `completeness` | Principle II, FR-009 — `completeness.ts` is not edited at all (R10) |
