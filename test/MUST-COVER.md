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

### `get_customer_risk_profile` — User Story 1 (Phase 3)

| Case                                                                                   | Named test block                                                                                                                                                                             | File                                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Three jurisdictions return three configurations, none merged** (FR-006, SC-003)      | `case: scenario 1 — three jurisdictions return three configurations, unmerged (FR-006, SC-003)` and `case: three jurisdictions map to three configurations, nothing merged (FR-006, SC-003)` | `integration/getCustomerRiskProfile.test.ts`, `unit/riskConfiguration.test.ts` |
| Each override carries its named catalogue path, broadest-first (FR-007)                | `case: an override path is BROADEST-FIRST, matching the catalogue domain (FR-007)`                                                                                                           | `unit/riskConfiguration.test.ts`                                               |
| An empty override path keeps `entityId` and fabricates no name                         | `case: an EMPTY path keeps entityId and fabricates NO name`                                                                                                                                  | `unit/riskConfiguration.test.ts`                                               |
| An absent boxed scalar is `null`, never `0`                                            | `case: an absent boxed scalar becomes null, NEVER zero`                                                                                                                                      | `unit/riskConfiguration.test.ts`                                               |
| No returned configuration carries a staff-authored note (FR-004)                       | `case: staff-authored notes and staff names never survive the mapping (FR-004, Principle V)`                                                                                                 | `unit/riskConfiguration.test.ts`                                               |
| **Unknown account → `notFound`**, not an empty success with fabricated defaults        | `case: scenario 3 — an unknown account is notFound, not an empty success`                                                                                                                    | `integration/getCustomerRiskProfile.test.ts`                                   |
| `401` → `auth`, never framed as "no results"                                           | `case: scenario 4 — an expired identity is an auth error a human can act on (FR-003)`                                                                                                        | `integration/getCustomerRiskProfile.test.ts`                                   |
| **`403` → `forbidden`, not retryable, never conflated with `auth`** (FR-028, SC-009)   | `case: insufficient permission is forbidden, not retryable, never auth (FR-028, SC-009)`                                                                                                     | `integration/getCustomerRiskProfile.test.ts`                                   |
| `500` → `upstream`, never an empty configuration set                                   | `case: a 500 is a retryable upstream error, not an empty configuration set`                                                                                                                  | `integration/getCustomerRiskProfile.test.ts`                                   |
| Completeness present on full success with **both** axes (FR-005, FR-026)               | `case: scenario 5 — completeness is present on full success with BOTH axes (FR-005, FR-026)`                                                                                                 | `integration/getCustomerRiskProfile.test.ts`                                   |
| CRS honesty rule — complete or error, never a synthesised partial (research.md R2)     | `case: the CRS honesty rule — complete or error, never a synthesised partial (research.md R2)`                                                                                               | `integration/getCustomerRiskProfile.test.ts`                                   |
| Malformed identifier → `argument`, echoing **no** value (FR-030, SC-008)               | `case: a malformed account identifier is an argument error echoing NO value (FR-030, SC-008)`                                                                                                | `integration/getCustomerRiskProfile.test.ts`                                   |
| **No customer identifier in any log, span, or error message** (FR-029, FR-030, SC-007) | `case: half one — the account identifier never reaches a LOG FIELD (FR-029)` and `case: half TWO — the identifier never reaches an ERROR MESSAGE (FR-030, SC-007)`                           | `unit/privacy.test.ts`                                                         |
| No customer financial value in any log line (FR-029)                                   | `case: half one …` — "emits no customer FINANCIAL VALUE in any log line (FR-029)"                                                                                                            | `unit/privacy.test.ts`                                                         |
| Catalogue log lines unchanged by the path-template fix (SC-012)                        | `case: the catalogue domain's log lines are UNCHANGED by the template fix (SC-012)`                                                                                                          | `unit/privacy.test.ts`                                                         |

**The privacy gate is mutation-verified, not merely green.** Rebuilding the `operation` label
from the interpolated path — i.e. landing only the first half of research.md R13's two-part fix —
fails **6 of the 12** privacy tests, including both error-message assertions. That is recorded
because a privacy test that only inspected log fields would have passed against that mutant while
the identifier still escaped to the model and the user through `safeUpstreamDetail`.

**Not applicable, asserted rather than assumed**: `get_customer_risk_profile` is one hop with one
identifier argument, so too-broad (no query to narrow), multi-match (an account id addresses one
account), and `TIMEOUT_PARTIAL` (no earlier hop whose data could survive an abort) are all
structurally unreachable. There is deliberately no `206` case: CRS declares no partial-failure
contract, and asserting one would be fiction (research.md R2).

### `find_customer_bets` — User Story 2 (Phase 4)

| Case                                                                                    | Named test block                                                                                                                                                            | File                                                             |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **A `200` carrying reported errors is marked INCOMPLETE** (FR-011, SC-002)              | `case: scenario 4 — a 200 carrying errors[] is INCOMPLETE (FR-011, SC-002)` and `case: a 200 carrying errors[] names the unavailable sections (FR-011, SC-002)`             | `integration/findCustomerBets.test.ts`, `unit/qbsErrors.test.ts` |
| That case is reported via `unavailableComponents`, **never** `failedInstances` (FR-026) | same blocks — "reports it through unavailableComponents and NOT through failedInstances" and `case: the result is unavailableComponents and NEVER failedInstances (FR-026)` | `integration/findCustomerBets.test.ts`, `unit/qbsErrors.test.ts` |
| A clean `200` marks nothing unavailable, however sparse                                 | `case: a CLEAN 200 marks nothing unavailable, however sparse (Principle II)`                                                                                                | `unit/qbsErrors.test.ts`                                         |
| **Zero identifiers** → `argument` naming all three choices (FR-008, SC-008)             | `case: zero or two identifiers is an argument error naming the choices (FR-008, SC-008)`                                                                                    | `integration/findCustomerBets.test.ts`                           |
| **Two identifiers** → `argument` naming which kinds, echoing no value (FR-030)          | same block — "rejects TWO identifiers" and "echoes NO supplied value in either message (FR-030)"                                                                            | `integration/findCustomerBets.test.ts`                           |
| **`kind: 'none'`** for nothing matched — not an error, not a caveat (FR-012)            | `case: scenario 3 — nothing matched is "none", not an error and not a caveat (FR-012)`                                                                                      | `integration/findCustomerBets.test.ts`                           |
| **The bound is REPORTED, not silently truncated** (FR-010)                              | `case: the configured bound is REPORTED, never silently truncating (FR-010)`                                                                                                | `integration/findCustomerBets.test.ts`                           |
| A caller may narrow the cap but never widen it (Principle V)                            | same block — "lets a caller ask for FEWER but never for more than the configured cap"                                                                                       | `integration/findCustomerBets.test.ts`                           |
| `orderingCaveat` present on **every** success (FR-010)                                  | `case: the ordering caveat is present on EVERY success (FR-010)` — parameterised over all five fixtures                                                                     | `integration/findCustomerBets.test.ts`                           |
| `sort: { PLACEMENT_DATE, DESC }` requested upstream (research.md R6)                    | `case: scenario 1 …` — "requests sort PLACEMENT_DATE DESC upstream"                                                                                                         | `integration/findCustomerBets.test.ts`                           |
| **No `?instance=` is sent** (FR-025, constitution v1.2.0)                               | `case: scenario 1 …` — "sends NO instance query parameter" (observed URL via `requestRecorder`)                                                                             | `integration/findCustomerBets.test.ts`                           |
| **No returned bet carries a staff-authored note** (FR-004)                              | `case: NO returned bet carries a staff-authored note (FR-004)`                                                                                                              | `unit/betProjection.test.ts`                                     |
| A receipt identifier searches directly, with no manual conversion                       | `case: scenario 2 — a receipt identifier searches directly, no conversion needed`                                                                                           | `integration/findCustomerBets.test.ts`                           |
| **`403` → `forbidden`, not retryable** (SC-009)                                         | `case: scenario 5 — insufficient permission is forbidden and not retryable (SC-009)`                                                                                        | `integration/findCustomerBets.test.ts`                           |
| `401` → `auth`; `500` → `upstream`, never an empty bet list                             | same block — "is distinct from the 401 outcome" and "maps a 500 to a retryable upstream error"                                                                              | `integration/findCustomerBets.test.ts`                           |
| No upstream error TEXT reaches the caveat, which could echo an identifier (FR-029)      | `case: scenario 4 …` — "surfaces no upstream error TEXT" and `case: no upstream error text is ever surfaced (Principle V, FR-029)`                                          | `integration/findCustomerBets.test.ts`, `unit/qbsErrors.test.ts` |
| R9's chosen `entityIds` member is recorded per leg                                      | `case: R9 — which entityIds member supplied the event id is RECORDED`                                                                                                       | `unit/betProjection.test.ts`                                     |
| **No caller value can reach an upstream query or path** (SC-010)                        | `read-only by construction (SC-010)` — 28 tests                                                                                                                             | `unit/readOnly.test.ts`                                          |

**A defect this suite caught in `core`.** `completeness.ts` mapped _any_ top-level `errors[]` into
`InstanceError`, which is correct for the v5 envelope and wrong for QBS: a GraphQL error is the
other axis entirely, and its message text can echo an account identifier. So a QBS
success-carrying-errors response produced a caveat that (a) claimed brand instances had failed when
none had, and (b) interpolated unvetted upstream text into a sentence a human reads. `errors[]` is
now recognised as per-instance only when the entry names a `configSource` or the body is
recognisably a v5 envelope. The test that caught it is
`case: scenario 4 …` → "surfaces no upstream error TEXT, which could echo an identifier".

**The read-only gate is mutation-verified.** Interpolating a caller value into the request path
fails 3 of its 28 tests; adding an `instance` input to a schema fails 2. It also strips comments
before asserting, deliberately: these modules explain at length why `?instance=` must never be sent
and why the document contains no mutation, and a raw-source scan would flag its own rationale and
pressure someone into deleting the explanation to make the gate pass.

**Not applicable, asserted rather than assumed**: `find_customer_bets` is one hop, so
`TIMEOUT_PARTIAL` is unreachable. Too-broad does not arise: the result cap is a configured bound
that is reported (`limitReached`), which is a different signal from "your query was too wide to
answer" — there is no query to narrow. There is no `206` case: QBS signals partial failure in a
`200` BODY, which is what `200-success-with-errors.json` covers.

### `get_bet_risk_context` — User Story 3 (Phase 5)

The composite. Three of its rows are asserted by **counting requests** rather than by inspecting
the result, because a result-only assertion passes even when the tool fetched everything and then
discarded it — which is a different program from the one FR-022 and SC-013 specify.

| Case                                                                                               | Named test block                                                                                                                                                | File                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **All four jurisdiction outcomes, each exercised** (SC-004)                                        | `case: ALL FOUR outcomes are reachable and each is exercised (SC-004)`                                                                                          | `unit/jurisdiction.test.ts`                                           |
| **The context list is PRIMARY; derivation is only a fallback** (constitution v1.2.0)               | `case: THE CONTEXT LIST IS PRIMARY and derivation is only a fallback (v1.2.0)` — asserted through the reported `mechanism`                                      | `unit/jurisdiction.test.ts`                                           |
| Ontario resolves through the list and provably **cannot** through derivation                       | same block — "resolves Ontario through the context list, which derivation provably cannot"                                                                      | `unit/jurisdiction.test.ts`                                           |
| Derivation contains **no jurisdiction table**, so it cannot go stale                               | `case: derivation is NARROW and is not a jurisdiction table (v1.2.0)`                                                                                           | `unit/jurisdiction.test.ts`                                           |
| **`noConfigurationForJurisdiction` stays DISTINCT from `jurisdictionNotMatched`** (SC-003, SC-004) | `case: outcome 3 …` — "stays DISTINCT from outcome 2 for the same customer" and `case: matching is NOT a form of incompleteness (FR-027)`                       | `unit/jurisdiction.test.ts`, `integration/getBetRiskContext.test.ts`  |
| **An unresolved jurisdiction leaves the result `complete: true`** (FR-027)                         | `case: matching is NOT a form of incompleteness (FR-027)`                                                                                                       | `integration/getBetRiskContext.test.ts`                               |
| **A multi-leg bet is never attributed to one leg** (FR-021, SC-006)                                | `case: trigger 3 — a multi-leg bet with bet-level figures (FR-021, SC-006)` and `case: scenario 2 — a multi-leg bet is never attributed to one leg`             | `unit/agreement.test.ts`, `integration/getBetRiskContext.test.ts`     |
| ...even when the values would have **matched exactly**                                             | same block — "does so even when the values would have MATCHED exactly"                                                                                          | `unit/agreement.test.ts`                                              |
| **Each `notComparable` trigger, separately** (FR-020)                                              | `case: trigger 1 …`, `case: trigger 2 …`, `case: trigger 3 …` and `case: each notComparable trigger produces a DISTINCT reason (FR-020)`                        | `unit/agreement.test.ts`                                              |
| Both values always present, even when `notComparable` (the R14 guard)                              | `case: differs …` — "is the R14 GUARD: a description-vs-code mismatch shows both strings"                                                                       | `unit/agreement.test.ts`                                              |
| No verdict explains **why** two values differ (FR-017)                                             | same block — "offers NO explanation of why they differ (FR-017)"                                                                                                | `unit/agreement.test.ts`                                              |
| **More than one bet match → all candidates and ZERO further hops** (FR-022)                        | `case: scenario 3 — several matches return candidates and do ZERO further work (FR-022)` — request-counted                                                      | `integration/getBetRiskContext.test.ts`                               |
| **Each missing SECTION via `unavailableComponents`, never a failed instance** (SC-001, FR-026)     | `case: a missing SECTION is the second axis, never a failed instance (FR-026, SC-001)`                                                                          | `integration/getBetRiskContext.test.ts`                               |
| The two missing sections stay **distinct** when both hops fail                                     | same block — "keeps the two missing sections DISTINCT when both hops fail"                                                                                      | `integration/getBetRiskContext.test.ts`                               |
| A CRS failure never becomes "the customer was on default settings"                                 | same block — "does not claim a configuration governed the bet when CRS failed"                                                                                  | `integration/getBetRiskContext.test.ts`                               |
| **A `206` on ONE event hop makes the WHOLE result `PARTIAL`** (Principle II)                       | `case: a 206 on ONE event hop makes the WHOLE result partial (Principle II)`                                                                                    | `integration/getBetRiskContext.test.ts`                               |
| ...and stays **off** the second axis, since retrying can help                                      | same block — "keeps a partial event hop OFF the second axis"                                                                                                    | `integration/getBetRiskContext.test.ts`                               |
| **A distinct event is resolved ONCE** (SC-013)                                                     | `case: a distinct event is resolved ONCE, however many legs use it (SC-013)` and "resolves a DISTINCT event once, however many legs share it" — request-counted | `unit/legResolution.test.ts`, `integration/getBetRiskContext.test.ts` |
| **The bound is REPORTED, naming the deferred legs** (FR-023)                                       | `case: the resolution bound is REPORTED, never silently truncated (FR-023)`                                                                                     | `unit/legResolution.test.ts`, `integration/getBetRiskContext.test.ts` |
| An empty `overridesInScope` on an unresolved leg is **never** "unrestricted"                       | `case: an EMPTY overridesInScope is never readable as "unrestricted"`                                                                                           | `unit/legResolution.test.ts`                                          |
| **An override covering several legs appears on EACH of them** (FR-019)                             | `case: scenario 2 …` — "still resolves every leg and puts a covering override on EACH of them (FR-019)"                                                         | `integration/getBetRiskContext.test.ts`                               |
| **The leg → override join works ACROSS the two id vocabularies** (FR-019)                          | `case: scenario 1 …` — "JOINS the leg to its overrides across the two vocabularies (FR-019)"                                                                    | `integration/getBetRiskContext.test.ts`                               |
| A `MARKET_TYPE` override is **not** claimed in scope, since the hop cannot resolve one             | same block — "does NOT claim a MARKET_TYPE override is in scope"                                                                                                | `integration/getBetRiskContext.test.ts`                               |
| The event hop sends the **URN** form and scopes by `sources`, not `instancesList`                  | same block — "sends the event id in the URN form R9 documents" and "scopes the event hop by the BET's catalogue instance"                                       | `integration/getBetRiskContext.test.ts`                               |
| `notResolvedIdentifierUnusable` kept separate, so a wrong R9 is visible                            | `case: all FOUR resolution outcomes are produced and kept distinct`                                                                                             | `unit/legResolution.test.ts`                                          |
| `resolvedVia` reports which member worked — R9's closure evidence                                  | `case: scenario 1 …` — "reports resolvedVia, which is R9's closure evidence"                                                                                    | `integration/getBetRiskContext.test.ts`, `unit/legResolution.test.ts` |
| Exactly one identifier, echoing **neither** value (FR-016, FR-030)                                 | `case: exactly one identifier, and neither value is ever echoed (FR-016, FR-030)`                                                                               | `integration/getBetRiskContext.test.ts`                               |

**Two defects this story caught, both the same shape: an identifier stated in two forms.**

1. **The event lookup id.** The composite sent the bare `rampId`, which 404s every leg — and
   because that surfaces as `notResolvedIdentifierUnusable`, the symptom is **indistinguishable
   from R9 being wrong**. The bridge is `entityIds.gbpId` (GMA's own join, `Rule4EnrichmentService:121`
   → `:128`), whose value carries its own `source` segment; the `gpd` in
   `urn:sbk:pc:e:gpd:{id}` is DATA, not a constant. Fixed by `toEventLookupId`, covered by an
   assertion on the observed URL.

   Two further outcomes belong to this row, both live-only. An **OpenBet** event answers HTTP
   **400** even for a well-formed URN — the GMA UI gets the same 400, so the event is absent
   from the catalogue rather than mis-addressed by us; pinned by
   `qbsSearchBets/200-openbet-bet.json` + `events/400-bad-request.json`, asserting the hop IS
   attempted and the leg reports `notResolvedUpstreamFailure`. And `isOb` is **not** used to
   skip that hop, since it does not predict resolvability.

2. **The override join.** CRS states override ids bare (`'3'`, `'3307'`) while
   `GET /v5/events/{id}` returns URNs. Compared verbatim they match nothing, so **every** leg
   reported an empty `overridesInScope` — the shape that reads as "no restriction covers this leg",
   a confidently-wrong answer about a real customer's limits. Fixed by comparing trailing segments
   with the `level` still required to agree, and the fixtures now state the two sides in their two
   real vocabularies so the join is exercised across the gap rather than around it.

A third, found while wiring hop 2: mapping the CRS response **before** hop 3 gave every
configuration a bare `contextId` reference that nothing could bridge to the bet's jurisdiction
code, so every bet reported `jurisdictionNotMatched`. Mapping now happens after both hops answer.

**Not applicable, asserted rather than assumed**: there is deliberately no `206` fixture for either
CRS surface — CRS declares **no** partial-failure contract at all, which is why a CRS failure is a
missing SECTION (`unavailableComponents`) and never a failed instance.

### `get_customer_betting_metrics` — User Story 4 (Phase 6)

Two of these rows are about a **refusal**. A missing aggregation and an unrecognised
jurisdiction code each have a tempting default — pick a grouping, drop the filter — and both
defaults answer a question nobody asked. Upstream in particular IGNORES a jurisdiction code it
does not recognise and returns metrics for every jurisdiction, so a silently-dropped filter
reads as "this customer bets far more than you thought".

| Case                                                                                   | Named test block                                                                                                                           | File                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **A missing `aggregation` is an `argument` error NAMING all three** (FR-014, SC-008)   | `case: a missing aggregation is an argument error NAMING all three (FR-014, SC-008)`                                                       | `integration/getCustomerBettingMetrics.test.ts`                                |
| ...and makes **no** upstream call, since the request cannot be correct                 | same block — "makes NO upstream call when the aggregation is absent"                                                                       | `integration/getCustomerBettingMetrics.test.ts`                                |
| The requested aggregation is **echoed back**, so the answer states its own shape       | `case: the requested aggregation is echoed back (data-model.md section 10)`                                                                | `integration/getCustomerBettingMetrics.test.ts`                                |
| **`keyKind` discriminates**, so a bet type cannot be read as a period                  | `case: keyKind DISCRIMINATES, so a bet type cannot be read as a period` — all three values produced                                        | `unit/metricsMapping.test.ts`                                                  |
| **An unrecognised jurisdiction code is an ERROR, never a dropped filter** (FR-013)     | `case: an unrecognised jurisdiction code is an ERROR, never a dropped filter (FR-013)`                                                     | `integration/getCustomerBettingMetrics.test.ts`                                |
| ...and points at `list_jurisdiction_contexts`, whose codes are not derivable           | same block — "rejects the code and points at list_jurisdiction_contexts" and "accepts a code no derivation could produce"                  | `integration/getCustomerBettingMetrics.test.ts`                                |
| A code that could not be VERIFIED is forwarded, not rejected                           | same block — "FORWARDS the filter when the codes could not be looked up"                                                                   | `integration/getCustomerBettingMetrics.test.ts`                                |
| **Each `400` `errorCode` becomes a self-correctable hint** (SC-008)                    | `case: each upstream 400 becomes a self-correctable hint (SC-008)` and `case: each 400 errorCode becomes a self-correctable hint (SC-008)` | `integration/getCustomerBettingMetrics.test.ts`, `unit/metricsMapping.test.ts` |
| **The upstream `message` is NEVER interpolated** — it can echo the account id (FR-029) | same blocks — "surfaces no upstream text for the shape that carries no errorCode" and "NEVER includes upstream message text in a hint"     | `integration/getCustomerBettingMetrics.test.ts`, `unit/metricsMapping.test.ts` |
| An unrecognised code leaves the error untouched rather than inventing guidance         | same block — "leaves the error untouched when the code is unrecognised"                                                                    | `integration/getCustomerBettingMetrics.test.ts`                                |
| **`vipManager` is absent from the output** — it names a person (Principle V)           | `case: vipManager NEVER leaves the mapper (Principle V)` and `case: vipManager reaches no caller (Principle V)`                            | `unit/metricsMapping.test.ts`, `integration/getCustomerBettingMetrics.test.ts` |
| The ~20 promo/device/internal-scoring measures are dropped; **exactly fifteen** remain | same block — "drops the promo, device-link, and internal-scoring measures" and "keeps exactly the fifteen curated measures"                | `unit/metricsMapping.test.ts`                                                  |
| **LLM-facing `EVENT_TYPE` → upstream `EVENTTYPE`** at the client boundary (R12)        | `case: the request body translates EVENT_TYPE to EVENTTYPE (R12)` and "translates EVENT_TYPE to EVENTTYPE on the wire"                     | `unit/metricsMapping.test.ts`, `integration/getCustomerBettingMetrics.test.ts` |
| **The `POST` variant is used; the `GET` is deprecated** (FR-015)                       | same block — "uses the POST variant, since the GET is deprecated (FR-015)"                                                                 | `integration/getCustomerBettingMetrics.test.ts`                                |
| Filters travel in the BODY, so no identifier reaches a URL                             | same block — "sends the filters in the BODY, never in the URL"                                                                             | `integration/getCustomerBettingMetrics.test.ts`                                |
| **A null measure is "not reported", NEVER zero**                                       | `case: an absent measure is null, NEVER zero` — including a genuine zero preserved                                                         | `unit/metricsMapping.test.ts`                                                  |
| `lifetime` and `filteredTotal` stay DISTINCT, since they are not comparable            | same block — "keeps lifetime and filteredTotal DISTINCT, since they are not comparable"                                                    | `unit/metricsMapping.test.ts`                                                  |
| **No account identifier in any error message** (FR-029, FR-030)                        | `case: the account identifier is never echoed (FR-029, FR-030)` — including through a `500`, whose message names the TEMPLATE              | `integration/getCustomerBettingMetrics.test.ts`                                |
| `401` → `auth`; `403` → `forbidden`, not a sign-in problem (SC-009)                    | same block — "maps a 401 to auth" and "maps a 403 to forbidden, which is NOT a sign-in problem"                                            | `integration/getCustomerBettingMetrics.test.ts`                                |
| A row naming none of the three keys is DROPPED, not given an invented key              | `case: keyKind DISCRIMINATES …` — "DROPS a row naming none of the three keys"                                                              | `unit/metricsMapping.test.ts`                                                  |

**A `core` addition this story required.** The client discarded every failure body, so a tool
could not reach a machine-readable `errorCode` — and SC-008 wants a self-correctable error, which
a bare code is not. `GmaCallOptions.errorHint` is an opt-in reader: the caller is handed the
parsed body and returns a sentence IT composed, which is appended to the error the status already
produced. Two properties keep it safe. The upstream `message` never reaches a tool-visible string
(on this surface it carries "the Json response that caused the exception", which can echo the
account identifier), and the hint changes neither the error's `kind` nor its retryability — a
`400` stays a non-retryable `argument` failure whichever code it carried. Every existing call
omits the option and is unchanged.

**Not applicable, asserted rather than assumed**: this is one hop, so `TIMEOUT_PARTIAL` is
unreachable and there is no aggregation to perform. `customer-metrics.yaml` declares **no** `206`
for this operation, so there is deliberately no partial-success fixture — the surface has no
partial-failure contract to model.
