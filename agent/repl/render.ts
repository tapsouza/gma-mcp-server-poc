/**
 * The SINGLE place anything in the harness writes to the terminal (FR-014, SC-008).
 *
 * Nothing else under `agent/` may call `console.*` or `process.stdout.write` —
 * `agent/test/architecture.test.ts` asserts that structurally, because a rule that
 * is only documented gets broken by the next person in a hurry.
 *
 * Two mechanisms, in the order they matter:
 *
 * 1. **An allowlist of line shapes.** Callers cannot emit arbitrary text; they call a
 *    named writer with typed fields, and this module formats it. This is the same
 *    reasoning `src/core/errors.ts`'s `safeUpstreamDetail` uses — it DISCARDS upstream
 *    body text rather than trying to redact it, because a new leak path cannot appear
 *    by being forgotten. A denylist of patterns would leak the day someone adds a
 *    field and forgets to scrub it.
 *
 * 2. **A registered-secret scrub, as the last gate before the write.** Every line,
 *    from every writer, is checked against the exact credential strings the session
 *    holds. This is belt-and-braces rather than the primary mechanism: mechanism 1 is
 *    what makes a leak structurally hard, and this is what catches the case mechanism
 *    1 cannot reason about — text that arrives from outside the harness (the model's
 *    own prose, the child's stderr) and could in principle quote a value back.
 *
 * The two together are why SC-008 is provable rather than aspirational.
 */

/** Where a line goes. Injectable so tests capture output without patching globals. */
export type Sink = (text: string) => void;

const REDACTED = '«redacted»';

/**
 * The exact credential strings this session must never print.
 *
 * A `Set` of literal values rather than a pattern: we know precisely what the
 * secrets are, so there is no guessing and no false positive on ordinary prose.
 * Short values are refused — scrubbing a two-character string would mangle every
 * line it happens to appear inside, which is noise pretending to be safety.
 */
const secrets = new Set<string>();

const MIN_SCRUBBABLE_LENGTH = 8;

/**
 * Register a value that must never reach the terminal.
 *
 * Called once the credential ladder resolves, and again after a refresh — the old
 * token stays registered, because a line built before the refresh may still be in
 * flight.
 */
export function registerSecret(value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SCRUBBABLE_LENGTH) return;
  secrets.add(trimmed);
}

/** Test seam only: forget every registered secret. */
export function resetSecretsForTest(): void {
  secrets.clear();
}

/** Replace every registered secret with a marker. The last gate before a write. */
export function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * A renderer bound to a sink.
 *
 * Constructed once in `main.ts` and threaded explicitly, rather than exported as a
 * module-level singleton, so a test can assert on exactly what a code path wrote
 * without touching global state.
 */
export interface Renderer {
  /** A startup or status line, prefixed `✓`. */
  status(text: string): void;
  /** One capability invocation, shown BEFORE the answer (FR-005). */
  traceCall(toolName: string, args: unknown): void;
  /** The short outcome line for an invocation that has returned (FR-005). */
  traceResult(toolName: string, summary: string): void;
  /**
   * The structured completeness verdict, rendered distinctly from the model's prose
   * so an engineer can tell at a glance whether the model RELAYED the caveat or
   * merely received it (FR-005, Story 3 AC-3).
   */
  traceCaveat(caveat: string): void;
  /** A chunk of the model's answer, streamed with no trailing newline (FR-004). */
  answerChunk(text: string): void;
  /** An informational notice — recovery in progress, child exited, and so on. */
  notice(text: string): void;
  /** A failure the engineer must act on. */
  failure(text: string): void;
  /** A line of the child's own diagnostics, echoed under `--verbose` (FR-012). */
  childDiagnostic(line: string): void;
  /** A bare newline, for spacing between a trace block and an answer. */
  blank(): void;
}

function defaultSink(text: string): void {
  process.stdout.write(text);
}

/**
 * The terminal streams, exposed because `readline` needs them and this module owns the
 * terminal.
 *
 * `readline` is the ONE legitimate consumer. What it writes through `terminalOutput` is
 * the prompt string and the echo of characters the engineer typed — never
 * harness-generated text, and never anything derived from a credential the harness
 * holds. Every line the harness itself produces still goes through a writer below.
 *
 * Exposing them here rather than reaching for `process.stdout` in `main.ts` keeps the
 * architecture assertion absolute: `agent/test/architecture.test.ts` asserts that no
 * file outside this one mentions `process.stdout` at all, which is a far stronger and
 * more reviewable property than "no file writes credentials to stdout".
 */
export const terminalInput = process.stdin;
export const terminalOutput = process.stdout;

/**
 * Format a tool call's arguments for a trace line.
 *
 * Bounded, because a model can pass a large argument and a trace line that wraps
 * twenty times hides the very thing it exists to show.
 */
const MAX_ARGS_LENGTH = 300;

function formatArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    // A circular or unserialisable argument is not worth a crash in a trace line.
    text = '<unserialisable arguments>';
  }
  return text.length > MAX_ARGS_LENGTH ? `${text.slice(0, MAX_ARGS_LENGTH)}…` : text;
}

export function createRenderer(sink: Sink = defaultSink): Renderer {
  // Every writer below funnels through this one function, so the scrub cannot be
  // skipped by adding a writer that forgets it.
  const write = (text: string): void => {
    sink(scrub(text));
  };

  return {
    status: (text) => write(`✓ ${text}\n`),
    traceCall: (toolName, args) => write(`⏺ ${toolName} ${formatArgs(args)}\n`),
    traceResult: (toolName, summary) => write(`  → ${toolName}: ${summary}\n`),
    traceCaveat: (caveat) => write(`  ⚠ server verdict: ${caveat}\n`),
    answerChunk: (text) => write(text),
    notice: (text) => write(`· ${text}\n`),
    failure: (text) => write(`✗ ${text}\n`),
    childDiagnostic: (line) => write(`  [server] ${line}\n`),
    blank: () => write('\n')
  };
}
