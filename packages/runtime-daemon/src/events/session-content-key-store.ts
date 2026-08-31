// Plan-006 T3.6 — the sole reader and minter of `session_content_keys`.
//
// The table holds ONE row per session: the AES-256 data-encryption key that
// seals every `content_payload` in that session, persisted only as an
// XChaCha20-Poly1305 envelope under the daemon master key.
//
// ----------------------------------------------------------------------------
// Why the key is STORED and not DERIVED
// ----------------------------------------------------------------------------
//
// A key derived from the daemon master key would be cheaper — no table, no
// mint, no rotation story. It is prohibited anyway, and the reason is a
// mechanism this repository already ships: `Spec-022 §Retention Policy`'
// rotate-on-shred generates a fresh master `M'`, re-wraps the stored key rows,
// and DESTROYS `M`. A derived key cannot be recovered once `M` is gone, so the
// first time any unrelated participant exercised erasure, every existing
// machine-authored body on this daemon would become permanently unreadable —
// destroying co-owned session work product the erasure request has no claim on,
// and doing it silently. A stored key is re-wrappable: rotation moves only its
// envelope and no ciphertext is rewritten.
//
// ----------------------------------------------------------------------------
// The wrap format, and what the AAD is actually for
// ----------------------------------------------------------------------------
//
// XChaCha20-Poly1305, 24-byte random nonce, wire `nonce || ciphertext || tag`,
// `AAD = session_id || "ais.session-content-wrap.v1" || key_version` — the
// `participant_keys.encrypted_key_blob` custody shape, domain-separated by its
// own info string so the two wrap domains can never be confused.
//
// Without that AAD the envelope authenticates on the master key ALONE. Two
// rows' blobs could then be swapped, or one replayed under a superseded
// `key_version`, and both would unwrap cleanly; the wrong key would simply fail
// to open that session's bodies, surfacing as an ordinary unreadable turn while
// the ciphertext-digest verifier stayed green, because the event ciphertext was
// never touched. That is a silent key substitution wearing the costume of
// routine transcript loss. Both negatives are pinned by tests.
//
// The concatenation is unambiguous under the `SessionId` grammar rather than by
// a length prefix, and the reasoning is worth writing down because plain
// concatenation usually is not: the middle segment is a fixed literal and
// `key_version` is a decimal suffix, so two distinct `(session, version)` pairs
// could collide only if one session id were a proper prefix of another followed
// by matching literal bytes — impossible for the fixed-width UUID form
// `SessionIdSchema` admits and for the reserved daemon-scope sentinel beside it.
//
// ----------------------------------------------------------------------------
// Two surfaces, one synchronous and one not — deliberately
// ----------------------------------------------------------------------------
//
// {@link SessionContentKeyStore.resolve} is ASYNC because obtaining the daemon
// master key can block on a human: `Spec-022 §Daemon Master Key` wipes the
// in-memory master on an idle timer and re-unwraps it via a keystore + PRF
// assertion or a passphrase prompt, so the first read after an idle wipe can
// await a WebAuthn ceremony. That is the same reason `DaemonSigningKeySealer`'s
// `unseal` is async.
//
// {@link SessionContentKeyStore.rewrapAll} is SYNCHRONOUS and takes both master
// keys as already-materialized bytes. This is not an oversight to be tidied
// later: rotate-on-shred re-wraps this table INSIDE the single `BEGIN
// EXCLUSIVE` that re-wraps `participant_keys`, a better-sqlite3 transaction
// cannot span an `await`, and a promise-returning re-wrap would therefore
// commit around nothing — leaving the crash window where participant keys are
// under `M'` while content keys are still under `M` and the destroyed master is
// the only thing that could read them. The caller resolves both keys first and
// hands them in.
//
// NO PLAINTEXT KEY CACHE. Every `resolve` unwraps afresh. A cache would save
// one 32-byte AEAD open per content-bearing append — the master key is already
// the caller's to cache — and would buy that with long-lived plaintext key
// material in a process map plus an invalidation problem at session purge, when
// a cached key would keep sealing bodies for a row that no longer exists.
//
// Refs: Plan-006 T3.6, invariant I-006-3-08, `Spec-022 §Daemon Master Key`,
// `docs/architecture/schemas/local-sqlite-schema.md §Session Content Keys (Plan-006)`.

import { randomBytes } from "node:crypto";

import type { SessionId } from "@ai-sidekicks/contracts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

/** Byte length of the AES-256 session content key this store mints. */
export const SESSION_CONTENT_KEY_BYTES = 32;

/** Byte length of the XChaCha20-Poly1305 nonce prefixing every wrapped blob. */
export const SESSION_CONTENT_WRAP_NONCE_BYTES = 24;

/** Byte length of the Poly1305 tag every wrapped blob ends with. */
const WRAP_TAG_BYTES = 16;

/**
 * The domain-separation string inside the wrap AAD. Distinct from the
 * participant wrap's `"ais.master-wrap.v1"` so a blob from one domain can never
 * authenticate in the other, even under the same master key.
 */
export const SESSION_CONTENT_WRAP_INFO = "ais.session-content-wrap.v1";

/**
 * The daemon master key, supplied by whoever owns its custody ladder.
 *
 * An INJECTED interface with no production implementation in this package —
 * the `DaemonSigningKeySealer` shape, for the same reason: the custody ladder
 * (`@napi-rs/keyring`, Keychain / Credential Manager / Secret Service) is
 * Plan-022's at Tier 5, and importing it here would pull a native binding into
 * the append path's consumers and invert the tier order. This module holds the
 * FORMAT and the table; the key's provenance stays behind this seam.
 *
 * Asynchronous because a read can block on a human — see the module header.
 */
export interface DaemonMasterKeySource {
  /**
   * Resolves the current daemon master key.
   *
   * MUST resolve to exactly {@link SESSION_CONTENT_KEY_BYTES} bytes. The store
   * refuses any other width rather than wrapping under it: an under-width key
   * silently truncated by the cipher would produce envelopes nothing could ever
   * reopen, and there is no later point at which that becomes detectable.
   *
   * MAY reject. A rejection is reported as
   * {@link SessionContentKeyUnavailableReason} `master_key_unavailable` rather
   * than propagated raw, so a read path can distinguish "the key is not
   * reachable right now" from "these bytes are not what was signed".
   */
  read(): Promise<Uint8Array>;
}

/**
 * Why a session content key could not be produced. Mapped onto the wire-facing
 * `HydratedContentUnavailableReason` by the read path; kept separate here
 * because the store is also on the WRITE path, where a failure is a refusal
 * rather than a projection.
 */
export type SessionContentKeyUnavailableReason =
  /** The master key could not be read, or is not the right width. */
  | "master_key_unavailable"
  /** No row for this session — nothing was ever sealed under it. */
  | "wrapped_key_missing"
  /** A row exists but its envelope did not open: wrong master, moved, replayed. */
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
 * A resolved session content key.
 *
 * `keyVersion` travels with the material because it is half of the AAD the
 * envelope was opened under; a caller that re-wraps must not have to re-read it.
 */
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
 * Builds the wrap AAD for one `(session, key version)` pair.
 *
 * Exported so the negative tests can construct the AAD a MOVED or REPLAYED blob
 * would need, rather than asserting a failure whose cause they cannot name.
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
  // Length is checked before the cipher sees the bytes: `subarray` on a short
  // blob yields empty views that the AEAD would reject with a message about
  // tags rather than about truncation, and the two failures deserve different
  // words in a log.
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
    // The AEAD refuses identically for a wrong master key, a blob moved to
    // another session's row, and a blob replayed under another `key_version` —
    // which is the point of binding both into the AAD. The cause is not
    // recoverable from here and is deliberately not guessed at.
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
 * The WRITE-PATH half of session-content-key custody — the narrow surface
 * `EventLogService` is annotated with.
 *
 * Declared separately from the class on the `DaemonSigningKeyProvisioner`
 * precedent: the append path needs exactly one operation, and handing it the
 * whole store would hand it {@link SessionContentKeyStore.rewrapAll} — a
 * rotation primitive that belongs to Plan-022's erasure orchestrator and to
 * nothing on the append path.
 */
export interface SessionContentKeySource {
  resolveForWrite(sessionId: SessionId): Promise<ResolvedSessionContentKey>;
}

/**
 * The READ half of the same seam, narrowed the same way and for the same reason
 * (Plan-006 T3.8).
 *
 * Split from {@link SessionContentKeySource} rather than merged with it because
 * the two operations differ in a way that matters: `resolveForWrite` MINTS on a
 * miss and `read` does not. A read path holding the write seam could create a
 * key for a session that sealed nothing — a row whose only effect is to turn a
 * later "this session has no body" into "this session has a key and no body",
 * which is the same answer with a durable side effect attached.
 */
export interface SessionContentKeyReader {
  read(sessionId: SessionId): Promise<ResolvedSessionContentKey>;
}

/**
 * The sole reader and minter of `session_content_keys`.
 *
 * Every statement is prepared in the constructor, so a handle that never ran
 * migration 13 fails LOUD at construction rather than at the first append
 * against a live database — the convention the compactor states.
 */
export class SessionContentKeyStore implements SessionContentKeySource, SessionContentKeyReader {
  readonly #masterKeySource: DaemonMasterKeySource;
  readonly #now: () => string;
  readonly #selectStmt: Statement;
  readonly #selectAllStmt: Statement;
  readonly #insertStmt: Statement;
  readonly #rewrapStmt: Statement;
  readonly #mintTransaction: (
    sessionId: string,
    blob: Uint8Array,
    createdAt: string,
  ) => WrappedKeyRow;

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

    // The mint is a double-checked insert under `.immediate()` — the same
    // primitive the migration runner uses, and for the same reason. Two
    // concurrent first appends for one session both find no row, both wrap a
    // candidate, and exactly one row must win; the loser must adopt the
    // winner's key rather than seal under a key no reader will ever find. The
    // `ON CONFLICT DO NOTHING` makes the losing INSERT a no-op and the
    // re-SELECT inside the same transaction returns the row that stands.
    this.#mintTransaction = database.transaction(
      (sessionId: string, blob: Uint8Array, createdAt: string): WrappedKeyRow => {
        this.#insertStmt.run(sessionId, blob, createdAt);
        return this.#selectStmt.get(sessionId) as WrappedKeyRow;
      },
    ).immediate as (sessionId: string, blob: Uint8Array, createdAt: string) => WrappedKeyRow;
  }

  /**
   * Reads a session's content key WITHOUT minting one.
   *
   * The read path's entry point: a session that never ran an agent has no row,
   * and that is an ordinary state rather than an error to be papered over by
   * creating a key nothing sealed anything under.
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
   * Reads a session's content key, minting and persisting one on first use.
   *
   * The write path's entry point. Called on a session's first content-bearing
   * append, which is why a session that never runs an agent stores no key.
   */
  async resolveForWrite(sessionId: SessionId): Promise<ResolvedSessionContentKey> {
    const existing = this.#selectStmt.get(sessionId) as WrappedKeyRow | undefined;
    if (existing !== undefined) {
      return this.#openRow(sessionId, existing);
    }

    // Wrapping needs the master key and therefore an `await`, which no
    // better-sqlite3 transaction may span — so the candidate is prepared out
    // here and the transaction below decides whether it is the row that stands.
    const masterKey = await this.#readMasterKey(sessionId);
    const candidate = new Uint8Array(randomBytes(SESSION_CONTENT_KEY_BYTES));
    const blob = wrapSessionContentKey(masterKey, sessionId, 1, candidate);
    const stored = this.#mintTransaction(sessionId, blob, this.#now());
    if (stored === undefined) {
      throw new SessionContentKeyUnavailableError(
        "wrapped_key_missing",
        sessionId,
        "the mint transaction left no row",
      );
    }
    return this.#openRow(sessionId, stored, masterKey);
  }

  /**
   * Re-wraps every stored key from `previousMasterKey` to `nextMasterKey`,
   * bumping each row's `key_version` and stamping `rotated_at`.
   *
   * SYNCHRONOUS AND TRANSACTION-LESS BY CONTRACT. The caller is rotate-on-shred,
   * and this runs INSIDE the `BEGIN EXCLUSIVE` that already re-wraps
   * `participant_keys` — opening a transaction here would nest inside that one,
   * and returning a promise would commit around nothing. Do not "fix" either.
   *
   * The inner AES-256 key is unchanged: only the envelope moves, so no
   * ciphertext is rewritten and no body is re-sealed. The version bump is what
   * forecloses rollback to a superseded wrap — the old envelope's AAD names the
   * old version and will not authenticate against the new one.
   *
   * THROWS on the first row it cannot open, which is the intended behaviour:
   * the caller's transaction rolls back, every row stays under the previous
   * master, and the all-or-nothing guarantee that rotation advertises holds
   * across both tables rather than only across one.
   *
   * @returns the number of rows re-wrapped.
   */
  rewrapAll(previousMasterKey: Uint8Array, nextMasterKey: Uint8Array): number {
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
