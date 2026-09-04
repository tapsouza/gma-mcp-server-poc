import { OUTCOME_SEVERITY, type Completeness, type InstanceError, type Outcome } from './types.js';

/**
 * Constitution Principle II (NON-NEGOTIABLE) lives here.
 *
 * This is the SINGLE place that turns an upstream signal into a `Completeness`,
 * and the single place that merges the verdicts of a multi-hop tool. Partial data
 * must never be presentable as complete, so the invariant
 *
 *   1. `complete === true` iff `outcome === 'COMPLETE'`
 *   2. `failedInstances.length > 0` implies NOT `complete`
 *   3. `caveat === null` iff `complete`
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
 * The human-readable sentence the agent is instructed to relay (FR-009).
 * `null` iff the result is complete — there is nothing to caveat.
 */
function buildCaveat(
  outcome: Outcome,
  failedInstances: readonly string[],
  errors: readonly InstanceError[]
): string | null {
  if (outcome === 'COMPLETE') return null;

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
        `${named}${detail} Relay this caveat to the user: the data shown may be missing entries.`
      );
    case 'TIMEOUT_PARTIAL':
      return (
        `INCOMPLETE RESULT — the upstream request timed out after some instances had answered. ` +
        `${named}${detail} Relay this caveat to the user: the data shown may be missing entries.`
      );
    case 'TOO_BROAD':
      return (
        `INCOMPLETE RESULT — the query matched too many entities to answer usefully, so no ` +
        `entity was resolved. Narrow the query and relay this to the user rather than ` +
        `presenting a partial list as the whole answer.`
      );
  }
}

/** Assemble a `Completeness`, deriving `complete` and `caveat` so they cannot disagree. */
function build(
  outcome: Outcome,
  successfulInstances: readonly string[],
  failedInstances: readonly string[],
  errors: readonly InstanceError[]
): Completeness {
  const successful = dedupe(successfulInstances);
  const failed = dedupe(failedInstances);
  const deduplicatedErrors = dedupeErrors(errors);

  // The invariant is upheld HERE, not by callers: an outcome worse than COMPLETE,
  // or any failed instance, makes the result incomplete. `complete` is never an
  // input — a caller cannot assert completeness it has not earned.
  const complete = outcome === 'COMPLETE' && failed.length === 0;
  const effectiveOutcome: Outcome = complete
    ? 'COMPLETE'
    : outcome === 'COMPLETE'
      ? // HTTP 200 that nonetheless named a failed instance. Trust the failure,
        // not the status: presenting this as complete is the exact trap
        // Principle II exists to prevent.
        'PARTIAL'
      : outcome;

  return Object.freeze({
    complete,
    outcome: effectiveOutcome,
    successfulInstances: Object.freeze(successful),
    failedInstances: Object.freeze(failed),
    errors: Object.freeze(deduplicatedErrors),
    caveat: buildCaveat(effectiveOutcome, failed, deduplicatedErrors)
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
  return build('TIMEOUT_PARTIAL', successfulInstances, failedInstances, errors);
}

/**
 * A too-broad query: derived from result cardinality, since v5 does not report it
 * (research.md R2). No entity is resolved, so the answer is incomplete by
 * definition even when every instance answered.
 */
export function fromTooBroad(base: Completeness): Completeness {
  return build('TOO_BROAD', base.successfulInstances, base.failedInstances, base.errors);
}

/** The verdict for a hop that succeeded outright — also the neutral element for `aggregate`. */
export function complete(successfulInstances: readonly string[] = []): Completeness {
  return build('COMPLETE', successfulInstances, [], []);
}

/**
 * Merge every hop of a multi-hop tool into one verdict (FR-008).
 *
 * - `complete` is the AND of all hops
 * - `outcome` is the worst hop by `OUTCOME_SEVERITY`
 * - instances and errors are the deduplicated union
 *
 * This is why a 206 on the second hop alone marks the whole result incomplete
 * (SC-011).
 */
export function aggregate(hops: readonly Completeness[]): Completeness {
  if (hops.length === 0) return complete();

  let worst: Outcome = 'COMPLETE';
  const successful: string[] = [];
  const failed: string[] = [];
  const errors: InstanceError[] = [];

  for (const hop of hops) {
    if (OUTCOME_SEVERITY[hop.outcome] > OUTCOME_SEVERITY[worst]) worst = hop.outcome;
    successful.push(...hop.successfulInstances);
    failed.push(...hop.failedInstances);
    errors.push(...hop.errors);
  }

  return build(worst, successful, failed, errors);
}
