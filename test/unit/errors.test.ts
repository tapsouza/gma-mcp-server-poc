import { describe, expect, it } from 'vitest';
import {
  argumentError,
  fromHttpStatus,
  fromTimeoutWithNoData,
  fromTransportFailure,
  isToolError,
  malformedResponse,
  unsatisfiableGeneration
} from '../../src/core/errors.js';
import { ToolError } from '../../src/core/types.js';

/** A realistic bearer token, used to prove it never survives into a message. */
const TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9.eyJzdWIiOiJqYW5lLmRvZUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJl';

describe('error mapping', () => {
  describe('case: each terminal status maps to the correct kind (FR-010, SC-008)', () => {
    it.each([
      [400, 'argument', false],
      [401, 'auth', false],
      [404, 'notFound', false],
      [500, 'upstream', true]
    ] as const)('maps HTTP %i to kind %s with retryable=%s', (status, kind, retryable) => {
      const error = fromHttpStatus(status, 'listInstances');

      expect(error).toBeInstanceOf(ToolError);
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(String(status));
    });

    it.each([[403], [409], [502], [503], [504]])(
      'maps unmapped status %i to upstream rather than guessing a kind',
      (status) => {
        const error = fromHttpStatus(status, 'listInstances');

        expect(error.kind).toBe('upstream');
        expect(error.retryable).toBe(true);
      }
    );

    it('refuses to turn a success status into an error', () => {
      for (const status of [200, 206]) {
        expect(() => fromHttpStatus(status, 'listInstances')).toThrowError(/completeness\.ts/);
      }
    });

    it.each([[400], [401], [404], [500]])(
      'carries no completeness field for HTTP %i, so a failure can never be read as data (FR-010)',
      (status) => {
        const error = fromHttpStatus(status, 'listInstances');

        expect(error).not.toHaveProperty('completeness');
        expect(error).not.toHaveProperty('complete');
        expect(error).not.toHaveProperty('data');
      }
    );
  });

  describe('case: 401 says a human must act, and is never framed as "no results" (FR-003)', () => {
    it('names re-authentication and warns against the empty-result framing', () => {
      const error = fromHttpStatus(401, 'listInstances');

      expect(error.kind).toBe('auth');
      expect(error.message).toMatch(/re-?authenticate/i);
      expect(error.message).toMatch(/no results found/i);
      expect(error.retryable).toBe(false);
    });
  });

  describe('case: 400 and local argument errors let the agent self-correct (SC-008)', () => {
    it('tells the agent it can fix a 400 itself, without the user', () => {
      const error = fromHttpStatus(400, 'searchByName');

      expect(error.kind).toBe('argument');
      expect(error.message).toMatch(/does not need the user/i);
    });

    it('points an unknown instance code at list_instances (FR-017)', () => {
      const error = fromHttpStatus(400, 'listInstances');

      expect(error.message).toContain('list_instances');
    });

    it('builds a local argument error with a caller-supplied hint', () => {
      const error = argumentError(
        'Unknown instance code "ZZ".',
        'Call list_instances to obtain valid codes.'
      );

      expect(error.kind).toBe('argument');
      expect(error.retryable).toBe(false);
      expect(error.message).toBe(
        'Unknown instance code "ZZ". Call list_instances to obtain valid codes.'
      );
    });

    it('falls back to the standard guidance when no hint is supplied', () => {
      const error = argumentError('Entity type "market" is not supported.');

      expect(error.message).toContain('Entity type "market" is not supported.');
      expect(error.message).toContain('Correct the arguments');
    });
  });

  describe('case: 404 reports absence rather than inviting a retry', () => {
    it('is not retryable and says to report the absence', () => {
      const error = fromHttpStatus(404, 'getSubclass');

      expect(error.kind).toBe('notFound');
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/report the absence/i);
    });
  });

  describe('case: timeout with no data is an upstream error, not partial data (FR-010)', () => {
    it('names the timeout budget and is retryable', () => {
      const error = fromTimeoutWithNoData('listInstances', 30_000);

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('30000ms');
      expect(error.message).toContain('no data was gathered');
    });

    it('carries no completeness, so it cannot be confused with TIMEOUT_PARTIAL', () => {
      const error = fromTimeoutWithNoData('listInstances', 1000);

      expect(error).not.toHaveProperty('completeness');
      expect(error.message).not.toContain('TIMEOUT_PARTIAL');
    });
  });

  describe('other transport and parsing failures', () => {
    it('maps an unreachable host to a retryable upstream error', () => {
      const error = fromTransportFailure('listInstances');

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/could not reach gma/i);
    });

    it('maps an unreadable body to a retryable upstream error', () => {
      const error = malformedResponse('searchByName');

      expect(error.kind).toBe('upstream');
      expect(error.message).toMatch(/unreadable/i);
    });
  });

  describe('case: no credential ever reaches an error message (FR-020, SC-006)', () => {
    it('never interpolates an upstream body into the message, so an echoed token cannot leak', () => {
      // Every mapper takes only a status and a stable operation label. There is no
      // parameter through which a response body — which may echo an Authorization
      // header — could reach the message. This asserts that boundary holds.
      const messages = [
        fromHttpStatus(400, 'listInstances').message,
        fromHttpStatus(401, 'listInstances').message,
        fromHttpStatus(404, 'getSubclass').message,
        fromHttpStatus(500, 'listInstances').message,
        fromTimeoutWithNoData('listInstances', 30_000).message,
        fromTransportFailure('listInstances').message,
        malformedResponse('listInstances').message
      ];

      for (const message of messages) {
        expect(message).not.toContain(TOKEN);
        expect(message.toLowerCase()).not.toContain('bearer');
        expect(message.toLowerCase()).not.toContain('authorization');
      }
    });

    it('does not leak a token an operation label was polluted with beyond that label', () => {
      // A caller that puts a token in the operation label has its own bug, but the
      // mapper must not amplify it: nothing else in the message repeats it.
      const error = fromHttpStatus(500, `GET /v5/instances?access_token=${TOKEN}`);
      const occurrences = error.message.split(TOKEN).length - 1;

      expect(occurrences).toBe(1);
    });

    it('keeps the operation label out of any credential-shaped position', () => {
      const error = fromHttpStatus(401, 'listInstances');

      // The message is guidance plus a status, not a dump of request state.
      // The label is the LOGICAL operation id, not `GET /v5/instances`. That is a
      // deliberate, recorded contract change (003 contracts §4, research.md R7): it moves
      // TOWARD Principle IV by keeping upstream mechanics out of agent-visible text, and
      // it keeps a metric series intact across a generation change.
      expect(error.message).toBe(
        'GMA returned HTTP 401 for listInstances. ' +
          'The user must re-authenticate. Do not retry with different credentials, and do not report this as "no results found".'
      );
    });
  });

  describe('case: an unsatisfiable generation is a config error only an operator can fix (003-FR-006)', () => {
    it('is a non-retryable config error, so no agent tries to work around it', () => {
      const error = unsatisfiableGeneration('catalogue', 'searchByName', 'v4', ['v5']);

      expect(error).toBeInstanceOf(ToolError);
      expect(error.kind).toBe('config');
      // Retrying cannot help: nothing an agent controls decides which generation answers.
      expect(error.retryable).toBe(false);
    });

    it('names all four facts, so it is fixable without reading source', () => {
      const error = unsatisfiableGeneration('catalogue', 'searchByName', 'v4', ['v5']);

      expect(error.message).toContain('catalogue');
      expect(error.message).toContain('searchByName');
      expect(error.message).toContain('v4');
      expect(error.message).toContain('v5');
      // And the variable to change, which is the actual fix.
      expect(error.message).toContain('GMA_CATALOGUE_GENERATION');
      expect(error.message).toMatch(/only an operator can fix this/i);
    });

    it('lists every generation that does offer the operation, not just the first', () => {
      const error = unsatisfiableGeneration('future', 'someOperation', 'v3', ['v4', 'v5']);

      expect(error.message).toContain('v4, v5');
    });

    it('carries no credential, host, or personal datum (001-FR-020)', () => {
      const error = unsatisfiableGeneration('catalogue', 'searchByName', 'v4', ['v5']);

      expect(error.message).not.toContain(TOKEN);
      expect(error.message.toLowerCase()).not.toContain('bearer');
      expect(error.message).not.toMatch(/https?:\/\//);
    });
  });

  describe('isToolError', () => {
    it('recognises a ToolError and rejects anything else', () => {
      expect(isToolError(fromHttpStatus(500, 'listInstances'))).toBe(true);
      expect(isToolError(new Error('plain'))).toBe(false);
      expect(isToolError('a string')).toBe(false);
      expect(isToolError(null)).toBe(false);
      expect(isToolError(undefined)).toBe(false);
    });

    it('preserves the Error contract, so a ToolError still has a stack and a name', () => {
      const error = fromHttpStatus(500, 'listInstances');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ToolError');
      expect(error.stack).toBeDefined();
    });
  });
});
