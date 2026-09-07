import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The credential cache: one file at `~/.gma-agent/token.json`, mode `0600`
 * (data-model.md §3).
 *
 * It lives OUTSIDE the repository, which is what makes FR-020's "impossible to
 * commit" hold structurally rather than by `.gitignore` discipline — a rule enforced
 * by where the file is, not by anyone remembering.
 *
 * Note this is the one act the plan records as a deliberate deviation from
 * constitution Principle I (see plan.md Complexity Tracking). Principle I binds the
 * SERVER, which must never cache a token; the harness is the client, standing in for
 * the human, and a client with no cache cannot hold the refresh token FR-023's
 * mid-session recovery requires.
 */

export interface StoredCredential {
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
  /** Epoch ms. Compared against an INJECTED clock, so the suite needs no waiting. */
  readonly expires_at: number;
  /** Checked against configuration on every read (FR-019). */
  readonly issuer: string;
  readonly client_id: string;
}

/** The read/write seam, injected so the suite touches no real home directory. */
export interface CredentialStore {
  read(): StoredCredential | undefined;
  write(credential: StoredCredential): void;
  clear(): void;
  /** Where the file is, for a message that tells the engineer what to delete. */
  readonly path: string;
}

export const STORE_DIR_NAME = '.gma-agent';
export const STORE_FILE_NAME = 'token.json';
/** Owner read/write only. Asserted by test, not assumed. */
export const STORE_FILE_MODE = 0o600;

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.access_token === 'string' &&
    record.access_token.length > 0 &&
    typeof record.expires_at === 'number' &&
    Number.isFinite(record.expires_at) &&
    typeof record.issuer === 'string' &&
    typeof record.client_id === 'string' &&
    (record.refresh_token === undefined || typeof record.refresh_token === 'string')
  );
}

/**
 * A store backed by a real file.
 *
 * @param baseDir the directory holding `.gma-agent/`. Defaults to the user's home;
 *   injectable so the suite writes into a temporary directory instead.
 */
export function createFileCredentialStore(baseDir: string = homedir()): CredentialStore {
  const dir = join(baseDir, STORE_DIR_NAME);
  const path = join(dir, STORE_FILE_NAME);

  return {
    path,

    read(): StoredCredential | undefined {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        // Absent is the normal case on a first run, not a failure.
        return undefined;
      }

      try {
        const parsed: unknown = JSON.parse(raw);
        // A file that does not parse, or parses to the wrong shape, is treated as
        // ABSENT rather than fatal (data-model.md §3): the ladder should fall through
        // to device login, not refuse to start because of a corrupt cache.
        return isStoredCredential(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },

    write(credential: StoredCredential): void {
      mkdirSync(dir, { recursive: true, mode: 0o700 });

      // Written atomically — temp file, chmod, then rename — so two concurrent
      // harness sessions cannot leave a half-written file behind (Edge Cases). The
      // mode is set on the temp file BEFORE the rename, so the credential is never
      // world-readable even momentarily.
      const temp = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(credential, null, 2)}\n`, {
          mode: STORE_FILE_MODE
        });
        chmodSync(temp, STORE_FILE_MODE);
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file may never have been created. Nothing to clean up.
        }
        throw error;
      }
    },

    clear(): void {
      try {
        unlinkSync(path);
      } catch {
        // Already absent. Clearing is idempotent.
      }
    }
  };
}
