# Contract: Command-Line Surface

**Feature**: `specs/002-local-cli-agent` | **Date**: 2026-09-07

The harness's interface to the engineer. This is the contract FR-001, FR-004, FR-005, and FR-007
are verified against.

---

## Invocation

```bash
npm run agent              # normal
npm run agent -- --verbose # echo the child's diagnostics live (FR-012)
```

The script chain is deliberate (FR-001):

```jsonc
"build:agent": "tsc -p agent/tsconfig.json",
"agent":      "npm run build && npm run build:agent && node dist-agent/main.js",
"test":       "vitest run",                                        // UNCHANGED (FR-026)
"test:agent": "npm run build && npm run build:agent && vitest run -c agent/vitest.config.ts",
"test:all":   "npm test && npm run test:agent"
```

`npm run build` comes first because the harness spawns `dist/index.js`. Without it an engineer can
silently drive a stale server and draw a false conclusion about the server's behaviour — which,
for a harness whose purpose is drawing conclusions about the server, is the worst available
failure.

`test:agent` builds **both** artefacts: suite C spawns a real `dist/index.js`, and the CLI suite
runs the real `dist-agent/main.js` as a process to assert the exit-code table below. `build:agent`
is a named script rather than an inlined `tsc` invocation so its two callers cannot drift.

**`npm test` is not touched.** SC-011 requires that be verifiable by comparison.

---

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--verbose` | off | Echo the child's stderr as it arrives (FR-012). Off by default because server logs interleaved with an interactive prompt make the harness unpleasant to use — which would defeat its purpose as the preferred manual tool. |

---

## Startup output

On success, before the first prompt (Story 1 AC-1, within 10 seconds):

```text
✓ signed in as <identity description>        ← never the token itself (FR-014)
✓ spawned gma-mcp-server (3 tools)
>
```

The identity line describes *which* credential is in use and how it was obtained — a
`source` from data-model.md §2 — never any part of the credential.

---

## A turn

```text
> which leagues are under football?

⏺ find_catalogue_entity { "name": "football" }
  → resolved: Football (12 children)

Football has 12 subclasses: Premier League, La Liga, …

⚠ assembled from PP only — BF failed.
```

Three requirements are visible here:

- **FR-005** — the capability name and its arguments appear **before** the answer. Every
  invocation, never summarised. This is the harness's primary purpose: seeing *which* capability
  the model chose and *what* it passed is the observation the MCP Inspector cannot give, because
  there a human authors the arguments.
- **FR-004** — the answer streams progressively.
- **SC-002** — the caveat in the final natural-language turn comes from the *model relaying the
  server's structured verdict*, driven by the server's own tool description. The harness does not
  synthesise that line from the result. If it did, SC-002 would measure the harness.

Multi-invocation turns print one trace block per invocation, in order (Story 1 AC-3). A turn that
makes no invocation still shows that plainly (Story 1 AC-7), so it is never ambiguous whether the
server was consulted.

---

## Interactive commands (FR-007, FR-035)

| Command | Effect |
| --- | --- |
| `/clear` | Empty the conversation. The harness stays running and the child is not restarted. |
| `/help` | List available commands. |
| `/exit` (and Ctrl-D) | Terminate the child, then exit. No orphan process (Story 1 AC-6). |

**FR-035 is open.** Three further commands were proposed in the design brief §5.4 — print the
conversation, invoke a capability directly with hand-written arguments, force re-authentication.
Command dispatch sits behind one seam (`agent/repl/commands.ts`), so each is an independent
addition. **Build the three above; add nothing else until the question is answered.**

Anything not starting with `/` is a question for the model.

---

## Interrupt

Ctrl-C mid-answer stops the output, returns to the prompt, and leaves the child healthy
(Edge Cases). It does not exit the harness — that is `/exit` or Ctrl-D.

---

## Exit codes

| Code | Meaning | Requirement |
| --- | --- | --- |
| `0` | Clean exit | — |
| `64` | Usage error (unknown flag) | — |
| `77` | No credential could be obtained, and device login is unavailable — the message states exactly what to request from an Okta administrator | FR-022, Story 4 AC-10 |
| `78` | Configuration invalid or missing; names the specific value; **child never spawned** | FR-010, SC-005 |
| `70` | Child failed to spawn or connect; the child's own buffered stderr is shown | FR-012, SC-006 |

`78` deliberately matches the child's own configuration exit code (`src/index.ts:31`, `EX_CONFIG`)
so the same class of failure reports the same way whichever process detects it.

---

## Output rules that hold in every mode

- **No credential material, ever** — not in trace lines, not in error messages, not under
  `--verbose`, not on any failure path (FR-014, SC-008). Enforced by routing every write through
  `agent/repl/render.ts` with an allowlist, the same reasoning `src/core/errors.ts`'s
  `safeUpstreamDetail` already uses: a new leak path cannot appear by being forgotten.
- **The child's diagnostics never corrupt the prompt** (FR-012, Story 2 AC-3). They are buffered,
  not inherited.
- **Recovery is never silent** (FR-023, Story 5 AC-3). A mid-session refresh-and-respawn prints
  notice lines.
