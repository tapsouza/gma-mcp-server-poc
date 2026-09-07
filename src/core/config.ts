import { z } from 'zod';
import type { Generation } from './surface.js';
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
   * Which GMA catalogue generation every operation consults unless a capability has
   * declared a per-operation requirement for the other one (003-FR-013).
   *
   * Read ONCE at startup by the generation resolver, and by nothing else. It is
   * operational and never an agent argument: no tool schema mentions a generation, so
   * the model has no way to select one and no reason to (003-FR-012).
   */
  readonly defaultGeneration: Generation;
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
  /**
   * Deliberately OPTIONAL rather than in `REQUIRED_VARS`: unset must mean `v4`
   * (003-FR-013), and the default is the SAFE value — which is precisely the case where
   * fail-fast should not apply. Adding it to the required set would break every existing
   * deployment for no safety gain.
   *
   * An *invalid* value still refuses startup (003-FR-014). Absent and wrong are
   * different, and only one of them is an operator error.
   *
   * The `.trim()` before the enum is what makes a whitespace-only value read as unset
   * rather than as an unrecognised generation — an env var set to a stray space is an
   * empty setting, not a typo'd one.
   */
  GMA_CATALOGUE_GENERATION: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 'v4' : value.trim()))
    .pipe(
      z.enum(['v4', 'v5'], {
        message: 'GMA_CATALOGUE_GENERATION must be one of: v4, v5'
      })
    ),
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
    defaultGeneration: raw.GMA_CATALOGUE_GENERATION,
    logLevel: raw.LOG_LEVEL
  });
}
