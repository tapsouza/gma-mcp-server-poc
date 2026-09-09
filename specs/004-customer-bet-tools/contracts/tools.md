# Phase 1 Contract: The Customer Domain MCP Tool Surface

**Feature**: `004-customer-bet-tools` | **Date**: 2026-09-08

Five tools, registered at `/mcp/customer` (Principle III: each domain exposes its own
endpoint, so each agent sees a small coherent list). Every tool is **read-only by
construction** (FR-024, FR-025) and every successful result carries `completeness` as a
structured top-level field, including on full success (Principle II).

Types referenced here are defined in [data-model.md](../data-model.md).

---

## Shared: what no tool accepts

Enforced by an automated assertion over the schema files, not by review (FR-024, FR-025,
SC-010):

| Never an input | Why |
|---|---|
| A query, query fragment, field selection, or operation name | An agent that can supply a query can supply a mutation |
| An upstream path or path fragment | A catch-all proxy must not be reachable with a caller-chosen target |
| GMA base URL, timeout, issuer | Operational values come from deployment configuration (Principle V) |
| A brand argument | FanDuel only (FR-003) |
| `completeness` | It is a verdict this server earns, never one a caller asserts |

The upstream requests are **fixed constants in this repository**. The GraphQL document lives
in `src/domains/customer/gql/searchBets.ts` as a string literal; caller values reach only
`variables`.

---

## Shared: the completeness field

```jsonc
{
  "complete": false,
  "outcome": "PARTIAL",
  "successfulInstances": [],
  "failedInstances": [],
  "unavailableComponents": ["customerRiskConfiguration"],
  "errors": [],
  "caveat": "INCOMPLETE RESULT — this answer is missing section(s): customer risk configuration. Relay this caveat to the user; do not retry with different scoping, which cannot help."
}
```

The two axes are **both** always present and **never** merged. Their descriptions in the
schema tell the agent what to *do*, which is the difference that matters:

- `failedInstances` — *"Sources that did not answer. A narrowed retry may help."*
- `unavailableComponents` — *"Sections of this answer that could not be retrieved. State what
  is absent; retrying with different scoping will NOT help."*

`unavailableComponents` is an enum over exactly: `customerRiskConfiguration`, `betDetail`,
`legCataloguePositions`, `jurisdictionContexts`.

---

## Shared: error outcomes

`isError: true`, no `structuredContent`, and **no** `completeness` — a failure must never be
readable as data (Principle II).

| `kind` | From | `retryable` | The human/agent action |
|---|---|---|---|
| `auth` | `401` | `false` | The user re-authenticates |
| `forbidden` | `403` | **`false`** | Request access. **Do not retry** — a retry cannot succeed |
| `argument` | `400`, local validation | `false` | The agent corrects its arguments |
| `notFound` | `404` | `false` | Report the absence |
| `upstream` | `500`, `424`, timeout with nothing usable | `true` | Retry once, then report unavailable |

No error message ever contains an account identifier, bet identifier, receipt identifier,
customer name, or customer financial value (FR-030). An argument error describes the
**expected form**; a not-found states that **nothing matched**.

---

## 1. `list_jurisdiction_contexts`

The discovery tool for this domain's scoping vocabulary (Principle V). Its existence is what
lets the other tools accept jurisdiction codes without an agent guessing them.

**Upstream**: `GET /crs/contexts` — 1 hop.

**Input**: none.

**Output**

| Field | Type | Description |
|---|---|---|
| `jurisdictions` | `JurisdictionRef[]` | `{ code, id, name }` |
| `completeness` | `Completeness` | |

**Description (agent-facing, abridged)**
> Lists the jurisdictions (US states and territories) that customer risk settings and betting
> metrics can be scoped to. Call this before passing any `jurisdictions` filter — the codes
> are not derivable from a state name. Codes are mostly two-letter (`NJ`, `PA`) but not
> always. If the result is incomplete, relay the caveat: a jurisdiction missing from this list
> is not evidence that it does not exist.

---

## 2. `get_customer_risk_profile` (User Story 1, P1)

**Upstream**: `GET /crs/accounts/{accountId}` — 1 hop. **No catalogue calls**: GMA already
enriches each override with its full named ancestor chain (research.md R3).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `accountId` | `string` | yes | Validated for shape locally; the value is never echoed in an error |

**Output**

| Field | Type | Description |
|---|---|---|
| `accountId` | `string` | Echoed for the agent's own correlation |
| `jurisdictionConfigurations` | `CustomerRiskConfiguration[]` | **One per jurisdiction, never merged** |
| `completeness` | `Completeness` | |

**Behaviour**

- A customer with settings in three jurisdictions returns **three** configurations, each
  identified by its jurisdiction (FR-006). Merging, averaging, or collapsing is prohibited.
- Each override carries `path` — the named catalogue chain — so no second lookup is needed
  (FR-007).
- An unknown account is `notFound`, **not** an empty success with fabricated defaults.
- CRS publishes no partial-failure signal, so this tool returns either a complete answer or a
  tool error. It **never** synthesises a partial verdict (research.md R2).

**Description (agent-facing, abridged)**
> Returns a customer's risk configuration for **every jurisdiction they have one in** — each
> with its own stake factor, liability group, in-running delay, payout limits, winnings cap,
> and hierarchy-level overrides. There is no single global configuration: a customer may be
> restricted in one state and unrestricted in another, so **never** summarise across
> jurisdictions. Each override lists the catalogue path it applies to. If the result is
> incomplete, relay the caveat verbatim rather than presenting the configurations as the
> customer's whole picture.

---

## 3. `find_customer_bets` (User Story 2, P2)

**Upstream**: `POST /qbs/graphql` with a **fixed** `searchBets` document — 1 hop.

**Input** — exactly one identifier is required (FR-008)

| Field | Type | Notes |
|---|---|---|
| `accountId` | `string?` | |
| `betId` | `string?` | |
| `receiptId` | `string?` | The identifier a customer quotes — no manual conversion needed |
| `limit` | `number?` | Defaults to the configured cap (20); a larger value is clamped and the clamp reported |

Zero identifiers or more than one is an `argument` error naming the choices (SC-008). Values
land in `variables.input.ids`; nothing reaches the document or the path.

**Output**

| Field | Type | Description |
|---|---|---|
| `kind` | `'bets' \| 'none'` | `none` is "nothing matched" — not an error, not a caveat (FR-012) |
| `bets` | `Bet[]?` | Present when `kind` is `bets`; the curated risk projection |
| `totalMatched` | `number?` | From upstream `pageInfo.count` |
| `orderingCaveat` | `string` | **Always present** — see below |
| `limitReached` | `boolean` | `true` when the cap truncated the set (FR-010, no silent truncation) |
| `completeness` | `Completeness` | |

**Behaviour**

- Sorted `PLACEMENT_DATE DESC` upstream (research.md R6), then again after retrieval as a
  safeguard.
- `orderingCaveat` is stated **unconditionally**: *"These are the first N bets of the
  upstream result set, most recent first; this may not be the globally most recent set."* An
  operator who believes they are seeing the latest activity and is not would draw a wrong
  conclusion about a customer.
- **A `200` is not evidence of a complete answer.** When the response carries GraphQL
  `errors[]` and leaves requested fields unpopulated, the result is `complete: false` with the
  affected section named (FR-011, research.md R1). This is the single worst defect this
  feature could ship, and it is the surface's mandatory fixture.
- No bet carries staff-authored notes (FR-004) — enforced by the document constant, which
  omits `betNotesDetails` entirely.

**Description (agent-facing, abridged)**
> Finds a customer's bets by account, bet identifier, or the bet receipt identifier a customer
> quotes. Supply exactly one. Returns a risk-shaped view per bet: identifiers, placement time,
> status, type, jurisdiction, the **applied** risk figures, wager amounts, and per leg the
> selection/market/event/competition/sport. Always relay the `orderingCaveat`. `kind: "none"`
> means nothing matched — report that, do not retry.

---

## 4. `get_bet_risk_context` (User Story 3, P3) — the composite

The capability the domain exists for, and the only one an agent cannot assemble from the
others: it requires resolving each leg's event to obtain its risk-side catalogue position,
which no single upstream surface exposes.

**Upstream** — up to `3 + N` hops, `N` bounded by `CUSTOMER_MAX_EVENT_RESOLUTIONS`:

1. `POST /qbs/graphql` (fixed `searchBets` document) — the bet
2. `GET /crs/accounts/{accountId}` — the customer's configurations
3. `GET /crs/contexts` — the platform jurisdiction list, for matching
4. `GET /v5/events/{id}` × **distinct** events across the legs

*Amended 2026-09-08 (was `2 + N`, without hop 3).* Constitution v1.2.0 makes the context list the
**primary** jurisdiction-matching mechanism and US-state derivation a **fallback only**. Without
this hop the matcher receives an empty list and derivation silently becomes primary — which is
precisely the confidently-wrong behaviour the amendment exists to prevent, and it would pass every
unit test that hands the matcher a list directly.

Hop 3 is **not fatal on failure**: the result carries
`unavailableComponents: ['jurisdictionContexts']`, is `complete: false`, and still answers by
falling back to derivation. A jurisdiction the fallback cannot match is reported as
`jurisdictionNotMatched` — a failure of our matching, never as a fact about the customer.

**Input** — exactly one of

| Field | Type |
|---|---|
| `betId` | `string?` |
| `receiptId` | `string?` |

No jurisdiction argument: the bet reports its own, so everything is derived from the
identifier.

**Output**

| Field | Type | Description |
|---|---|---|
| `bet` | `Bet` | Including `appliedRisk` |
| `jurisdictionMatch` | `JurisdictionMatchOutcome` | One of four — **not** a form of incompleteness |
| `governingJurisdiction` | `JurisdictionRef?` | Present only when `matched` |
| `allJurisdictionConfigurations` | `CustomerRiskConfiguration[]` | **Always** — every configuration that exists |
| `resolvedLegs` | `ResolvedLeg[]` | Per leg: catalogue path, overrides in scope, resolution outcome, and `resolvedVia` |
| `agreement` | `AgreementVerdict[]` | Three-valued, both values always shown |
| `appliedFiguresAreBetLevel` | `boolean` | `true` for a multi-leg bet |
| `attributionNotice` | `string?` | Present iff `appliedFiguresAreBetLevel` |
| `candidates` | `BetRef[]?` | Present iff the identifier matched more than one bet |
| `completeness` | `Completeness` | |

**Behaviour**

- **More than one match resolves nothing.** All candidates are returned, no join is
  performed, and **no resolution work** is done — no CRS call, no event calls (FR-022).
- **Four distinguishable jurisdiction outcomes** (FR-018). In every non-`matched` case, all
  existing configurations are returned and the result **never** asserts that default settings
  applied. `noConfigurationForJurisdiction` (a fact about the customer) stays distinct from
  `jurisdictionNotMatched` (a failure of our matching) so a systematic defect cannot pass as
  data.
- **Never explains how a limit was computed** (FR-017). Applied and configured values sit side
  by side; the causal step is the human's.
- **Multi-leg bets carry `attributionNotice`** (FR-021): *"The applied risk figures are
  bet-level and cannot be attributed to any single leg."* And every comparison for such a bet
  is `notComparable`.
- **Distinct events resolve once** regardless of how many legs reference them (FR-023,
  SC-013). Exceeding the bound names the unresolved legs via each leg's
  `resolution: 'notAttemptedBoundReached'` and marks the result incomplete via
  `unavailableComponents: ['legCataloguePositions']`.
- **A missing section is named as such.** If CRS fails, `unavailableComponents` carries
  `customerRiskConfiguration` and the result is `complete: false` — never reported as a failed
  instance, which would tell the agent to retry with scoping that cannot help (FR-026).
- `overridesInScope: []` on a `resolved` leg means no override covers it. On an unresolved leg
  it means nothing is known. `resolution` is what tells them apart — never read the empty list
  as "unrestricted".

**Description (agent-facing, abridged)**
> For one bet, returns its **applied** risk figures side by side with the customer risk
> settings that were **in scope** for it. It does **not** and cannot explain how any limit was
> calculated — that formula is not available. Read `jurisdictionMatch` first: only `matched`
> means a specific configuration governed this bet, and in every other case you must **not**
> tell the user the customer was on default settings. For a multi-leg bet, relay
> `attributionNotice`: the applied figures are bet-level. Check each leg's `resolution` before
> reading its overrides — an empty override list on an unresolved leg does not mean
> unrestricted.

---

## 5. `get_customer_betting_metrics` (User Story 4, P4)

**Upstream**: `POST /accounts/{accountId}/metrics` — 1 hop. The `GET` variant is
`deprecated: true` and is **not** used (FR-015, research.md R12).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `accountId` | `string` | yes | |
| `aggregation` | `'BET_TYPE' \| 'HIERARCHY_ENTITY' \| 'TIMEFRAME'` | **yes** | Never defaulted (FR-014) |
| `period` | enum? | no | `_24_HOURS` … `LIFETIME` |
| `betTypes` | enum[]? | no | `SINGLE`, `PARLAY`, `SGP`, `SGP_PLUS`, `TEASER` |
| `placementStatus` | enum[]? | no | `PRE_MATCH`, `IN_PLAY` |
| `jurisdictions` | `string[]?` | no | Codes from `list_jurisdiction_contexts` |
| `hierarchy` | `{ level, ids[] }?` | no | One level only — several cannot be combined |
| `includeLifetimeTotals` | `boolean?` | no | |

**Output**

| Field | Type |
|---|---|
| `accountId` | `string` |
| `metrics` | `BettingMetrics` |
| `completeness` | `Completeness` |

**Behaviour**

- **Omitting `aggregation` is an `argument` error naming the three choices.** The system must
  not pick one: the aggregation determines the shape and meaning of the answer, and that is
  the operator's judgment.
- Upstream `400` bodies carry named `errorCode`s
  (`MULTIPLE_HIERARCHY_LEVELS_NOT_COMBINABLE`, `TOO_MANY_HIERARCHY_ENTITIES`,
  `ACCOUNT_IDENTIFIER_MISSING`). Each is translated to a **hint** precise enough to
  self-correct (SC-008). The upstream `message` is **never** interpolated — it can echo the
  account identifier.
- A `jurisdictions` filter gets the same honesty about matching as the composite: an
  unrecognised code is an `argument` error pointing at `list_jurisdiction_contexts`, never a
  silently-dropped filter.
- `vipManager` is **excluded** from the projection: it names a person (Principle V).

**Description (agent-facing, abridged)**
> Returns a customer's betting metrics — stakes, margins, bet counts, behavioural indicators —
> optionally narrowed by period, bet type, placement status, jurisdiction, or catalogue
> hierarchy. You **must** choose an `aggregation`; it changes the shape and meaning of the
> answer, so it is never chosen for you. Call `list_jurisdiction_contexts` for valid
> jurisdiction codes. If the result is incomplete, relay the caveat: metrics assembled from an
> incomplete set understate every total.

---

## Upstream operations used (surface register)

Every operation below appears in the constitution's surface register under `customer`, as
amended to **v1.2.0**. A tool MUST NOT call an operation absent from that register
(Principle IV).

| Tool | Operation | Hops |
|---|---|---|
| `list_jurisdiction_contexts` | `GET /crs/contexts` ★ | 1 |
| `get_customer_risk_profile` | `GET /crs/accounts/{accountId}` | 1 |
| `find_customer_bets` | `POST /qbs/graphql` (fixed document) | 1 |
| `get_customer_betting_metrics` | `POST /accounts/{accountId}/metrics` | 1 |
| `get_bet_risk_context` | all of: `POST /qbs/graphql`, `GET /crs/accounts/{accountId}`, `GET /crs/contexts`, `GET /v5/events/{id}` | 3 + N |

★ Added to the register by the v1.2.0 amendment (2026-09-08). The same amendment narrowed the
row's `POST /qbs/{path}` entry to `POST /qbs/graphql`: a register entry containing a path
variable would appear to license the caller-chosen upstream target Principle IV forbids.

v1.2.0 also makes the context list the **primary** jurisdiction-matching mechanism, with
derivation as a fallback only, and **prohibits** a hardcoded jurisdiction table. And it records
that `?instance=` MUST NOT be sent while QBS multi-instance routing is disabled, nor ever be
exposed as a tool argument — it is routing, not scoping.

`GET /v5/events/{id}` is already in the `customer` row and is reached through the shared
`core` client. That is composition, not coupling — no `domain → domain` import exists
(Principle III).
