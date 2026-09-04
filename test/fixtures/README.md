# GMA fixture library

The constitution (v1.0.2, _Development Workflow & Quality Gates_) makes this library
**blocking**: a fixture must exist for every distinguishable upstream outcome, for every GMA
operation a tool depends on, and a hand-crafted fixture must record that it was hand-crafted.

## Provenance

**Every fixture in this directory is hand-crafted from the OpenAPI schema, not captured from a
live GMA.** None has been observed against a running instance.

- **Source of truth**: `gma-api/src/main/resources/static/api_catalogue.yaml` (the v5 catalogue
  surface), as analysed in [research.md](../../specs/001-catalogue-mcp-tools/research.md) R1 and R3.
- **Why hand-crafted**: partial failure (`206`) and transport timeouts cannot be provoked on
  demand against a live BFF, and live GMA access is a manual pre-release step that is never part
  of CI. Constitution: _"Hand-crafting a fixture from the OpenAPI schema is acceptable when the
  real response cannot be captured; the fixture MUST record that it was hand-crafted."_
- **Consequence to keep in mind**: these fixtures are faithful to the _schema_, so they prove the
  client parses the declared contract correctly. They cannot prove GMA's runtime behaviour matches
  its own schema. That gap is closed by the manual live validation in
  [quickstart.md](../../specs/001-catalogue-mcp-tools/quickstart.md) Validation 3, not here.
- Entity names (`Football`, `Premier League`, `Winner`) and instance codes (`PP`, `BF`) are
  illustrative. No real host, credential, or personal datum appears anywhere in this library.

## Outcome coverage

Fixtures are keyed by **HTTP status**, not by a `status.code` envelope: the v5 catalogue surface
has no such envelope (research.md R1). A `status.code` fixture set would be fiction.

### `instances/` — `GET /v5/instances`

| Fixture                 | Outcome                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `200-success.json`      | all config sources answered                                    |
| `206-partial.json`      | one config source failed, with a per-instance `errors[]` entry |
| `400-bad-request.json`  | malformed argument → agent self-corrects                       |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates           |
| `500-server-error.json` | nothing usable                                                 |

### `searchByName/` — `POST /v5/searchByName`

This operation declares only `200 / 400 / 401 / 500` — **notably not `206`** (research.md R2).
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

### `entities/` — `GET /v5/{superclasses,subclasses,eventTypes}/{id}` and `GET /v5/subclasses/{id}/eventTypes`

| Fixture                        | Outcome                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`             | a subclass with its parent superclass inline                                                                            |
| `200-superclass.json`          | a superclass with its subclasses inline (children of a matched superclass)                                              |
| `200-eventType.json`           | an event type with its full ancestor chain                                                                              |
| `200-eventTypes-children.json` | `GET /v5/subclasses/{id}/eventTypes` — the second hop for a matched subclass                                            |
| `206-partial.json`             | second-hop partial failure, so a `206` on hop 2 alone can be shown to mark the whole result incomplete (FR-008, SC-011) |
| `206-partial-entity.json`      | single-entity retrieval with a failed config source                                                                     |
| `404-not-found.json`           | unknown identifier → `kind: 'notFound'`                                                                                 |
| `401-unauthorized.json`        | identity invalid or expired                                                                                             |
| `500-server-error.json`        | nothing usable                                                                                                          |

## The timeout outcome has no fixture, by design

`REQUEST_TIMEOUT` does not exist on the v5 surface (research.md R1): a timeout produces **no HTTP
response at all**. It is therefore simulated in tests with a delayed `msw` handler plus an abort
signal, which is what preserves the spec's distinction between _timeout with partial data already
gathered_ (result + caveat, `TIMEOUT_PARTIAL`) and _timeout with nothing usable_ (a `ToolError`) —
FR-010.

## Vocabulary

These files intentionally use GMA's **upstream** vocabulary — `successfulConfigSources`,
`failedConfigSources`, `errors[].configSource` — because that is what GMA sends. It is translated
to the project's `instance` vocabulary at the client boundary (`src/core/completeness.ts`) and must
never appear in a tool schema (constitution Principle IV).
