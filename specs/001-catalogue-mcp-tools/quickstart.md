# Phase 1 Quickstart: Validating Catalogue MCP Tools

**Date**: 2026-09-03 | **Contracts**: [contracts/tools.md](./contracts/tools.md) | **Types**: [data-model.md](./data-model.md)

How to run this slice and prove it works. Scope is local-only (FR-023, FR-024): a developer
machine against non-production GMA, plus a fully offline test suite.

---

## Prerequisites

- Node.js 22 LTS
- A **non-production** GMA base URL reachable from your machine
- A real OKTA token from the **matching environment's** authorization server — issuers are
  per-environment, so a token from one environment is rejected by another
- Membership in that environment's `app_*_<env>` groups (GMA rejects otherwise)

## Setup

```bash
npm install
cp .env.example .env    # then fill in the values below
```

Required (startup fails without them — FR-019, verified by step 4):

| Variable | Example |
|---|---|
| `GMA_BASE_URL` | `https://<non-prod-gma-host>` |
| `GMA_DEFAULT_INSTANCES` | `PP,BF` |
| `OKTA_ISSUER` | `https://fanduel.okta.com/oauth2/<env-authz-server-id>` |

Optional: `GMA_TIMEOUT_MS` (30000), `GMA_MAX_CANDIDATES` (25), `LOG_LEVEL` (`info`).

---

## Validation 1 — Automated suite (no GMA, no token)

The primary gate. Runs entirely against fixtures, so it exercises outcomes live GMA cannot be
made to produce on demand.

```bash
npm test                 # unit + integration + protocol smoke
npm run test:coverage    # enforces the constitutional gates
```

**Expected**: all green; coverage ≥ 90% line / 85% branch overall and ≥ 95% line for `core/`.
A coverage shortfall is a **failure**, not a warning — the threshold is constitutional and is
never lowered to make a build pass.

Must-cover cases, each named in a test (SC-003):

| Case | Asserts |
|---|---|
| Single match → resolved + children | FR-013, FR-025, SC-011 |
| Several matches → all candidates, none chosen | FR-014, SC-002 |
| Zero matches → `kind: 'none'`, not an error | FR-010 |
| HTTP 206 on hop 1 → caveat at top level | FR-005–FR-007, SC-001 |
| HTTP 206 on hop 2 only → whole result incomplete | FR-008, SC-011 |
| Match count > threshold → `tooBroad` + `narrowBy` | FR-015 |
| 400 → `argument`; 401 → `auth`; 404 → `notFound`; 500 → `upstream` | FR-010, SC-008 |
| Timeout with partial data vs none | FR-010 |
| Two identities in one process → no bleed | **FR-023a**, SC-010 |
| Unknown instance code → `argument` naming `list_instances` | FR-017, SC-008 |
| Token absent from all logs and span attributes | FR-020, SC-006 |

---

## Validation 2 — MCP protocol smoke

Confirms the three tools are discoverable and one round-trips.

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

**Expected**: exactly three tools listed — `list_instances`, `find_catalogue_entity`,
`get_catalogue_entity` — each with a description that mentions relaying caveats (FR-009), and
neither `completeness` nor identity appearing as an *input* parameter.

---

## Validation 3 — Live GMA (manual, pre-release only)

Never in CI: it needs a human token and cannot force failure modes.

```bash
export GMA_USER_TOKEN="<your OKTA access token>"
npm run dev              # stdio server
```

Then, from an MCP client:

1. **`list_instances`** → expect real brand codes, `complete: true`.
   *This alone proves the whole pipeline: identity forwarded, response parsed, completeness
   produced (Story 1, P1).*
2. **`find_catalogue_entity`** with a name you expect to be unique (e.g. `"Premier League"`)
   → `kind: 'resolved'` with `children` populated one level down.
3. **`find_catalogue_entity`** with a deliberately vague name (e.g. `"a"`) → `candidates` or
   `tooBroad`, never an arbitrary single pick.
4. **`get_catalogue_entity`** using an id from step 2 → matching entity.
5. **Expire the token** (or corrupt it) and retry → `kind: 'auth'`, not "no results".

---

## Validation 4 — Fail-fast configuration

```bash
unset GMA_BASE_URL && npm run dev
```

**Expected**: refuses to start, naming the missing variable; **never** starts and fails at
first request (FR-019, SC-007).

---

## Definition of done

- [ ] `npm test` green; coverage gates met
- [ ] All must-cover cases present and named
- [ ] Protocol smoke lists exactly three tools with caveat-relaying descriptions
- [ ] Live validation steps 1–5 pass against non-production GMA
- [ ] Missing-config startup refusal verified
- [ ] No credential appears in any log, trace, or error message

Out of scope, deliberately: remote transport, shared-environment deployment, the Prefab
scaffold (deferred — [research.md](./research.md) R6), traversal below one level, any fourth
tool.
