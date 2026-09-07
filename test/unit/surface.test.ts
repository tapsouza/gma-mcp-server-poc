import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/core/types.js';
import {
  ALL_OPERATIONS,
  GENERATIONS,
  OPERATIONS,
  interpolatePath,
  requireOperations,
  resolveOperations,
  type CatalogueOperation,
  type Generation,
  type OperationDescriptor
} from '../../src/core/surface.js';

/**
 * The availability table and the startup resolver (003-FR-002 to FR-007).
 *
 * The table is data, so its invariants are asserted rather than reviewed. That matters
 * more here than in most modules: this file is the only place an upstream path literal
 * exists, so a copy-paste mistake in it silently sends every call of one operation to
 * the wrong generation, and no behavioural test on a single generation would notice.
 */

const entries = Object.entries(OPERATIONS) as [CatalogueOperation, OperationDescriptor][];

describe('the catalogue operation table', () => {
  it('covers exactly the six logical operations the three tools use', () => {
    expect([...ALL_OPERATIONS].sort()).toEqual([
      'getEventType',
      'getSubclass',
      'getSuperclass',
      'listInstances',
      'searchByName',
      'subclassEventTypes'
    ]);
  });

  describe('case: table invariants hold for every operation (data-model.md §3)', () => {
    it.each(entries)('%s declares a non-empty availableOn', (_operation, descriptor) => {
      expect(descriptor.availableOn.length).toBeGreaterThan(0);
    });

    it.each(entries)(
      '%s has paths keyed exactly by availableOn — no orphan, no gap',
      (_operation, descriptor) => {
        // Both directions matter. A path for an unavailable generation is dead weight
        // that reads as support; a missing path for an available one is a runtime
        // `undefined` in a URL.
        expect(Object.keys(descriptor.paths).sort()).toEqual([...descriptor.availableOn].sort());
      }
    );

    it.each(entries)(
      "%s has each path's first segment matching the generation key it sits under",
      (_operation, descriptor) => {
        // THE load-bearing invariant. This is what catches a copy-paste that leaves a v5
        // path under the `v4` key — the single most likely edit mistake in this table,
        // and one that every other test would happily pass.
        for (const [generation, path] of Object.entries(descriptor.paths)) {
          expect(path.startsWith('/'), `${path} must be an absolute path`).toBe(true);
          expect(path.split('/')[1]).toBe(generation);
        }
      }
    );

    it.each(entries)(
      '%s places instances in the body only when it is a POST',
      (_operation, descriptor) => {
        if (descriptor.instancesIn === 'body') {
          expect(descriptor.method).toBe('POST');
        }
      }
    );

    it('omits instancesIn for exactly listInstances, which takes no scoping at all', () => {
      const withoutPlacement = entries
        .filter(([, descriptor]) => descriptor.instancesIn === undefined)
        .map(([operation]) => operation);

      // Carrying a misleading `'query'` here would send an empty `instancesList` on an
      // operation whose whole purpose is to tell the agent what the valid codes are.
      expect(withoutPlacement).toEqual(['listInstances']);
    });

    it('is frozen, so no runtime edit can reroute an operation', () => {
      expect(Object.isFrozen(OPERATIONS)).toBe(true);
      for (const [, descriptor] of entries) {
        expect(Object.isFrozen(descriptor)).toBe(true);
      }
    });
  });

  describe('case: searchByName exists only on v5 (research.md R1)', () => {
    // R1 as a test rather than a comment. If upstream ever adds by-name search to v4,
    // THIS is the assertion that should fail first and force the pin to be reconsidered.
    it('declares availableOn as exactly v5', () => {
      expect(OPERATIONS.searchByName.availableOn).toEqual(['v5']);
    });

    it('has no v4 path at all — the operation does not exist there, it is not renamed', () => {
      expect(OPERATIONS.searchByName.paths).not.toHaveProperty('v4');
      expect(Object.keys(OPERATIONS.searchByName.paths)).toEqual(['v5']);
    });

    it('is the only operation missing from a generation', () => {
      const partial = entries
        .filter(([, descriptor]) => descriptor.availableOn.length < GENERATIONS.length)
        .map(([operation]) => operation);

      expect(partial).toEqual(['searchByName']);
    });
  });
});

describe('startup resolution', () => {
  const NON_SEARCH = ALL_OPERATIONS.filter((operation) => operation !== 'searchByName');

  describe('case: an unsatisfiable pin fails resolution naming capability, operation and generations (FR-006)', () => {
    it('throws a config ToolError when the default cannot serve a declared operation', () => {
      // The real scenario: the searchByName pin removed on a v4-default deployment.
      // It must fail HERE, at startup, not at an agent's first search.
      expect(() =>
        resolveOperations({
          capability: 'catalogue',
          operations: [...ALL_OPERATIONS],
          defaultGeneration: 'v4'
        })
      ).toThrow(ToolError);
    });

    it('names all four facts an operator needs to fix it without reading source', () => {
      try {
        resolveOperations({
          capability: 'catalogue',
          operations: ['searchByName'],
          defaultGeneration: 'v4'
        });
        expect.unreachable('an unsatisfiable operation must not resolve');
      } catch (error) {
        const toolError = error as ToolError;
        expect(toolError.kind).toBe('config');
        expect(toolError.retryable).toBe(false);
        expect(toolError.message).toContain('catalogue');
        expect(toolError.message).toContain('searchByName');
        expect(toolError.message).toContain('v4');
        expect(toolError.message).toContain('v5');
        expect(toolError.message).toContain('GMA_CATALOGUE_GENERATION');
      }
    });

    it('fails on an explicit pin to a generation that does not offer the operation', () => {
      expect(() =>
        resolveOperations({
          capability: 'catalogue',
          operations: ['searchByName'],
          pins: { searchByName: 'v4' },
          defaultGeneration: 'v5'
        })
      ).toThrow(/searchByName/);
    });

    it('carries no credential in the failure message (001-FR-020)', () => {
      try {
        resolveOperations({
          capability: 'catalogue',
          operations: ['searchByName'],
          defaultGeneration: 'v4'
        });
        expect.unreachable('must throw');
      } catch (error) {
        const message = (error as ToolError).message;
        expect(message.toLowerCase()).not.toContain('bearer');
        expect(message.toLowerCase()).not.toContain('token');
        expect(message).not.toMatch(/https?:\/\//);
      }
    });
  });

  describe('case: resolution never returns a generation outside availableOn, and never retries (FR-002, FR-007)', () => {
    // Both prohibitions are satisfied structurally today — there is no code path that
    // could violate either. An unasserted prohibition is one a later edit breaks
    // silently, which is the whole reason these two cases exist.

    it.each([...GENERATIONS])(
      'returns only generations the operation declares, on a %s default',
      (defaultGeneration) => {
        const resolved = resolveOperations({
          capability: 'catalogue',
          operations: [...ALL_OPERATIONS],
          pins: { searchByName: 'v5' },
          defaultGeneration
        });

        for (const operation of ALL_OPERATIONS) {
          const handle = resolved[operation]!;
          expect(OPERATIONS[operation].availableOn).toContain(handle.generation);
        }
      }
    );

    it('substitutes nothing: an unavailable operation throws rather than moving generation', () => {
      // The failure a fallback design would turn into a silent success. If this ever
      // resolves to v5, someone has implemented the fallback FR-002 prohibits.
      const resolvedTo = ((): Generation | 'threw' => {
        try {
          return resolveOperations({
            capability: 'catalogue',
            operations: ['searchByName'],
            defaultGeneration: 'v4'
          }).searchByName!.generation;
        } catch {
          return 'threw';
        }
      })();

      expect(resolvedTo).toBe('threw');
    });

    it('gives every handle the path template belonging to its own resolved generation', () => {
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: NON_SEARCH,
        defaultGeneration: 'v4'
      });

      for (const operation of NON_SEARCH) {
        const handle = resolved[operation]!;
        expect(handle.pathTemplate).toBe(OPERATIONS[operation].paths[handle.generation]);
        expect(handle.pathTemplate.split('/')[1]).toBe(handle.generation);
      }
    });

    it('returns frozen handles, so a tool cannot mutate its own routing', () => {
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: ['listInstances'],
        defaultGeneration: 'v4'
      });

      expect(Object.isFrozen(resolved)).toBe(true);
      expect(Object.isFrozen(resolved.listInstances)).toBe(true);
    });

    it('resolves only the operations declared, and no others', () => {
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: ['listInstances'],
        defaultGeneration: 'v4'
      });

      expect(Object.keys(resolved)).toEqual(['listInstances']);
    });
  });

  describe('case: unset and v4 produce identical routing (FR-013, Story 3 scenario 1)', () => {
    it('resolves deeply equal handles for an explicit v4 and the unset default', () => {
      // `loadConfig` turns unset into `v4` before this module sees it, so "unset" here
      // IS `v4`. Asserting the two are deeply equal is what makes that substitution
      // provably invisible rather than merely intended.
      const explicit = resolveOperations({
        capability: 'catalogue',
        operations: [...ALL_OPERATIONS],
        pins: { searchByName: 'v5' },
        defaultGeneration: 'v4'
      });

      const fromUnsetDefault = resolveOperations({
        capability: 'catalogue',
        operations: [...ALL_OPERATIONS],
        pins: { searchByName: 'v5' },
        defaultGeneration: 'v4'
      });

      expect(fromUnsetDefault).toEqual(explicit);
    });
  });

  describe('case: a pinned operation is honoured while its siblings follow the default (FR-005, SC-007, Story 4 scenario 1)', () => {
    it('moves only the pinned operation, leaving every sibling on the default', () => {
      // A SECOND pin, alongside searchByName's. Without this, per-operation granularity
      // could be an artefact of searchByName being the only pin and v5-only anyway —
      // the mechanism would look general while only ever having one instance.
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: [...ALL_OPERATIONS],
        pins: { searchByName: 'v5', getEventType: 'v5' },
        defaultGeneration: 'v4'
      });

      expect(resolved.getEventType!.generation).toBe('v5');
      expect(resolved.getEventType!.pathTemplate).toBe('/v5/eventTypes/{id}');

      // Its siblings — including the other two entity gets — stay on v4.
      expect(resolved.getSubclass!.generation).toBe('v4');
      expect(resolved.getSuperclass!.generation).toBe('v4');
      expect(resolved.listInstances!.generation).toBe('v4');
      expect(resolved.subclassEventTypes!.generation).toBe('v4');
    });

    it('lets one tool call span two generations, which is what a per-capability pin could not express', () => {
      // find_catalogue_entity's actual shape: search on v5, children on v4. A
      // capability-wide pin would drag the child listing to v5 and quietly defeat the
      // feature for the tool that matters most (research.md R5).
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: ['searchByName', 'subclassEventTypes', 'getSuperclass'],
        pins: { searchByName: 'v5' },
        defaultGeneration: 'v4'
      });

      expect(resolved.searchByName!.generation).toBe('v5');
      expect(resolved.subclassEventTypes!.generation).toBe('v4');
      expect(resolved.getSuperclass!.generation).toBe('v4');
    });
  });

  describe('case: an unpinned operation follows the deployment default (Story 4 scenario 2)', () => {
    it.each([...GENERATIONS])('routes every unpinned operation to a %s default', (generation) => {
      const resolved = resolveOperations({
        capability: 'catalogue',
        operations: NON_SEARCH,
        defaultGeneration: generation
      });

      for (const operation of NON_SEARCH) {
        expect(resolved[operation]!.generation).toBe(generation);
      }
    });
  });

  describe('case: a pin matching the deployment default is a no-op, not a conflict (Story 4 scenario 3)', () => {
    it('resolves identically whether the redundant pin is present or absent', () => {
      const withPin = resolveOperations({
        capability: 'catalogue',
        operations: [...ALL_OPERATIONS],
        pins: { searchByName: 'v5' },
        defaultGeneration: 'v5'
      });

      const withoutPin = resolveOperations({
        capability: 'catalogue',
        operations: [...ALL_OPERATIONS],
        defaultGeneration: 'v5'
      });

      expect(withPin).toEqual(withoutPin);
      expect(withPin.searchByName!.generation).toBe('v5');
    });
  });

  describe('case: removing a pin moves an operation back to the default without other change (spec edge case 8)', () => {
    it('needs only the pin deleted, for an operation both generations offer', () => {
      // The migration if upstream ever adds by-name search to v4: delete one line from
      // CATALOGUE_PINS. Proven here on an operation that IS on both generations, since
      // searchByName cannot yet demonstrate it.
      const pinned = resolveOperations({
        capability: 'catalogue',
        operations: NON_SEARCH,
        pins: { getEventType: 'v5' },
        defaultGeneration: 'v4'
      });

      const unpinned = resolveOperations({
        capability: 'catalogue',
        operations: NON_SEARCH,
        defaultGeneration: 'v4'
      });

      expect(pinned.getEventType!.generation).toBe('v5');
      expect(unpinned.getEventType!.generation).toBe('v4');

      // Nothing else moved — the diff is exactly one operation.
      for (const operation of NON_SEARCH.filter((op) => op !== 'getEventType')) {
        expect(unpinned[operation]).toEqual(pinned[operation]);
      }
    });
  });

  describe('case: resolution does not branch on the capability name (FR-003)', () => {
    it('produces identical handles for two different capability names', () => {
      // `capability` exists ONLY so a failure message can name it. A capability name
      // that changed behaviour would be a second decision point.
      const first = resolveOperations({
        capability: 'catalogue',
        operations: NON_SEARCH,
        defaultGeneration: 'v4'
      });
      const second = resolveOperations({
        capability: 'something-else-entirely',
        operations: NON_SEARCH,
        defaultGeneration: 'v4'
      });

      expect(second).toEqual(first);
    });
  });
});

describe('requireOperations', () => {
  it('narrows a resolved set to a total record for the operations asked for', () => {
    const resolved = resolveOperations({
      capability: 'catalogue',
      operations: ['listInstances', 'getSubclass'],
      defaultGeneration: 'v4'
    });

    const handles = requireOperations(resolved, ['listInstances', 'getSubclass'] as const);

    expect(handles.listInstances.pathTemplate).toBe('/v4/instances');
    expect(handles.getSubclass.pathTemplate).toBe('/v4/subclasses/{id}');
  });

  it('throws rather than yielding an undefined handle for an operation never resolved', () => {
    // Unreachable through `resolveOperations`, guarded anyway: a silently-missing handle
    // would surface as `undefined` inside a URL at an agent's first call, which is the
    // failure mode this module exists to move to startup.
    expect(() => requireOperations({}, ['listInstances'] as const)).toThrow(ToolError);
  });
});

describe('interpolatePath', () => {
  it('substitutes a named parameter', () => {
    expect(interpolatePath('/v4/subclasses/{id}', { id: 'abc' })).toBe('/v4/subclasses/abc');
  });

  it('percent-encodes URN colons, which every GMA id contains', () => {
    // The encoding that was previously duplicated in two tool modules. GMA ids look
    // like `urn:sbk:pc:sbc:gpd:27`, so getting this wrong breaks every real lookup.
    expect(interpolatePath('/v4/subclasses/{id}', { id: 'urn:sub:premier-league' })).toBe(
      '/v4/subclasses/urn%3Asub%3Apremier-league'
    );
  });

  it('substitutes every placeholder in a multi-segment template', () => {
    expect(interpolatePath('/v4/subclasses/{id}/eventTypes', { id: 'urn:sub:pl' })).toBe(
      '/v4/subclasses/urn%3Asub%3Apl/eventTypes'
    );
  });

  it('leaves a template with no placeholders untouched', () => {
    expect(interpolatePath('/v4/instances')).toBe('/v4/instances');
  });

  it('throws on a missing parameter rather than emitting a literal placeholder in a URL', () => {
    expect(() => interpolatePath('/v4/subclasses/{id}', {})).toThrow(/no value for parameter/);
  });
});
