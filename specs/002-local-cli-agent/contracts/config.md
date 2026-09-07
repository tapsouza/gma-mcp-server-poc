# Contract: Configuration

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

Every environment variable the harness reads, who validates it, and — the column that matters
most — **whether it is forwarded to the child**. That column is the FR-011 contract.

---

## The variables

| Variable | Required | Default | Validated by | Forwarded to child? |
| --- | --- | --- | --- | --- |
| `GMA_BASE_URL` | yes | — | harness, before spawn | **yes** |
| `GMA_DEFAULT_INSTANCES` | yes | — | harness, before spawn | **yes** |
| `OKTA_ISSUER` | yes | — | harness, before spawn | **yes** |
| `GMA_USER_TOKEN` | no *(was required)* | — | harness, if present | **yes** |
| `GMA_TIMEOUT_MS` | no | child's `30000` | child | **yes**, if set |
| `GMA_MAX_CANDIDATES` | no | child's `25` | child | **yes**, if set |
| `LOG_LEVEL` | no | **`warn`** (harness overrides the child's `info`) | harness | **yes** |
| `OKTA_CLIENT_ID` | only for device login | — | harness, lazily | **no** |
| `AGENT_MODEL_ID` | no | `us.anthropic.claude-sonnet-5` | harness | **no** |
| `AWS_REGION` | yes | — | harness | **no** |
| `AWS_ACCESS_KEY_ID` | yes | — | Bedrock provider | **no** |
| `AWS_SECRET_ACCESS_KEY` | yes | — | Bedrock provider | **no** |
| `AWS_SESSION_TOKEN` | if using SSO | — | Bedrock provider | **no** |

---

## Rules

**1. `GMA_USER_TOKEN` becomes optional.** It was required for the server; the harness can now
produce a credential by device login instead. When it *is* set it wins outright (FR-015 step 1),
which keeps the harness usable before the Okta app exists (FR-016) and keeps working with whatever
token an engineer is already pasting for the MCP Inspector.

**2. AWS credentials are never forwarded.** The GMA server has no business holding them, and its
narrow audited input set is the entire point of `src/core/config.ts`. Suite C asserts the child
does not receive `AWS_SECRET_ACCESS_KEY` — a test, not a convention.

**3. The child's environment is an explicit allowlist**, never the parent's environment. This is
not defensive coding: both candidate transports strip everything except
`['HOME','LOGNAME','PATH','SHELL','TERM','USER']` (research.md R4), so the values *must* be passed
deliberately or the child exits `78`.

**4. Validation happens before the spawn** (FR-010). Ordering within it is deliberate: the three
values the child requires are checked first, because that is the most likely first failure and
must produce the clearest message.

**5. `OKTA_CLIENT_ID` is validated lazily** — only when the credential ladder actually reaches
device login. Validating it eagerly would break the supplied-token path for everyone until an Okta
app exists, defeating FR-033.

**6. `LOG_LEVEL` defaults the child to `warn`, not `info`.** At `info` the server's own log lines
scribble over the prompt mid-typing. Still configurable (FR-013).

**7. `AGENT_MODEL_ID` exists so a Bedrock `403` is a configuration fix, not a code change**
(FR-009, SC-014). Bedrock model access is granted per AWS account, so the default is a starting
guess and the failure message must name this variable.

---

## `.env` loading

`process.loadEnvFile('.env')` — a Node 22 builtin, no dependency — must be the **first statement**
in `agent/main.ts`, before any import that reads the environment at module scope. The Bedrock
provider reads `AWS_*` when it is evaluated; import it earlier and it sees an empty environment and
fails with an authentication error that points nowhere near the real cause.

---

## `.env.example`

Gains `OKTA_CLIENT_ID`, `AGENT_MODEL_ID`, `AWS_REGION`, and the AWS credential names, and
`GMA_USER_TOKEN` is re-documented as optional (FR-031).

Its existing discipline holds without exception: every value illustrative, no real host, no real
client id, no token, no key. The file is committed — a real value in it is an incident, not an
inconvenience.
