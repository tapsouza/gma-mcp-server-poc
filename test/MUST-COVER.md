# Must-cover matrix

The constitution (v1.0.2, _Development Workflow & Quality Gates_) makes these cases
**blocking**, and requires each to be "covered by a test naming the case". This file is the
audit: every row names the `describe('case: …')` block that covers it.

Verified by `npm test` — 3 tool suites, 8 unit suites, 1 protocol suite.

## Quickstart must-cover list

| Case (quickstart.md Validation 1)                          | Named test block                                                                                                                                                                                                                                                 | File                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Single match → resolved + children                         | `case: scenario 1 — single match resolves with its immediate children (FR-013, SC-011)`                                                                                                                                                                          | `integration/findCatalogueEntity.test.ts`                                                     |
| Several matches → all candidates, none chosen              | `case: scenario 2 — several matches return all candidates, none resolved (FR-014, SC-002)` and `case: several matches return ALL candidates and auto-pick NONE (FR-014, SC-002)`                                                                                 | `integration/findCatalogueEntity.test.ts`, `unit/resolve.test.ts`                             |
| Zero matches → `kind: 'none'`, not an error                | `case: scenario 3 — no match is "none", not an error (FR-010)` and `case: zero matches is "none", not an error and not a caveat (FR-010)`                                                                                                                        | `integration/findCatalogueEntity.test.ts`, `unit/resolve.test.ts`                             |
| HTTP 206 on hop 1 → caveat at top level                    | `case: scenario 5 — a partial hop marks the WHOLE result incomplete (FR-008, SC-011)` ("hop 1 ALONE was partial")                                                                                                                                                | `integration/findCatalogueEntity.test.ts`                                                     |
| HTTP 206 on hop 2 only → whole result incomplete           | `case: scenario 5 …` ("hop 2 ALONE was partial") and `case: multi-hop aggregation (FR-008, SC-011)`                                                                                                                                                              | `integration/findCatalogueEntity.test.ts`, `unit/completeness.test.ts`                        |
| Match count > threshold → `tooBroad` + `narrowBy`          | `case: scenario 4 — too broad returns no resolution plus a narrowing hint (FR-015)` and `case: too many matches gives no resolution plus a narrowing hint (FR-015)`                                                                                              | `integration/findCatalogueEntity.test.ts`, `unit/resolve.test.ts`                             |
| 400 → `argument`                                           | `case: a malformed argument is an argument error (FR-010, SC-008)` (×2 tools), `case: terminal failures on hop 1`, `case: 400 and local argument errors let the agent self-correct (SC-008)`                                                                     | all 3 tool suites, `unit/errors.test.ts`                                                      |
| 401 → `auth`                                               | `case: scenario 3 — expired identity is an auth error a human can act on (FR-003)`, `case: 401 says a human must act, and is never framed as "no results" (FR-003)`                                                                                              | `integration/listInstances.test.ts`, `unit/errors.test.ts`                                    |
| 404 → `notFound`                                           | `case: scenario 2 — an unknown id is notFound, not an empty success`, `case: 404 reports absence rather than inviting a retry`                                                                                                                                   | `integration/getCatalogueEntity.test.ts`, `unit/errors.test.ts`                               |
| 500 → `upstream`                                           | `case: scenario 4 — upstream failure errors rather than returning an empty list`                                                                                                                                                                                 | `integration/listInstances.test.ts` (+ all suites)                                            |
| Timeout with partial data vs none                          | `case: scenario 5 …` ("reports TIMEOUT_PARTIAL when hop 2 times out but hop 1 produced the entity"), `case: timeout with no data is an upstream error, not partial data (FR-010)`, `case: timeout with partial data is distinct from timeout with none (FR-010)` | `integration/findCatalogueEntity.test.ts`, `unit/errors.test.ts`, `unit/completeness.test.ts` |
| Two identities in one process → no bleed                   | `identity isolation within one process (FR-023a, SC-010)` — 7 tests including concurrent interleaving                                                                                                                                                            | `integration/identityIsolation.test.ts`                                                       |
| Unknown instance code → `argument` naming `list_instances` | `case: unknown instance code is an argument error naming list_instances (FR-017, SC-008)`                                                                                                                                                                        | `unit/instances.test.ts` (+ both scoped tools)                                                |
| Token absent from all logs and span attributes             | `case: an unlisted key emits neither the key nor its value (FR-020, SC-006)`, `case: span attributes go through the same allowlist (SC-006)`, `case: no credential ever reaches an error message (FR-020, SC-006)`                                               | `unit/telemetry.test.ts`, `unit/errors.test.ts`                                               |

## SC-003: every outcome class, for every capability

SC-003 asks for all six upstream outcome classes plus authentication failure, per capability.
Two are structurally **not reachable** for the single-hop tools, and that is recorded as a
deliberate N/A with a test rather than left as a silent gap:

| Outcome                      | `list_instances`                                                                                                  | `find_catalogue_entity`                               | `get_catalogue_entity`                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Full success (200)           | ✅ scenario 1                                                                                                     | ✅ scenario 1                                         | ✅ scenario 1                                                                                     |
| Partial success (206)        | ✅ scenario 2                                                                                                     | ✅ scenario 5 (hop 1 and hop 2)                       | ✅ scenario 1 (partial caveat)                                                                    |
| Too broad                    | **N/A** — no input, so no query to narrow (`case: too-broad does not apply to this capability`)                   | ✅ scenario 4                                         | **N/A** — one id returns at most one entity (`case: too-broad does not apply to this capability`) |
| Timeout with data            | **N/A** — one hop, so no earlier data survives an abort (`case: timeout — … TIMEOUT_PARTIAL is unreachable here`) | ✅ hop 2 times out after hop 1 resolved               | **N/A** — one hop (`case: timeout — … TIMEOUT_PARTIAL is unreachable here`)                       |
| Timeout without data         | ✅ `case: timeout — with no data it is an error`                                                                  | ✅ client-level, `integration/gmaClient.test.ts`      | ✅ `case: timeout — with no data it is an error`                                                  |
| Outright failure (500)       | ✅ scenario 4                                                                                                     | ✅ `case: terminal failures on hop 1`                 | ✅ `case: scenario 2` (401/500 pair)                                                              |
| Authentication failure (401) | ✅ scenario 3                                                                                                     | ✅ `case: terminal failures on hop 1`, plus hop-2 401 | ✅ `case: scenario 2` (401/500 pair)                                                              |

Each N/A is asserted, not assumed: the test states why the outcome cannot arise and checks the
structural fact that makes it so (no query parameter; a single hop). If a later change gave one
of these tools a second hop or a search input, the corresponding row stops being N/A and needs a
real test — the assertion is what will make that visible.

## Fixture coverage

Every fixture in `fixtures/` is hand-crafted from the OpenAPI schema, as recorded in
[`fixtures/README.md`](./fixtures/README.md). `searchByName` has no `206` fixture because that
operation does not declare one (research.md R2), and the timeout outcome has no fixture at all
because a timeout produces no HTTP response (research.md R1).

---

## Feature 004 — the customer domain

The constitution's v1.1.0 additions for composite and read-only tools are blocking, and
quickstart.md 1b adds this feature's own seven. Rows are added per phase as tools land.

### Shared `core` changes (Phase 2)

| Case                                                                                                                | Named test block                                                                                                                               | File                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A composite answer missing a section is reported via `unavailableComponents` and is never `complete: true` (SC-001) | `case: the second failure axis — unavailableComponents (Principle II, FR-026)`                                                                 | `unit/completeness.test.ts` |
| The two completeness axes are never merged into one another                                                         | `case: aggregate unions the second axis independently (Principle II)` — "never turns a missing section into a failed instance, or the reverse" | `unit/completeness.test.ts` |
| A missing section tells the agent NOT to retry with different scoping                                               | `case: the second failure axis …` — "names the missing section in the caveat and tells the agent NOT to retry scoping"                         | `unit/completeness.test.ts` |
| Multi-hop aggregation where one hop's missing section flags the whole result                                        | `case: aggregate unions the second axis independently …` — "marks the whole result incomplete when ONE hop was missing a section"              | `unit/completeness.test.ts` |
| `403` produces a non-retryable `forbidden` error the agent does not retry (SC-009)                                  | `case: 403 is forbidden, never auth, and never retried (Principle I, FR-028, SC-009)`                                                          | `unit/errors.test.ts`       |
| `403` is never conflated with `auth`                                                                                | same block — "is its own kind, distinct from auth"                                                                                             | `unit/errors.test.ts`       |
| `424` maps to a retryable `upstream` error                                                                          | `case: 424 is a retryable upstream failure of a GMA dependency`                                                                                | `unit/errors.test.ts`       |
| Existing catalogue tests pass unmodified after the shared-type change (SC-012)                                      | Recorded as the T015 gate result in [tasks.md](../specs/004-customer-bet-tools/tasks.md)                                                       | whole suite                 |
| Both new configuration bounds are optional with a default and validated                                             | `case: the customer-domain bounds are optional with a default (Principle V, FR-010, FR-023)`                                                   | `unit/config.test.ts`       |

### `list_jurisdiction_contexts` (Phase 2)

| Case                                                                       | Named test block                                                                                                              | File                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Full success returns every jurisdiction, both completeness axes present    | `case: full success returns every jurisdiction with a complete verdict`                                                       | `integration/listJurisdictionContexts.test.ts` |
| A **non-derivable** code survives the mapping — the tool's justification   | same block — "carries a NON-DERIVABLE code through unchanged" and "surfaces that non-derivable code in the mapped result"     | `integration/listJurisdictionContexts.test.ts` |
| `401` → `auth`                                                             | `case: 401 is an auth error a human can act on (Principle I)`                                                                 | `integration/listJurisdictionContexts.test.ts` |
| **`403` → `forbidden`, not retryable** (quickstart 1b marks this blocking) | `case: 403 is forbidden and NOT retryable, never conflated with auth (SC-009)`                                                | `integration/listJurisdictionContexts.test.ts` |
| `500` → `upstream`, never an empty list                                    | `case: 500 is a retryable upstream error, not an empty list`                                                                  | `integration/listJurisdictionContexts.test.ts` |
| Zero-match (an empty upstream list) is not an error                        | `case: a context with no usable code is dropped rather than fabricated` — "returns an empty list for an empty upstream array" | `integration/listJurisdictionContexts.test.ts` |
| No upstream DTO vocabulary reaches the result or the description           | same blocks — "exposes no upstream DTO vocabulary in the result / to the model"                                               | `integration/listJurisdictionContexts.test.ts` |
| The description instructs the agent to relay caveats (FR-009)              | `case: the description instructs the agent as Principle IV and FR-009 require`                                                | `integration/listJurisdictionContexts.test.ts` |

**Not applicable, asserted rather than assumed**: this tool takes **no input**, so `400` /
`argument`, too-broad, multi-match and unknown-scoping-code have no reachable path — there is no
argument to malform and no query to narrow. `TIMEOUT_PARTIAL` is unreachable for the same reason
it is for `list_instances`: one hop, so no earlier data can survive an abort.
