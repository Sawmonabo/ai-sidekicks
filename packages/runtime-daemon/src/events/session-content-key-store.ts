// The sole reader and minter of `session_content_keys`: one row per session holding the AES-256
// key that seals that session's `content_payload`s, stored only as an XChaCha20-Poly1305 envelope
// under the daemon master key. It is stored, not derived, so rotate-on-shred re-wraps it without
// re-sealing any body.
// - Wrap: 24-byte random nonce, wire `nonce || ciphertext || tag`, AAD = `session_id || info ||
//   key_version`, so a blob swapped between rows or replayed under an old version cannot open.
// - `rewrapAll` is synchronous: it runs inside rotate-on-shred's `BEGIN EXCLUSIVE`, which cannot
//   span an `await`. `read` and `resolveForWrite` are async; the master key can block on a person.
// - A first mint must not lose a race with rotation; `#rotationEpoch` is the fence. It is per
//   instance and does not cover a second process on the same file; the daemon is one per machine.
// - No plaintext key cache: a stale key would keep sealing after its row is purged.

import { randomBytes } from "node:crypto";

import type { SessionId } from "@ai-sidekicks/contracts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

import { withSessionAppendLock } from "./session-append-lock.js";

/** Byte length of the AES-256 session content key this store mints. */
export const SESSION_CONTENT_KEY_BYTES = 32;

/** Byte length of the XChaCha20-Poly1305 nonce prefixing every wrapped blob. */
export const SESSION_CONTENT_WRAP_NONCE_BYTES = 24;

/** Byte length of the Poly1305 tag every wrapped blob ends with. */
const WRAP_TAG_BYTES = 16;

/**
 * Passes a first mint may make (the first attempt plus two retries after losing a race with
 * rotation). Bounded so a source that rotates on every read fails the append instead of spinning.
 */
const MINT_ROTATION_PASS_LIMIT = 3;

/**
 * The domain-separation string in the wrap AAD, distinct from the user wrap's
 * `"ais.master-wrap.v1"` so a blob from one domain never authenticates in the other.
 */
const SESSION_CONTENT_WRAP_INFO = "ais.session-content-wrap.v1";

/**
 * The daemon master key, supplied by whoever owns its custody ladder. Injected because the ladder
 * (OS keychain through `@napi-rs/keyring`) lives elsewhere and would pull a native binding here.
 */
export interface DaemonMasterKeySource {
  /**
   * Resolves the current master key, which must be exactly {@link SESSION_CONTENT_KEY_BYTES} bytes.
   * A rejection is reported as `master_key_unavailable` rather than propagated raw.
   */
  read(): Promise<Uint8Array>;
}

/**
 * Why a session content key could not be produced. The read path maps it onto the wire-facing
 * `HydratedContentUnavailableReason`; the write path treats a failure as a refusal.
 */
export type SessionContentKeyUnavailableReason =
  /** The master key could not be read, is the wrong width, or kept being superseded by rotation. */
  | "master_key_unavailable"
  /** No row for this session: nothing was ever sealed under it. */
  | "wrapped_key_missing"
  /** A row exists but its envelope did not open: wrong master, moved, or replayed. */
  | "wrapped_key_unopenable";

/** Raised when a session content key cannot be resolved. */
export class SessionContentKeyUnavailableError extends Error {
  readonly reason: SessionContentKeyUnavailableReason;
  readonly sessionId: string;

  constructor(reason: SessionContentKeyUnavailableReason, sessionId: string, detail: string) {
    super(`session content key for session ${sessionId} is unavailable (${reason}): ${detail}`);
    this.name = "SessionContentKeyUnavailableError";
    this.reason = reason;
    this.sessionId = sessionId;
  }
}

/**
 * Thrown inside the mint transaction when the master rotated mid-mint, so the row rolls back (a
 * returned sentinel would commit it). Never seen by a caller: `resolveForWrite` catches exactly
 * this class and retries.
 */
class MasterKeyRotatedDuringMintError extends Error {
  constructor(sessionId: string) {
    super(
      `the daemon master key was rotated while minting the session content key for session ${sessionId}`,
    );
    this.name = "MasterKeyRotatedDuringMintError";
  }
}

/** A resolved session content key; `keyVersion` is half of the AAD the envelope opened under. */
export interface ResolvedSessionContentKey {
  readonly sessionId: SessionId;
  readonly key: Uint8Array;
  readonly keyVersion: number;
}

interface WrappedKeyRow {
  readonly encrypted_key_blob: unknown;
  readonly key_version: unknown;
}

/** Constructor dependencies for {@link SessionContentKeyStore}. */
export interface SessionContentKeyStoreDeps {
  readonly database: DatabaseType;
  readonly masterKeySource: DaemonMasterKeySource;
  /** RFC 3339 UTC timestamp source; defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * Builds the wrap AAD for one `(session, key version)` pair; exported for tests. The concatenation
 * is unambiguous: fixed literal in the middle, decimal suffix, fixed-width UUID session ids.
 */
export function buildSessionContentWrapAad(sessionId: string, keyVersion: number): Uint8Array {
  return new TextEncoder().encode(`${sessionId}${SESSION_CONTENT_WRAP_INFO}${String(keyVersion)}`);
}

function assertMasterKeyWidth(masterKey: Uint8Array, sessionId: string): void {
  if (masterKey.length !== SESSION_CONTENT_KEY_BYTES) {
    throw new SessionContentKeyUnavailableError(
      "master_key_unavailable",
      sessionId,
      `master key is ${String(masterKey.length)} bytes, expected ${String(SESSION_CONTENT_KEY_BYTES)}`,
    );
  }
}

function wrapSessionContentKey(
  masterKey: Uint8Array,
  sessionId: string,
  keyVersion: number,
  contentKey: Uint8Array,
): Uint8Array {
  const nonce = new Uint8Array(randomBytes(SESSION_CONTENT_WRAP_NONCE_BYTES));
  const sealed = xchacha20poly1305(
    masterKey,
    nonce,
    buildSessionContentWrapAad(sessionId, keyVersion),
  ).encrypt(contentKey);
  const blob = new Uint8Array(nonce.length + sealed.length);
  blob.set(nonce, 0);
  blob.set(sealed, nonce.length);
  return blob;
}

function unwrapSessionContentKey(
  masterKey: Uint8Array,
  sessionId: string,
  keyVersion: number,
  blob: Uint8Array,
): Uint8Array {
  // Checked first: a short blob would otherwise fail with a message about tags, not truncation.
  const minimum = SESSION_CONTENT_WRAP_NONCE_BYTES + WRAP_TAG_BYTES;
  if (blob.length <= minimum) {
    throw new SessionContentKeyUnavailableError(
      "wrapped_key_unopenable",
      sessionId,
      `wrapped blob is ${String(blob.length)} bytes, under the ${String(minimum)}-byte nonce+tag floor`,
    );
  }
  const nonce = blob.subarray(0, SESSION_CONTENT_WRAP_NONCE_BYTES);
  const sealed = blob.subarray(SESSION_CONTENT_WRAP_NONCE_BYTES);
  let opened: Uint8Array;
  try {
    opened = xchacha20poly1305(
      masterKey,
      nonce,
      buildSessionContentWrapAad(sessionId, keyVersion),
    ).decrypt(sealed);
  } catch (error) {
    // The AEAD refuses identically for a wrong master, a moved blob and a replayed `key_version`.
    throw new SessionContentKeyUnavailableError(
      "wrapped_key_unopenable",
      sessionId,
      error instanceof Error ? error.message : "AEAD refused the envelope",
    );
  }
  if (opened.length !== SESSION_CONTENT_KEY_BYTES) {
    throw new SessionContentKeyUnavailableError(
      "wrapped_key_unopenable",
      sessionId,
      `unwrapped key is ${String(opened.length)} bytes, expected ${String(SESSION_CONTENT_KEY_BYTES)}`,
    );
  }
  return opened;
}

function readBlob(value: unknown, sessionId: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new SessionContentKeyUnavailableError(
    "wrapped_key_unopenable",
    sessionId,
    `encrypted_key_blob is ${typeof value}, expected a BLOB`,
  );
}

function readKeyVersion(value: unknown, sessionId: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new SessionContentKeyUnavailableError(
    "wrapped_key_unopenable",
    sessionId,
    `key_version is ${String(value)}, expected a positive integer`,
  );
}

/**
 * The write-path view, the surface `EventLogService` is typed against; it hides `rewrapAll`, which
 * belongs to the erasure orchestrator.
 */
export interface SessionContentKeySource {
  resolveForWrite(sessionId: SessionId): Promise<ResolvedSessionContentKey>;
}

/**
 * The read-path view. Separate because `resolveForWrite` mints on a miss and `read` does not, so a
 * reader cannot create a key row for a session that sealed nothing.
 */
export interface SessionContentKeyReader {
  read(sessionId: SessionId): Promise<ResolvedSessionContentKey>;
}

/**
 * The lifecycle view for the session purge and the compactor's sweep: a clearing path may only
 * retire wrapped keys, not mint them or read the plaintext key of bodies it destroys.
 */
export interface SessionContentKeyDisposer {
  deleteIfUnreferenced(sessionId: SessionId): Promise<boolean>;
  /**
   * Retires every wrapped key that no retained ciphertext depends on. The per-session call is the
   * prompt path; this durable pass makes a failed prompt disposal a delay, not a permanent leak.
   */
  sweepUnreferenced(): Promise<SessionContentKeySweepResult>;
}

/**
 * What one {@link SessionContentKeyDisposer.sweepUnreferenced} pass did. `skipped` sits beside
 * `reclaimed` because a fault that fails one disposal usually fails all, which would look idle.
 */
export interface SessionContentKeySweepResult {
  /** Wrapped DEKs actually removed. */
  readonly reclaimed: number;
  /**
   * Candidates passed over because disposal threw or the id was unusable. Nonzero once is normal
   * (`SQLITE_BUSY`); nonzero across passes means the sweep is not sweeping.
   */
  readonly skipped: number;
}

/**
 * The sole reader and minter of `session_content_keys`. Every statement is prepared in the
 * constructor, so a handle without the table fails there rather than at the first append.
 */
export class SessionContentKeyStore
  implements SessionContentKeySource, SessionContentKeyReader, SessionContentKeyDisposer
{
  readonly #masterKeySource: DaemonMasterKeySource;
  readonly #now: () => string;
  readonly #selectStmt: Statement;
  readonly #selectAllStmt: Statement;
  readonly #selectUnreferencedStmt: Statement;
  readonly #insertStmt: Statement;
  readonly #rewrapStmt: Statement;
  readonly #deleteIfUnreferencedTransaction: (sessionId: string) => boolean;
  readonly #mintTransaction: (
    sessionId: string,
    blob: Uint8Array,
    createdAt: string,
    epochAtMasterKeyRead: number,
  ) => WrappedKeyRow;

  // The rotation fence: `rewrapAll` bumps it, `resolveForWrite` samples it before reading the
  // master key, and the mint transaction re-checks it synchronously with the INSERT; a mismatch
  // retries. A counter, not a flag, which would read false again by the time of the check.
  #rotationEpoch = 0;

  constructor(deps: SessionContentKeyStoreDeps) {
    this.#masterKeySource = deps.masterKeySource;
    this.#now = deps.now ?? (() => new Date().toISOString());

    const database = deps.database;
    this.#selectStmt = database.prepare(
      `SELECT encrypted_key_blob AS encrypted_key_blob, key_version AS key_version
         FROM session_content_keys
        WHERE session_id = ?`,
    );
    this.#selectAllStmt = database.prepare(
      `SELECT session_id AS session_id,
              encrypted_key_blob AS encrypted_key_blob,
              key_version AS key_version
         FROM session_content_keys
        ORDER BY session_id`,
    );
    // Candidate list only: it runs outside every lock, so the delete re-checks under the append
    // hold. An anti-join, since the wanted rows are rare.
    this.#selectUnreferencedStmt = database.prepare(
      `SELECT k.session_id AS session_id
         FROM session_content_keys k
        WHERE NOT EXISTS (
                SELECT 1
                  FROM session_events e
                 WHERE e.session_id = k.session_id
                   AND e.content_payload IS NOT NULL)
        ORDER BY k.session_id`,
    );
    this.#insertStmt = database.prepare(
      `INSERT INTO session_content_keys (session_id, encrypted_key_blob, key_version, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    );
    this.#rewrapStmt = database.prepare(
      `UPDATE session_content_keys
          SET encrypted_key_blob = ?, key_version = ?, rotated_at = ?
        WHERE session_id = ? AND key_version = ?`,
    );

    // A purged row (column cleared) or one received from a peer (never sealed here) is not live.
    const liveContentStmt = database.prepare(
      `SELECT 1 AS live
         FROM session_events
        WHERE session_id = ? AND content_payload IS NOT NULL
        LIMIT 1`,
    );
    const deleteStmt = database.prepare(`DELETE FROM session_content_keys WHERE session_id = ?`);

    // One `.immediate()` transaction: as two statements another connection could install a sealed
    // row between check and delete. The append lock in `deleteIfUnreferenced` is the other half.
    this.#deleteIfUnreferencedTransaction = database.transaction((sessionId: string): boolean => {
      if (liveContentStmt.get(sessionId) !== undefined) {
        return false;
      }
      return deleteStmt.run(sessionId).changes > 0;
    }).immediate as (sessionId: string) => boolean;

    // Double-checked insert under `.immediate()`: two concurrent first appends both wrap a
    // candidate, and the loser adopts the standing row (`ON CONFLICT DO NOTHING`, then re-SELECT).
    // The fence is re-checked synchronously before the INSERT so a doomed blob never reaches it.
    this.#mintTransaction = database.transaction(
      (
        sessionId: string,
        blob: Uint8Array,
        createdAt: string,
        epochAtMasterKeyRead: number,
      ): WrappedKeyRow => {
        if (this.#rotationEpoch !== epochAtMasterKeyRead) {
          throw new MasterKeyRotatedDuringMintError(sessionId);
        }
        this.#insertStmt.run(sessionId, blob, createdAt);
        return this.#selectStmt.get(sessionId) as WrappedKeyRow;
      },
    ).immediate as (
      sessionId: string,
      blob: Uint8Array,
      createdAt: string,
      epochAtMasterKeyRead: number,
    ) => WrappedKeyRow;
  }

  /**
   * Reads a session's content key without minting one; throws `wrapped_key_missing` for a session
   * that never ran an agent.
   */
  async read(sessionId: SessionId): Promise<ResolvedSessionContentKey> {
    const row = this.#selectStmt.get(sessionId) as WrappedKeyRow | undefined;
    if (row === undefined) {
      throw new SessionContentKeyUnavailableError(
        "wrapped_key_missing",
        sessionId,
        "no session_content_keys row",
      );
    }
    return this.#openRow(sessionId, row);
  }

  /**
   * Reads a session's content key, minting one on the first content-bearing append. The loop is
   * the rotation fence, not an IO retry, and repeats the existing-row check because a competing
   * mint may have won; throws `master_key_unavailable` after every pass lost to a rotation.
   */
  async resolveForWrite(sessionId: SessionId): Promise<ResolvedSessionContentKey> {
    for (let passNumber = 1; passNumber <= MINT_ROTATION_PASS_LIMIT; passNumber += 1) {
      const existing = this.#selectStmt.get(sessionId) as WrappedKeyRow | undefined;
      if (existing !== undefined) {
        return this.#openRow(sessionId, existing);
      }

      // Sampled before the master key read, which may resolve with pre-rotation bytes; the `await`
      // is the only point at which `rewrapAll` can interleave.
      const epochAtMasterKeyRead = this.#rotationEpoch;

      // The candidate is built outside the transaction, which cannot span an `await`.
      const masterKey = await this.#readMasterKey(sessionId);
      const candidate = new Uint8Array(randomBytes(SESSION_CONTENT_KEY_BYTES));
      const blob = wrapSessionContentKey(masterKey, sessionId, 1, candidate);
      let stored: WrappedKeyRow;
      try {
        stored = this.#mintTransaction(sessionId, blob, this.#now(), epochAtMasterKeyRead);
      } catch (error) {
        if (error instanceof MasterKeyRotatedDuringMintError) {
          continue;
        }
        throw error;
      }
      if (stored === undefined) {
        throw new SessionContentKeyUnavailableError(
          "wrapped_key_missing",
          sessionId,
          "the mint transaction left no row",
        );
      }
      return this.#openRow(sessionId, stored, masterKey);
    }

    // Not a new reason: the read path would need an arm for it, and `read` never mints.
    throw new SessionContentKeyUnavailableError(
      "master_key_unavailable",
      sessionId,
      `the daemon master key was rotated during each of ${String(MINT_ROTATION_PASS_LIMIT)} mint passes for this session's content key; refusing rather than wrapping under a superseded master`,
    );
  }

  /**
   * Re-wraps every stored key from `previousMasterKey` to `nextMasterKey`, bumping `key_version`
   * and `rotated_at`; only the envelope moves. Throws on the first unopenable row so the caller's
   * `BEGIN EXCLUSIVE` rolls back and every row stays under the previous master.
   */
  rewrapAll(previousMasterKey: Uint8Array, nextMasterKey: Uint8Array): number {
    // Bumped first, even for an empty table or a rotation that then throws: a spurious mint retry
    // costs less than a missed one.
    this.#rotationEpoch += 1;
    if (
      previousMasterKey.length !== SESSION_CONTENT_KEY_BYTES ||
      nextMasterKey.length !== SESSION_CONTENT_KEY_BYTES
    ) {
      throw new SessionContentKeyUnavailableError(
        "master_key_unavailable",
        "*",
        `rotation needs two ${String(SESSION_CONTENT_KEY_BYTES)}-byte master keys, got ` +
          `${String(previousMasterKey.length)} and ${String(nextMasterKey.length)}`,
      );
    }
    const rotatedAt = this.#now();
    const rows = this.#selectAllStmt.all() as ReadonlyArray<
      WrappedKeyRow & { readonly session_id: unknown }
    >;
    let rewrapped = 0;
    for (const row of rows) {
      const sessionId =
        typeof row.session_id === "string" ? row.session_id : String(row.session_id);
      const keyVersion = readKeyVersion(row.key_version, sessionId);
      const contentKey = unwrapSessionContentKey(
        previousMasterKey,
        sessionId,
        keyVersion,
        readBlob(row.encrypted_key_blob, sessionId),
      );
      const nextVersion = keyVersion + 1;
      const result = this.#rewrapStmt.run(
        wrapSessionContentKey(nextMasterKey, sessionId, nextVersion, contentKey),
        nextVersion,
        rotatedAt,
        sessionId,
        keyVersion,
      );
      if (result.changes !== 1) {
        throw new SessionContentKeyUnavailableError(
          "wrapped_key_unopenable",
          sessionId,
          `re-wrap updated ${String(result.changes)} rows, expected exactly 1`,
        );
      }
      rewrapped += 1;
    }
    return rewrapped;
  }

  /**
   * Deletes the session's wrapped key if no retained ciphertext depends on it, so `rewrapAll`
   * never re-wraps dead sessions; returns whether a row was removed. Every path that clears
   * `content_payload` must call this afterward; it is idempotent.
   */
  async deleteIfUnreferenced(sessionId: SessionId): Promise<boolean> {
    // The append lock covers the gap between an append's mint and its insert (process-local and
    // reentrant). Across processes a concurrently removed key reads back as `wrapped_key_missing`,
    // never as wrong plaintext.
    return withSessionAppendLock(sessionId, async () =>
      this.#deleteIfUnreferencedTransaction(sessionId),
    );
  }

  /**
   * Retires every unreferenced wrapped key; see {@link SessionContentKeyDisposer}. The candidate
   * read is unlocked, so each decision is re-run per session in {@link deleteIfUnreferenced} (one
   * hold per session, never per pass); a session whose disposal throws is skipped and counted.
   */
  async sweepUnreferenced(): Promise<SessionContentKeySweepResult> {
    const candidates = this.#selectUnreferencedStmt.all() as ReadonlyArray<{
      readonly session_id: unknown;
    }>;
    let reclaimed = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      // SQLite does not enforce column types; a non-string id could not key the session lock.
      if (typeof candidate.session_id !== "string" || candidate.session_id.length === 0) {
        skipped += 1;
        continue;
      }
      const sessionId = candidate.session_id as SessionId;
      try {
        if (await this.deleteIfUnreferenced(sessionId)) {
          reclaimed += 1;
        }
      } catch {
        // Passed over and counted; the next pass re-derives this candidate.
        skipped += 1;
      }
    }
    return { reclaimed, skipped };
  }

  async #readMasterKey(sessionId: string): Promise<Uint8Array> {
    let masterKey: Uint8Array;
    try {
      masterKey = await this.#masterKeySource.read();
    } catch (error) {
      throw new SessionContentKeyUnavailableError(
        "master_key_unavailable",
        sessionId,
        error instanceof Error ? error.message : "master key source rejected",
      );
    }
    assertMasterKeyWidth(masterKey, sessionId);
    return masterKey;
  }

  async #openRow(
    sessionId: SessionId,
    row: WrappedKeyRow,
    materializedMasterKey?: Uint8Array,
  ): Promise<ResolvedSessionContentKey> {
    const keyVersion = readKeyVersion(row.key_version, sessionId);
    const blob = readBlob(row.encrypted_key_blob, sessionId);
    const masterKey = materializedMasterKey ?? (await this.#readMasterKey(sessionId));
    return {
      sessionId,
      key: unwrapSessionContentKey(masterKey, sessionId, keyVersion, blob),
      keyVersion,
    };
  }
}
