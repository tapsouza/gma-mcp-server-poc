import type { Renderer } from './render.js';

/**
 * Interactive command dispatch (FR-007, contracts/cli.md).
 *
 * Exactly three commands: `/clear`, `/help`, `/exit`. Anything not starting with `/` is
 * a question for the model.
 *
 * **FR-035 is open, and answered NO for this feature.** The design brief §5.4 proposed
 * three more — print the conversation, invoke a capability directly with hand-written
 * arguments, force re-authentication. Dispatch sits behind this one seam precisely so
 * each is an independent later addition; none is built here.
 */

export type CommandOutcome =
  | { readonly kind: 'handled' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'question'; readonly text: string };

const HELP_LINES = [
  'Commands:',
  '  /clear   empty the conversation (the server keeps running)',
  '  /help    show this list',
  '  /exit    terminate the server and leave (Ctrl-D does the same)',
  '',
  'Anything else is a question. Ctrl-C interrupts an answer in progress.'
];

/**
 * Classify one line of input.
 *
 * An unknown `/command` is reported rather than sent to the model: silently treating
 * `/histroy` as a question would produce a baffling answer to a typo.
 */
export function dispatch(line: string, render: Renderer): CommandOutcome {
  const trimmed = line.trim();

  if (trimmed.length === 0) return { kind: 'handled' };

  if (!trimmed.startsWith('/')) return { kind: 'question', text: trimmed };

  switch (trimmed.toLowerCase()) {
    case '/exit':
    case '/quit':
      return { kind: 'exit' };

    case '/clear':
      return { kind: 'clear' };

    case '/help':
      for (const line of HELP_LINES) render.notice(line);
      return { kind: 'handled' };

    default:
      render.failure(`Unknown command: ${trimmed}. Try /help.`);
      return { kind: 'handled' };
  }
}
