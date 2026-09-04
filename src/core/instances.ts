import type { Config } from './config.js';
import { argumentError } from './errors.js';

/**
 * Brand instance codes (FR-017, data-model.md section 3).
 *
 * Humans and agents think in short codes (`PP`); GMA wants URNs (`urn:i:PP:PP`).
 * This module is the only place that bridges the two, so no tool has to know the
 * URN shape and no URN vocabulary leaks into a tool schema (Principle IV).
 */

/** GMA's instance URN shape, as seen in the v5 catalogue responses. */
const URN_PATTERN = /^urn:i:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;

/** A short code: letters and digits, no separators. */
const CODE_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/** Build the URN GMA expects from a short code. */
export function codeToUrn(code: string): string {
  const upper = code.toUpperCase();
  return `urn:i:${upper}:${upper}`;
}

/**
 * Recover the short code from a URN.
 *
 * Returns the URN unchanged when it does not match the expected shape: an
 * unrecognised value is reported as GMA sent it rather than mangled into something
 * that looks like a code but is not.
 */
export function urnToCode(urn: string): string {
  const match = /^urn:i:([A-Za-z0-9._-]+):/.exec(urn);
  return match?.[1] ?? urn;
}

/**
 * Resolve the caller's `instances` argument to the URNs GMA expects.
 *
 * - absent or omitted: the configured default set (FR-017 — the agent must not need
 *   to know the default)
 * - short codes: mapped to URNs
 * - URNs: passed through, since an agent may legitimately echo an id it was given
 *
 * @throws ToolError of kind `argument` naming `list_instances` for anything else, so
 *   the agent can self-correct without a human (SC-008)
 */
export function resolveInstances(
  requested: readonly string[] | undefined,
  config: Config
): readonly string[] {
  if (requested === undefined) {
    return config.defaultInstances.map(codeToUrn);
  }

  // An explicitly empty list is contradictory narrowing: silently substituting the
  // default set would run a wider query than the caller asked for, which the spec
  // calls out as a defect rather than a convenience.
  if (requested.length === 0) {
    throw argumentError(
      'The instances list was supplied but empty, so no brand instance would be queried.',
      'Omit instances entirely to use the configured default set, or name at least one code. Call list_instances for the valid codes.'
    );
  }

  const resolved: string[] = [];
  const rejected: string[] = [];

  for (const raw of requested) {
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (URN_PATTERN.test(value)) {
      resolved.push(value);
      continue;
    }
    if (CODE_PATTERN.test(value)) {
      resolved.push(codeToUrn(value));
      continue;
    }
    rejected.push(value);
  }

  if (rejected.length > 0) {
    // The rejected values are the agent's own arguments, not upstream content, so
    // naming them is what lets the agent fix its next call. They are never
    // credentials: a token would fail CODE_PATTERN and be reported as-is, so the
    // quoting below keeps them visibly distinct from prose.
    const named = rejected.map((value) => (value === '' ? '(empty)' : `"${value}"`)).join(', ');
    throw argumentError(
      `Unrecognised brand instance value(s): ${named}.`,
      'Call list_instances to obtain the valid instance codes, then retry with those.'
    );
  }

  return [...new Set(resolved)];
}

/** True when the value already looks like a GMA instance URN. */
export function isInstanceUrn(value: string): boolean {
  return URN_PATTERN.test(value);
}
