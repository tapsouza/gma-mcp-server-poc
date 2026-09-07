# Phase 0 Research: v4 Catalogue Surface by Default

**Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Every Technical Context unknown is resolved below. Two findings should be read before the rest:

- **R1** — the v4/v5 operation gap that shapes the whole design.
- **R8** — **two pre-existing defects in the exact read path this feature touches**, plus the
  fixtures that hide them. R8 is not caused by this feature, but it determines whether this
  feature's central claim ("behaviour is unchanged across generations") can be honestly verified.

All upstream facts were read on **2026-09-07** from `../gma-service` at
`gma-api/src/main/resources/static/` and the Java sources beside them. That repository is **not**
available in CI, so these facts are recorded here as a dated verification rather than asserted by
an automated test — see R3 for how that gap is bounded.

---

## R1 — v4 is a strict subset of v5 for these tools, except `searchByName`, which v4 lacks entirely

**Decision**: Route the two non-search operations plus both child-listing operations to **v4** by
default, and keep the by-name search on **v5** because v4 has no equivalent operation of any kind.

**Evidence**:

| | `api_catalogue_v4.yaml` | `api_catalogue.yaml` |
|---|---|---|
| Declared version | `4.0.0` | `5.0.0` |
| Paths / operations | 14 / 21 | 22 / 30 |
| `deprecated: true` operations | **0** | **0** (its 2 `deprecated` mentions describe enum *values*) |
| `searchByName` | **absent — zero occurrences, case-insensitive** | `POST /v5/searchByName` |
| Served & auth-exempted | yes (`SecurityFilterFactory.java:61`) | yes (`:60`) |
| Upstream README status | "Catalogue Search, Retrieve and Overrides for **v4** Endpoints" | same wording for **v5** |

`searchByName` was added recently and only to v5 — upstream commit `63811f454`
*"[FEAT][FD][BLUE-1891]: Add name based search endpoint"*, which touches
`api_catalogue.yaml` and no v4 file. The v4 spec's last two commits (`e0348a14a`, `0f99349c7`)
predate it.

Every operation the three tools use, mapped:

| Logical operation | v4 | v5 |
|---|---|---|
| list instances | `GET /v4/instances` | `GET /v5/instances` |
| get superclass by id | `GET /v4/superclasses/{id}` | `GET /v5/superclasses/{id}` |
| get subclass by id | `GET /v4/subclasses/{id}` | `GET /v5/subclasses/{id}` |
| get event type by id | `GET /v4/eventTypes/{id}` | `GET /v5/eventTypes/{id}` |
| list a subclass's event types | `GET /v4/subclasses/{id}/eventTypes` | `GET /v5/subclasses/{id}/eventTypes` |
| **search by name** | **— does not exist —** | `POST /v5/searchByName` |

Same `operationId`s, same `instancesList` parameter (`$ref: '#/components/parameters/instancesList'`,
byte-identical definitions), same declared status sets on the same operations.

**Alternatives considered**:

- *Drop the by-name search and accept v4-only.* Rejected: it deletes the tool the whole server
  exists for, and the user asked to change which generation answers, not to lose a capability.
- *Emulate `searchByName` on v4* by listing superclasses, then subclasses, then event types and
  filtering client-side. Rejected on three counts: it is a fan-out of unbounded cardinality where
  today there is one call; the too-broad and partial-failure surface multiplies with every extra
  hop; and FR-007 explicitly forbids synthesising an absent upstream operation. The spec's own
  reasoning applies — traversal is the tool's job, but *inventing* an upstream capability is not.
- *Try v4, fall back to v5 on 404.* Rejected, and specifically prohibited by FR-002. A fallback
  emits a real request that really fails, pollutes upstream error metrics, and makes a
  configuration mistake indistinguishable from an upstream outage. A declared, startup-checked
  requirement fails at the only moment where failing is free.

---

## R2 — For every field these tools read, the two generations are shape-identical

**Decision**: One set of response-body fixtures serves both generations. Do not fork the fixture
library by generation.

**Evidence** — field by field, for the operations in R1's table:

| Read by | Field | v4 | v5 |
|---|---|---|---|
| `list_instances` | `instances[].id`, `.name` | ✅ | ✅ |
| completeness (all ops) | `successfulConfigSources`, `failedConfigSources`, `errors[].configSource`, `.message` | ✅ | ✅ |
| `get_catalogue_entity` | `{superclass\|subclass\|eventType}` wrapper | ✅ `SuperclassResponseSuccess`, `SubclassResponse`, `EventTypeResponse` | ✅ same schema names |
| entity identity | `.id`, `.name` (both via `$ref: Entity`) | ✅ | ✅ |
| ancestry | `superclassId`, `superclassName`, `subclassId`, `subclassName` — **flat scalars** | ✅ | ✅ |
| superclass children | `superclass.subclasses[]` (`Entity[]`) | ✅ | ✅ |
| subclass children | `entities[]` (`EntitiesResponse`) | ✅ | ✅ |

The three differences that exist are all outside the read set:

1. v5's `Instance` adds an optional `shortName`. Not read.
2. v4's `Superclass` has `mappedIds` at the top level; v5 moves it under `settings`. Not read.
3. v4's `Filter.status` is v5's `Filter.bettingStatus` — on `searchEventTypesFiltered`, an
   operation **no tool uses**.

**Why this is safe rather than convenient**: sharing a body fixture across generations is only
sound while the schemas agree, and CI cannot check that. Bounded by R3.

### Verification log (quickstart Validation 5)

Every re-verification of the parity claim above, dated. A release that changes generation behaviour
must add a row before shipping.

| Date | Result | Checked |
|---|---|---|
| 2026-09-07 | ✅ no divergence | Original field-by-field reading (this section). |
| 2026-09-07 | ✅ no divergence, at implementation time | Re-run against `../gma-service/gma-api/src/main/resources/static/`: 14 `/v4/` paths present; `searchbyname` has **0** case-insensitive occurrences in `api_catalogue_v4.yaml`; `deprecated: true` count is **0** on both files; `EntitiesResponse` is `{ entities: Entity[] }` on both; `Subclass` carries flat `superclassId`/`superclassName` and `EventType` adds flat `subclassId`/`subclassName` on both, with **no** nested parent object on either; `Superclass.subclasses[]` is `Entity[]` on both; `instancesList` is a query parameter with byte-identical definitions and only `POST /v5/searchByName` takes it in the body; **per-operation declared status sets are identical across generations** for every operation the tools use (`200/206/400/401/404/500`, with `/instances` omitting `400` and `404` on both). |

**Next re-verification is due** before any release that changes which generation a capability
consults, and whenever `../gma-service` changes its catalogue specs.

**Alternative considered**: duplicate every fixture under `v4/` and `v5/` trees. Rejected — it
would double a 21-file library with byte-identical content, and two copies of the same fiction
drift independently. FR-016's requirement is that a *double exists per generation*; the double is
the request handler bound to the generation's path, not the response body (R3).

---

## R3 — Fixtures shared, request handlers parameterised, schema parity re-verified by hand

**Decision**: Tests parameterise over generation at the **handler** level — `describe.each(['v4','v5'])`
mounting the handler at that generation's path — while sharing one body fixture. Two things make
this honest:

1. Each parameterised run asserts the **request went to the expected path** and the **parsed
   result is identical**. So the generation-routing logic is genuinely exercised twice; only the
   body is shared.
2. Schema parity (R2) is recorded here with a date, restated in `test/fixtures/README.md`, and
   added to `quickstart.md` as a **manual re-verification step** performed against `../gma-service`
   before any release that changes generation behaviour.

**Why not an automated parity test**: `../gma-service` is a separate repository that is not
guaranteed present, and the constitution forbids CI depending on live GMA. Vendoring both OpenAPI
files into this repo to diff them was considered and rejected: a vendored copy is stale the moment
upstream merges, which converts a real check into a false reassurance. A dated manual verification
that is honest about being manual is worth more than an automated test of a stale artefact.

---

## R4 — Generation is resolved **once at startup** into pre-resolved operation handles

**Decision**: Tools stop naming paths. `core/surface.ts` holds a table of logical operations and,
per operation, which generations offer it and each one's path template. At startup, each
capability's declared operation set is resolved into `ResolvedOperation` handles
(`{ operation, generation, pathTemplate }`), which are handed to the tools as a dependency. The
client takes a handle plus path parameters and interpolates.

```
config default generation ─┐
                           ├─► resolve once at startup ─► ResolvedOperation handles ─► tools
capability's per-op pins ──┘         (also the FR-006 availability check)
```

**Rationale**, requirement by requirement:

- **FR-003** ("exactly one place decides") is satisfied *literally*, not by convention. There is
  one resolver, called once. A tool holds a handle and has no way to express a generation.
- **FR-006** ("detected at startup, not first use") needs no separate validation pass — resolution
  *is* the check. An operation unavailable on its effective generation cannot produce a handle, so
  the process cannot start.
- **FR-012** (generation invisible to the model) holds structurally: nothing generation-shaped
  exists in a tool's argument surface to leak.
- It also removes a small existing duplication — `encodeURIComponent` on path ids is currently
  repeated in two tool modules and moves into the client.

**Alternatives considered**:

- *A `generation` field on every call's options.* Rejected: it re-creates the per-call decision
  FR-003 exists to remove, and the failure mode is a single call site quietly on the wrong
  generation — invisible in review, invisible in tests that mock only one generation.
- *A base-path prefix on the client (`${base}/v4`) with paths kept relative.* Tempting and small,
  but it cannot express `searchByName`, whose generation differs from the client's. One capability
  spanning two generations (Story 2 scenario 4) is not representable, so it fails the feature.
- *A `Generation` parameter threaded through every tool function.* Rejected: every tool signature
  grows a parameter it must not interpret, and "must not interpret" is exactly the kind of rule
  that decays.

---

## R5 — The pin is declared **per operation**, at the capability

**Decision**: Availability (`availableOn`) is a property of the **operation**. A **pin** is
declared by the **capability**, per operation it uses. Effective generation =
`pin ?? config.defaultGeneration`, then asserted against `availableOn`.

**Why not per-capability**: FR-005 says "per-capability requirement", but Story 2 scenario 4 asks
for a capability whose search step is v5 while its child-retrieval step is the default v4, with
completeness aggregated across both. A capability-wide pin cannot express that — pinning
`find_catalogue_entity` to v5 would silently drag its child listing to v5 too, quietly defeating
the feature for the tool that matters most. Per-operation pinning satisfies FR-005's actual
intent (declared once, not special-cased in calling code) **and** FR-002's prohibition on
fallback, because an unpinned v5-only operation makes startup fail loudly rather than resolve
itself.

Concretely, `find_catalogue_entity` declares:

| Operation | Pin | Effective (default v4) |
|---|---|---|
| `searchByName` | `v5` — v4 has no such operation | v5 |
| `subclassEventTypes` | *(none)* | v4 |
| `getSuperclass` | *(none)* | v4 |

Remove that one pin and the process refuses to start, naming the capability, the operation, and
the generation. That is the check having teeth.

---

## R6 — `GMA_CATALOGUE_GENERATION`, defaulting to `v4`, validated at startup

**Decision**: One new optional variable, `GMA_CATALOGUE_GENERATION`, accepting exactly `v4` or
`v5`, defaulting to **`v4`** when unset or empty. Anything else is a `config` `ToolError` that
prevents startup, naming the variable and listing the accepted values.

It joins the existing `Config` object as `defaultGeneration` and is read only by the startup
resolver (R4). It is **optional**, not required: unset must mean v4 (FR-013), so adding it to
`REQUIRED_VARS` would break every existing deployment for no safety gain — the default is the
safe value, which is precisely the case where fail-fast should not apply.

**Alternatives considered**: a boolean `GMA_USE_V5`. Rejected — it cannot name a third generation
without a second variable and a precedence rule, and `v4`/`v5` reads the same way in config as in
the upstream URL, so no translation is needed.

---

## R7 — Telemetry gains `generation`; `operation` becomes the *logical* label

**Decision**: Add `generation` to `LOG_FIELD_ALLOWLIST`. Change the `operation` field from an
HTTP-and-path label (`GET /v5/instances`) to the **logical operation id** (`listInstances`), with
the resolved template staying in the existing `path` field.

**Rationale**: FR-015 requires that diagnostics say which generation served a call, and the
allowlist is the only way a field reaches a log or a span. `generation` is a two-value enum — no
credential, no identifier, no personal datum — so it is safe under 001-FR-020 and SC-009.

Re-keying `operation` is a deliberate improvement rather than incidental churn: keeping
`operation` generation-free means a dashboard or alert keyed on `listInstances` keeps working
across a generation change instead of splitting into two series, while `path` + `generation`
carry the detail. It also *reduces* upstream leakage in agent-facing error text — a tool error
today reads `GMA returned HTTP 404 for GET /v5/eventTypes/{id}` and will read
`GMA returned HTTP 404 for getEventType`, which is closer to FR-012's intent (upstream mechanics
hidden from the model) than the status quo.

Existing tests assert the current label format and must be updated. That is a visible,
intentional contract change, recorded here so it is not mistaken for a regression.

---

## R8 — ⚠️ Two pre-existing defects in the read path this feature touches, hidden by fixtures that contradict GMA's schema

**This is the most consequential finding in this document and it is not about v4 at all.**

While verifying R2's field-by-field parity, the fields the implementation actually reads turned
out not to be the fields **either** generation returns.

### Defect 1 — the subclass child listing reads the wrong field

`src/domains/catalogue/traversal.ts` reads `result.data?.eventTypes` from
`GET /{v4,v5}/subclasses/{id}/eventTypes`.

Both generations declare that operation's `200` as `EntitiesResponse`, which is
`{ entities: Entity[] }`. Confirmed in GMA's own delegate
(`SearchCatalogueApiDelegateImpl.searchEventTypesByInstancesAndSubclassId`), which builds
`new EntitiesResponse()` and calls `setEntities(...)`. There is no `eventTypes` key in the
response.

**Effect against real GMA**: a matched subclass returns `children: []` — always. The tool reports
"no children" for every subclass, with `complete: true`, which is precisely the confidently-wrong
answer Principle II exists to prevent.

### Defect 2 — ancestry reads nested parent objects that do not exist

`src/domains/catalogue/tools/getCatalogueEntity.ts` → `collectAncestors` reads
`node.subclass.superclass` and `node.superclass` as nested objects.

Both generations declare ancestry as **flat scalars** on the entity: `Subclass` has
`superclassId` / `superclassName`; `EventType` has `superclassId` / `superclassName` /
`subclassId` / `subclassName`. Neither schema has a nested `superclass` or `subclass` object, and
GMA's domain records (`gbp.gma.domain.catalogue.Subclass`, `.EventType`) carry exactly those flat
fields.

**Effect against real GMA**: `ancestors` is always `[]`. Since `ancestors` is the field the schema
describes as "how two entities with the same name are told apart — always show it when presenting
candidates", 001-FR-014's distinguishing detail is silently absent.

### Why the tests are green

`test/fixtures/gma/entities/200-success.json`, `200-eventType.json`, and
`200-eventTypes-children.json` were hand-crafted (as `fixtures/README.md` honestly records) and
were crafted to match the **implementation's assumptions**, not the schema:

```jsonc
// 200-eventTypes-children.json — key is "eventTypes"; the schema says "entities"
{ "eventTypes": [ { "id": "urn:et:pl-winner", "name": "Winner" } ] }

// 200-success.json — nested "superclass" object; the schema says flat superclassId/superclassName
{ "subclass": { "id": "…", "superclass": { "id": "urn:sc:football", "name": "Football" } } }
```

Implementation and fixture agree with each other and disagree with GMA. The suite is therefore
green and proves nothing about these two paths. The fixture README's own stated source of truth —
`api_catalogue.yaml` — is what these files contradict, so this is a violation of the
constitution's fixture rule on its own terms, independent of this feature.

`mapSearchResults.ts` was checked and is **correct**: `SearchByNameResult` genuinely is a triple of
`Entity` objects, so the hierarchy-triple reading is right. The superclass child hop in
`traversal.ts` (`superclass.subclasses`) is also **correct**. Only the two paths above are wrong.

### Decision: correct the fixtures and the two read paths within this feature

**Rationale**, in order of weight:

1. **This feature's central promise cannot otherwise be verified.** FR-008/SC-002 promise the
   agent-facing result is unchanged, and FR-017 requires a test proving each capability consults
   v4. Both would be asserted against fixtures that match neither generation — verifying a change
   of generation against a body no generation sends.
2. **FR-016 makes it worse, not neutral.** It requires doubles covering both generations. Under
   R2's shared-fixture decision, the wrong body would be asserted twice.
3. **The constitution already forbids it.** A fixture must be derived from the OpenAPI schema; a
   hand-crafted one must record that it was hand-crafted — which these do — but recording the
   provenance does not license contradicting the source.
4. **The fix is small and mechanical**: one field name in `traversal.ts`, one function in
   `getCatalogueEntity.ts` rewritten from nested-object walking to flat-scalar reading, and three
   fixtures corrected. No tool schema, no `Completeness`, no identity path is touched.

**Alternative considered and rejected**: leave both defects, ship the generation change, and file
them separately. Rejected because it would mean writing new tests that assert known-false
behaviour, and re-affirming three fixtures known to contradict the schema — turning a passive
pre-existing bug into an actively re-endorsed one.

**Scope discipline**: this is a **correction of the same read path**, not licence to broaden the
feature. It is tracked as its own explicitly-labelled tasks, ahead of the generation work, so it
can be reviewed and reverted independently. It does **not** authorise refactoring, extra fields,
or new capabilities.

**Live verification is now mandatory, not optional.** Fixtures are hand-crafted, so a corrected
fixture is still only as good as this reading of the schema. `quickstart.md` Validation 3 is
promoted from a nice-to-have to a **required pre-release step** for these two paths specifically:
one real subclass fetched with children, one real event type fetched with ancestry.

---

## R9 — The constitution pins the v1 surface to v5 and must be amended before this ships

**Finding**: constitution v1.0.2, *Technology & Platform Constraints*, states:

> **v1 API surface**: the v5 catalogue API (`api_catalogue.yaml`) — `GET /v5/instances`,
> `POST /v5/searchByName`, `GET /v5/{superclasses|subclasses|eventTypes}/{id}`,
> `GET /v5/subclasses/{id}/eventTypes`, …

This feature contradicts that sentence directly. Governance is explicit — *"Where the
implementation plan and this constitution disagree, this constitution wins"* — so the amendment is
a **prerequisite**, not a follow-up.

**Also needing generalisation** (same amendment, same PR):

- Principle II's mapping table says `complete` requires "HTTP `200` on the **v5 catalogue
  surface**". The fact is true of v4 too; only the wording is v5-specific.
- The *"Deployed GMA partial-failure contract (verified 2026-09-03)"* subsection is titled and
  worded as v5-only ("declared on 28 v5 operations"). Its verified facts hold identically on v4
  (R1, R2) and should say so.
- The fixture-library gate names "the v5 catalogue surface" as the outcome source.

**Version bump**: **MINOR** (→ 1.1.0). It changes a *Technology & Platform Constraints* section
rather than removing or redefining a principle; every principle's rules survive verbatim. A
maintainer may reasonably argue MAJOR on the grounds that code compliant with the old sentence
(v5-pinned paths) is non-compliant with the new one — but the versioning policy scopes MAJOR to
*principles*, and no principle changes. The amendment PR should state this reasoning and let the
maintainer settle it; **no code from this feature should merge before it does.**

**Not a violation of Principle IV**: *"New tools MUST NOT be built on GMA endpoints marked
`deprecated: true`."* v4 has **zero** deprecated operations (R1) and is documented upstream as
current. Defaulting to v4 is therefore permitted by the letter and the intent of that rule. This
is worth stating explicitly because "prefer the newer version" is the intuition a reviewer will
arrive with, and here it is the upstream project itself that treats both as current.

---

## R10 — Unchanged by this feature, confirmed deliberately

Recorded so a reviewer can see these were checked rather than overlooked:

- **Identity** (Principle I): the token remains a per-invocation parameter. Generation resolution
  happens at startup and touches nothing identity-shaped. `identity.ts` is untouched.
- **Completeness derivation** (Principle II, FR-009): `completeness.ts` needs **no change at all**.
  The signal is the HTTP status on both generations, and the envelope field names are identical, so
  the single source of truth stays single. This is the strongest evidence the feature is well
  scoped — the most safety-critical module is not edited.
- **Module boundaries** (Principle III): `surface.ts` is domain-agnostic and belongs in `core/`.
  The startup availability check needs to see a domain's declarations, so it is wired in
  `server/register.ts` — which may import both — with `core/` exposing the validator and the
  domain exposing the data. No `core → domain` import is introduced; the ESLint rule and
  `architecture.test.ts` continue to enforce it.
- **Tool surface** (Principle IV, FR-008): still exactly three tools, same names, same input and
  output schemas. `schemas.ts` is untouched.
- **Config discipline** (Principle V): one new optional variable, read once at startup, never an
  agent argument, absent from every tool schema.
