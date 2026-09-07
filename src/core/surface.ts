import { unsatisfiableGeneration } from './errors.js';

/**
 * Which upstream catalogue generation serves each operation (003-FR-001 to FR-007,
 * constitution "v1 API surface").
 *
 * GMA publishes TWO current catalogue generations. This module is the single place that
 * knows they exist: the only place any upstream path literal appears, and the only place
 * a generation is chosen. Resolution runs ONCE at startup and produces
 * `ResolvedOperation` handles that tools hold.
 *
 * That is what makes "exactly one place decides the generation" (FR-003) structural
 * rather than a rule someone must remember. A tool receives a handle and has no way to
 * name a path, name a generation, or choose either — the capability is absent from its
 * vocabulary, which is stronger than a convention saying it must not be used.
 *
 * This module is domain-agnostic, so it belongs in `core/` (Principle III). The
 * declarations it resolves come from a domain, which is why the resolver is CALLED from
 * `server/register.ts` — the one layer permitted to see both `core/` and a domain — and
 * never imports one itself.
 */

/**
 * ## Adding a capability that requires a specific generation
 *
 * One line, in the domain's `CATALOGUE_PINS`:
 *
 * ```ts
 * export const CATALOGUE_PINS: OperationPins = Object.freeze({
 *   searchByName: 'v5',
 *   someNewOperation: 'v5'   // declared once, honoured on every deployment
 * });
 * ```
 *
 * No change to any shared calling code, and no change to any other capability. If the
 * operation is not available on the generation you pin it to — or on the deployment
 * default when you forget to pin it — the process **refuses to start**, naming the
 * capability, the operation, and the generations that do offer it. It does not fail at
 * an agent's first use, which is the point: startup is the only moment where failing is
 * free.
 *
 * Removing a pin is equally one line. If upstream ever adds by-name search to v4, the
 * whole migration is deleting `searchByName: 'v5'` — the table's `availableOn` gains a
 * `v4` entry and every unpinned operation follows the deployment default already.
 */

/** A GMA catalogue generation. Two values because two exist upstream (research.md R1). */
export type Generation = 'v4' | 'v5';

/** Every generation, in the order an error message should list them. */
export const GENERATIONS: readonly Generation[] = Object.freeze(['v4', 'v5']);

/**
 * A logical operation id — exactly the six the three tools use.
 *
 * Deliberately generation-free, so a log or dashboard keyed on `listInstances` survives
 * a generation change instead of splitting into two series (research.md R7).
 */
export type CatalogueOperation =
  | 'listInstances'
  | 'searchByName'
  | 'getSuperclass'
  | 'getSubclass'
  | 'getEventType'
  | 'subclassEventTypes';

/** Where an operation's instance scoping travels. */
export type InstancePlacement = 'query' | 'body';

/** What each generation offers for one logical operation. */
export interface OperationDescriptor {
  readonly method: 'GET' | 'POST';
  /** Generations that offer this operation. Non-empty. */
  readonly availableOn: readonly Generation[];
  /** Path template per available generation. Keys are exactly `availableOn`. */
  readonly paths: Readonly<Partial<Record<Generation, string>>>;
  /**
   * Where instance scoping goes. OMITTED for an operation that takes no instance
   * scoping at all, so the table never carries a misleading value.
   */
  readonly instancesIn?: InstancePlacement;
}

/**
 * A capability's declared per-operation generation requirement.
 *
 * Absence is meaningful: it means "follow the deployment default". It NEVER means "try
 * one and fall back to the other" — a fallback emits a real request that really fails,
 * pollutes upstream error metrics, and makes a configuration mistake indistinguishable
 * from an upstream outage (FR-002).
 */
export type OperationPins = Readonly<Partial<Record<CatalogueOperation, Generation>>>;

/** The handle a tool holds: the only operation-shaped value it ever sees. */
export interface ResolvedOperation {
  readonly operation: CatalogueOperation;
  readonly generation: Generation;
  readonly method: 'GET' | 'POST';
  readonly pathTemplate: string;
  readonly instancesIn?: InstancePlacement;
}

/**
 * The availability table — the sole encoding of research.md R1, and the ONLY place an
 * upstream path literal appears anywhere in `src/`.
 *
 * `searchByName` being `availableOn: ['v5']` with no `v4` path is that finding: v4 has
 * no by-name search of any kind, not a renamed one. It was added to v5 recently and to
 * no v4 file. Because it is data rather than a comment, it is asserted by a test.
 *
 * Verified 2026-09-07 against `../gma-service/gma-api/src/main/resources/static/`.
 */
export const OPERATIONS: Readonly<Record<CatalogueOperation, OperationDescriptor>> = Object.freeze({
  listInstances: Object.freeze({
    method: 'GET',
    availableOn: Object.freeze<Generation[]>(['v4', 'v5']),
    paths: Object.freeze({ v4: '/v4/instances', v5: '/v5/instances' })
    // No `instancesIn`: listing the instances is what an agent calls BEFORE it can
    // scope anything, so there is nothing to scope by. A misleading `'query'` here
    // would send an empty `instancesList` on a required-parameter operation.
  }),

  searchByName: Object.freeze({
    method: 'POST',
    // v4 has NO by-name search at all (research.md R1). This single-entry list is why
    // the startup availability check exists.
    availableOn: Object.freeze<Generation[]>(['v5']),
    paths: Object.freeze({ v5: '/v5/searchByName' }),
    // The one operation taking instances in the REQUEST BODY. Every other takes a
    // query parameter. That asymmetry is upstream's, and it lives here rather than in
    // a tool.
    instancesIn: 'body'
  }),

  getSuperclass: Object.freeze({
    method: 'GET',
    availableOn: Object.freeze<Generation[]>(['v4', 'v5']),
    paths: Object.freeze({ v4: '/v4/superclasses/{id}', v5: '/v5/superclasses/{id}' }),
    instancesIn: 'query'
  }),

  getSubclass: Object.freeze({
    method: 'GET',
    availableOn: Object.freeze<Generation[]>(['v4', 'v5']),
    paths: Object.freeze({ v4: '/v4/subclasses/{id}', v5: '/v5/subclasses/{id}' }),
    instancesIn: 'query'
  }),

  getEventType: Object.freeze({
    method: 'GET',
    availableOn: Object.freeze<Generation[]>(['v4', 'v5']),
    paths: Object.freeze({ v4: '/v4/eventTypes/{id}', v5: '/v5/eventTypes/{id}' }),
    instancesIn: 'query'
  }),

  subclassEventTypes: Object.freeze({
    method: 'GET',
    availableOn: Object.freeze<Generation[]>(['v4', 'v5']),
    paths: Object.freeze({
      v4: '/v4/subclasses/{id}/eventTypes',
      v5: '/v5/subclasses/{id}/eventTypes'
    }),
    instancesIn: 'query'
  })
});

/** Every operation id in the table, for tests and for a domain declaring all of them. */
export const ALL_OPERATIONS = Object.freeze(
  Object.keys(OPERATIONS) as CatalogueOperation[]
) as readonly CatalogueOperation[];

export interface ResolveOperationsInput {
  /**
   * The capability doing the declaring, used ONLY to name it in a failure message.
   *
   * Resolution MUST NOT branch on it. A capability name that changed behaviour would be
   * a second decision point, which is exactly what FR-003 forbids.
   */
  readonly capability: string;
  readonly operations: readonly CatalogueOperation[];
  readonly pins?: OperationPins | undefined;
  readonly defaultGeneration: Generation;
}

/**
 * Resolve a capability's declared operations into handles, once, at startup.
 *
 * ```
 * effective(op) = pins[op] ?? defaultGeneration
 * REQUIRE effective(op) ∈ descriptor(op).availableOn     ← else the process refuses to start
 * ```
 *
 * The availability requirement IS the FR-006 check — there is no separate validation
 * pass, because an operation that cannot be satisfied cannot produce a handle, so the
 * server cannot start holding one. Failing here is free; failing at an agent's first
 * call is not.
 *
 * Note what this function cannot do: it never returns a generation outside `availableOn`,
 * and it never retries or substitutes one (FR-002, FR-007). Both hold structurally —
 * there is no code path that could — and both are asserted by tests so a later edit
 * cannot quietly introduce one.
 */
export function resolveOperations({
  capability,
  operations,
  pins,
  defaultGeneration
}: ResolveOperationsInput): Readonly<Partial<Record<CatalogueOperation, ResolvedOperation>>> {
  const resolved: Partial<Record<CatalogueOperation, ResolvedOperation>> = {};

  for (const operation of operations) {
    const descriptor = OPERATIONS[operation];
    const effective = pins?.[operation] ?? defaultGeneration;

    if (!descriptor.availableOn.includes(effective)) {
      throw unsatisfiableGeneration(capability, operation, effective, descriptor.availableOn);
    }

    // Guaranteed present: the table's invariant is that `paths` keys are exactly
    // `availableOn`, asserted by a unit test rather than trusted.
    const pathTemplate = descriptor.paths[effective] as string;

    resolved[operation] = Object.freeze({
      operation,
      generation: effective,
      method: descriptor.method,
      pathTemplate,
      ...(descriptor.instancesIn === undefined ? {} : { instancesIn: descriptor.instancesIn })
    });
  }

  return Object.freeze(resolved);
}

/**
 * The handle set for a capability that declared every operation, with each one present.
 *
 * A capability declares the operations it uses; this narrows the resolver's partial
 * result to a total one for the operations it asked for, so a tool holding a handle
 * needs no optional-chaining at its call site.
 */
export function requireOperations<K extends CatalogueOperation>(
  resolved: Readonly<Partial<Record<CatalogueOperation, ResolvedOperation>>>,
  operations: readonly K[]
): Readonly<Record<K, ResolvedOperation>> {
  const total = {} as Record<K, ResolvedOperation>;

  for (const operation of operations) {
    const handle = resolved[operation];
    if (handle === undefined) {
      // Unreachable through `resolveOperations`, which resolves every operation it is
      // given or throws. Guarded anyway: a silently-missing handle would surface as an
      // undefined path at an agent's first call, which is the failure mode this whole
      // module exists to move to startup.
      throw unsatisfiableGeneration('unknown', operation, 'v4', OPERATIONS[operation].availableOn);
    }
    total[operation] = handle;
  }

  return Object.freeze(total);
}

/**
 * Interpolate a path template's `{name}` placeholders.
 *
 * Every value is percent-encoded here, which is the reason this lives beside the table
 * rather than in each tool: GMA ids are URNs full of colons, and the encoding was
 * previously repeated in two tool modules.
 */
export function interpolatePath(
  template: string,
  params: Readonly<Record<string, string>> = {}
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      // A programming error, not an operator or agent error: the template and the call
      // site disagree. Throwing a plain Error is right — it is not a condition any
      // agent or operator can act on.
      throw new Error(`path template "${template}" has no value for parameter "${name}"`);
    }
    return encodeURIComponent(value);
  });
}
