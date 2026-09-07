# GMA fixture library

The constitution (v1.1.0, _Development Workflow & Quality Gates_) makes this library
**blocking**: a fixture must exist for every distinguishable upstream outcome, for every GMA
operation a tool depends on, and a hand-crafted fixture must record that it was hand-crafted.

## Provenance

**Every fixture in this directory is hand-crafted from the OpenAPI schema, not captured from a
live GMA.** None has been observed against a running instance.

- **Source of truth**: `gma-api/src/main/resources/static/api_catalogue.yaml` (v5) and
  `api_catalogue_v4.yaml` (v4), as analysed in
  [001 research.md](../../specs/001-catalogue-mcp-tools/research.md) R1/R3 and
  [003 research.md](../../specs/003-v4-catalogue-default/research.md) R2/R8.
- **Why hand-crafted**: partial failure (`206`) and transport timeouts cannot be provoked on
  demand against a live BFF, and live GMA access is a manual pre-release step that is never part
  of CI. Constitution: _"Hand-crafting a fixture from the OpenAPI schema is acceptable when the
  real response cannot be captured; the fixture MUST record that it was hand-crafted."_
- **Consequence to keep in mind**: these fixtures are faithful to the _schema_, so they prove the
  client parses the declared contract correctly. They cannot prove GMA's runtime behaviour matches
  its own schema. That gap is closed by the manual live validation in
  [003 quickstart.md](../../specs/003-v4-catalogue-default/quickstart.md) Validation 4c, not here.
- Entity names (`Football`, `Premier League`, `Winner`) and instance codes (`PP`, `BF`) are
  illustrative. No real host, credential, or personal datum appears anywhere in this library.

### ⚠️ Five fixtures previously contradicted this stated source of truth (corrected 2026-09-07)

Recorded at length because it is the most instructive thing in this directory, and because the
failure mode is invisible to a passing test suite.

**What was wrong.** Five entity fixtures were crafted to match what the _implementation_ assumed,
not what the schema declares:

| Fixture                                 | Was                                          | Schema says                                                            | Effect against real GMA                                                           |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `entities/200-eventTypes-children.json` | `{ "eventTypes": [...] }`                    | `EntitiesResponse` = `{ entities: Entity[] }`                          | every matched subclass reported **no children**, under a fully-successful verdict |
| `entities/206-partial.json`             | same `eventTypes` key                        | same                                                                   | same, on the partial-success path                                                 |
| `entities/200-success.json`             | nested `subclass.superclass` object          | flat `superclassId` / `superclassName`                                 | `ancestors` was **always empty**                                                  |
| `entities/200-eventType.json`           | nested `eventType.subclass.superclass` chain | flat `superclassId` / `superclassName` / `subclassId` / `subclassName` | same                                                                              |
| `entities/206-partial-entity.json`      | nested `subclass.superclass` object          | flat scalars                                                           | same                                                                              |

Two inline response bodies in `test/protocol/smoke.test.ts` encoded the same two mistakes and were
corrected with them.

**Why the suite was green.** Implementation and fixture agreed with each other and disagreed with
GMA. A test can only compare code against the double it was given, so a double built from the code's
own assumptions asserts nothing. Both defects would have shipped as confidently-wrong answers: an
agent told a subclass has no event types, and candidate lists stripped of the ancestor path that
001-FR-014 relies on to tell two same-named entities apart.

**The rule this establishes.** _When a fixture and the OpenAPI schema disagree, the schema is
authoritative and the fixture is the defect_ — including, and especially, when the implementation
agrees with the fixture. Recording that a fixture is hand-crafted (as this file always did) licenses
crafting it from the schema; it does not license contradicting the schema. That is now written into
the constitution's fixture gate rather than left as folklore.

**What to do when correcting one.** Change the fixture first and watch the suite go **red**. A green
suite after correcting a fixture means the correction did not land, or a test asserts something
weaker than it appears to — which is exactly how these five survived. The corrected shapes are
additionally pinned by inline-bodied tests named `case: subclass children are read from entities[]`
and `case: ancestry is derived from flat scalars, not nested objects`, so a future fixture edit
cannot quietly move what they assert.

Verified 2026-09-07 against both catalogue specs, GMA's `SearchCatalogueApiDelegateImpl`, and its
`gbp.gma.domain.catalogue` records.

## One body serves both catalogue generations

Upstream publishes two current catalogue generations, **v4** (the default) and **v5**. This library
is **not** forked by generation: one response body serves both, and the tables below name paths as
`/{v}/…` where both offer the operation.

**Why that is sound rather than merely convenient.** For every field these tools read, the two
generations declare shape-identical responses — verified field by field on **2026-09-07** and
recorded in [003 research.md](../../specs/003-v4-catalogue-default/research.md) R2. The three
differences that exist are all outside the read set: v5's `Instance` adds an optional `shortName`;
v4 has `mappedIds` at the `Superclass` top level where v5 moves it under `settings`; and
`Filter.status` / `Filter.bettingStatus` differ on an operation no tool uses.

**What makes the sharing honest.** The **request handler** is bound per generation
(`describe.each(['v4','v5'])` mounting at that generation's own path), and each parameterised run
asserts the request reached the expected path and produced an identical parsed result. So routing is
genuinely exercised twice; only the body is shared. Duplicating a 21-file library with
byte-identical content would create two copies of the same fiction that drift independently.

**The residual risk, stated rather than hidden.** Shape identity is a claim about upstream, and CI
cannot check it: `../gma-service` is a separate repository that is not guaranteed present, and the
constitution forbids CI depending on live GMA. Vendoring both OpenAPI files here to diff
automatically was considered and rejected — a vendored copy is stale the moment upstream merges,
converting a real check into false reassurance. Instead the claim is **re-verified by hand** before
any release that changes generation behaviour, per
[003 quickstart.md](../../specs/003-v4-catalogue-default/quickstart.md) Validation 5, and the
verification date is carried in research R2. Any divergence means forking the affected fixture by
generation and updating R2 with the new finding.

## Outcome coverage

Fixtures are keyed by **HTTP status**, not by a `status.code` envelope: neither catalogue generation
has such an envelope (001 research R1, 003 research R2). A `status.code` fixture set would be
fiction.

### `instances/` — `GET /{v}/instances`

| Fixture                 | Outcome                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `200-success.json`      | all config sources answered                                    |
| `206-partial.json`      | one config source failed, with a per-instance `errors[]` entry |
| `400-bad-request.json`  | malformed argument → agent self-corrects                       |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates           |
| `500-server-error.json` | nothing usable                                                 |

### `searchByName/` — `POST /v5/searchByName` (**v5 only**)

The one operation with no `/{v}/` in its path, because **v4 has no by-name search at all** — zero
case-insensitive occurrences in `api_catalogue_v4.yaml`, verified 2026-09-07 (003 research R1). It
was added to v5 recently and to no v4 file. That single fact is why generation pins are declared
**per operation**: `find_catalogue_entity` searches on v5 and lists children on the v4 default,
within one tool call.

So these fixtures are mounted at the v5 path only, and there is no v4 double for this operation —
not an omission, but all the upstream declares.

This operation declares only `200 / 400 / 401 / 500` — **notably not `206`** (001 research R2).
There is deliberately no `206` fixture here; adding one would assert a response GMA does not
declare.

| Fixture                 | Outcome                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `200-single-match.json` | exactly one match → resolve and traverse one level                                                       |
| `200-multi-match.json`  | three matches all named "Winner", distinguished only by their ancestor path — the case FR-014 exists for |
| `200-no-match.json`     | zero matches → `kind: 'none'`, which is not an error                                                     |
| `200-many-matches.json` | 40 matches, above the default `GMA_MAX_CANDIDATES` of 25 → drives the client-derived too-broad path      |
| `400-bad-request.json`  | blank `name` rejected upstream                                                                           |
| `401-unauthorized.json` | identity invalid or expired                                                                              |
| `500-server-error.json` | nothing usable                                                                                           |

### `entities/` — `GET /{v}/{superclasses,subclasses,eventTypes}/{id}` and `GET /{v}/subclasses/{id}/eventTypes`

| Fixture                        | Outcome                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`             | a subclass carrying its parent as flat `superclassId` / `superclassName` scalars                                        |
| `200-superclass.json`          | a superclass with its subclasses inline (children of a matched superclass) — see the note below                         |
| `200-eventType.json`           | an event type with both ancestry levels as flat scalars                                                                 |
| `200-eventTypes-children.json` | `GET /{v}/subclasses/{id}/eventTypes` — the second hop for a matched subclass, keyed `entities`                         |
| `206-partial.json`             | second-hop partial failure, so a `206` on hop 2 alone can be shown to mark the whole result incomplete (FR-008, SC-011) |
| `206-partial-entity.json`      | single-entity retrieval with a failed config source                                                                     |
| `404-not-found.json`           | unknown identifier → `kind: 'notFound'`                                                                                 |
| `401-unauthorized.json`        | identity invalid or expired                                                                                             |
| `500-server-error.json`        | nothing usable                                                                                                          |

### `200-superclass.json` is correct as written — do not "fix" it

Worth stating explicitly, because it sits beside five files that **were** corrected for exactly
this class of mistake (see Provenance above), and the nesting looks like the same error.

`superclass.subclasses[]` is genuinely what both generations return. `SuperclassResponseSuccess`
wraps `superclass: Superclass`, and `Superclass` declares `subclasses` as an array of `Entity`
(verified 2026-09-07 in both `api_catalogue_v4.yaml` and `api_catalogue.yaml`). A superclass's
children arrive **inline on the entity itself**, which is why the matched-superclass hop reads
`/{v}/superclasses/{id}` rather than a separate children operation.

The corrected files are different: they nested a **parent** where the schema has flat scalars, or
named a collection `eventTypes` where the schema says `entities`. Nesting a **child** collection
under its own entity is what the schema actually declares.

## The timeout outcome has no fixture, by design

`REQUEST_TIMEOUT` does not exist on either catalogue generation (001 research R1): a timeout produces **no HTTP
response at all**. It is therefore simulated in tests with a delayed `msw` handler plus an abort
signal, which is what preserves the spec's distinction between _timeout with partial data already
gathered_ (result + caveat, `TIMEOUT_PARTIAL`) and _timeout with nothing usable_ (a `ToolError`) —
FR-010.

## Vocabulary

These files intentionally use GMA's **upstream** vocabulary — `successfulConfigSources`,
`failedConfigSources`, `errors[].configSource` — because that is what GMA sends. It is translated
to the project's `instance` vocabulary at the client boundary (`src/core/completeness.ts`) and must
never appear in a tool schema (constitution Principle IV).
