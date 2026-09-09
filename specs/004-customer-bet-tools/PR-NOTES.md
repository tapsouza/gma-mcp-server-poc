# PR description record — Customer Risk & Bet Tools (004)

Written for whoever reviews or ships this branch. Everything below is a claim about *this*
change that a reviewer should not have to reconstruct from the diff.

## What landed

A second MCP capability domain (`customer`) alongside `catalogue`, with **five** read-only
tools. The curated surface grows from three tools to **eight**, which is a reviewed act under
constitution Principle IV — `test/protocol/smoke.test.ts` and `agent/test/spawn.test.ts` both
pin the exact list, so growth cannot happen by accident.

| Tool                            | Hops    | Upstream |
| ------------------------------- | ------- | -------- |
| `list_jurisdiction_contexts`    | 1       | `GET /crs/contexts` |
| `get_customer_risk_profile`     | 1       | `GET /crs/accounts/{accountId}` |
| `find_customer_bets`            | 1       | `POST /qbs/graphql` |
| `get_bet_risk_context`          | `3 + N` | QBS, CRS ×2, `GET /v5/events/{id}` × distinct events |
| `get_customer_betting_metrics`  | 1       | `POST /accounts/{accountId}/metrics` |

863 tests across 29 files. Coverage: 98.71% lines / 88.48% branches overall, `src/core/**` at
98.28% lines — all above the constitutional thresholds, none of which was touched.

## The amendment-acceptance gate (SC-012)

`test/unit/errors.test.ts:32` was edited, and it is the **only** existing test this change
touches. It asserted `[403, 'upstream', true]` — a live **retry loop**: a `403` means the
identity lacks permission, so every retry is guaranteed to fail. That is a documented **defect
correction**, not an accommodation of the new code, and constitution v1.1.0's `forbidden` kind
is what makes it correct.

Every other pre-existing catalogue test passed **unmodified** against the amended `src`. This
was verified by reverting every test file to `HEAD` and running: **363 of 365 passed**, the two
failures being (1) that `403` row and (2) `config.test.ts`'s deliberately exhaustive six-key
enumeration meeting two new config variables. `completeness.test.ts` passing byte-unmodified is
the load-bearing result — the second completeness axis is additive.

Two guards were later widened as their subjects grew, both recorded here as reviewed acts:

- `test/protocol/smoke.test.ts` — the exact tool list, three → eight.
- `test/unit/architecture.test.ts` — the completeness-construction assertion was keyed to one
  spelling of an assignment and had stopped describing its own rule. It now asserts the
  **absence** of a literal verdict outside `core/completeness.ts`, strips comments so a module
  need not delete its rationale to pass, and carries a guard-the-guard test.

## Documents amended on 2026-09-08

None changes the design; each corrects a document against it.

- `contracts/tools.md` and `plan.md` — `get_bet_risk_context` is `3 + N` hops, not `2 + N`.
- `data-model.md` §7 — `ResolvedLeg` gained `resolvedVia`.
- `spec.md` — FR-001 is "exactly five", requirements range corrected to FR-030.

## Defects found while implementing, not anticipated by the plan

Seven, and five share one shape: **an identifier stated in two forms, failing silently.** Two of
the seven were found only against **live** GMA, and neither was catchable by a fixture — see
"Found only live" below.

1. **`core/completeness.ts` conflated two failure axes.** `toInstanceErrors` mapped any
   top-level `errors[]` into an `InstanceError`, which is right for the v5 envelope and wrong
   for QBS — where a GraphQL error is the *other* axis. A QBS success-carrying-errors response
   therefore produced a caveat that claimed brand instances had failed when none had, **and**
   interpolated unvetted upstream text (which can echo an account identifier) into a sentence a
   human reads. Now recognised as per-instance only when the entry names a `configSource` or the
   body is recognisably a v5 envelope.

2. **`GET /v5/events/{id}` declares `sources`, not `instancesList`.** The shared client
   hardcoded the latter, so the parameter would have been silently **ignored** and the lookup
   fanned out across every instance. `GmaCallOptions.instancesParam` now carries the name per
   call, as the constitution's "MUST NOT be assumed uniform" rule requires.

3. **The event lookup sent the bare `rampId`.** Fixed mid-branch by prefixing it — and that fix
   was itself wrong, superseded by defect 7 below. Recorded because the intermediate state is
   what made the live diagnosis legible.

4. **The FR-019 override join could not match.** CRS states override ids bare (`'3'`, `'3307'`;
   `crs-service/docs/openapi/api.yaml`, `gbpcrsui-tool/src/constants/mocks.ts:541`) while
   `GET /v5/events/{id}` returns URNs. Compared verbatim, **every** leg reported an empty
   `overridesInScope` — the shape that reads as "no restriction covers this leg", a confidently
   wrong answer about a real customer's limits. Now compared by trailing segment with the
   `level` still required to agree. The fixtures state the two sides in their two real
   vocabularies, so the join is exercised **across** the gap rather than around it.

5. **The composite mapped CRS before fetching the context list.** Every configuration therefore
   carried a bare `contextId` that nothing could bridge to the bet's jurisdiction code, so
   every bet reported `jurisdictionNotMatched`. Mapping now happens after both hops answer.

## Found only live, and why no fixture could have caught either

Both were discovered during Validation 4 against dev GMA. Both are recorded here because they
expose a real limit of this branch's test strategy: `test/MUST-COVER.md` claims a fixture for
every distinguishable outcome of every operation, and **neither of these outcomes can be
produced by a fixture at all.**

6. **QBS `pageNumber` is ZERO-based; we sent `1`.** That asks for the SECOND page. A single-bet
   lookup is one page long, so QBS answered HTTP 200 with `pageInfo.count: 0` and no `errors[]`
   — indistinguishable from "this bet does not exist". `find_customer_bets` returned
   `kind: 'none'` and `get_bet_risk_context` failed at hop 1, making the **entire composite
   unreachable for any single bet**. The schema documents `pageNumber` only as "The number of
   the page requested"; the convention comes from `useDynamicQuery.ts:91` (the front-end
   converts a one-based index on the way out) and `BetExportProgress.java:8` (GMA's own export
   starts at 0). Now a named `FIRST_PAGE` constant carrying that provenance.

   *Why no fixture could catch it:* `msw` ignores `pageNumber` entirely and returns whatever the
   handler holds. Every offline test passed with either value.

7. **The event URN's `source` segment is DATA, not a constant.** See the R9 section below for the
   full account. Short version: `gpd` was hardcoded, the real source comes from the `gbpId`
   value, and inventing it produced a live HTTP **400** for every OpenBet-stack bet.

   *Why no fixture could catch it:* every existing fixture was authored from the same wrong
   assumption, so the fixtures and the code agreed. `200-openbet-bet.json` now encodes the real
   OpenBet shape — legs carrying only a bare `rampId` — and the regression suite asserts that
   **no event call is made at all** for such a leg.

**The strategy gap this leaves open.** Fixtures verify that code and fixture agree; they cannot
verify that either matches upstream. Every one of the identifier defects on this branch was of
that kind. The mitigation available today is quickstart.md's Validation 4, and this run is the
argument for treating it as mandatory before release rather than optional.

## Additions to `core`, both opt-in and additive

- `GmaCallOptions.instancesParam` — see defect 2.
- `GmaCallOptions.errorHint` — the client discarded every failure body, so a tool could not
  reach a machine-readable `errorCode`, and SC-008 wants a self-correctable error. The caller is
  handed the parsed body and returns a sentence **it** composed. The upstream `message` never
  reaches a tool-visible string (on the metrics surface it carries "the Json response that
  caused the exception", which can echo the account identifier), and the hint changes neither
  the error's `kind` nor its retryability.

Every existing call omits both options and behaves exactly as before.

## The event hop's instance scoping (tasks.md T043's open question)

**Settled: scope by the bet's own `catalogueInstanceId`, and send nothing when the bet reported
none.** Verified in `api_catalogue.yaml`: `getEventById` references `sourcesParam`
(`required: false`), so omitting it is legal. The bet's own instance names the catalogue the
leg's event actually lives in — a fact about this bet rather than a deployment default that
could silently narrow or widen the lookup.

## Open assumptions — owner and removal condition

Validation 4 was run against live dev GMA on 2026-09-09. **R9 and R14 are closed**; R8 remains
open with an owner, since it cannot be settled by observation.

| Ref | Assumption | Removal condition | Owner |
| --- | ---------- | ----------------- | ----- |
| ~~**R9**~~ | ~~`leg.event.entityIds.rampId`, URN-prefixed, is the v5 event identifier~~ | **CLOSED 2026-09-09 — against the assumption.** See below. | closed |
| ~~**R14**~~ | ~~A bet's applied `liabilityGroup` string is the configured group's `description`~~ | **CLOSED 2026-09-09 — as assumed.** A live bet reported `configuredValue: "Marks Soccer AT"` against `appliedValue: "Arber"` — both human-authored descriptions, not codes. The `code` fallback never fired, and the three-valued verdict correctly reported `differs` with both strings visible rather than a confident wrong answer. | closed |
| **R8** | An unconfigured jurisdiction is omitted from a customer's configuration list rather than returned empty | **Ask a human who owns CRS** — this cannot be settled by observation alone | CRS system owner |

### R9 closed AGAINST the assumption, and how a passing test hid that

R9 assumed the bridge was `rampId` with a hardcoded `urn:sbk:pc:e:gpd:` prefix. **It is
`gbpId`**, and the `gpd` is not a constant — it is the `source` segment, carried in the data.

GMA performs this exact join itself, in `Rule4EnrichmentService:121`:

```java
GbpId.fromSourceId(gbpIdOf(leg.getEvent()), "e").toLongUrn()
```

`gbpIdOf` reads **`entityIds.gbpId`** (`:128`), and `GbpId.fromSourceId` (`GbpId.java:17`)
requires `source:sourceId`, assembling `urn:sbk:pc:{level}:{source}:{sourceId}`. When the
gbpId is blank, `:114` **skips the leg** rather than substituting anything.

**The two bet stacks are why this mattered.** Steel-thread bets (internal, ids shaped
`urn:sbk:bet:…`) carry a namespaced `gbpId`; **OpenBet** bets (numeric ids, `isOb: true`) may
carry only a bare `rampId`. Against a real OpenBet bet, the invented `gpd` namespace produced
a live **HTTP 400**, and the composite went `PARTIAL` for every bet on that stack.

**How a live test appeared to confirm the wrong answer.** A steel-thread bet resolved both
legs with `resolvedVia: rampId`, and that was read as confirmation. It was not: for that bet
`rampId` and the gbpId's `sourceId` were the same number *and* the source happened to be
`gpd`, so the two candidate mechanisms were indistinguishable. **A passing result does not
confirm a mechanism unless the alternative would have failed.** Only a bet where the forms
differ could tell them apart — which is what the OpenBet bet is, and what
`200-openbet-bet.json` now pins.

`pickIdentifier` now prefers `gbpId`; `rampId` remains a fallback for display only, and
yields `null` from `toEventLookupId` because no URN can be built from it without inventing a
namespace. Such a leg is reported `notResolvedIdentifierUnusable` — distinct from
`notResolvedUpstreamFailure`, since no retry can supply a namespace the bet never carried.

R9 also gained a **second, narrower** unverified element while implementing: defect 4's
trailing-segment comparison is evidenced for events only, and the three non-event levels are
assumed to correspond the same way. The failure mode stays honest — a level whose ids do not
correspond yields no override in scope on a `resolved` leg, never a fabricated one.

## Not done, and why

- **T067** (`npm run agent`, quickstart Validation 3) and **T068** (closing R9/R14/R8) both
  require a live GMA token and an interactive session. The harness builds and its offline suite
  passes; the manual walkthrough is a pre-release step.
- **Two `agent/test/cli.test.ts` failures are pre-existing at `HEAD`**, and are not caused by
  this change: the repo's local `.env` leaks into the spawned child, so the tests that assert
  exit `78`/`77` for *missing* configuration find it present. Verified by moving `.env` aside —
  all 17 pass. Deleting a developer's `.env` is not this change's business; the fix is for the
  harness to isolate the child's environment.
