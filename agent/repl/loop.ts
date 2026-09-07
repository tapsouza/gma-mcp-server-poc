import { amazonBedrock } from '@ai-sdk/amazon-bedrock';
import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { AgentConfig } from '../config.js';
import { SYSTEM_PROMPT } from '../prompt.js';
import type { Renderer } from './render.js';

/**
 * The turn loop (FR-004, FR-005, FR-006, FR-023).
 *
 * Note the provider export is **`amazonBedrock`**, not `bedrock`, and it reads
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`
 * from the environment lazily, at call time. Using the default instance rather than
 * passing credentials as constructor arguments is deliberate: a literal `accessKeyId`
 * suppresses `AWS_SESSION_TOKEN` pickup, which breaks rotating SSO credentials
 * (research.md R3).
 */

/**
 * A cap on steps per turn, so a misbehaving turn cannot loop indefinitely (FR-004).
 *
 * Generous enough for a real multi-hop question — find an entity, then fetch its
 * detail, then answer — and low enough that a model stuck in a retry cycle stops
 * rather than burning tokens until someone notices.
 */
export const MAX_STEPS_PER_TURN = 12;

/** The prefix the server tags an auth failure with, pinned by `test/protocol/smoke.test.ts:200`. */
export const AUTH_ERROR_PREFIX = '[auth]';

/**
 * The session's accumulated turns (data-model.md §5).
 *
 * Held here, in the harness, which is what lets it survive the respawn in FR-023.
 */
export type Conversation = ModelMessage[];

export interface RunTurnDeps {
  readonly config: AgentConfig;
  readonly tools: ToolSet;
  readonly render: Renderer;
  readonly conversation: Conversation;
  /** Aborts the stream on Ctrl-C (Edge Cases). */
  readonly signal?: AbortSignal | undefined;
  /**
   * The model, injected only by the suite.
   *
   * `main.ts` never passes this, so production always uses the Bedrock provider below.
   * The seam exists because FR-023's "retry at most once" and FR-005's trace ordering are
   * properties of THIS function, and asserting them against a real model would be
   * non-deterministic, cost tokens per run, and need AWS credentials in CI — the reasons
   * FR-028 keeps a real-model test out of automation entirely.
   */
  readonly model?: LanguageModel | undefined;
}

export interface TurnOutcome {
  /** True when a tool result carried an `[auth]` failure, so the caller may recover. */
  readonly authFailed: boolean;
  /** True when the turn made at least one capability invocation (Story 1 AC-7). */
  readonly invokedCapability: boolean;
  /** True when the turn was interrupted by Ctrl-C rather than completing. */
  readonly aborted: boolean;
}

/** Extract the text a tool returned, whatever shape the MCP result arrived in. */
function toolResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output !== 'object' || output === null) return '';

  const record = output as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/** Whether an MCP tool result is an error. `@ai-sdk/mcp` RETURNS these, never throws them. */
function isErrorResult(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { isError?: unknown }).isError === true
  );
}

/**
 * A short outcome line for a returned invocation (FR-005).
 *
 * Deliberately a SUMMARY, not the payload: a catalogue result can be hundreds of lines
 * of JSON, and burying the trace in it defeats the point of showing the trace. The full
 * result still reaches the model.
 */
function summariseResult(output: unknown): string {
  if (isErrorResult(output)) {
    const text = toolResultText(output).split('\n')[0] ?? 'error';
    return `error — ${text}`;
  }

  const structured = extractStructured(output);
  if (structured === undefined) return 'returned';

  const parts: string[] = [];
  if (typeof structured.kind === 'string') parts.push(structured.kind);
  if (Array.isArray(structured.candidates))
    parts.push(`${structured.candidates.length} candidates`);
  if (Array.isArray(structured.instances)) parts.push(`${structured.instances.length} instances`);
  if (Array.isArray(structured.children)) parts.push(`${structured.children.length} children`);

  const entity = structured.entity;
  if (
    typeof entity === 'object' &&
    entity !== null &&
    typeof (entity as { name?: unknown }).name === 'string'
  ) {
    parts.push(`entity "${(entity as { name: string }).name}"`);
  }

  return parts.length === 0 ? 'returned' : parts.join(', ');
}

/** The server mirrors its structured payload into the text content, so parse that. */
function extractStructured(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === 'object' && output !== null) {
    const direct = (output as { structuredContent?: unknown }).structuredContent;
    if (typeof direct === 'object' && direct !== null) return direct as Record<string, unknown>;
  }

  const text = toolResultText(output);
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's own completeness verdict, when the result carries an incomplete one.
 *
 * Rendered distinctly from the model's prose (Story 3 AC-3) so an engineer performing
 * the SC-002 verification can tell at a glance whether the model RELAYED the caveat or
 * merely received it. The harness does NOT synthesise the caveat into the answer — if
 * it did, SC-002 would measure the harness rather than the server's descriptions.
 */
function incompleteCaveat(output: unknown): string | undefined {
  const structured = extractStructured(output);
  const completeness = structured?.completeness;
  if (typeof completeness !== 'object' || completeness === null) return undefined;

  const record = completeness as { complete?: unknown; caveat?: unknown };
  if (record.complete !== false) return undefined;
  return typeof record.caveat === 'string' ? record.caveat : 'result is incomplete';
}

/**
 * Run one turn: send the conversation to the model, stream the answer, and trace every
 * capability invocation.
 *
 * The user's message must already be appended to `conversation`, so a retry after an
 * auth recovery replays the same turn without the engineer retyping it (FR-023).
 */
export async function runTurn(deps: RunTurnDeps): Promise<TurnOutcome> {
  const { config, tools, render, conversation, signal, model } = deps;

  let authFailed = false;
  let invokedCapability = false;
  let aborted = false;
  let wroteAnswerText = false;

  const result = streamText({
    model: model ?? amazonBedrock(config.modelId),
    system: SYSTEM_PROMPT,
    messages: conversation,
    tools,
    // A misbehaving turn must stop rather than loop (FR-004).
    stopWhen: isStepCount(MAX_STEPS_PER_TURN),
    ...(signal === undefined ? {} : { abortSignal: signal })
  });

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'tool-call':
          // BEFORE the answer, every time, never summarised across invocations
          // (FR-005, Story 1 AC-3). Seeing which capability the model chose and what
          // it passed is the observation the MCP Inspector cannot give, because there
          // a human authors the arguments.
          invokedCapability = true;
          render.traceCall(part.toolName, part.input);
          break;

        case 'tool-result': {
          render.traceResult(part.toolName, summariseResult(part.output));

          const caveat = incompleteCaveat(part.output);
          if (caveat !== undefined) render.traceCaveat(caveat);

          // Auth detection is a BRANCH here rather than a wrapper around the discovered
          // tools, because `@ai-sdk/mcp`'s `execute` does `if (result.isError) return
          // result` — the error is a value the model reads as text, not a throw
          // (research.md R2). Only the harness can refresh the token and respawn, so
          // only the harness inspecting this can drive recovery.
          if (
            isErrorResult(part.output) &&
            toolResultText(part.output).includes(AUTH_ERROR_PREFIX)
          ) {
            authFailed = true;
          }
          break;
        }

        case 'tool-error':
          // A tool that threw rather than returning an error result. Rare with MCP, but
          // an invocation the engineer must still see.
          render.traceResult(part.toolName, 'invocation failed');
          break;

        case 'text-delta':
          if (!wroteAnswerText && part.text.length > 0) {
            render.blank();
            wroteAnswerText = true;
          }
          // Streamed progressively as it arrives (FR-004).
          render.answerChunk(part.text);
          break;

        case 'abort':
          aborted = true;
          break;

        default:
          // Every other part type — step framing, reasoning, raw provider chunks —
          // carries nothing the engineer needs. Explicitly ignored rather than
          // rendered, so the trace stays the signal it is meant to be.
          break;
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      aborted = true;
    } else {
      throw error;
    }
  }

  if (wroteAnswerText) render.blank();

  if (aborted) {
    // History is deliberately NOT appended on an interrupt: a half-streamed answer
    // would be indistinguishable from a complete one on the next turn, and the model
    // would build on a sentence it never finished.
    return { authFailed, invokedCapability, aborted };
  }

  if (!invokedCapability) {
    // It must never be ambiguous whether the server was consulted (Story 1 AC-7). A
    // turn answered from the model's own knowledge is a different kind of answer, and
    // an engineer verifying the server's behaviour needs to know which one they got.
    render.notice('no capability was invoked — answered without consulting the server');
  }

  // Appended INCLUDING tool-result messages (FR-006). This is what lets a follow-up
  // like "the Premier League one" resolve against the previous turn's candidates.
  // Dropping them would leave the harness running while silently disabling SC-003 —
  // the disambiguation contract could not be exercised at all.
  //
  // **`responseMessages`, not `response.messages`.** research.md R5 named the latter;
  // in `ai@7.0.93` that accessor is deprecated and carries only the FINAL step, so on a
  // turn that invoked a capability (step 1: tool call → step 2: prose) the tool-result
  // message is silently dropped and the harness quietly stops testing what it exists to
  // test. `responseMessages` is documented as "the accumulated response messages of all
  // steps". `agent/test/recovery.test.ts` asserts a `tool` role reaches history, which
  // is what caught this.
  conversation.push(...(await result.responseMessages));

  return { authFailed, invokedCapability, aborted };
}

/** Ctrl-C surfaces as an abort, which is an interruption rather than a failure. */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'ResponseAborted';
}

/**
 * What a caller must supply to recover from a mid-session credential expiry.
 *
 * Kept as an interface so `runTurnWithRecovery` can be driven by the suite without a
 * real child process or a real identity provider — which is what makes the
 * at-most-one-retry rule assertable rather than merely intended.
 */
export interface RecoveryCollaborators {
  /**
   * Renew the credential, or return `undefined` having already explained why it cannot
   * be renewed (a `source: 'env'` credential carries no refresh token).
   */
  renew(): Promise<string | undefined>;
  /** Replace the child with one holding the new token, and re-discover capabilities. */
  respawn(accessToken: string): Promise<void>;
  /** The capability set to use after a respawn — re-read, never assumed unchanged. */
  toolsAfterRespawn(): ToolSet;
}

export interface RunTurnWithRecoveryDeps extends RunTurnDeps {
  readonly recovery: RecoveryCollaborators;
}

/**
 * Run a turn, recovering once from a credential that expired mid-session (FR-023).
 *
 * **At most ONE retry per turn.** That single retry is what distinguishes "the
 * credential aged out while I was working" from "this credential will never work" — and
 * the bound is what stops the latter from looping forever (Story 5 AC-5).
 *
 * Recovery is never silent (Story 5 AC-3): an unexplained pause followed by a restarted
 * server is indistinguishable from a hang.
 */
export async function runTurnWithRecovery(deps: RunTurnWithRecoveryDeps): Promise<TurnOutcome> {
  const { render, recovery } = deps;

  const first = await runTurn(deps);
  if (!first.authFailed || first.aborted) return first;

  render.notice('the server reported an authentication failure');

  const renewed = await recovery.renew();
  // `undefined` means the collaborator has already said why — a doomed refresh attempt
  // would only add a second, less useful message.
  if (renewed === undefined) return first;

  render.notice('renewed the credential — restarting the server');
  try {
    await recovery.respawn(renewed);
  } catch (error) {
    // A failed respawn leaves the session unusable, but the harness itself should stay
    // up: the engineer may still want `/exit` to tear down cleanly, and killing the
    // process here would lose the conversation for no benefit.
    render.failure(
      `Could not restart the catalogue server after renewing the credential: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    );
    return first;
  }

  render.notice('retrying your question');
  // Retried from the PRESERVED conversation, so the engineer does not retype the
  // question (Story 5 AC-1). The conversation survives because it lives here, in the
  // harness, not in the child that was just replaced.
  const second = await runTurn({ ...deps, tools: recovery.toolsAfterRespawn() });

  // Deliberately NOT recursive and not looped: whatever the retry produced is the
  // outcome, even another auth failure.
  return second;
}
