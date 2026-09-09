# PR description record — Customer Risk & Bet Tools (004)

Written for whoever reviews or ships this branch. Everything below is a claim about *this*
change that a reviewer should not have to reconstruct from the diff.

## What landed

A second MCP capability domain (`customer`) alongside `catalogue`, with **five** read-only
tools, plus one addition to the catalogue domain. The curated surface grows from three tools to
**nine**, which is a reviewed act under constitution Principle IV —
`test/protocol/smoke.test.ts` and `agent/test/spawn.test.ts` both pin the exact list, so growth
cannot happen by accident.

| Tool                            | Domain      | Hops    | Upstream |
| ------------------------------- | ----------- | ------- | -------- |
| `list_jurisdiction_contexts`    | `customer`  | 1       | `GET /crs/contexts` |
| `get_customer_risk_profile`     | `customer`  | 1       | `GET /crs/accounts/{accountId}` |
| `find_customer_bets`            | `customer`  | 1       | `POST /qbs/graphql` |
| `get_bet_risk_context`          | `customer`  | `3 + N` | QBS, CRS ×2, `GET /v5/events/{id}` × distinct events |
| `get_customer_betting_metrics`  | `customer`  | 1       | `POST /accounts/{accountId}/metrics` |
| `get_event`                     | `catalogue` | 1       | `GET /v5/events/{id}` |

**`get_event` closes a loop this feature opened.** `find_customer_bets` and
`get_bet_risk_context` each report an event name and id per leg, and nothing could act on the id
— there was no tool that took one. It needed **no** constitutional amendment:
`GET /v5/events/{id}` is already in the `catalogue` row of the surface register. It is a separate
tool rather than a fourth `get_catalogue_entity` type because the upstream response nests its
parents where this one states them flat, the scoping parameter differs (`sources`, not
`instancesList`), and widening `entityTypeSchema` would let `Ancestor.type` claim `'event'` — a
level that is never any other entity's ancestor.

There is deliberately **no** event *name* search: `POST /v5/searchByName` covers superclass,
subclass and event type only (`SearchByNameResult` is a three-field record), and the one event
listing operation requires an event-type id you must already have. The tool's description says so
outright, because an agent that does not know will send a name and get an error it cannot fix.

963 tests across 30 files. Coverage: 98.48% lines / 89.15% branches overall, `src/core/**` at
98.29% lines — all above the constitutional thresholds, none of which was touched.

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

- `test/protocol/smoke.test.ts` — the exact tool list, three → nine.
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

Fifteen. Six share one shape — **an identifier stated in two vocabularies, compared in only one of
them, failing silently** — and three more share another: **the tool was right and the agent still
said something false**, because the payload carried no prohibition against the inference. **Ten** of
the fifteen were found only against **live** GMA and none of those was catchable by a fixture — see
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

## Found only live, and why no fixture could have caught any of them

All ten were discovered during live validation against dev GMA on 2026-09-09 (Validation 4, then
Validation 3). They are recorded here because they expose a real limit of this branch's test
strategy: `test/MUST-COVER.md` claims a fixture for every distinguishable outcome of every
operation, and **none of these outcomes could have been produced by a fixture derived from the
schema** — each response is exactly what its schema says a response looks like, and **five of the
ten are not upstream behaviours at all** but things the tool failed to TELL the agent.

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

7. **The event lookup read the wrong `entityIds` member.** GMA's own join uses **`gbpId`**
   (`Rule4EnrichmentService:121` → `gbpIdOf` at `:128`), not `rampId`, and the `source` segment
   is DATA rather than the hardcoded `gpd`. See the R9 section below.

   *Why no fixture could catch it:* every existing fixture was authored from the same wrong
   assumption, so the fixtures and the code agreed.

   **A correction to how this was first reported.** The `gpd` hardcoding was initially blamed
   for a live HTTP **400** on an OpenBet bet. It was not the cause: for that bet the assembled
   URN is byte-identical before and after the fix (`urn:sbk:pc:e:gpd:14643022`), because its
   gbpId's source IS `gpd`. The 400 is upstream's — **the GMA UI receives the same 400 for the
   same event**, so the event is absent from the catalogue PCSS serves and no request shape we
   could send would resolve it. The `gbpId` fix stands on its own merits (it removes an invented
   constant and matches GMA's join); it simply did not fix that symptom.

   **R9 is now closed with evidence that discriminates.** A steel-thread ninefold resolved all
   **nine** legs `resolvedVia: gbpId`, and `get_event` on `gpd:40646467` returned HTTP **200**
   with a full hierarchy — the same operation, same id form, same instance scoping that 400s for
   the OpenBet event. So the mechanism is confirmed by a case where the alternative would have
   failed, and the OpenBet 400 is confirmed as upstream's rather than ours.

8. **An all-zero metrics response is indistinguishable from "this customer has never bet."** A
   customer with **3,795 bets** — confirmed via `find_customer_bets` in the same session —
   returned metrics reading zero on every measure, in a schema-valid HTTP 200 with no `errors[]`.
   A model shown that states the customer has never placed a bet: a **positive false claim about
   a real person**, which makes this the most dangerous of the three, since the other two present
   as missing data rather than as a confident finding.

   The cause is deliberate on GMA's part. `UnmappedCustomerMetricsResponseGenerator` fabricates
   rows for buckets the Data API did not return — all three `enrichWith*` methods build
   `CustomerMetrics.builder().build()`. Lombok leaves Java **primitives** at `0` (`int betCount`,
   `double grossStake`) and every **boxed** member null (`Integer distinctEvents`, both
   `LocalDate` bet dates), which is a shape a real row cannot have. Metrics also come from a
   separate reporting warehouse (`data-api…fddata-dev.net`, `dev.rb:20`) than bet records, so the
   two can genuinely disagree.

   `get_customer_betting_metrics` now attaches an optional **`noDataNotice`** when the figures
   carry that signature, and its description forbids concluding a customer has not bet from zero
   metrics. Three deliberate choices: a notice rather than an **error**, since the zeros may be
   genuine for a new account and refusing would deny a legitimate question; **off** the
   completeness axes, since the section WAS retrieved and what is uncertain is its meaning —
   folding an interpretive doubt into `complete: false` would make that flag mean two things and
   invite a retry that returns the same body; and keyed on the **totals**, not on individual
   groups, because a zero-filled group is the normal, informative way "no activity in this
   bucket" is reported.

   *Why no fixture could catch it:* the response satisfies its own schema completely, so a
   schema-derived fixture asserts exactly the behaviour that is wrong.
   `200-all-zero-no-data.json` is generated field-for-field from `CustomerMetrics.java`'s
   primitive/boxed split — a reproducible statement about GMA rather than a guess.

**The strategy gap this leaves open.** Fixtures verify that code and fixture agree; they cannot
verify that either matches upstream — and they cannot verify what an AGENT concludes from a
correct payload at all. Two of the live findings (11 and 12) are of that second kind: the tool
reported the truth and the agent still drew a false conclusion, because the payload did not
distinguish "our logic failed" from "our logic never ran", and because an error hint named an
argument the operation does not have.

The mitigation available today is quickstart.md's Validations 3 and 4, and this run is the
argument for treating both as **mandatory** before release rather than optional: **ten of this
branch's fifteen defects were reachable no other way**, and eight of those ten would have shipped
as confidently wrong answers about real customers rather than as visible failures — that a customer
has never bet, that a bet's jurisdiction could not be determined, that no configuration governed a
bet whose governing configuration was in the same response, that a bet's figures "came from
defaults", that a valid account identifier was invalid, that a RESTRICTED customer has no
restrictions, that a page of bets proves what a customer may do, and that absent metrics are a
reporting lag.

**Validation 3 earns its place separately from Validation 4.** Four turned on upstream behaviour a
fixture could not reproduce; the other six turned on what an agent concluded from a payload that
was correct. Only a real model reading real descriptions surfaces the second kind, and five of the
six were found in a single twenty-minute session.

9. **A bet may state its jurisdiction as a context NAME, and matching compared only ids and
   codes.** A live bet reported `INTBS1` — which is `{ contextCode: 'NJ1', contextName: 'INTBS1' }`
   — so it matched nothing and the tool answered `jurisdictionNotMatched`, meaning "we could not
   tell what this bet's jurisdiction is", while the governing configuration sat in the very same
   response *named* `INTBS1`. A trader asking why the bet got its limit is told the tool could not
   work it out.

   This is the **third** instance on this branch of one identifier stated in two vocabularies and
   compared in only one of them (after the event URN and the FR-019 override join). That is now a
   pattern rather than a coincidence, and the lesson for the next surface is to ask, for every
   join: *which vocabularies can each side state this identifier in?*

   Fixed by resolving a name through the platform's context list, **last** (so an id or code match
   always wins) and **only when exactly one** context bears that name. The ambiguity guard is not
   defensive decoration: the live list has two contexts sharing id `754`, so duplicate
   human-authored values in this data are demonstrated. On a tie the outcome stays
   `jurisdictionNotMatched` — attributing a bet to the wrong state's settings would be a confident
   claim about a real customer's restrictions, which is worse than admitting we cannot tell. Names
   are deliberately NOT compared inside `corresponds`, because a name is human-authored where a
   code is platform-issued.

10. **`mechanism` was computed on every match and never surfaced.** `matchJurisdiction` has always
    returned which step produced the answer, and its own doc comment says it exists "for the caller
    to report" — but no field carried it out. That threw away the one signal distinguishing "the
    context list did its job" from "we fell back to derivation and got lucky". Constitution v1.2.0
    makes the context list primary and derivation "a fallback, never the primary mechanism"; with
    the field discarded, an inversion of that ordering was invisible in the field, which is
    precisely where it matters — US bets keep working and every non-US bet is confidently wrong.
    Now surfaced as `jurisdictionMatchMechanism`.

11. **Matching ran when it had nothing to match against, and reported a match FAILURE.** With CRS
    returning `400` for every call, hop 2 produced no configurations. Matching proceeded against
    the empty list — which can only ever answer "nothing matched" — so the tool reported
    `jurisdictionNotMatched`: *"we know the bet's jurisdiction and our matching failed on it"*, when
    the truth was *"we never had anything to match against"*.

    The consequence was the worst kind. The agent told the user the applied figures **"come from
    defaults"** — the single inference `jurisdictionMatchOutcomeSchema` forbids in every
    non-`matched` case. It was not being careless: nothing in the payload distinguished a matching
    failure from absent inputs, and a matching failure genuinely *does* suggest the bet fell
    through to something. The tool had reported the outcome and named both missing sections
    correctly; the gap was that FR-018's four outcomes all assume the configurations were
    **retrieved**, with no value for "matching was not attempted".

    Fixed with a fifth outcome, `jurisdictionMatchNotAttempted`, checked **first** — before the
    bet's own jurisdiction, since with no configurations every other answer is an artefact of an
    empty list. Same rule as `notResolvedIdentifierUnusable` on a leg, one level up: **logic that
    FAILED must stay separate from logic that never RAN.** Both the schema description and the tool
    description now forbid the defaults inference explicitly, since that is where the model reads
    it.

12. **A `400` told the agent to check an instance code on operations that take none.** The
    `argument` guidance said unconditionally "If an instance code was rejected, call
    `list_instances` for the valid codes." CRS returned `400` for `GET /crs/accounts/{accountId}`
    **and** `GET /crs/contexts` — the second takes no argument at all — and, directed at its
    arguments, the agent concluded the **account identifier was invalid** and told the user to
    double-check it. The identifier was valid; CRS was failing every request.

    Advice naming the wrong argument is worse than none: it does not merely fail to help, it
    steers the diagnosis away from the truth and the agent relays that to a human as a claim about
    their input. The hint is now attached only when the call actually **sent** an instance list —
    which the client knows and `errors.ts` cannot — and defaults to omitted, the safe direction.

13. **An empty `overrides` list read as "unrestricted", beside `eligibility: RESTRICTED`.** Asked
    "is this customer restricted on soccer?", the agent answered *"no catalogue-level restrictions
    apply — whether for soccer or any other sport"*. All three of that customer's jurisdictions
    carried `eligibility: RESTRICTED`. An empty `overrides` array means no **sport-specific**
    override; the jurisdiction-wide restriction still applies to every sport, soccer included.

    The design already guards this shape one level down — `ResolvedLeg.resolution` exists
    precisely so an empty `overridesInScope` cannot read as "unrestricted" — and the
    configuration-level list had no equivalent. `RESTRICTED` sitting immediately beside an empty
    list is exactly where the two get conflated. The field description now names the interaction,
    `eligibility` states that `RESTRICTED` **is** a restriction and is jurisdiction-wide, and the
    tool description orders the two reads.

14. **A restriction question was answered from BET HISTORY.** In the same run the agent reversed
    itself, concluding from one soccer bet on a 20-bet first page that the customer "is not
    restricted on soccer" — and it dropped the ordering caveat's second half while doing so,
    relaying "most recent first" but not "may not be the globally most recent".

    A page of bets cannot support a claim about what a customer MAY do: the bets that would
    disprove it are exactly the ones a first page omits, and a restriction added after these bets
    were placed is invisible. The caveat warned only about recency, which left the inference
    unaddressed; it now forbids reasoning from absence, states that a bet's presence is not
    permission, and names `get_customer_risk_profile` as the tool that answers the question.

15. **The all-zero metrics notice was explained away.** The agent relayed the caveat faithfully
    and then resolved the ambiguity anyway: seeing 23,038 bets, it concluded *"the metrics service
    simply has no data for them yet. This is likely a reporting lag."* Reasonable-sounding,
    unfounded, and possibly wrong — an account with tens of thousands of bets and **zero**
    warehouse rows looks less like lag than like a warehouse never populated for this environment.

    The notice had said a reporting gap and genuine inactivity "look identical here" and stopped;
    naming candidate causes is what invited the pick. It now prohibits explaining **why** the
    figures are missing, and says why that matters: a plausible explanation offered to a user
    reads as a finding.

**Defects 13 to 15 are a category the rest of this list does not contain.** In each, the tool
returned correct data with a correct caveat and the **agent still produced a false statement**. No
fixture can catch these, because there is nothing wrong with the payload — what was missing was a
prohibition in the text the model reads. quickstart.md's Validation 3 is the only mechanism that
surfaces them, and its own note is exactly right: *a failure here is a tool-description defect, not
an agent defect.* All three fixes are description-only; no logic changed.

## Validation 3 (T067) — failed, fixed, re-run clean

Run against live GMA on 2026-09-09. **The first pass failed three of the five asks**, every failure
a description defect (13 to 15 above). After the wording changes, the same asks pass:

| Ask | Result |
| --- | ------ |
| Risk configuration | ✅ three jurisdictions stated separately, nothing averaged |
| "Why did bet X get this limit?" | ✅ applied vs configured side by side, no calculation narrated, bet-level attribution relayed, R14's `liabilityGroup` disagreement shown with both strings |
| "Restricted on soccer?" | ✅ **now answers "Yes"** — jurisdiction-wide `RESTRICTED`, while noting no sport-specific override exists. Previously answered "no restrictions apply" |
| "Show me their recent bets" | ✅ **both halves** of the ordering caveat relayed, and it now refuses to answer the restriction question from bets, deferring to the risk profile |
| "Their metrics?" | ✅ asks which aggregation rather than picking; on the all-zero answer it stops at "unavailable" and no longer diagnoses a reporting lag |

Two observations from the run that are not defects but are worth a reader's time.

**The `NXTCANBS` fixture comment is imprecise.** `crsContexts/200-success.json` labels it
"Ontario's `NXTCANBS`". Live, Ontario is `CA-ON` (id `521`) and `NXTCANBS` is a **separate**
context (id `930`) whose name is also `NXTCANBS`. The fixture's load-bearing property is intact and
its justification for `list_jurisdiction_contexts` is unaffected — `NXTCANBS` is still a code no
derivation from a state name produces, which is the whole point — but the pairing with Ontario is
not what dev returns, and a reader should not take it as a mapping.

**The bet-level attribution notice is doing real work.** On the nine-leg parlay the agent reported
the applied figures as bet-level and made every agreement verdict `notComparable`, rather than
attributing a stake factor to one leg. That is SC-006 holding up under a model that had every
incentive to be more specific than the data allows.

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
| **R8** | An unconfigured jurisdiction is omitted from a customer's configuration list rather than returned empty | **Ask a human who owns CRS.** Live evidence now points strongly at OMISSION — see below — but "is that by design?" is still a question only the owner can answer | CRS system owner |

### R8 — narrowed by observation, not yet closed

The 2026-09-09 run makes the question much sharper than it was. `GET /crs/contexts` returned
**35** contexts; account `100119636` returned configurations for **3** (`NJ`, `NJ1`, `NXTCANBS`).
The other 32 were **absent entirely** — not present-with-defaults, not empty rows.

So the observed behaviour is omission. What observation still cannot settle is whether that is
CRS's contract or an artefact: an omitted jurisdiction and one CRS simply failed to return look
identical from outside, which is exactly why FR-018's second outcome states the fact
(`noConfigurationForJurisdiction`) rather than inferring "default settings apply".

**The question for the CRS owner, in the form to ask it:** *for a customer with no configuration
in a jurisdiction, does `GET /crs/accounts/{id}` omit that context from `contexts` entirely, or
return it with default-only values? If it omits, is that guaranteed — i.e. can a consumer treat
"absent" as "unconfigured", or only as "not returned this time"?*

Two incidental findings from the same response, neither ours to fix, both worth recording because
a future reader will hit them:

- **The dev contexts list carries non-jurisdictions** — `AX`, `YY`, `US-XX`, `prdtst`. Harmless
  here (they are looked up, never derived), but a caller that treated the list as a jurisdiction
  registry would be wrong.
- **Two contexts share the id `754`** — `NJ1` and `WV`. That collision is the concrete reason the
  name-matching fix below refuses to resolve an ambiguous name rather than picking the first.

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

**The two bet stacks do NOT differ in identifier shape**, which is where the first diagnosis
went wrong. Legs on both stacks carry a namespaced `gbpId` — verified live across ten legs:
`gpd:14643022` on an OpenBet bet, `gpd:40646467` and eight more on a steel-thread ninefold. So
`isOb` does not predict resolvability, and it is deliberately **not** used to skip the event
hop: the UI's own fixtures hold `isOb: true` bets whose events carry good gbpIds
(`gbpbmui-tool/src/utils/mockedData.ts` — `'162079'`), and skipping on the flag would deny a
lookup to legs that can resolve, trading an honest failure for a silent one.

**How a live test appeared to confirm the wrong answer.** A steel-thread bet resolved both
legs with `resolvedVia: rampId`, and that was read as confirmation. It was not: for that bet
`rampId` and the gbpId's `sourceId` were the same number *and* the source happened to be
`gpd`, so the two candidate mechanisms were indistinguishable. **A passing result does not
confirm a mechanism unless the alternative would have failed.**

The converse bit too, and is worth recording. The OpenBet 400 was read as convicting the
request, and two fixes were committed on that reading before anyone checked whether the *UI*
could fetch the same event. It cannot — same 400. **A failing result does not convict the
request until the same request is shown to succeed elsewhere.**

`pickIdentifier` now prefers `gbpId`; `rampId` remains a fallback for display only, and
yields `null` from `toEventLookupId` because no URN can be built from it without inventing a
namespace. That null is a guard against an unobserved shape, not the live path. A leg that hit
it would be reported `notResolvedIdentifierUnusable` — distinct from
`notResolvedUpstreamFailure`, since no retry can supply a namespace the bet never carried.

`200-openbet-bet.json` now states the **observed** shape (a namespaced `gbpId` alongside the
bare `rampId`) rather than the shape originally assumed, and its suite asserts the live
outcome: the lookup IS attempted, the URN is well formed, upstream answers 400, and the leg is
reported `notResolvedUpstreamFailure` with `resolvedVia: gbpId` — the field that tells the next
reader the request was right and stops a third round of id-form "fixes".

R9 also gained a **second, narrower** unverified element while implementing: defect 4's
trailing-segment comparison is evidenced for events only, and the three non-event levels are
assumed to correspond the same way. The failure mode stays honest — a level whose ids do not
correspond yields no override in scope on a `resolved` leg, never a fabricated one.

## Not done, and why

- **T067** (`npm run agent`, quickstart Validation 3) and **T068** (closing R9/R14/R8) both
  require a live GMA token and an interactive session. The harness builds and its offline suite
  passes; the manual walkthrough is a pre-release step.
- ~~**Two `agent/test/cli.test.ts` failures are pre-existing at `HEAD`**~~ — **now fixed**, see
  below. They were pre-existing and not caused by this change, but "the fix is for the harness to
  isolate the child's environment" turned out to be a two-line change, so leaving it undone was
  not worth the standing red.

## The `.env` leak (defect 16 — pre-existing, fixed here)

Two `agent/test/cli.test.ts` cases assert the harness **refuses to start** when configuration is
missing: exit `78` naming the absent variable (FR-010, SC-005) and exit `77` with the administrator
ask (FR-022). Both spawn the built entrypoint with a deliberately incomplete environment.

`agent/main.ts` opened with `process.loadEnvFile('.env')`. That call **does not overwrite** a
variable that is already set — but it does **fill in** one that is absent, which is exactly what
those two tests had arranged. The repository's own `.env` restored the withheld values and the
process started cleanly, so both tests reported exit `0`.

The failure mode is the interesting part: **green on every developer machine, red on a clean
checkout.** The tests were not weak — they were correct, and were being answered by a file they
never mentioned.

**Fix**: `.env` now arrives from `node --env-file-if-exists=.env` on the `agent` npm script, and
no source file loads it. `test:agent` does not pass the flag, so a spawn cannot inherit the file:
isolation is structural rather than a convention to remember. Precedence is unchanged (real
environment still beats the file) and `-if-exists` keeps a `.env`-less setup legitimate.

Verified in both directions, because a pass alone would not distinguish the fix from the leak:
`cli.test.ts` gives **17/17 with `.env` present and 17/17 with it moved aside** — the result no
longer depends on the file — and `npm run agent` still signs in from `.env` and reports
`spawned gma-mcp-server (9 tools)`. `agent/test/architecture.test.ts` guards both halves (no
`loadEnvFile` in source; the flag on `agent`; **not** on `test:agent`).

**A second, unrelated claim fell out of it.** The old placement was mandated as "the **first
statement** in `agent/main.ts`, before any import that reads the environment at module scope",
because `@ai-sdk/amazon-bedrock` reads `AWS_*` when evaluated. ESM imports are **hoisted**, so that
statement ran *after* `./repl/loop.js` — and therefore Bedrock — had already been evaluated. The
guarantee was never achieved, and no body statement could achieve it; the flag can, since it is
applied before any module is evaluated. (Importing the provider against an empty environment does
not in fact throw — the authentication failure arrives at the first model call.) `contracts/config.md`
and `plan.md` are amended.

Worth stating as a general rule, since this is the second time in this branch that a passing result
turned out to be answering a different question than the one asked: **a test that asserts what
happens when configuration is missing must not share a configuration-loading path with the thing it
tests.**
