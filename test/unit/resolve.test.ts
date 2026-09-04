import { describe, expect, it } from 'vitest';
import { complete } from '../../src/core/completeness.js';
import {
  mapSearchResults,
  toCatalogueEntity,
  type SearchByNameResult
} from '../../src/domains/catalogue/mapSearchResults.js';
import {
  NARROW_BY,
  resolveByCardinality,
  toToolPayload,
  withChildren
} from '../../src/domains/catalogue/resolve.js';
import type { CatalogueEntity } from '../../src/domains/catalogue/schemas.js';

import multiMatch from '../fixtures/gma/searchByName/200-multi-match.json' with { type: 'json' };
import singleMatch from '../fixtures/gma/searchByName/200-single-match.json' with { type: 'json' };
import noMatch from '../fixtures/gma/searchByName/200-no-match.json' with { type: 'json' };
import manyMatches from '../fixtures/gma/searchByName/200-many-matches.json' with { type: 'json' };

const MAX_CANDIDATES = 25;

function entity(
  id: string,
  name = id,
  type: CatalogueEntity['type'] = 'subclass'
): CatalogueEntity {
  return { id, name, type, ancestors: [] };
}

describe('search result mapping (research.md R3)', () => {
  it('derives the type from the most specific populated field', () => {
    expect(toCatalogueEntity({ superclass: { id: 'urn:sc:f', name: 'Football' } })?.type).toBe(
      'superclass'
    );
    expect(
      toCatalogueEntity({
        superclass: { id: 'urn:sc:f', name: 'Football' },
        subclass: { id: 'urn:sub:pl', name: 'Premier League' }
      })?.type
    ).toBe('subclass');
    expect(
      toCatalogueEntity({
        superclass: { id: 'urn:sc:f', name: 'Football' },
        subclass: { id: 'urn:sub:pl', name: 'Premier League' },
        eventType: { id: 'urn:et:w', name: 'Winner' }
      })?.type
    ).toBe('eventType');
  });

  it('puts the broader levels in the ancestor chain, broadest first', () => {
    const mapped = toCatalogueEntity({
      superclass: { id: 'urn:sc:f', name: 'Football' },
      subclass: { id: 'urn:sub:pl', name: 'Premier League' },
      eventType: { id: 'urn:et:w', name: 'Winner' }
    });

    expect(mapped?.ancestors).toEqual([
      { id: 'urn:sc:f', name: 'Football', type: 'superclass' },
      { id: 'urn:sub:pl', name: 'Premier League', type: 'subclass' }
    ]);
  });

  it('leaves a superclass with an empty ancestor chain', () => {
    expect(
      toCatalogueEntity({ superclass: { id: 'urn:sc:f', name: 'Football' } })?.ancestors
    ).toEqual([]);
  });

  it('drops an entirely empty triple rather than inventing an entity', () => {
    expect(toCatalogueEntity({})).toBeNull();
    expect(toCatalogueEntity({ subclass: null, eventType: undefined })).toBeNull();
    expect(toCatalogueEntity({ subclass: { name: 'no id' } })).toBeNull();
  });

  it('falls back to the id when a node has no name', () => {
    expect(toCatalogueEntity({ subclass: { id: 'urn:sub:pl' } })?.name).toBe('urn:sub:pl');
  });

  it('maps the single-match fixture to one subclass under Football', () => {
    const mapped = mapSearchResults(singleMatch);

    expect(mapped).toEqual([
      {
        id: 'urn:sub:premier-league',
        name: 'Premier League',
        type: 'subclass',
        ancestors: [{ id: 'urn:sc:football', name: 'Football', type: 'superclass' }]
      }
    ]);
  });

  it('deduplicates the same entity reported by more than one instance', () => {
    const duplicated: { results: SearchByNameResult[] } = {
      results: [
        { subclass: { id: 'urn:sub:pl', name: 'Premier League' } },
        { subclass: { id: 'urn:sub:pl', name: 'Premier League' } }
      ]
    };

    expect(mapSearchResults(duplicated)).toHaveLength(1);
  });

  it('returns an empty list for a null or empty response rather than throwing', () => {
    expect(mapSearchResults(null)).toEqual([]);
    expect(mapSearchResults({})).toEqual([]);
    expect(mapSearchResults({ results: [] })).toEqual([]);
  });
});

describe('resolution by cardinality (FR-014, FR-015)', () => {
  describe('case: zero matches is "none", not an error and not a caveat (FR-010)', () => {
    it('returns kind none for an empty match list', () => {
      const { outcome, needsTraversal } = resolveByCardinality([], MAX_CANDIDATES);

      expect(outcome).toEqual({ kind: 'none' });
      expect(needsTraversal).toBeNull();
    });

    it('returns none for the no-match fixture', () => {
      const { outcome } = resolveByCardinality(mapSearchResults(noMatch), MAX_CANDIDATES);

      expect(outcome.kind).toBe('none');
    });
  });

  describe('case: exactly one match resolves and requests traversal (FR-013)', () => {
    it('resolves the single match and asks for its children', () => {
      const matches = mapSearchResults(singleMatch);
      const { outcome, needsTraversal } = resolveByCardinality(matches, MAX_CANDIDATES);

      expect(outcome.kind).toBe('resolved');
      expect(needsTraversal).toEqual(matches[0]);
      if (outcome.kind === 'resolved') {
        expect(outcome.entity.name).toBe('Premier League');
        // Empty until the caller attaches them — never absent, so a caller cannot
        // forget to look.
        expect(outcome.children).toEqual([]);
      }
    });

    it('attaches children to a resolved outcome and to nothing else', () => {
      const children = [entity('urn:et:w', 'Winner', 'eventType')];

      const resolved = withChildren(
        { kind: 'resolved', entity: entity('urn:sub:pl'), children: [] },
        children
      );
      expect(resolved).toEqual({ kind: 'resolved', entity: entity('urn:sub:pl'), children });

      // A non-resolved outcome is returned untouched: children make no sense there.
      const candidates = { kind: 'candidates' as const, candidates: [entity('a'), entity('b')] };
      expect(withChildren(candidates, children)).toBe(candidates);
      expect(withChildren({ kind: 'none' }, children)).toEqual({ kind: 'none' });
    });
  });

  describe('case: several matches return ALL candidates and auto-pick NONE (FR-014, SC-002)', () => {
    it('returns every candidate with no entity resolved', () => {
      const matches = mapSearchResults(multiMatch);
      const { outcome, needsTraversal } = resolveByCardinality(matches, MAX_CANDIDATES);

      expect(outcome.kind).toBe('candidates');
      expect(needsTraversal).toBeNull();
      if (outcome.kind === 'candidates') {
        expect(outcome.candidates).toHaveLength(3);
      }
      // Structurally impossible for a candidates outcome to carry a resolved entity.
      expect(outcome).not.toHaveProperty('entity');
    });

    it('preserves the ancestor chain on every candidate — the distinguishing detail', () => {
      const { outcome } = resolveByCardinality(mapSearchResults(multiMatch), MAX_CANDIDATES);

      if (outcome.kind !== 'candidates') expect.unreachable('expected candidates');
      else {
        // All three are named "Winner"; only the path tells them apart.
        expect(outcome.candidates.map((c) => c.name)).toEqual(['Winner', 'Winner', 'Winner']);
        expect(outcome.candidates.map((c) => c.ancestors.map((a) => a.name).join(' / '))).toEqual([
          'Football / Premier League',
          'Rugby Union / Six Nations',
          'Tennis / Wimbledon'
        ]);
        for (const candidate of outcome.candidates) {
          expect(candidate.ancestors.length).toBeGreaterThan(0);
        }
      }
    });

    it('never auto-picks, for any count above one and up to the threshold', () => {
      for (const count of [2, 3, 5, 10, MAX_CANDIDATES]) {
        const matches = Array.from({ length: count }, (_, i) => entity(`urn:sub:${i}`));
        const { outcome, needsTraversal } = resolveByCardinality(matches, MAX_CANDIDATES);

        expect(outcome.kind).toBe('candidates');
        expect(needsTraversal).toBeNull();
      }
    });

    it('returns a copy, so a caller cannot mutate the resolution afterwards', () => {
      const matches = [entity('a'), entity('b')];
      const { outcome } = resolveByCardinality(matches, MAX_CANDIDATES);

      if (outcome.kind === 'candidates') {
        expect(outcome.candidates).not.toBe(matches);
        expect(outcome.candidates).toEqual(matches);
      }
    });
  });

  describe('case: too many matches gives no resolution plus a narrowing hint (FR-015)', () => {
    it('returns tooBroad with the count and the fields to narrow by', () => {
      const matches = mapSearchResults(manyMatches);
      const { outcome, needsTraversal } = resolveByCardinality(matches, MAX_CANDIDATES);

      expect(needsTraversal).toBeNull();
      expect(outcome.kind).toBe('tooBroad');
      if (outcome.kind === 'tooBroad') {
        expect(outcome.matchCount).toBe(40);
        expect(outcome.narrowBy).toEqual(NARROW_BY);
        expect(outcome.narrowBy.length).toBeGreaterThan(0);
      }
    });

    it('names concrete fields rather than saying "be more specific"', () => {
      expect(NARROW_BY).toContain('instances');
      expect(NARROW_BY.join(' ')).toContain('name');
    });

    it('resolves at exactly the threshold and reports too-broad one above it', () => {
      const at = Array.from({ length: MAX_CANDIDATES }, (_, i) => entity(`urn:sub:${i}`));
      const above = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => entity(`urn:sub:${i}`));

      expect(resolveByCardinality(at, MAX_CANDIDATES).outcome.kind).toBe('candidates');
      expect(resolveByCardinality(above, MAX_CANDIDATES).outcome.kind).toBe('tooBroad');
    });

    it('honours a configured threshold of one, where two matches are already too broad', () => {
      const { outcome } = resolveByCardinality([entity('a'), entity('b')], 1);

      expect(outcome.kind).toBe('tooBroad');
    });

    it('still resolves a single match when the threshold is one', () => {
      const { outcome } = resolveByCardinality([entity('a')], 1);

      expect(outcome.kind).toBe('resolved');
    });

    it('carries no truncated candidate list, so no partial list can pass as the whole answer', () => {
      const { outcome } = resolveByCardinality(mapSearchResults(manyMatches), MAX_CANDIDATES);

      expect(outcome).not.toHaveProperty('candidates');
      expect(outcome).not.toHaveProperty('entity');
    });
  });

  describe('tool payload always carries the verdict (FR-005)', () => {
    it.each([
      ['resolved', { kind: 'resolved' as const, entity: entity('a'), children: [] }],
      ['candidates', { kind: 'candidates' as const, candidates: [entity('a'), entity('b')] }],
      ['none', { kind: 'none' as const }],
      ['tooBroad', { kind: 'tooBroad' as const, matchCount: 99, narrowBy: NARROW_BY }]
    ])('includes completeness for a %s outcome', (kind, outcome) => {
      const payload = toToolPayload(outcome, complete(['urn:i:PP:PP']));

      expect(payload.kind).toBe(kind);
      expect(payload).toHaveProperty('completeness');
      expect((payload.completeness as { complete: boolean }).complete).toBe(true);
    });

    it('emits only the fields that belong to each variant', () => {
      expect(Object.keys(toToolPayload({ kind: 'none' }, complete())).sort()).toEqual([
        'completeness',
        'kind'
      ]);

      expect(
        Object.keys(
          toToolPayload({ kind: 'tooBroad', matchCount: 9, narrowBy: NARROW_BY }, complete())
        ).sort()
      ).toEqual(['completeness', 'kind', 'matchCount', 'narrowBy']);
    });
  });
});
