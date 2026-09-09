import { describe, expect, it } from 'vitest';
import {
  argumentError,
  fromHttpStatus,
  fromTimeoutWithNoData,
  fromTransportFailure,
  isToolError,
  malformedResponse
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
      // A DELIBERATE DEFECT CORRECTION, not an accommodation of the amendment.
      // This row previously read `[403, 'upstream', true]`, which documented a live
      // retry loop: a 403 means the identity lacks permission, so every retry is
      // guaranteed to fail. Constitution Principle I requires `forbidden`, NOT
      // retryable, never conflated with `auth`. It is the ONLY existing catalogue
      // assertion the amendment-acceptance gate permits changing, because the
      // behaviour itself is what the amendment changes (research.md R10).
      [403, 'forbidden', false],
      [404, 'notFound', false],
      // A dependency of GMA failed — distinct cause, same agent action as 500.
      [424, 'upstream', true],
      [500, 'upstream', true]
    ] as const)('maps HTTP %i to kind %s with retryable=%s', (status, kind, retryable) => {
      const error = fromHttpStatus(status, 'GET /v5/instances');

      expect(error).toBeInstanceOf(ToolError);
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(String(status));
    });

    it.each([[409], [502], [503], [504]])(
      'maps unmapped status %i to upstream rather than guessing a kind',
      (status) => {
        const error = fromHttpStatus(status, 'GET /v5/instances');

        expect(error.kind).toBe('upstream');
        expect(error.retryable).toBe(true);
      }
    );

    it('refuses to turn a success status into an error', () => {
      for (const status of [200, 206]) {
        expect(() => fromHttpStatus(status, 'GET /v5/instances')).toThrowError(/completeness\.ts/);
      }
    });

    it.each([[400], [401], [404], [500]])(
      'carries no completeness field for HTTP %i, so a failure can never be read as data (FR-010)',
      (status) => {
        const error = fromHttpStatus(status, 'GET /v5/instances');

        expect(error).not.toHaveProperty('completeness');
        expect(error).not.toHaveProperty('complete');
        expect(error).not.toHaveProperty('data');
      }
    );
  });

  describe('case: 401 says a human must act, and is never framed as "no results" (FR-003)', () => {
    it('names re-authentication and warns against the empty-result framing', () => {
      const error = fromHttpStatus(401, 'GET /v5/instances');

      expect(error.kind).toBe('auth');
      expect(error.message).toMatch(/re-?authenticate/i);
      expect(error.message).toMatch(/no results found/i);
      expect(error.retryable).toBe(false);
    });
  });

  describe('case: 400 and local argument errors let the agent self-correct (SC-008)', () => {
    it('tells the agent it can fix a 400 itself, without the user', () => {
      const error = fromHttpStatus(400, 'POST /v5/searchByName');

      expect(error.kind).toBe('argument');
      expect(error.message).toMatch(/does not need the user/i);
    });

    it('points an unknown instance code at list_instances for an INSTANCE-SCOPED call (FR-017)', () => {
      const error = fromHttpStatus(400, 'GET /v5/instances', true);

      expect(error.message).toContain('list_instances');
    });

    it('does NOT mention instance codes for an operation that takes none', () => {
      // A live misdirection this prevents. CRS returned `400` for both
      // `GET /crs/accounts/{accountId}` and `GET /crs/contexts` — the second takes NO
      // argument at all — and the unconditional hint told the agent to check an instance
      // code it had never supplied. Directed at its arguments, the agent concluded the
      // ACCOUNT IDENTIFIER was invalid and told the user to double-check it. It was
      // valid; CRS was failing every request.
      //
      // Advice naming the wrong argument is worse than none: it does not just fail to
      // help, it steers the diagnosis away from the truth and the agent relays that to a
      // human as a claim about their input.
      const error = fromHttpStatus(400, 'GET /crs/contexts');

      expect(error.kind).toBe('argument');
      expect(error.message).not.toContain('list_instances');
      // The actionable half is still there — only the wrong-argument hint is gone.
      expect(error.message).toMatch(/does not need the user/i);
    });

    it('defaults to omitting the hint, so a new call site cannot misdirect by accident', () => {
      // The safe direction: an absent hint costs one reasoning step, a wrong one sends
      // the agent to blame an argument the operation does not have.
      expect(fromHttpStatus(400, 'GET /crs/accounts/{accountId}').message).not.toContain(
        'list_instances'
      );
    });

    it('attaches the hint to no other kind, even on an instance-scoped call', () => {
      // A `500` is not the agent's arguments to fix, so instance advice there would be
      // noise pointing at the wrong actor entirely.
      for (const status of [401, 403, 404, 500]) {
        expect(fromHttpStatus(status, 'GET /v5/instances', true).message).not.toContain(
          'list_instances'
        );
      }
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

  describe('case: 403 is forbidden, never auth, and never retried (Principle I, FR-028, SC-009)', () => {
    it('is its own kind, distinct from auth', () => {
      const forbidden = fromHttpStatus(403, 'POST /qbs/graphql');
      const auth = fromHttpStatus(401, 'POST /qbs/graphql');

      expect(forbidden.kind).toBe('forbidden');
      expect(forbidden.kind).not.toBe(auth.kind);
    });

    it('is NOT retryable, because a retry with the same identity cannot succeed', () => {
      // SC-009: the agent must not retry. This is also the defect correction — the
      // old mapping made 403 retryable, which is a retry loop rather than a bug in
      // the abstract (research.md R10).
      const error = fromHttpStatus(403, 'POST /qbs/graphql');

      expect(error.retryable).toBe(false);
      expect(error.message.toLowerCase()).toContain('do not retry');
    });

    it('tells the human to request access rather than to sign in again', () => {
      // The two human actions differ, and conflating them wastes the operator's
      // time on a re-authentication that changes nothing.
      const error = fromHttpStatus(403, 'GET /crs/accounts/{accountId}');

      expect(error.message).toMatch(/request access/i);
      expect(error.message).toMatch(/lacks permission/i);
      expect(error.message).not.toMatch(/re-?authenticate/i);
    });

    it('is not reported as an upstream failure, which would invite a retry', () => {
      const error = fromHttpStatus(403, 'POST /qbs/graphql');

      expect(error.kind).not.toBe('upstream');
      expect(error.message).not.toContain('The upstream system failed');
    });

    it('carries no completeness, so a permission failure cannot be read as data', () => {
      const error = fromHttpStatus(403, 'POST /qbs/graphql');

      expect(error).not.toHaveProperty('completeness');
      expect(error).not.toHaveProperty('complete');
      expect(error).not.toHaveProperty('data');
    });
  });

  describe('case: 424 is a retryable upstream failure of a GMA dependency', () => {
    it('maps to upstream and is retryable, distinct in cause but not in agent action', () => {
      const error = fromHttpStatus(424, 'GET /crs/accounts/{accountId}');

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('424');
    });
  });

  describe('case: 404 reports absence rather than inviting a retry', () => {
    it('is not retryable and says to report the absence', () => {
      const error = fromHttpStatus(404, 'GET /v5/subclasses/{id}');

      expect(error.kind).toBe('notFound');
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/report the absence/i);
    });
  });

  describe('case: timeout with no data is an upstream error, not partial data (FR-010)', () => {
    it('names the timeout budget and is retryable', () => {
      const error = fromTimeoutWithNoData('GET /v5/instances', 30_000);

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('30000ms');
      expect(error.message).toContain('no data was gathered');
    });

    it('carries no completeness, so it cannot be confused with TIMEOUT_PARTIAL', () => {
      const error = fromTimeoutWithNoData('GET /v5/instances', 1000);

      expect(error).not.toHaveProperty('completeness');
      expect(error.message).not.toContain('TIMEOUT_PARTIAL');
    });
  });

  describe('other transport and parsing failures', () => {
    it('maps an unreachable host to a retryable upstream error', () => {
      const error = fromTransportFailure('GET /v5/instances');

      expect(error.kind).toBe('upstream');
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/could not reach gma/i);
    });

    it('maps an unreadable body to a retryable upstream error', () => {
      const error = malformedResponse('POST /v5/searchByName');

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
        fromHttpStatus(400, 'GET /v5/instances').message,
        fromHttpStatus(401, 'GET /v5/instances').message,
        fromHttpStatus(404, 'GET /v5/subclasses/{id}').message,
        fromHttpStatus(500, 'GET /v5/instances').message,
        fromTimeoutWithNoData('GET /v5/instances', 30_000).message,
        fromTransportFailure('GET /v5/instances').message,
        malformedResponse('GET /v5/instances').message
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
      const error = fromHttpStatus(401, 'GET /v5/instances');

      // The message is guidance plus a status, not a dump of request state.
      expect(error.message).toBe(
        'GMA returned HTTP 401 for GET /v5/instances. ' +
          'The user must re-authenticate. Do not retry with different credentials, and do not report this as "no results found".'
      );
    });
  });

  describe('isToolError', () => {
    it('recognises a ToolError and rejects anything else', () => {
      expect(isToolError(fromHttpStatus(500, 'GET /v5/instances'))).toBe(true);
      expect(isToolError(new Error('plain'))).toBe(false);
      expect(isToolError('a string')).toBe(false);
      expect(isToolError(null)).toBe(false);
      expect(isToolError(undefined)).toBe(false);
    });

    it('preserves the Error contract, so a ToolError still has a stack and a name', () => {
      const error = fromHttpStatus(500, 'GET /v5/instances');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ToolError');
      expect(error.stack).toBeDefined();
    });
  });
});
