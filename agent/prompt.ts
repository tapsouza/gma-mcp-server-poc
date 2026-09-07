/**
 * The system prompt. It lives ALONE in this file, and it stays this small.
 *
 * ⚠ GROWING THIS FILE INVALIDATES SC-002 AND SC-003. ⚠
 *
 * The whole point of the harness is to find out whether a real model, reading only the
 * SERVER's own tool descriptions, relays a completeness caveat to a human and declines
 * to choose between ambiguous candidates. Those are the two contracts
 * `test/protocol/smoke.test.ts` structurally cannot reach: it proves a tool RESULT
 * carries its verdict, not that the verdict survives into the final English sentence.
 *
 * So this prompt MUST NOT restate the caveat-relaying rule or the non-selection rule
 * (FR-008). If it did, a passing verification would be measuring the harness's
 * coaching rather than the server's descriptions — a false pass, because a third-party
 * agent in production will never read this file.
 *
 * `agent/test/architecture.test.ts` asserts the absence of that coaching, so this is
 * enforced rather than merely requested. If the verification FAILS, the fix belongs in
 * the tool descriptions under `src/domains/catalogue/**` and is an escalation (FR-025,
 * T050) — never a line added here.
 */
export const SYSTEM_PROMPT = [
  'You are helping an engineer explore the GMA betting catalogue from a terminal.',
  '',
  'Answer using the tools available to you. Each tool carries its own description of',
  'what it does, what it returns, and how its results are to be used — read them and',
  'follow them.',
  '',
  'Answer in plain prose suitable for a terminal. Be concise.'
].join('\n');
