# Phase 1 Contracts: MCP Tool Surface

**Date**: 2026-09-03 | **Types**: [data-model.md](../data-model.md)

The externally-visible interface of this feature is its **MCP tool surface** — three tools on
one endpoint. Exactly three, per FR-022; the surface is curated, never generated.

Every tool result carries a top-level `completeness` field (FR-005). Every description
instructs the agent to relay caveats (FR-009). Identity is **never** a tool parameter — it
arrives with the request and is threaded per invocation (FR-023a).

---

## Shared output envelope

Every successful result:

```jsonc
{
  "completeness": {
    "complete": true,
    "outcome": "COMPLETE",
    "successfulInstances": ["PP", "BF"],
    "failedInstances": [],
    "errors": [],
    "caveat": null
  }
  // ...tool-specific fields
}
```

On terminal failure a tool returns an MCP error with `kind` from `ErrorKind`, and **no**
`completeness` — a failure is never dressed as data.

---

## 1. `list_instances`

**Description shown to the model**:
> Lists the brand instances (e.g. PP, BF) that catalogue queries can be scoped to. Call this
> first if you need to narrow a query by brand, rather than guessing instance codes. If the
> result reports failed instances, relay that caveat to the user — the list may be incomplete.

**Input**: none.

**Output**:

| Field | Type |
|---|---|
| `instances` | `BrandInstance[]` (`code`, `id`, `name`) |
| `completeness` | `Completeness` |

**GMA mapping**: `GET /v5/instances` → 200 `EntityResponseSuccess` / 206
`SearchInstancesResponsePartialSuccess`.

**Requirements**: FR-011, FR-005–FR-007. **Story 1 (P1)**.

---

## 2. `find_catalogue_entity`

The hero tool. Its contract is where FR-014 is enforced structurally.

**Description shown to the model**:
> Finds a catalogue entity (superclass, subclass, or event type) by a partial,
> case-insensitive name, and returns it with its immediate children. If several entities
> match, returns ALL of them as candidates without choosing — present the candidates to the
> user and ask which they mean; do not pick one yourself. If the query is too broad, returns
> guidance on how to narrow it. Always relay any data-completeness caveat to the user.

**Input**:

| Param | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` (min 1, non-blank) | yes | Partial, case-insensitive |
| `instances` | `string[]` (min 1) | no | Codes or URNs; defaults to configured set (FR-017) |

**Output** — discriminated on `kind`:

```jsonc
// exactly one match
{ "kind": "resolved",
  "entity": { "id": "...", "name": "...", "type": "subclass", "ancestors": [...] },
  "children": [ { "id": "...", "name": "...", "type": "eventType", "ancestors": [...] } ],
  "completeness": { ... } }        // aggregated across BOTH hops

// several matches — none chosen
{ "kind": "candidates",
  "candidates": [ /* each with ancestors, the distinguishing detail */ ],
  "completeness": { ... } }

// nothing matched — NOT an error
{ "kind": "none", "completeness": { ... } }

// too many to be useful
{ "kind": "tooBroad", "matchCount": 312,
  "narrowBy": ["a more specific name", "instances"],
  "completeness": { ... } }
```

**GMA mapping** (2 hops max):
1. `POST /v5/searchByName` — body `{ name, instancesList? }` → hierarchy triples (R3)
2. Only when exactly one match, one level down per FR-025:
   - matched `subclass` → `GET /v5/subclasses/{id}/eventTypes`
   - matched `superclass` → `GET /v5/superclasses/{id}` (children inline)
   - matched `eventType` → **no second hop** (children would be events, out of scope)

Completeness is aggregated across both hops: a 206 on either marks the whole result
incomplete (FR-008, SC-011).

**Requirements**: FR-012–FR-015, FR-017, FR-025, FR-005–FR-008. **Story 2 (P2)**.

---

## 3. `get_catalogue_entity`

**Description shown to the model**:
> Retrieves a catalogue entity's details by its type and id — use when you already have an
> id, e.g. one the user chose from a candidate list. To find an entity by name instead, use
> find_catalogue_entity. Relay any data-completeness caveat to the user.

**Input**:

| Param | Type | Required |
|---|---|---|
| `type` | `'superclass' \| 'subclass' \| 'eventType'` | yes |
| `id` | `string` (URN) | yes |
| `instances` | `string[]` | no |

**Output**: `{ entity: CatalogueEntity, completeness: Completeness }`

**GMA mapping**: `GET /v5/{superclasses|subclasses|eventTypes}/{id}`.
404 → `ToolError{ kind: 'notFound' }`; unsupported `type` → `argument` error, rejected by
schema validation before any call.

**Requirements**: FR-016, FR-005–FR-007. **Story 3 (P3)**.

---

## Error contract (all tools)

| Condition | HTTP | `kind` | Result |
|---|---|---|---|
| All instances succeeded | 200 | — | data, `complete: true` |
| Some instances failed | 206 | — | data + caveat, `complete: false` |
| Match count > threshold | 200 | — | `kind: 'tooBroad'` + `narrowBy` |
| Timeout, some data | — | — | data + caveat, `TIMEOUT_PARTIAL` |
| Timeout, no data | — | `upstream` | error |
| Bad arguments | 400 | `argument` | error — agent self-corrects |
| Unknown instance code | — | `argument` | error naming `list_instances` |
| Identity invalid/expired | 401 | `auth` | error — human re-authenticates |
| Unknown id | 404 | `notFound` | error |
| Upstream failure | 500 | `upstream` | error |

**Note (R1)**: this table is keyed on **HTTP status**, because v5 has no `status.code`
envelope. The constitution's Principle II table is keyed on the envelope and needs a PATCH
amendment to match. The *semantics* are unchanged — only the signal's shape.

---

## Transport contract

- **This slice**: stdio only (FR-023). One MCP server exposing the three tools above.
- **Health**: a `healthcheck` capability answerable without identity (FR-021).
- **Later, additively**: the same registered tools mounted on Streamable HTTP at
  `/mcp/catalogue`. No tool definition changes (FR-023b) — verified by registering tools in
  a transport-agnostic module that both entrypoints import.
