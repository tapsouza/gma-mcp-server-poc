/**
 * Internal core types. These are the shapes constitution Principle II
 * (Mandatory Completeness Caveat) exists to protect.
 *
 * Nothing here can hold a credential: identity is a per-invocation parameter,
 * never a field on a value (FR-002, FR-023a). See `identity.ts`.
 */

/**
 * How complete an upstream answer was.
 *
 * Derived from the HTTP status on the v5 catalogue surface — NOT parsed from a
 * `status.code` body field, which v5 does not expose (research.md R1).
 *
 * Terminal failures (400/401/404/500, or a timeout with nothing usable) are
 * deliberately NOT members of this union. They are `ToolError`s and never carry a
 * `Completeness`, so a failure cannot be dressed as data (FR-010).
 */
export type Outcome =
  /** HTTP 200 — every config source answered. */
  | 'COMPLETE'
  /** HTTP 206 — some config sources failed; the data present is usable. */
  | 'PARTIAL'
  /** Client-derived from result cardinality; v5 does not report it (research.md R2). */
  | 'TOO_BROAD'
  /** Aborted, but some hops had already produced usable data. */
  | 'TIMEOUT_PARTIAL';

/**
 * Severity precedence for multi-hop aggregation — worst outcome wins (FR-008).
 * `TIMEOUT_PARTIAL` > `TOO_BROAD` > `PARTIAL` > `COMPLETE`.
 */
export const OUTCOME_SEVERITY: Readonly<Record<Outcome, number>> = Object.freeze({
  COMPLETE: 0,
  PARTIAL: 1,
  TOO_BROAD: 2,
  TIMEOUT_PARTIAL: 3
});

/**
 * A failure reported by one brand instance.
 *
 * Renamed from GMA's `configSource` at the client boundary so the tool-facing
 * vocabulary stays consistent (constitution Principle IV — upstream DTO
 * vocabulary must not leak into a tool schema).
 */
export interface InstanceError {
  readonly instance: string;
  readonly message: string;
}

/**
 * The mandatory verdict attached to every tool result as a top-level field —
 * present even on full success, and never prose-only (FR-005, FR-006).
 *
 * Invariant, asserted in `test/unit/completeness.test.ts`:
 *   `complete === true` ⟺ `outcome === 'COMPLETE'` ⟺ `failedInstances.length === 0`
 */
export interface Completeness {
  /** `true` only when every hop returned HTTP 200. */
  readonly complete: boolean;
  /** Worst outcome across all hops, by `OUTCOME_SEVERITY`. */
  readonly outcome: Outcome;
  /** Union of `successfulConfigSources` across hops, deduplicated. */
  readonly successfulInstances: readonly string[];
  /** Union of `failedConfigSources` across hops, deduplicated. */
  readonly failedInstances: readonly string[];
  /** Union of per-instance errors across hops, deduplicated. */
  readonly errors: readonly InstanceError[];
  /** Human-readable sentence for the agent to relay; `null` iff `complete`. */
  readonly caveat: string | null;
}

/**
 * The core GMA client's ONLY success return type. `core` never returns a bare
 * payload (FR-005), so a tool cannot receive data without its verdict.
 */
export interface GmaResult<T> {
  readonly data: T | null;
  readonly completeness: Completeness;
}

/**
 * Who must act on a failure. This is the distinction FR-010 requires: an agent
 * can self-correct an `argument` error, but only a human can fix `auth`.
 */
export type ErrorKind =
  /** HTTP 401 — identity absent, expired, or from the wrong issuer. Human re-authenticates. */
  | 'auth'
  /** HTTP 400, or local validation. The agent corrects its own arguments. */
  | 'argument'
  /** HTTP 404 — the identifier does not exist. */
  | 'notFound'
  /** HTTP 500, or a timeout with nothing usable. Retry or escalate. */
  | 'upstream'
  /** Startup only — the operator must fix configuration; the process refuses to start. */
  | 'config';

/**
 * A terminal failure. Carries no `Completeness` by construction (FR-010).
 *
 * `message` must be actionable and must NEVER contain a credential or personal
 * datum (FR-020). `errors.ts` is the single place that constructs these.
 */
export class ToolError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;

  constructor(kind: ErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.retryable = retryable;
  }
}
