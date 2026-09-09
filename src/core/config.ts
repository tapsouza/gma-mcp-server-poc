import { z } from 'zod';
import { ToolError } from './types.js';

/**
 * Deployment configuration (constitution Principle V).
 *
 * Every value here is operational and comes from the environment ONLY. None may be
 * supplied by an agent, and none may be embedded in the built artefact (FR-018,
 * FR-024b). In particular the GMA base URL is NOT a tool argument: environment
 * selection is achieved by deploying one instance per GMA environment.
 *
 * Parsed and validated ONCE at startup. A missing or invalid required value makes
 * the process refuse to start rather than fail at first request (FR-019).
 */
export interface Config {
  /** Base URL of the GMA instance this deployment talks to. */
  readonly gmaBaseUrl: string;
  /** Brand instance codes used when a tool supplies no `instances` override. */
  readonly defaultInstances: readonly string[];
  /**
   * The accepted OKTA issuer. GMA's issuer is a PER-ENVIRONMENT custom
   * authorization server, so a token is valid against exactly one GMA
   * environment. This must never be hardcoded or widened.
   */
  readonly oktaIssuer: string;
  /** Per-GMA-request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Above this match count, a search reports `tooBroad` instead of candidates. */
  readonly maxCandidates: number;
  /**
   * Maximum bets a customer bet search returns. Reaching it is REPORTED in the
   * result (`limitReached`), never silently truncated (Principle V, FR-010).
   */
  readonly customerMaxBets: number;
  /**
   * Maximum distinct catalogue positions one composite call resolves. This is a
   * CORRECTNESS bound, not a performance target: reaching it names the unresolved
   * legs rather than dropping them (FR-023).
   */
  readonly customerMaxEventResolutions: number;
  readonly logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REQUIRED_VARS = ['GMA_BASE_URL', 'GMA_DEFAULT_INSTANCES', 'OKTA_ISSUER'] as const;

/** An absolute http(s) URL. Rejects a bare hostname or a relative path. */
const absoluteUrl = (varName: string) =>
  z.string().refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: `${varName} must be an absolute http(s) URL` }
  );

/** A positive integer read from a string env var. */
const positiveIntFromString = (varName: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? String(fallback) : value))
    .refine((value) => /^\d+$/.test(value) && Number(value) > 0, {
      message: `${varName} must be a positive integer`
    })
    .transform(Number);

const schema = z.object({
  GMA_BASE_URL: absoluteUrl('GMA_BASE_URL'),
  GMA_DEFAULT_INSTANCES: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((code) => code.trim())
        .filter((code) => code.length > 0)
    )
    .refine((codes) => codes.length > 0, {
      message: 'GMA_DEFAULT_INSTANCES must list at least one instance code'
    }),
  OKTA_ISSUER: absoluteUrl('OKTA_ISSUER'),
  GMA_TIMEOUT_MS: positiveIntFromString('GMA_TIMEOUT_MS', 30_000),
  GMA_MAX_CANDIDATES: positiveIntFromString('GMA_MAX_CANDIDATES', 25),
  // Both customer bounds are OPTIONAL WITH A DEFAULT, deliberately: the fail-fast
  // rule would otherwise break every existing deployment's startup the moment this
  // domain lands, which is a migration cost with no safety benefit.
  CUSTOMER_MAX_BETS: positiveIntFromString('CUSTOMER_MAX_BETS', 20),
  CUSTOMER_MAX_EVENT_RESOLUTIONS: positiveIntFromString('CUSTOMER_MAX_EVENT_RESOLUTIONS', 10),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .transform((value) => value ?? 'info')
});

/**
 * Read and validate configuration from the given environment.
 *
 * Called ONCE at startup. Throws a `config` `ToolError` naming the offending
 * variable — the operator is the only one who can fix it, so the process must not
 * start (FR-019, SC-007).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Reported before zod runs, so the message names the variable plainly rather
  // than describing a type mismatch against `undefined`.
  const missing = REQUIRED_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new ToolError(
      'config',
      `Missing required configuration: ${missing.join(', ')}. ` +
        `Set ${missing.length === 1 ? 'it' : 'them'} in the environment (see .env.example). ` +
        `The server refuses to start rather than serve requests against an unknown target.`,
      false
    );
  }

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => issue.message ?? `${String(issue.path[0] ?? 'configuration')} is invalid`)
      .join('; ');
    throw new ToolError('config', `Invalid configuration: ${detail}`, false);
  }

  const raw = parsed.data;
  return Object.freeze({
    gmaBaseUrl: raw.GMA_BASE_URL.replace(/\/+$/, ''),
    defaultInstances: Object.freeze(raw.GMA_DEFAULT_INSTANCES),
    oktaIssuer: raw.OKTA_ISSUER,
    requestTimeoutMs: raw.GMA_TIMEOUT_MS,
    maxCandidates: raw.GMA_MAX_CANDIDATES,
    customerMaxBets: raw.CUSTOMER_MAX_BETS,
    customerMaxEventResolutions: raw.CUSTOMER_MAX_EVENT_RESOLUTIONS,
    logLevel: raw.LOG_LEVEL
  });
}
