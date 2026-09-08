import { describe, expect, it } from 'vitest';
import {
  aggregate,
  complete,
  fromHttpStatus,
  fromTimeoutWithPartialData,
  fromTooBroad,
  withUnavailableComponents,
  type GmaEnvelope
} from '../../src/core/completeness.js';
import { OUTCOME_SEVERITY, type Completeness, type Outcome } from '../../src/core/types.js';

import instances200 from '../fixtures/gma/instances/200-success.json' with { type: 'json' };
import instances206 from '../fixtures/gma/instances/206-partial.json' with { type: 'json' };

/**
 * Constitution Principle II is NON-NEGOTIABLE, so this suite asserts the invariant
 * itself rather than only the happy paths that happen to satisfy it.
 */

/**
 * The invariant every `Completeness` must satisfy.
 *
 * data-model.md section 1 states this as a three-way equivalence:
 *
 *   `complete === true` iff `outcome === 'COMPLETE'` iff `failedInstances.length === 0`
 *
 * That document is internally inconsistent with its own `Outcome` table, which
 * defines `TOO_BROAD` as `complete: false`. A too-broad query has ZERO failed
 * instances — every instance answered, the query was simply too wide — and the same
 * is true of a timeout that named no failing instance. Read literally, the third
 * clause would declare both of those complete while the second declares them
 * incomplete, so no implementation can satisfy all three.
 *
 * What the invariant exists to protect is that partial data is never presentable as
 * complete, and that is preserved exactly by taking the failure clause in the
 * direction that carries the safety property:
 *
 *   1. `complete === true` iff `outcome === 'COMPLETE'`      (the equivalence)
 *   2. `failedInstances.length > 0` implies NOT `complete`     (one-directional)
 *   3. `unavailableComponents.length > 0` implies NOT `complete`  (one-directional)
 *   4. `caveat === null` iff `complete`
 *
 * Clause 2 is the trap-prevention rule: you may never report failures and
 * completeness together. Its converse is what the document got wrong. Clause 3, added
 * by feature 004, is the same rule for the SECOND axis — a composite answer missing a
 * section is never complete, and the two axes are never merged into one another.
 */
function assertInvariant(c: Completeness): void {
  expect(
    c.complete === (c.outcome === 'COMPLETE'),
    `invariant 1 violated: complete=${c.complete} but outcome=${c.outcome}`
  ).toBe(true);

  if (c.failedInstances.length > 0) {
    expect(
      c.complete,
      `invariant 2 violated: reported complete alongside failures ${JSON.stringify(c.failedInstances)}`
    ).toBe(false);
  }

  if (c.unavailableComponents.length > 0) {
    expect(
      c.complete,
      `invariant 3 violated: reported complete alongside missing section(s) ${JSON.stringify(c.unavailableComponents)}`
    ).toBe(false);
  }

  // A complete result has nothing to caveat; an incomplete one must never be
  // silently caveat-free.
  expect(c.caveat === null).toBe(c.complete);
}

const ALL_OUTCOMES: readonly Outcome[] = ['COMPLETE', 'PARTIAL', 'TOO_BROAD', 'TIMEOUT_PARTIAL'];

/** Build a single-hop completeness with the given outcome, for precedence testing. */
function hopWith(outcome: Outcome, instance = 'urn:i:XX:XX'): Completeness {
  switch (outcome) {
    case 'COMPLETE':
      return complete([instance]);
    case 'PARTIAL':
      return fromHttpStatus(206, {
        successfulConfigSources: [instance],
        failedConfigSources: ['urn:i:FF:FF'],
        errors: [{ configSource: 'urn:i:FF:FF', message: 'down' }]
      });
    case 'TOO_BROAD':
      return fromTooBroad(complete([instance]));
    case 'TIMEOUT_PARTIAL':
      return fromTimeoutWithPartialData([instance]);
  }
}

describe('completeness', () => {
  describe('case: completeness is present on full success (FR-005, FR-006)', () => {
    it('produces a complete verdict from an HTTP 200 fixture', () => {
      const result = fromHttpStatus(200, instances200 as GmaEnvelope);

      expect(result.complete).toBe(true);
      expect(result.outcome).toBe('COMPLETE');
      expect(result.successfulInstances).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
      expect(result.failedInstances).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.caveat).toBeNull();
      assertInvariant(result);
    });

    it('still returns a verdict object when the body carries no envelope fields at all', () => {
      const result = fromHttpStatus(200, {});

      expect(result.complete).toBe(true);
      expect(result.successfulInstances).toEqual([]);
      assertInvariant(result);
    });

    it('still returns a verdict when the body is null or undefined', () => {
      for (const body of [null, undefined]) {
        const result = fromHttpStatus(200, body);
        expect(result.complete).toBe(true);
        assertInvariant(result);
      }
    });
  });

  describe('case: HTTP 206 names the failed instances (FR-007)', () => {
    it('maps a 206 fixture to an incomplete verdict naming the failure', () => {
      const result = fromHttpStatus(206, instances206 as GmaEnvelope);

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('PARTIAL');
      expect(result.successfulInstances).toEqual(['urn:i:PP:PP']);
      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.errors).toEqual([
        {
          instance: 'urn:i:BF:BF',
          message: 'Upstream config source did not respond within the read timeout'
        }
      ]);
      assertInvariant(result);
    });

    it('names the failed instance in the caveat text the agent will relay (FR-009)', () => {
      const result = fromHttpStatus(206, instances206 as GmaEnvelope);

      expect(result.caveat).toContain('urn:i:BF:BF');
      expect(result.caveat).toContain('INCOMPLETE');
      expect(result.caveat?.toLowerCase()).toContain('relay');
    });

    it('translates upstream configSource vocabulary to instance vocabulary at this boundary', () => {
      const result = fromHttpStatus(206, instances206 as GmaEnvelope);

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('configSource');
      expect(serialised).not.toContain('ConfigSources');
      expect(result.errors[0]).toHaveProperty('instance');
    });

    it('substitutes a placeholder rather than dropping an error with no configSource', () => {
      const result = fromHttpStatus(206, {
        successfulConfigSources: ['urn:i:PP:PP'],
        failedConfigSources: ['urn:i:BF:BF'],
        errors: [{ message: null }]
      });

      expect(result.errors).toEqual([{ instance: 'unknown', message: 'No error detail reported' }]);
    });

    it('reports an unidentified failure honestly when 206 names no failed instance', () => {
      const result = fromHttpStatus(206, { successfulConfigSources: ['urn:i:PP:PP'] });

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('PARTIAL');
      expect(result.caveat).toContain('not identified');
      assertInvariant(result);
    });
  });

  describe('the invariant cannot be circumvented', () => {
    it('treats an HTTP 200 that names a failed instance as PARTIAL, not complete', () => {
      // The trap Principle II exists to prevent: trust the named failure over the
      // status line rather than reporting a confidently-wrong complete answer.
      const result = fromHttpStatus(200, {
        successfulConfigSources: ['urn:i:PP:PP'],
        failedConfigSources: ['urn:i:BF:BF']
      });

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('PARTIAL');
      expect(result.caveat).not.toBeNull();
      assertInvariant(result);
    });

    it('refuses to produce a verdict for a terminal HTTP status', () => {
      for (const status of [400, 401, 404, 500, 503]) {
        expect(() => fromHttpStatus(status, {})).toThrowError(/errors\.ts/);
      }
    });

    it('never reports failed instances alongside a complete verdict, for any outcome', () => {
      // Clause 2 of the invariant, stated directly: this is the trap Principle II
      // exists to prevent, and it must hold across every outcome the module can
      // produce, not only the ones a happy path exercises.
      const withFailures: Completeness[] = [
        fromHttpStatus(206, instances206 as GmaEnvelope),
        fromHttpStatus(200, {
          successfulConfigSources: ['urn:i:PP:PP'],
          failedConfigSources: ['urn:i:BF:BF']
        }),
        fromTooBroad(fromHttpStatus(206, instances206 as GmaEnvelope)),
        fromTimeoutWithPartialData(['urn:i:PP:PP'], ['urn:i:BF:BF']),
        aggregate([complete(['urn:i:PP:PP']), fromHttpStatus(206, instances206 as GmaEnvelope)])
      ];

      for (const verdict of withFailures) {
        expect(verdict.failedInstances.length).toBeGreaterThan(0);
        expect(verdict.complete).toBe(false);
        expect(verdict.caveat).not.toBeNull();
      }
    });

    it('marks a zero-failure result incomplete when the outcome is not COMPLETE', () => {
      // The converse of clause 2 does NOT hold, deliberately: too-broad and a
      // nameless timeout are incomplete despite naming no failed instance.
      for (const verdict of [
        fromTooBroad(complete(['urn:i:PP:PP'])),
        fromTimeoutWithPartialData([])
      ]) {
        expect(verdict.failedInstances).toEqual([]);
        expect(verdict.complete).toBe(false);
        expect(verdict.caveat).not.toBeNull();
      }
    });

    it('returns frozen verdicts, so no caller can flip complete after the fact', () => {
      const result = fromHttpStatus(206, instances206 as GmaEnvelope);

      expect(Object.isFrozen(result)).toBe(true);
      expect(() => {
        (result as { complete: boolean }).complete = true;
      }).toThrow();
      expect(result.complete).toBe(false);
    });
  });

  describe('case: too broad is incomplete even though every instance answered (FR-015)', () => {
    it('marks a too-broad result incomplete with a narrowing-oriented caveat', () => {
      const result = fromTooBroad(complete(['urn:i:PP:PP', 'urn:i:BF:BF']));

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('TOO_BROAD');
      expect(result.caveat).toContain('Narrow');
      // The invariant ties complete to failedInstances, so a too-broad verdict
      // must not claim completeness merely because nothing failed upstream.
      expect(result.failedInstances).toEqual([]);
      expect(result.complete).toBe(false);
    });

    it('preserves an underlying partial failure when the query was also too broad', () => {
      const result = fromTooBroad(fromHttpStatus(206, instances206 as GmaEnvelope));

      expect(result.outcome).toBe('TOO_BROAD');
      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      assertInvariant(result);
    });
  });

  describe('case: timeout with partial data is distinct from timeout with none (FR-010)', () => {
    it('produces a TIMEOUT_PARTIAL verdict when some instances had answered', () => {
      const result = fromTimeoutWithPartialData(
        ['urn:i:PP:PP'],
        ['urn:i:BF:BF'],
        [{ instance: 'urn:i:BF:BF', message: 'aborted' }]
      );

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('TIMEOUT_PARTIAL');
      expect(result.caveat).toContain('timed out');
      assertInvariant(result);
    });

    // Timeout-with-nothing-usable is a ToolError and never reaches this module;
    // that is asserted in errors.test.ts and gmaClient.test.ts.
  });

  describe('case: multi-hop aggregation (FR-008, SC-011)', () => {
    it('is the neutral element for zero hops', () => {
      const result = aggregate([]);

      expect(result.complete).toBe(true);
      expect(result.outcome).toBe('COMPLETE');
      assertInvariant(result);
    });

    it('returns an equivalent verdict for a single hop', () => {
      const hop = fromHttpStatus(206, instances206 as GmaEnvelope);
      const result = aggregate([hop]);

      expect(result).toEqual(hop);
      assertInvariant(result);
    });

    it('marks the whole result incomplete when hop 2 alone was partial (SC-011)', () => {
      const result = aggregate([
        fromHttpStatus(200, instances200 as GmaEnvelope),
        fromHttpStatus(206, instances206 as GmaEnvelope)
      ]);

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('PARTIAL');
      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      assertInvariant(result);
    });

    it('marks the whole result incomplete when hop 1 alone was partial', () => {
      const result = aggregate([
        fromHttpStatus(206, instances206 as GmaEnvelope),
        fromHttpStatus(200, instances200 as GmaEnvelope)
      ]);

      expect(result.complete).toBe(false);
      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      assertInvariant(result);
    });

    it('is complete only when every hop was complete (AND, not OR)', () => {
      const result = aggregate([complete(['urn:i:PP:PP']), complete(['urn:i:BF:BF'])]);

      expect(result.complete).toBe(true);
      expect(result.successfulInstances).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
      assertInvariant(result);
    });

    describe('worst-outcome precedence, every ordered pair', () => {
      for (const a of ALL_OUTCOMES) {
        for (const b of ALL_OUTCOMES) {
          const expected = OUTCOME_SEVERITY[a] >= OUTCOME_SEVERITY[b] ? a : b;

          it(`aggregates ${a} + ${b} to ${expected}`, () => {
            const result = aggregate([hopWith(a), hopWith(b)]);

            expect(result.outcome).toBe(expected);
            assertInvariant(result);
          });
        }
      }

      it('honours the documented precedence order TIMEOUT_PARTIAL > TOO_BROAD > PARTIAL > COMPLETE', () => {
        expect(OUTCOME_SEVERITY.TIMEOUT_PARTIAL).toBeGreaterThan(OUTCOME_SEVERITY.TOO_BROAD);
        expect(OUTCOME_SEVERITY.TOO_BROAD).toBeGreaterThan(OUTCOME_SEVERITY.PARTIAL);
        expect(OUTCOME_SEVERITY.PARTIAL).toBeGreaterThan(OUTCOME_SEVERITY.COMPLETE);
      });

      it('is order-independent across three hops', () => {
        const hops = [hopWith('COMPLETE'), hopWith('TIMEOUT_PARTIAL'), hopWith('PARTIAL')];
        const forward = aggregate(hops);
        const reversed = aggregate([...hops].reverse());

        expect(forward.outcome).toBe('TIMEOUT_PARTIAL');
        expect(reversed.outcome).toBe('TIMEOUT_PARTIAL');
        expect([...forward.failedInstances].sort()).toEqual([...reversed.failedInstances].sort());
      });
    });

    describe('union deduplication', () => {
      it('deduplicates instances reported by more than one hop', () => {
        const hop = fromHttpStatus(206, instances206 as GmaEnvelope);
        const result = aggregate([hop, hop, hop]);

        expect(result.successfulInstances).toEqual(['urn:i:PP:PP']);
        expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      });

      it('deduplicates identical errors but keeps distinct messages from one instance', () => {
        const first = fromHttpStatus(206, {
          successfulConfigSources: ['urn:i:PP:PP'],
          failedConfigSources: ['urn:i:BF:BF'],
          errors: [{ configSource: 'urn:i:BF:BF', message: 'timeout' }]
        });
        const second = fromHttpStatus(206, {
          successfulConfigSources: ['urn:i:PP:PP'],
          failedConfigSources: ['urn:i:BF:BF'],
          errors: [
            { configSource: 'urn:i:BF:BF', message: 'timeout' },
            { configSource: 'urn:i:BF:BF', message: 'connection reset' }
          ]
        });

        const result = aggregate([first, second]);

        expect(result.errors).toEqual([
          { instance: 'urn:i:BF:BF', message: 'timeout' },
          { instance: 'urn:i:BF:BF', message: 'connection reset' }
        ]);
      });

      it('takes the union of different failures across hops', () => {
        const result = aggregate([
          fromHttpStatus(206, {
            successfulConfigSources: ['urn:i:PP:PP'],
            failedConfigSources: ['urn:i:BF:BF']
          }),
          fromHttpStatus(206, {
            successfulConfigSources: ['urn:i:BF:BF'],
            failedConfigSources: ['urn:i:SBG:SBG']
          })
        ]);

        expect(result.failedInstances).toEqual(['urn:i:BF:BF', 'urn:i:SBG:SBG']);
        expect(result.successfulInstances).toEqual(['urn:i:PP:PP', 'urn:i:BF:BF']);
      });

      it('ignores empty-string instance names rather than reporting a nameless failure', () => {
        const result = fromHttpStatus(206, {
          successfulConfigSources: ['urn:i:PP:PP', ''],
          failedConfigSources: ['urn:i:BF:BF']
        });

        expect(result.successfulInstances).toEqual(['urn:i:PP:PP']);
      });
    });
  });

  describe('case: the second failure axis — unavailableComponents (Principle II, FR-026)', () => {
    it('is present and empty on every verdict the HTTP path produces, including full success', () => {
      // Both axes must ALWAYS be present in the structure — a schema where one
      // appears only sometimes is a schema the model learns to ignore.
      for (const verdict of [
        fromHttpStatus(200, instances200 as GmaEnvelope),
        fromHttpStatus(206, instances206 as GmaEnvelope),
        complete(),
        fromTooBroad(complete()),
        fromTimeoutWithPartialData(['urn:i:PP:PP'])
      ]) {
        expect(verdict).toHaveProperty('unavailableComponents');
        expect(verdict.unavailableComponents).toEqual([]);
        assertInvariant(verdict);
      }
    });

    it('marks an otherwise-complete result INCOMPLETE when a section is missing', () => {
      // The case the axis exists for: every source answered, so a one-axis verdict
      // would call this complete. It is not — a section of the answer is absent.
      const result = withUnavailableComponents(complete(['urn:i:PP:PP']), [
        'customerRiskConfiguration'
      ]);

      expect(result.complete).toBe(false);
      expect(result.outcome).toBe('PARTIAL');
      expect(result.unavailableComponents).toEqual(['customerRiskConfiguration']);
      expect(result.failedInstances).toEqual([]);
      assertInvariant(result);
    });

    it('is still complete: false with ZERO failed instances, which is the whole point', () => {
      const result = withUnavailableComponents(complete(['urn:i:PP:PP']), ['betDetail']);

      expect(result.failedInstances).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.caveat).not.toBeNull();
    });

    it('names the missing section in the caveat and tells the agent NOT to retry scoping', () => {
      // The behavioural difference between the axes, asserted on the text the agent
      // actually relays. A missing section that reads like a failed instance sends
      // the agent retrying with narrower scoping, which cannot help — forever.
      const result = withUnavailableComponents(complete(['urn:i:PP:PP']), [
        'customerRiskConfiguration'
      ]);

      expect(result.caveat).toContain('INCOMPLETE');
      expect(result.caveat).toContain('customer risk configuration');
      expect(result.caveat?.toLowerCase()).toContain('relay');
      expect(result.caveat?.toLowerCase()).toContain('do not retry with different scoping');
      // And it must NOT claim an instance failed, because none did.
      expect(result.caveat).not.toContain('only some brand instances');
    });

    it('names EVERY missing section, not just the first', () => {
      const result = withUnavailableComponents(complete(), [
        'customerRiskConfiguration',
        'legCataloguePositions'
      ]);

      expect(result.unavailableComponents).toEqual([
        'customerRiskConfiguration',
        'legCataloguePositions'
      ]);
      expect(result.caveat).toContain('customer risk configuration');
      expect(result.caveat).toContain('catalogue positions');
    });

    it('returns the base verdict unchanged for an empty component list', () => {
      // So a tool can call this unconditionally rather than branching, which is what
      // keeps the "always report what is missing" path from being skipped by accident.
      const base = complete(['urn:i:PP:PP']);
      const result = withUnavailableComponents(base, []);

      expect(result.complete).toBe(true);
      expect(result.unavailableComponents).toEqual([]);
      expect(result).toEqual(base);
    });

    it('keeps a missing section separate from a failed instance when both occur', () => {
      const result = withUnavailableComponents(fromHttpStatus(206, instances206 as GmaEnvelope), [
        'jurisdictionContexts'
      ]);

      // Neither axis absorbs the other: the instance failure stays an instance
      // failure and the missing section stays a missing section.
      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.unavailableComponents).toEqual(['jurisdictionContexts']);
      expect(result.caveat).toContain('urn:i:BF:BF');
      expect(result.caveat).toContain('jurisdiction context list');
      assertInvariant(result);
    });

    it('deduplicates repeated component names', () => {
      const result = withUnavailableComponents(
        withUnavailableComponents(complete(), ['betDetail']),
        ['betDetail']
      );

      expect(result.unavailableComponents).toEqual(['betDetail']);
    });

    it('preserves a worse outcome rather than downgrading it to PARTIAL', () => {
      const result = withUnavailableComponents(fromTimeoutWithPartialData(['urn:i:PP:PP']), [
        'betDetail'
      ]);

      expect(result.outcome).toBe('TIMEOUT_PARTIAL');
      expect(result.unavailableComponents).toEqual(['betDetail']);
      assertInvariant(result);
    });

    it('survives fromTooBroad, so a too-broad composite still names its missing sections', () => {
      const result = fromTooBroad(
        withUnavailableComponents(complete(['urn:i:PP:PP']), ['legCataloguePositions'])
      );

      expect(result.outcome).toBe('TOO_BROAD');
      expect(result.unavailableComponents).toEqual(['legCataloguePositions']);
      assertInvariant(result);
    });

    it('returns a frozen verdict, so no caller can empty the axis after the fact', () => {
      const result = withUnavailableComponents(complete(), ['betDetail']);

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.unavailableComponents)).toBe(true);
      expect(() => {
        (result as { complete: boolean }).complete = true;
      }).toThrow();
    });
  });

  describe('case: aggregate unions the second axis independently (Principle II)', () => {
    it('unions missing sections across hops', () => {
      const result = aggregate([
        withUnavailableComponents(complete(['urn:i:PP:PP']), ['customerRiskConfiguration']),
        withUnavailableComponents(complete(['urn:i:BF:BF']), ['legCataloguePositions'])
      ]);

      expect(result.unavailableComponents).toEqual([
        'customerRiskConfiguration',
        'legCataloguePositions'
      ]);
      expect(result.complete).toBe(false);
      assertInvariant(result);
    });

    it('deduplicates a section reported by more than one hop', () => {
      const hop = withUnavailableComponents(complete(['urn:i:PP:PP']), ['betDetail']);
      const result = aggregate([hop, hop, hop]);

      expect(result.unavailableComponents).toEqual(['betDetail']);
    });

    it('marks the whole result incomplete when ONE hop was missing a section', () => {
      // The composite case: hops 1 and 2 answered fully, hop 3's section is absent.
      const result = aggregate([
        fromHttpStatus(200, instances200 as GmaEnvelope),
        complete(['urn:i:PP:PP']),
        withUnavailableComponents(complete(), ['jurisdictionContexts'])
      ]);

      expect(result.complete).toBe(false);
      expect(result.unavailableComponents).toEqual(['jurisdictionContexts']);
      expect(result.failedInstances).toEqual([]);
      assertInvariant(result);
    });

    it('never turns a missing section into a failed instance, or the reverse', () => {
      const result = aggregate([
        fromHttpStatus(206, instances206 as GmaEnvelope),
        withUnavailableComponents(complete(), ['customerRiskConfiguration'])
      ]);

      expect(result.failedInstances).toEqual(['urn:i:BF:BF']);
      expect(result.unavailableComponents).toEqual(['customerRiskConfiguration']);
      expect(result.failedInstances).not.toContain('customerRiskConfiguration');
      expect(result.unavailableComponents).not.toContain('urn:i:BF:BF');
    });

    it('is order-independent across hops for the second axis', () => {
      const hops = [
        withUnavailableComponents(complete(), ['betDetail']),
        complete(['urn:i:PP:PP']),
        withUnavailableComponents(complete(), ['jurisdictionContexts'])
      ];

      const forward = aggregate(hops);
      const reversed = aggregate([...hops].reverse());

      expect([...forward.unavailableComponents].sort()).toEqual(
        [...reversed.unavailableComponents].sort()
      );
      expect(forward.complete).toBe(reversed.complete);
    });
  });
});
