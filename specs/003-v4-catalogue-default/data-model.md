# Phase 1 Data Model: v4 Catalogue Surface by Default

**Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

New and changed internal types only. Types this feature does **not** touch —
`Completeness`, `Outcome`, `InstanceError`, `GmaResult<T>`, `ToolError`, `ErrorKind`,
`CatalogueEntity`, `BrandInstance`, `Ancestor`, and every tool input/output schema — are
specified in [001's data model](../001-catalogue-mcp-tools/data-model.md) and are unchanged
(R10). Nothing here appears in a tool schema (Principle IV, FR-012).

---

## 1. `Generation` — which upstream catalogue generation

```ts
export type Generation = 'v4' | 'v5';
```

A closed enum, not a string. Two values because two exist upstream (R1). It is the **only**
new vocabulary this feature introduces, and it is confined to `core/surface.ts`,
`core/config.ts`, one telemetry field, and each domain's operation declarations.

| Rule | Why |
|---|---|
| MUST NOT appear in any tool input or output schema | FR-012 — upstream mechanics stay hidden from the model |
| MUST NOT be derivable from an agent-supplied value | FR-013, Story 3 scenario 4 |
| MUST NOT appear in an error message shown to the model | FR-012; R7 makes error text read `getEventType`, not a versioned path |

---

## 2. `CatalogueOperation` — a logical operation id

```ts
export type CatalogueOperation =
  | 'listInstances'
  | 'searchByName'
  | 'getSuperclass'
  | 'getSubclass'
  | 'getEventType'
  | 'subclassEventTypes';
```

Exactly the six operations the three tools use (R1). Tools name operations from this union
and never name a path — that is what makes FR-003's "exactly one place decides" structural
rather than a convention.

The names are deliberately **generation-free**, so a log or dashboard keyed on
`listInstances` survives a generation change instead of splitting into two series (R7).

---

## 3. `OperationDescriptor` — availability, and the path per generation

One entry per `CatalogueOperation`, in a frozen table in `core/surface.ts`. This table is the
single encoding of R1's findings.

```ts
interface OperationDescriptor {
  readonly method: 'GET' | 'POST';
  /** Generations that offer this operation. Non-empty. */
  readonly availableOn: readonly Generation[];
  /** Path template per available generation. Keys === availableOn. */
  readonly paths: Readonly<Partial<Record<Generation, string>>>;
  /**
   * Where instance scoping goes. OMITTED for an operation that takes no instance
   * scoping at all (`listInstances`), so the table never carries a misleading value.
   */
  readonly instancesIn?: 'query' | 'body';
}
```

| Operation | Method | `availableOn` | v4 path | v5 path | `instancesIn` |
|---|---|---|---|---|---|
| `listInstances` | GET | v4, v5 | `/v4/instances` | `/v5/instances` | *(neither — unscoped)* |
| `searchByName` | POST | **v5 only** | — | `/v5/searchByName` | `body` |
| `getSuperclass` | GET | v4, v5 | `/v4/superclasses/{id}` | `/v5/superclasses/{id}` | `query` |
| `getSubclass` | GET | v4, v5 | `/v4/subclasses/{id}` | `/v5/subclasses/{id}` | `query` |
| `getEventType` | GET | v4, v5 | `/v4/eventTypes/{id}` | `/v5/eventTypes/{id}` | `query` |
| `subclassEventTypes` | GET | v4, v5 | `/v4/subclasses/{id}/eventTypes` | `/v5/subclasses/{id}/eventTypes` | `query` |

`searchByName`'s single-entry `availableOn` is the whole reason FR-006's startup check exists.
It is data, so it is testable: a test asserts `availableOn` is exactly `['v5']` and that
`paths` has no `v4` key.

**Validation rules** (asserted by a unit test over the table, not left to review):

1. `availableOn` is non-empty.
2. `paths` keys are exactly `availableOn` — no path for an unavailable generation, no missing
   path for an available one.
3. Each path starts with `/` and its first segment is that generation's own name. This is what
   catches a copy-paste that leaves a v5 path under the `v4` key — the single most likely edit
   mistake in this table.
4. `instancesIn` is `'body'` only for POST operations (R1: GETs take `instancesList` as a query
   parameter, `searchByName` takes it in the body — an asymmetry that already exists and is
   simply moved into the table), and is **absent** exactly for `listInstances`.

---

## 4. `OperationPin` — a capability's declared requirement

A capability declares, per operation, that it needs a specific generation regardless of the
deployment default (FR-005, R5).

```ts
type OperationPins = Readonly<Partial<Record<CatalogueOperation, Generation>>>;
```

The catalogue domain's declaration:

```ts
export const CATALOGUE_PINS: OperationPins = Object.freeze({
  // v4 has no by-name search at all (research.md R1), so this is a fact about
  // upstream, not a preference. Removing it makes startup fail, by design.
  searchByName: 'v5'
});
```

**Per operation, not per capability** (R5): `find_catalogue_entity` needs its search on v5 while
its child listing follows the default. A capability-wide pin cannot express that and would
silently drag the child listing onto v5, defeating the feature for the most important tool.

Absence of a pin is meaningful: it means "follow the deployment default". It never means
"try one and fall back" (FR-002).

---

## 5. `ResolvedOperation` — the handle a tool holds

The output of startup resolution, and the only operation-shaped value a tool ever sees.

```ts
interface ResolvedOperation {
  readonly operation: CatalogueOperation;
  readonly generation: Generation;
  readonly method: 'GET' | 'POST';
  readonly pathTemplate: string;
  readonly instancesIn?: 'query' | 'body';
}
```

A tool receives a `Record<CatalogueOperation, ResolvedOperation>` for the operations it
declared and passes handles to the client. A tool therefore **cannot** name a generation, name
a path, or choose either — the capability is absent from its vocabulary, which is a stronger
guarantee than a rule saying it must not (FR-003, FR-012).

### Resolution rule

```
resolveOperations({ capability, operations, pins, defaultGeneration })

effective(op) = pins[op] ?? config.defaultGeneration
REQUIRE  effective(op) ∈ descriptor(op).availableOn      ← else startup fails (FR-006)
pathTemplate = descriptor(op).paths[effective(op)]        ← guaranteed present by rule 2 above
```

Resolution runs **once**, at startup, for every operation every registered capability declares.
No per-call decision exists anywhere (FR-003).

`capability` is an input purely so the failure message below can name it. Resolution MUST NOT
branch on it — a capability name that changed behaviour would be a second decision point, which
is exactly what FR-003 forbids.

### Failure mode

An unsatisfiable pin or default throws a `config` `ToolError`, so the process refuses to start
(FR-006, FR-014, consistent with the existing `loadConfig` behaviour). The message must name
the capability, the operation, the effective generation, and the generations that do offer it —
enough for an operator to fix it without reading source. It carries no credential and no
personal datum (001-FR-020).

---

## 6. `Config` — one added field

The only change to the existing `Config` interface:

| Field | Type | Env var | Required | Default |
|---|---|---|---|---|
| `defaultGeneration` | `Generation` | `GMA_CATALOGUE_GENERATION` | **No** | `'v4'` |

Deliberately **optional** (R6): unset must mean v4 (FR-013), and the default is the safe value,
so adding it to `REQUIRED_VARS` would break existing deployments for no safety gain. An
*invalid* value still fails startup (FR-014) — absent and wrong are different, and only one of
them is an operator error.

Accepted: exactly `v4` or `v5`. Unset or empty → `v4`. Anything else → a `config` `ToolError`
naming the variable and the accepted values.

Every existing `Config` field is unchanged.

---

## 7. Telemetry fields

| Field | Change | Values |
|---|---|---|
| `generation` | **added** to `LOG_FIELD_ALLOWLIST` | `'v4'` \| `'v5'` |
| `operation` | **re-keyed** | now the logical id (`listInstances`), was `GET /v5/instances` |
| `path` | unchanged in name; now the resolved template | e.g. `/v4/subclasses/{id}/eventTypes` |

`generation` is a two-value enum — no credential, no identifier, no personal datum — so it is
safe under 001-FR-020 and satisfies FR-015/SC-009. The allowlist remains the only egress path for
both logs and span attributes, so one addition covers both.

Re-keying `operation` is a visible contract change to log output, made deliberately (R7) and
called out so it is not read as a regression. Existing tests asserting the old format must be
updated.

---

## 8. Corrected read shapes (R8 — pre-existing defects)

Not new types: corrections to how two existing response bodies are read. Both generations
declare these identically (R2), so one correction serves both.

| Read site | Currently reads | GMA actually returns | Effect of the bug |
|---|---|---|---|
| `traversal.ts` — subclass children | `data.eventTypes[]` | `data.entities[]` (`EntitiesResponse`) | `children: []` for every subclass, with `complete: true` |
| `getCatalogueEntity.ts` — `collectAncestors` | nested `node.subclass.superclass` objects | flat `superclassId` / `superclassName` / `subclassId` / `subclassName` scalars | `ancestors: []` always, so 001-FR-014's distinguishing detail is absent |

Corrected ancestry derivation, from flat scalars:

- **superclass** → `ancestors: []` (no parent exists)
- **subclass** → `[{ id: superclassId, name: superclassName, type: 'superclass' }]`
- **eventType** → `[{ id: superclassId, name: superclassName, type: 'superclass' },`
  `{ id: subclassId, name: subclassName, type: 'subclass' }]`

Order stays broadest-first, matching the existing `ancestors` contract, so **no tool schema
changes** — the field simply stops being empty. A missing or blank scalar yields a shorter
chain rather than a fabricated entry: an invented ancestor id an agent might then try to fetch
is worse than a shorter path.

The superclass-children hop (`superclass.subclasses`) and `mapSearchResults.ts` were both
verified **correct** and are not touched (R8).

Three fixtures are corrected to match the schema they claim as their source:
`entities/200-eventTypes-children.json` (`eventTypes` → `entities`),
`entities/200-success.json` and `entities/200-eventType.json` (nested parent objects → flat
scalars). `entities/206-partial.json` and `206-partial-entity.json` need the same treatment for
the same reason.
