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

### Provenance of the customer-domain fixtures (feature 004)

The four customer surfaces do **not** share the catalogue's provenance, and the difference is
recorded here because a reader would otherwise assume an OpenAPI source that does not exist.

| Directory          | Operation                            | Derived from                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crsAccounts/`     | `GET /crs/accounts/{accountId}`      | **The Java model classes**, read field-for-field — `AccountRiskSettings` → `AccountContextRiskSettings` → `AccountContextHierarchyGroup` → `HierarchyGroupMetadata` → `HierarchyGroupMetadataEntity`, plus `LiabilityGroup` and `EligibilityProfile`. This path appears in **no** OpenAPI spec (research.md R15) |
| `crsContexts/`     | `GET /crs/contexts`                  | `ContextEntity { contextName, contextId, contextCode }`, typed in `@flutter-global/gma-client` `endpoints/account/types.d.ts` (research.md R7)                                                                                                                                                                   |
| `qbsSearchBets/`   | `POST /qbs/graphql`                  | QBS `schema.graphql` (the `Bet`, `Leg`, `RiskInfo`, `WageInfo` types) plus the observed `200`-with-`errors[]` shape (`BetSearchClient.java:52`, research.md R1)                                                                                                                                                  |
| `customerMetrics/` | `POST /accounts/{accountId}/metrics` | `customer-metrics.yaml`, the `post:` block and its `oneOf` `400` shapes (research.md R12)                                                                                                                                                                                                                        |
| `events/`          | `GET /v5/events/{id}`                | `api_catalogue.yaml`, the `Event` schema. **Separate from `entities/`**: those are `eventType` documents from a different path and cover a different operation (research.md R5)                                                                                                                                  |

**Why `events/` is not covered by `entities/`.** The composite resolves each leg's event to
obtain its risk-side catalogue position, and `GET /v5/events/{id}` returns an `Event` carrying
`superclassId/Name`, `subclassId/Name` and `eventTypeId/Name` — three id/name pairs no existing
fixture holds. The existing `entities/` fixtures are `eventType` documents; using one here would
assert a response shape this operation does not return.

**No customer datum, anywhere.** Account, bet, and receipt identifiers in these fixtures are
obviously synthetic, no fixture carries a customer name, and monetary values are illustrative
round numbers. This is the same standing rule the catalogue fixtures follow, restated because
this surface is where breaking it would matter (Principle V).

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

### `crsContexts/` — `GET /crs/contexts`

The response is a **bare JSON array** of `ContextEntity`, not an object with a `contexts` key —
verified against `@flutter-global/gma-client`, whose `fetchCrsContexts` is typed
`Promise<ContextEntity[]>`. Getting this wrong would have produced an always-empty jurisdiction
list that still reported `complete: true`.

| Fixture                 | Outcome                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200-success.json`      | four jurisdictions, including Ontario's **`NXTCANBS`** — a code no derivation from a state name produces, and the concrete justification for `list_jurisdiction_contexts` |
| `401-unauthorized.json` | identity invalid or expired → human re-authenticates                                                                                                                      |
| `403-forbidden.json`    | identity valid, permission absent → `forbidden`, NOT retryable (SC-009)                                                                                                   |
| `500-server-error.json` | nothing usable → `upstream`, never an empty jurisdiction list                                                                                                             |

There is deliberately **no `206`** and no `400` fixture: `/crs/**` is a raw forwarding proxy that
declares no partial-failure contract at all (research.md R2), and this operation takes no
argument to malform.

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
