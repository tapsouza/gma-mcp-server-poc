import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadAgentConfig, type AgentConfig } from '../config.js';
import {
  AUTH_ERROR_PREFIX,
  runTurn,
  runTurnWithRecovery,
  type Conversation,
  type RecoveryCollaborators
} from '../repl/loop.js';
import { createRenderer, type Renderer } from '../repl/render.js';

/**
 * Mid-session credential recovery, and the turn loop's own contracts
 * (T068-T070, T029, T030, T034, T047; FR-004, FR-005, FR-006, FR-023, SC-007).
 *
 * The model is a stub. That is deliberate and is not the same exclusion FR-028 makes: the
 * properties asserted here belong to the HARNESS — trace ordering, history retention, the
 * one-retry bound — and are deterministic. What FR-028 excludes is asserting what a REAL
 * model does with the server's descriptions, which is SC-002/SC-003 and stays a manual
 * quickstart step.
 *
 * Must-cover cases:
 *  - an `isError` result whose text begins `[auth]` triggers renew → respawn → one retry
 *  - the conversation is UNCHANGED across the respawn (SC-007)
 *  - the retry happens at most ONCE per turn, so a doomed credential cannot loop
 *  - a `source: 'env'` credential produces "supply a new token", not a doomed refresh
 */

const ISSUER = 'https://example.okta.invalid/oauth2/aus000';

function config(): AgentConfig {
  return loadAgentConfig({
    GMA_BASE_URL: 'https://gma.example-nonprod.invalid',
    GMA_DEFAULT_INSTANCES: 'PP,BF',
    OKTA_ISSUER: ISSUER,
    AWS_REGION: 'us-east-1'
  });
}

interface Captured {
  readonly render: Renderer;
  readonly lines: string[];
  text(): string;
}

function captured(): Captured {
  const lines: string[] = [];
  return {
    lines,
    render: createRenderer((text) => lines.push(text)),
    text: () => lines.join('')
  };
}

/** A tool set shaped like the server's, returning whatever the test scripts. */
function toolsReturning(...outputs: unknown[]): ToolSet {
  let call = 0;
  return {
    list_instances: tool({
      description: 'List brand instances. Relay any caveat to the user.',
      inputSchema: z.object({}),
      execute: async () => {
        const output = outputs[Math.min(call, outputs.length - 1)];
        call += 1;
        return output;
      }
    })
  };
}

/** An MCP-shaped error result. `@ai-sdk/mcp` RETURNS these rather than throwing them. */
function authErrorResult(): unknown {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${AUTH_ERROR_PREFIX} No operator identity accompanied this request. The user must re-authenticate.`
      }
    ]
  };
}

function successResult(complete = true): unknown {
  const payload = {
    instances: [{ code: 'PP' }, { code: 'BF' }],
    completeness: complete
      ? { complete: true }
      : {
          complete: false,
          failedInstances: ['urn:i:BF:BF'],
          caveat: 'assembled from PP only — BF failed'
        }
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** The v4 usage shape, which the stub must supply on every `finish` part. */
const NO_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, reasoning: 0 },
  totalTokens: 2
} as unknown as LanguageModelV4Usage;

/**
 * A v4 `finishReason` is an OBJECT, not a string.
 *
 * Worth naming rather than inlining: the SDK gates tool execution on
 * `finishReason.unified` being `stop` or `tool-calls`, so a stub that supplies a bare
 * string silently produces a turn where the tool is never executed and no `tool-result`
 * part is emitted — a stub that looks right and tests nothing.
 */
const FINISH_TOOL_CALLS = { unified: 'tool-calls', raw: undefined } as const;
const FINISH_STOP = { unified: 'stop', raw: undefined } as const;

/**
 * A model that calls `list_instances` once, then answers in prose.
 *
 * Steps are consumed in order across the turns of one test — which is what lets a retry
 * be distinguished from the original attempt.
 */
function scriptedModel(steps: ('call' | 'answer')[]): LanguageModel {
  let index = 0;

  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;

      const chunks: LanguageModelV4StreamPart[] =
        step === 'call'
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `call-${index}`,
                toolName: 'list_instances',
                input: '{}'
              },
              { type: 'finish', finishReason: FINISH_TOOL_CALLS, usage: NO_USAGE }
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: `text-${index}` },
              { type: 'text-delta', id: `text-${index}`, delta: 'Two instances: PP and BF.' },
              { type: 'text-end', id: `text-${index}` },
              { type: 'finish', finishReason: FINISH_STOP, usage: NO_USAGE }
            ];

      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          }
        })
      };
    }
  });
}

function recoveryStub(
  overrides: Partial<RecoveryCollaborators> = {}
): RecoveryCollaborators & { renewCalls: number; respawnCalls: number } {
  const stub = {
    renewCalls: 0,
    respawnCalls: 0,
    async renew(): Promise<string | undefined> {
      stub.renewCalls += 1;
      return 'a-renewed-token-4f8c2a9e6b';
    },
    async respawn(): Promise<void> {
      stub.respawnCalls += 1;
    },
    toolsAfterRespawn(): ToolSet {
      return toolsReturning(successResult());
    },
    ...overrides
  };
  return stub;
}

describe('runTurn — trace lines and history', () => {
  it('shows the capability invocation BEFORE the answer (FR-005)', async () => {
    const out = captured();
    const conversation: Conversation = [{ role: 'user', content: 'which instances exist?' }];

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult()),
      render: out.render,
      conversation,
      model: scriptedModel(['call', 'answer'])
    });

    const text = out.text();
    const tracePosition = text.indexOf('⏺ list_instances');
    const answerPosition = text.indexOf('Two instances');

    // Seeing WHICH capability the model chose and WHAT it passed is the observation the
    // MCP Inspector cannot give, because there a human authors the arguments.
    expect(tracePosition).toBeGreaterThanOrEqual(0);
    expect(answerPosition).toBeGreaterThan(tracePosition);
  });

  it('shows the arguments the model passed', async () => {
    const out = captured();

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    expect(out.text()).toContain('⏺ list_instances {}');
  });

  it('shows a short outcome line for the returned invocation', async () => {
    const out = captured();

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    expect(out.text()).toContain('→ list_instances: 2 instances');
  });

  it('renders the structured completeness verdict DISTINCTLY from the prose (T047, FR-005)', async () => {
    const out = captured();

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult(false)),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    const text = out.text();
    // The trace shows what the SERVER said; the prose is what the MODEL said. Keeping
    // them visually distinct is what lets an engineer performing the SC-002 verification
    // tell whether the model RELAYED the caveat or merely received it.
    expect(text).toContain('⚠ server verdict:');
    expect(text).toContain('assembled from PP only');
  });

  it('does not synthesise the caveat into the answer', async () => {
    const out = captured();

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult(false)),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    // The stub model's prose says nothing about incompleteness. If the harness added a
    // caveat to the answer itself, SC-002 would measure the harness rather than the
    // server's descriptions — a false pass, since a third-party agent never runs this code.
    const answerOnly = out.text().split('⚠ server verdict:')[1] ?? '';
    expect(answerOnly).toContain('Two instances: PP and BF.');
    expect(answerOnly.toLowerCase()).not.toContain('incomplete');
  });

  it('makes the ABSENCE of an invocation plainly visible (Story 1 AC-7)', async () => {
    const out = captured();

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'hello' }],
      model: scriptedModel(['answer'])
    });

    // It must never be ambiguous whether the server was consulted: an answer from the
    // model's own knowledge is a different kind of answer, and an engineer verifying the
    // server's behaviour needs to know which one they got.
    expect(out.text()).toContain('no capability was invoked');
  });

  it('appends tool-result messages to history, not just prose (FR-006)', async () => {
    const conversation: Conversation = [{ role: 'user', content: 'which instances exist?' }];

    await runTurn({
      config: config(),
      tools: toolsReturning(successResult()),
      render: captured().render,
      conversation,
      model: scriptedModel(['call', 'answer'])
    });

    // Without the tool-result messages, a follow-up like "the Premier League one" cannot
    // resolve against the previous turn's candidates — the harness would still run while
    // silently disabling SC-003 entirely.
    const roles = conversation.map((message) => message.role);
    expect(roles).toContain('tool');
    expect(roles).toContain('assistant');
  });

  it('reports an auth-tagged error result without throwing', async () => {
    const out = captured();

    const turn = await runTurn({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    // `@ai-sdk/mcp`'s `execute` does `if (result.isError) return result` — the error is a
    // VALUE the model reads as text, never a throw (research.md R2). Only the harness can
    // refresh and respawn, so only the harness inspecting this can drive recovery.
    expect(turn.authFailed).toBe(true);
    expect(out.text()).toContain('error');
  });

  it('does not mistake a non-auth error for an auth failure', async () => {
    const upstreamError = {
      isError: true,
      content: [{ type: 'text', text: '[upstream] GMA returned HTTP 500 for GET /v5/instances.' }]
    };

    const turn = await runTurn({
      config: config(),
      tools: toolsReturning(upstreamError),
      render: captured().render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer'])
    });

    // Respawning on an upstream failure would restart the server for a problem the
    // server did not have, and would hide a genuine GMA outage behind a credential story.
    expect(turn.authFailed).toBe(false);
  });
});

describe('runTurnWithRecovery — mid-session expiry (FR-023, SC-007)', () => {
  it('renews, respawns, and retries once when the server reports [auth]', async () => {
    const out = captured();
    const recovery = recoveryStub();

    const turn = await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer', 'call', 'answer']),
      recovery
    });

    expect(recovery.renewCalls).toBe(1);
    expect(recovery.respawnCalls).toBe(1);
    expect(turn.authFailed).toBe(false);
  });

  it('leaves the conversation intact across the respawn (SC-007)', async () => {
    const conversation: Conversation = [
      { role: 'user', content: 'which leagues are under football?' },
      { role: 'assistant', content: 'Premier League, La Liga, and ten others.' },
      { role: 'user', content: 'which instances exist?' }
    ];
    const before = conversation.slice(0, 3);

    await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: captured().render,
      conversation,
      model: scriptedModel(['call', 'answer', 'call', 'answer']),
      recovery: recoveryStub()
    });

    // The conversation survives because it lives in the HARNESS, not in the child that
    // was replaced — which is what makes an earlier turn still influence the answer.
    expect(conversation.slice(0, 3)).toEqual(before);
    expect(conversation.length).toBeGreaterThan(3);
  });

  it('re-reads the tool set after the respawn rather than reusing the old one (FR-003)', async () => {
    let toolsRead = 0;
    const recovery = recoveryStub({
      toolsAfterRespawn(): ToolSet {
        toolsRead += 1;
        return toolsReturning(successResult());
      }
    });

    await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: captured().render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer', 'call', 'answer']),
      recovery
    });

    expect(toolsRead).toBe(1);
  });

  it('narrates the recovery — it is never silent (Story 5 AC-3)', async () => {
    const out = captured();

    await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer', 'call', 'answer']),
      recovery: recoveryStub()
    });

    // An unexplained pause followed by a restarted server is indistinguishable from a hang.
    const text = out.text().toLowerCase();
    expect(text).toContain('authentication failure');
    expect(text).toContain('renewed the credential');
    expect(text).toContain('retrying your question');
  });

  it('retries AT MOST ONCE, even when the retry also fails (Story 5 AC-5)', async () => {
    const recovery = recoveryStub({
      // A credential that will never work: the retry hits the same `[auth]` result.
      toolsAfterRespawn: () => toolsReturning(authErrorResult())
    });

    const turn = await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: captured().render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer', 'call', 'answer']),
      recovery
    });

    // One retry distinguishes "the credential aged out mid-session" from "this credential
    // will never work". Without the bound, the second case loops forever.
    expect(recovery.renewCalls).toBe(1);
    expect(recovery.respawnCalls).toBe(1);
    expect(turn.authFailed).toBe(true);
  });

  it('does not attempt recovery when the turn succeeded', async () => {
    const recovery = recoveryStub();

    await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(successResult()),
      render: captured().render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer']),
      recovery
    });

    expect(recovery.renewCalls).toBe(0);
    expect(recovery.respawnCalls).toBe(0);
  });

  it('stops when renewal declines, without a doomed respawn (Story 5 AC-4)', async () => {
    const out = captured();
    const recovery = recoveryStub({
      // What `main.ts` returns for a `source: 'env'` credential: it carries no refresh
      // token, so there is nothing to renew, and it has already said so.
      renew: async () => undefined
    });

    const turn = await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: out.render,
      conversation: [{ role: 'user', content: 'which instances exist?' }],
      model: scriptedModel(['call', 'answer']),
      recovery
    });

    expect(recovery.respawnCalls).toBe(0);
    expect(turn.authFailed).toBe(true);
  });

  it('reports a failed respawn without losing the conversation', async () => {
    const out = captured();
    const conversation: Conversation = [{ role: 'user', content: 'which instances exist?' }];
    const recovery = recoveryStub({
      respawn: async () => {
        throw new Error('spawn ENOENT');
      }
    });

    await runTurnWithRecovery({
      config: config(),
      tools: toolsReturning(authErrorResult()),
      render: out.render,
      conversation,
      model: scriptedModel(['call', 'answer']),
      recovery
    });

    expect(out.text()).toContain('Could not restart the catalogue server');
    expect(conversation.length).toBeGreaterThan(0);
  });
});
