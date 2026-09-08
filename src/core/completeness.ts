import {
  OUTCOME_SEVERITY,
  type Completeness,
  type ComponentName,
  type InstanceError,
  type Outcome
} from './types.js';

/**
 * Constitution Principle II (NON-NEGOTIABLE) lives here.
 *
 * This is the SINGLE place that turns an upstream signal into a `Completeness`,
 * and the single place that merges the verdicts of a multi-hop tool. Partial data
 * must never be presentable as complete, so the invariant
 *
 *   1. `complete === true` iff `outcome === 'COMPLETE'`
 *   2. `failedInstances.length > 0` implies NOT `complete`
 *   3. `unavailableComponents.length > 0` implies NOT `complete`
 *   4. `caveat === null` iff `complete`
 *
 * is established by construction here rather than checked by callers. `complete` is
 * never an input to any function in this module: a caller cannot assert completeness
 * it has not earned.
 *
 * NOTE on clause 2: data-model.md section 1 states the invariant as a three-way
 * equivalence, whose third clause is `failedInstances.length === 0` implies
 * `complete`. That contradicts the same document's `Outcome` table, which defines
 * `TOO_BROAD` as `complete: false` — and a too-broad query has zero failed
 * instances, since every instance answered and only the query was too wide. A
 * timeout that named no failing instance is the same shape. The equivalence is
 * therefore unsatisfiable as written, so clause 2 keeps the direction that carries
 * the safety property (never report failures and completeness together) and drops
 * the converse that the document got wrong.
 *
 * NOTE on clause 3 (added by feature 004): one-directional for exactly the same
 * reason. A missing SECTION makes a result incomplete, but an empty section list
 * does not by itself make it complete — the other axis and the outcome still apply.
 * Crucially, the two axes are kept SEPARATE all the way through: `aggregate` unions
 * them independently and `buildCaveat` says different things about them, because a
 * failed instance invites a narrowed retry and a missing section must tell the agent
 * NOT to retry with different scoping.
 *
 * On the v5 catalogue surface the upstream signal is the HTTP STATUS CODE, not a
 * `status.code` body field — v5 exposes no such envelope (research.md R1).
 */

/**
 * The subset of a GMA v5 response body this module reads.
 *
 * Uses GMA's own `configSource` vocabulary because that is what GMA sends. It is
 * translated to the project's `instance` vocabulary here, at the client boundary,
 * and goes no further (constitution Principle IV).
 */
export interface GmaEnvelope {
  readonly successfulConfigSources?: readonly string[] | null;
  readonly failedConfigSources?: readonly string[] | null;
  readonly errors?: readonly { configSource?: string | null; message?: string | null }[] | null;
}

/** Deduplicate while preserving first-seen order, so caveats read deterministically. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

/** Deduplicate errors by their (instance, message) pair. */
function dedupeErrors(errors: readonly InstanceError[]): InstanceError[] {
  const seen = new Map<string, InstanceError>();
  for (const error of errors) {
    const key = `${error.instance} ${error.message}`;
    if (!seen.has(key)) seen.set(key, error);
  }
  return [...seen.values()];
}

/** Translate the upstream `errors[]` shape into the project's vocabulary. */
function toInstanceErrors(envelope: GmaEnvelope): InstanceError[] {
  return (envelope.errors ?? [])
    .filter((error): error is { configSource?: string | null; message?: string | null } =>
      Boolean(error)
    )
    .map((error) => ({
      instance: error.configSource ?? 'unknown',
      message: error.message ?? 'No error detail reported'
    }));
}

/**
 * The phrase a person reads for each component name.
 *
 * The enum member is the agent-facing token and stays machine-stable; this is the
 * prose for the caveat sentence a human is told verbatim.
 */
const COMPONENT_LABEL: Readonly<Record<ComponentName, string>> = Object.freeze({
  customerRiskConfiguration: 'customer risk configuration',
  betDetail: 'bet detail',
  legCataloguePositions: 'catalogue positions for one or more bet legs',
  jurisdictionContexts: 'jurisdiction context list'
});

/** Label the known components; pass an unknown one through rather than dropping it. */
function humaniseComponents(components: readonly string[]): string {
  return components.map((name) => COMPONENT_LABEL[name as ComponentName] ?? name).join(', ');
}

/**
 * The sentence that distinguishes the second axis from the first.
 *
 * The "do NOT retry with different scoping" clause is the whole point: an agent told
 * a section is missing the way it is told an instance failed will retry with narrower
 * scoping, which cannot fix a missing section, so it retries indefinitely
 * (constitution Principle II).
 */
function missingSectionSentence(components: readonly string[]): string {
  return (
    `This answer is missing section(s): ${humaniseComponents(components)}. ` +
    `Relay this caveat to the user and state what is absent; do NOT retry with different ` +
    `scoping, which cannot help.`
  );
}

/**
 * The human-readable sentence the agent is instructed to relay (FR-009).
 * `null` iff the result is complete — there is nothing to caveat.
 */
function buildCaveat(
  outcome: Outcome,
  failedInstances: readonly string[],
  unavailableComponents: readonly string[],
  errors: readonly InstanceError[]
): string | null {
  if (outcome === 'COMPLETE') return null;

  const sections =
    unavailableComponents.length > 0 ? ` ${missingSectionSentence(unavailableComponents)}` : '';

  // A result whose ONLY defect is a missing section must not be described as
  // "assembled from only some brand instances": no instance failed, and saying one
  // did is precisely what sends the agent off retrying scoping that cannot help.
  if (
    unavailableComponents.length > 0 &&
    failedInstances.length === 0 &&
    errors.length === 0 &&
    outcome === 'PARTIAL'
  ) {
    return `INCOMPLETE RESULT —${sections}`;
  }

  const named =
    failedInstances.length > 0
      ? `Instance(s) that did not answer: ${failedInstances.join(', ')}.`
      : 'The failing instance(s) were not identified by the upstream system.';

  const detail =
    errors.length > 0
      ? ` Reported: ${errors.map((e) => `${e.instance}: ${e.message}`).join('; ')}.`
      : '';

  switch (outcome) {
    case 'PARTIAL':
      return (
        `INCOMPLETE RESULT — this answer is assembled from only some brand instances. ` +
        `${named}${detail} Relay this caveat to the user: the data shown may be missing entries.${sections}`
      );
    case 'TIMEOUT_PARTIAL':
      return (
        `INCOMPLETE RESULT — the upstream request timed out after some instances had answered. ` +
        `${named}${detail} Relay this caveat to the user: the data shown may be missing entries.${sections}`
      );
    case 'TOO_BROAD':
      return (
        `INCOMPLETE RESULT — the query matched too many entities to answer usefully, so no ` +
        `entity was resolved. Narrow the query and relay this to the user rather than ` +
        `presenting a partial list as the whole answer.${sections}`
      );
  }
}

/** Assemble a `Completeness`, deriving `complete` and `caveat` so they cannot disagree. */
function build(
  outcome: Outcome,
  successfulInstances: readonly string[],
  failedInstances: readonly string[],
  unavailableComponents: readonly string[],
  errors: readonly InstanceError[]
): Completeness {
  const successful = dedupe(successfulInstances);
  const failed = dedupe(failedInstances);
  const unavailable = dedupe(unavailableComponents);
  const deduplicatedErrors = dedupeErrors(errors);

  // The invariant is upheld HERE, not by callers: an outcome worse than COMPLETE, any
  // failed instance, or any unavailable section makes the result incomplete.
  // `complete` is never an input — a caller cannot assert completeness it has not
  // earned.
  const complete = outcome === 'COMPLETE' && failed.length === 0 && unavailable.length === 0;
  const effectiveOutcome: Outcome = complete
    ? 'COMPLETE'
    : outcome === 'COMPLETE'
      ? // HTTP 200 that nonetheless named a failed instance, or a composite hop that
        // answered while a section of the answer is missing. Trust the failure, not
        // the status: presenting either as complete is the exact trap Principle II
        // exists to prevent. `Outcome` gains no new member — a missing section is an
        // independent AXIS, not a new severity (data-model.md section 1).
        'PARTIAL'
      : outcome;

  return Object.freeze({
    complete,
    outcome: effectiveOutcome,
    successfulInstances: Object.freeze(successful),
    failedInstances: Object.freeze(failed),
    unavailableComponents: Object.freeze(unavailable),
    errors: Object.freeze(deduplicatedErrors),
    caveat: buildCaveat(effectiveOutcome, failed, unavailable, deduplicatedErrors)
  });
}

/**
 * Map one GMA hop's HTTP status and body to a `Completeness`.
 *
 * Only 200 and 206 reach this function: every other status is a terminal failure
 * mapped to a `ToolError` by `errors.ts`, and never carries a completeness (FR-010).
 *
 * @throws if given a status that is not completeness-bearing — a caller routing a
 *   500 here has a bug, and failing loudly is safer than inventing a verdict.
 */
export function fromHttpStatus(status: number, body: GmaEnvelope | null | undefined): Completeness {
  if (status !== 200 && status !== 206) {
    throw new Error(
      `fromHttpStatus received HTTP ${status}, which is a terminal failure and must be ` +
        `mapped by errors.ts rather than given a completeness verdict`
    );
  }

  const envelope = body ?? {};
  return build(
    status === 200 ? 'COMPLETE' : 'PARTIAL',
    envelope.successfulConfigSources ?? [],
    envelope.failedConfigSources ?? [],
    // An HTTP hop reports instance failures, never missing SECTIONS: a section is a
    // property of a composite answer this module cannot see. Only a composing tool
    // knows one is absent, which is why `withUnavailableComponents` exists.
    [],
    toInstanceErrors(envelope)
  );
}

/**
 * A timeout that aborted AFTER some instances had already answered.
 *
 * A timeout with nothing usable is NOT this: it is a `ToolError` of kind
 * `upstream`. The spec requires the two never be conflated (FR-010).
 */
export function fromTimeoutWithPartialData(
  successfulInstances: readonly string[],
  failedInstances: readonly string[] = [],
  errors: readonly InstanceError[] = []
): Completeness {
  return build('TIMEOUT_PARTIAL', successfulInstances, failedInstances, [], errors);
}

/**
 * A too-broad query: derived from result cardinality, since v5 does not report it
 * (research.md R2). No entity is resolved, so the answer is incomplete by
 * definition even when every instance answered.
 */
export function fromTooBroad(base: Completeness): Completeness {
  return build(
    'TOO_BROAD',
    base.successfulInstances,
    base.failedInstances,
    base.unavailableComponents,
    base.errors
  );
}

/**
 * A composite hop that ANSWERED, but whose named section of the answer is missing.
 *
 * This is the second axis's only constructor, and it is deliberately separate from
 * everything above: the axes must never be conflated, and a caller reaching for this
 * function is stating "a section is absent", not "a source failed". Passing an empty
 * list returns the base verdict unchanged, so a tool can call this unconditionally.
 *
 * Note the type: `ComponentName[]`, not `string[]`. The closed set is enforced by the
 * compiler at the call site, which is where a typo would otherwise become a component
 * name the agent has never been told about.
 */
export function withUnavailableComponents(
  base: Completeness,
  components: readonly ComponentName[]
): Completeness {
  return build(
    base.outcome,
    base.successfulInstances,
    base.failedInstances,
    [...base.unavailableComponents, ...components],
    base.errors
  );
}

/** The verdict for a hop that succeeded outright — also the neutral element for `aggregate`. */
export function complete(successfulInstances: readonly string[] = []): Completeness {
  return build('COMPLETE', successfulInstances, [], [], []);
}

/**
 * Merge every hop of a multi-hop tool into one verdict (FR-008).
 *
 * - `complete` is the AND of all hops
 * - `outcome` is the worst hop by `OUTCOME_SEVERITY`
 * - instances, components, and errors are the deduplicated union, each axis
 *   independently — a hop's missing section never becomes another hop's failed
 *   instance
 *
 * This is why a 206 on the second hop alone marks the whole result incomplete
 * (SC-011), and equally why a missing section on hop 3 does.
 */
export function aggregate(hops: readonly Completeness[]): Completeness {
  if (hops.length === 0) return complete();

  let worst: Outcome = 'COMPLETE';
  const successful: string[] = [];
  const failed: string[] = [];
  const unavailable: string[] = [];
  const errors: InstanceError[] = [];

  for (const hop of hops) {
    if (OUTCOME_SEVERITY[hop.outcome] > OUTCOME_SEVERITY[worst]) worst = hop.outcome;
    successful.push(...hop.successfulInstances);
    failed.push(...hop.failedInstances);
    unavailable.push(...hop.unavailableComponents);
    errors.push(...hop.errors);
  }

  return build(worst, successful, failed, unavailable, errors);
}
