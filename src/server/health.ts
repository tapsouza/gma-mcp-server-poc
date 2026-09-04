/**
 * Health signal (FR-021).
 *
 * Answerable WITHOUT a caller identity, so automated monitoring can poll it without
 * holding a credential. It deliberately reports only that the process is up and
 * configured — it does NOT call GMA, because a health check that depends on an
 * upstream turns a GMA blip into a false "this server is down" and invites a
 * restart that fixes nothing.
 */

export interface HealthStatus {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  /** Seconds this process has been running. */
  readonly uptimeSeconds: number;
}

/**
 * The current health status.
 *
 * Carries no configuration VALUES — no base URL, no issuer — because a health
 * endpoint is typically the least protected surface a service exposes, and echoing
 * which upstream a deployment targets is needless disclosure.
 */
export function health(service: string, version: string): HealthStatus {
  return {
    status: 'ok',
    service,
    version,
    uptimeSeconds: Math.floor(process.uptime())
  };
}
