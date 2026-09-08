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

Five, and four share one shape: **an identifier stated in two forms, failing silently.**

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

3. **The event lookup sent the bare `rampId`.** R9's only evidence is `rampId` **prefixed** with
   `urn:sbk:pc:e:gpd:` (`gbpbmui-tool/src/utils/linkManager.ts:51` reads it, `:88` prefixes it).
   Every leg would have 404'd — and because an unresolvable leg reports
   `notResolvedIdentifierUnusable`, the symptom is **indistinguishable from R9 being wrong**.

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

Validation 4 requires a live GMA token and a human-in-the-loop session, so all three remain
open. Each has a stated owner and a removal condition, as quickstart.md requires.

| Ref | Assumption | Removal condition | Owner |
| --- | ---------- | ----------------- | ----- |
| **R9** | `leg.event.entityIds.rampId`, URN-prefixed, is the v5 event identifier | Observe one real leg resolve, and read its `resolvedVia` — the field exists precisely to record which member worked | feature implementer, before release |
| **R14** | A bet's applied `liabilityGroup` string is the configured group's `description` (with `code` as fallback) | Observe one real bet whose applied group matches a configured one | feature implementer, before release |
| **R8** | An unconfigured jurisdiction is omitted from a customer's configuration list rather than returned empty | **Ask a human who owns CRS** — this cannot be settled by observation alone | CRS system owner |

**A caution for whoever closes R9.** If **every** leg reports `notResolvedIdentifierUnusable`,
suspect three things in this order: the URN prefix (defect 3 above), the instance scoping
(T043), and only then the `entityIds` member itself. All three produce an identical symptom.

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
