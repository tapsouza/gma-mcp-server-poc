import { describe, expect, it } from 'vitest';
import { withUnavailableComponents } from '../../src/core/completeness.js';
import { complete } from '../../src/core/completeness.js';
import type { QbsSearchBetsResponse } from '../../src/domains/customer/mapping/betProjection.js';
import {
  reportedErrors,
  unavailableFromQbs
} from '../../src/domains/customer/mapping/qbsErrors.js';

import qbsSingle from '../fixtures/gma/qbsSearchBets/200-single-bet.json' with { type: 'json' };
import qbsWithErrors from '../fixtures/gma/qbsSearchBets/200-success-with-errors.json' with { type: 'json' };
import qbsNoMatch from '../fixtures/gma/qbsSearchBets/200-no-match.json' with { type: 'json' };

/**
 * The QBS error mapping (User Story 2) — the single most important module in this
 * feature.
 *
 * The defect it prevents: QBS returns HTTP **200** carrying GraphQL `errors[]` with
 * requested fields unpopulated. GMA's own client treats that as usable data, and the
 * bet-management front-end comments "If error is found, response will still be 200 OK".
 * A tool that trusted the status line would present a half-populated bet as complete,
 * which the constitution calls "the single most important" fixture on this surface and
 * which the plan calls "the single worst defect this feature could ship".
 *
 * And the second property, which is subtler: the result must be
 * `unavailableComponents`, NEVER `failedInstances`. Every source ANSWERED, so nothing
 * failed to answer — what is missing is a SECTION. Reporting it as a failed instance
 * tells the agent to retry with narrower scoping, which cannot help, so it retries
 * forever (FR-026).
 */

const asResponse = (fixture: unknown) => fixture as QbsSearchBetsResponse;

describe('QBS error mapping', () => {
  describe('case: a 200 carrying errors[] names the unavailable sections (FR-011, SC-002)', () => {
    it('names both affected sections from the mandatory fixture', () => {
      // The fixture reports errors at `results[0].riskInfo` and `results[0].legs`,
      // and leaves both fields null.
      const components = unavailableFromQbs(asResponse(qbsWithErrors));

      expect(components).toContain('betDetail');
      expect(components).toContain('legCataloguePositions');
    });

    it('drives a complete: false verdict when threaded through completeness', () => {
      // The end-to-end property SC-002 asks for: a technically-successful response is
      // NOT presented as complete.
      const components = unavailableFromQbs(asResponse(qbsWithErrors));
      const completeness = withUnavailableComponents(complete(), components);

      expect(completeness.complete).toBe(false);
      expect(completeness.caveat).not.toBeNull();
    });

    it('reports that errors were present at all', () => {
      expect(reportedErrors(asResponse(qbsWithErrors))).toBe(true);
    });

    it('maps a riskInfo error path to betDetail', () => {
      const components = unavailableFromQbs({
        errors: [{ message: 'boom', path: ['searchBets', 'results', 0, 'riskInfo'] }],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['betDetail']);
    });

    it('maps a legs error path to legCataloguePositions', () => {
      const components = unavailableFromQbs({
        errors: [{ message: 'boom', path: ['searchBets', 'results', 0, 'legs'] }],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['legCataloguePositions']);
    });

    it.each([['sport'], ['competition'], ['event'], ['market'], ['selection']])(
      'maps a %s error path to legCataloguePositions',
      (segment) => {
        const components = unavailableFromQbs({
          errors: [{ message: 'boom', path: ['searchBets', 'results', 0, 'legs', 0, segment] }],
          data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
        });

        expect(components).toEqual(['legCataloguePositions']);
      }
    );

    it('attributes to the MORE SPECIFIC segment when a path names several', () => {
      // `legs/0/event` is about a leg's catalogue entity, not about the bet record,
      // so the specific attribution is the useful one.
      const components = unavailableFromQbs({
        errors: [{ message: 'boom', path: ['searchBets', 'results', 0, 'legs', 0, 'event'] }],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['legCataloguePositions']);
    });

    it('deduplicates when several errors implicate the same section', () => {
      const components = unavailableFromQbs({
        errors: [
          { message: 'a', path: ['searchBets', 'results', 0, 'riskInfo'] },
          { message: 'b', path: ['searchBets', 'results', 1, 'riskInfo'] },
          { message: 'c', path: ['searchBets', 'results', 2, 'wageInfo'] }
        ],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['betDetail']);
    });

    it('names both sections when errors implicate both', () => {
      const components = unavailableFromQbs({
        errors: [
          { message: 'a', path: ['searchBets', 'results', 0, 'riskInfo'] },
          { message: 'b', path: ['searchBets', 'results', 0, 'legs'] }
        ],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['betDetail', 'legCataloguePositions']);
    });
  });

  describe('case: the result is unavailableComponents and NEVER failedInstances (FR-026)', () => {
    it('returns only ComponentName values, never an instance-shaped string', () => {
      const components = unavailableFromQbs(asResponse(qbsWithErrors));

      for (const component of components) {
        expect([
          'customerRiskConfiguration',
          'betDetail',
          'legCataloguePositions',
          'jurisdictionContexts'
        ]).toContain(component);
        // An instance URN would be the wrong axis entirely.
        expect(component).not.toMatch(/^urn:i:/);
      }
    });

    it('leaves failedInstances EMPTY when threaded through completeness', () => {
      // This is the assertion that distinguishes the axes. A failed instance invites
      // a narrowed retry; a missing section must tell the agent not to bother.
      const completeness = withUnavailableComponents(
        complete(),
        unavailableFromQbs(asResponse(qbsWithErrors))
      );

      expect(completeness.failedInstances).toEqual([]);
      expect(completeness.unavailableComponents.length).toBeGreaterThan(0);
    });

    it('produces a caveat that tells the agent NOT to retry with different scoping', () => {
      const completeness = withUnavailableComponents(
        complete(),
        unavailableFromQbs(asResponse(qbsWithErrors))
      );

      expect(completeness.caveat?.toLowerCase()).toContain('do not retry with different scoping');
      // And it must not describe this as an instance problem, because it is not.
      expect(completeness.caveat).not.toContain('only some brand instances');
    });
  });

  describe('case: a CLEAN 200 marks nothing unavailable, however sparse (Principle II)', () => {
    it('returns an empty list for a fully-populated response', () => {
      expect(unavailableFromQbs(asResponse(qbsSingle))).toEqual([]);
      expect(reportedErrors(asResponse(qbsSingle))).toBe(false);
    });

    it('returns an empty list for a zero-match response, which is not a failure', () => {
      // "Nothing matched" is an ANSWER (FR-012). Caveating it would train the agent to
      // hedge a fact, and every genuine caveat is worth less as a result.
      expect(unavailableFromQbs(asResponse(qbsNoMatch))).toEqual([]);
    });

    it('marks nothing unavailable when a bet legitimately has no risk figures', () => {
      // An unpriced bet has no `riskInfo`, and that absence is not a failure. Only an
      // accompanying error makes it evidence of one.
      const components = unavailableFromQbs({
        data: { searchBets: { results: [{ ids: { betId: 'b1' }, riskInfo: null }] } }
      });

      expect(components).toEqual([]);
    });

    it('returns an empty list for an empty errors array', () => {
      expect(unavailableFromQbs({ errors: [], data: { searchBets: { results: [] } } })).toEqual([]);
    });
  });

  describe('case: an error with no usable path falls back to what is OBSERVABLY absent', () => {
    it('names the sections whose data is in fact missing', () => {
      // A GraphQL error path is not guaranteed to name every field left empty, so a
      // pathless error must not be treated as harmless.
      const components = unavailableFromQbs({
        errors: [{ message: 'something went wrong' }],
        data: {
          searchBets: {
            results: [{ ids: { betId: 'b1' }, wageInfo: { stake: 1 }, legs: null }]
          }
        }
      });

      expect(components).toContain('legCataloguePositions');
    });

    it('names betDetail when the identifiers themselves are absent', () => {
      const components = unavailableFromQbs({
        errors: [{ message: 'boom' }],
        data: { searchBets: { results: [{ wageInfo: { stake: 1 }, legs: [] }] } }
      });

      expect(components).toContain('betDetail');
    });

    it('names betDetail when a reported error left nothing observably absent', () => {
      // Still says the bet detail is suspect: a 200 WITH an error is by definition
      // not a clean success, and reporting it as complete is the trap.
      const components = unavailableFromQbs({
        errors: [{ message: 'boom' }],
        data: {
          searchBets: {
            results: [{ ids: { betId: 'b1' }, wageInfo: { stake: 1 }, legs: [] }]
          }
        }
      });

      expect(components).toEqual(['betDetail']);
    });

    it('names betDetail when the whole searchBets payload is missing', () => {
      expect(unavailableFromQbs({ errors: [{ message: 'boom' }], data: {} })).toEqual([
        'betDetail'
      ]);
      expect(
        unavailableFromQbs({ errors: [{ message: 'boom' }], data: { searchBets: null } })
      ).toEqual(['betDetail']);
    });

    it('names betDetail when a reported error came with zero results', () => {
      const components = unavailableFromQbs({
        errors: [{ message: 'boom' }],
        data: { searchBets: { results: [] } }
      });

      expect(components).toEqual(['betDetail']);
    });

    it('names betDetail for a null entry in the results array', () => {
      const components = unavailableFromQbs({
        errors: [{ message: 'boom' }],
        data: { searchBets: { results: [null] } }
      });

      expect(components).toContain('betDetail');
    });

    it('handles an error whose path contains only numeric segments', () => {
      // A path of array indices names no field, so it is treated as pathless and the
      // fallback inspects what is observably absent. Here `legs` is absent (the
      // upstream schema types it non-null), so both sections are named — which is the
      // honest answer rather than a guess from an uninformative path.
      const components = unavailableFromQbs({
        errors: [{ message: 'boom', path: [0, 1] }],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(components).toEqual(['betDetail', 'legCataloguePositions']);
    });
  });

  describe('case: an absent response is a missing bet, not a clean answer', () => {
    it('names betDetail for a null or undefined body', () => {
      expect(unavailableFromQbs(null)).toEqual(['betDetail']);
      expect(unavailableFromQbs(undefined)).toEqual(['betDetail']);
    });

    it('reports no errors for an absent body without throwing', () => {
      expect(reportedErrors(null)).toBe(false);
      expect(reportedErrors(undefined)).toBe(false);
    });
  });

  describe('case: no upstream error text is ever surfaced (Principle V, FR-029)', () => {
    it('returns only section NAMES, never the upstream message', () => {
      // A GraphQL error message can echo request state — including, on this surface,
      // an account identifier. Only the closed set of component names leaves here.
      const components = unavailableFromQbs({
        errors: [
          {
            message: 'Failed for account acct-recognisable-99887',
            path: ['searchBets', 'results', 0, 'riskInfo']
          }
        ],
        data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
      });

      expect(JSON.stringify(components)).not.toContain('acct-recognisable-99887');
      expect(JSON.stringify(components)).not.toContain('99887');
      expect(components).toEqual(['betDetail']);
    });

    it('keeps upstream message text out of the caveat the agent relays', () => {
      const completeness = withUnavailableComponents(
        complete(),
        unavailableFromQbs({
          errors: [
            {
              message: 'Failed for account acct-recognisable-99887',
              path: ['searchBets', 'results', 0, 'riskInfo']
            }
          ],
          data: { searchBets: { results: [{ ids: { betId: 'b1' } }] } }
        })
      );

      expect(completeness.caveat).not.toContain('acct-recognisable-99887');
    });
  });
});
