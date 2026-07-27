// Per-session daemon signing-key custody — the one module that holds
// daemon-private key material, and the one site where key bytes enter the type
// system (Plan-006 T2.7).
//
// Every `session_events` row carries a `daemon_signature` minted by
// `signer.ts`'s `signRow`, which takes its key as a PARAMETER and constructs,
// loads, unseals, and persists nothing ("KEY CUSTODY IS NOT HERE", that
// module's header). This is where custody lives: generate the per-session
// Ed25519 keypair, hand the sealed private half to `daemon_signing_keys`, and
// resolve it back for the signer. `signer.ts` knows the key TYPE; this module
// knows the key SOURCE, and nothing else does either.
//
// ----------------------------------------------------------------------------
// The public/private split, and exactly how much of it the types enforce
// ----------------------------------------------------------------------------
//
// Plan-002's session-create call site registers the daemon's PUBLIC key in the
// session participant roster (CP-006-7) — the key a verifier later resolves by
// `NodeId` per `Spec-006 §Canonical Serialization Rules`. It has no business
// holding the private half, and the Plan-006 T2.7 row says so: daemon-private
// signing material never crosses the Plan-006/Plan-002 boundary.
//
// STRUCTURALLY ENFORCED. {@link DaemonSigningKeyProvisioner} declares `create`
// and NOTHING else, and `create` resolves to `{ publicKey }` only. Code holding
// a value of that type cannot reach the private half at all: `read` is not on
// it, so calling it is a compile error (TS2339), and no overload, cast helper,
// or escape hatch is exported to get back to the wider type.
//
// A CALLER OBLIGATION, AND NAMED HERE BECAUSE IT IS NOT ENFORCED. TypeScript is
// structurally typed, so the ONE
// {@link OsKeystoreSealedDaemonSigningKeySource} instance the composition root
// builds satisfies both interfaces at once. Nothing forces the Plan-002 call
// site to ANNOTATE what it receives as the narrow type — handed the instance
// under the wide {@link DaemonSigningKeySource} annotation, or under an
// inferred type, it can call `read`. The obligation therefore lands on the
// composition root that wires Plan-002's session-create path: declare that
// parameter `DaemonSigningKeyProvisioner`. What the split buys is that
// upholding it is one annotation rather than a review convention, and that
// breaking it is visible in a signature rather than buried in a call.
//
// ----------------------------------------------------------------------------
// Where key material enters the type system
// ----------------------------------------------------------------------------
//
// `signer.ts` exports NO brand constructor for `Ed25519PrivateKey` /
// `Ed25519PublicKey`, deliberately — an exported `toEd25519PrivateKey(bytes)`
// would let any module mint a signing key from arbitrary bytes. Its header
// names this file as the single greppable site where the narrowing happens
// instead. That is {@link toEd25519PublicKey} and {@link toEd25519PrivateKey}
// below: TWO casts, one per brand, and no third anywhere in the workspace.
//
// Both VALIDATE the 32-byte width before narrowing, and that is not
// belt-and-braces. `signer.ts`'s `verifyEd25519` names "T2.7's unvalidated
// `as Ed25519PublicKey` cast" as one of the ways a wrong-shaped public key
// reaches it, and its guard THROWS on that rather than returning
// `signature_mismatch`, precisely because a mis-plumbed key is a
// key-resolution bug and reporting it as a tamper would raise
// `audit_integrity_failed` on every row it touches. Validating here refuses the
// bad key at the boundary that produced it, where the diagnostic still names
// the cause.
//
// ----------------------------------------------------------------------------
// What is NOT here: the seal itself
// ----------------------------------------------------------------------------
//
// This module performs no cryptography beyond Ed25519 key generation and the
// public-key derivation `read` checks an unsealed seed against. The seal
// and unseal of the private half are an INJECTED boundary
// ({@link DaemonSigningKeySealer}), for a reason that is a corpus fact rather
// than a preference: no byte format for `daemon_signing_keys.sealed_private_key`
// is specified anywhere. `Spec-022 §Daemon Master Key` specifies the MASTER
// key's own custody (the OS-keystore tier-1 ladder, the KEK derivation, the
// 98-byte envelope) and Plan-022 specifies the wrap for
// `participant_keys.encrypted_key_blob` (XChaCha20-Poly1305, AAD
// `participant_id || "ais.master-wrap.v1" || key_version`) — neither covers
// this column. Inventing a third format here would pre-commit every later
// reader of the column, including whatever re-wrap a master-key rotation
// needs, on a guess. So the OPERATION is declared and the FORMAT ships with the
// implementor, the same seam Plan-006 already uses twice: T2.4's `PiiEncryptor`
// (interface here, implementation owned by Plan-022 per CP-006-1) and T3.2's
// injected `RollbackAttributionSource`.
//
// That keeps the module self-contained against Plan-022 at Tier 5 with no tier
// inversion — the property the `daemon_signing_keys` row in
// `docs/architecture/cross-plan-dependencies.md §1. Table Ownership Map`
// requires — and it keeps `@napi-rs/keyring` OUT of this module's import graph.
// That second effect is load-bearing on its own: the keyring binding is a
// native module, so importing it here would pull a native dependency into
// every consumer of the append path, on CI legs where a headless Linux box has
// no Secret Service and `Spec-023 §Native Keystore` requires the keystore layer
// to detect the no-keystore case and refuse rather than silently fall back.
//
// In-package surface for now: `src/index.ts` does not re-export this module,
// matching T2.1 and T2.2.
//
// Refs: `Spec-022 §Daemon Master Key`, `ADR-004 §Decision`,
// `Spec-006 §Canonical Serialization Rules`,
// `docs/architecture/security-architecture.md §Per-Event Daemon Signature`,
// `docs/architecture/schemas/local-sqlite-schema.md §Audit Log Crypto Tables (Plan-006)`.
import type { SessionId } from "@ai-sidekicks/contracts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { equalBytes } from "@noble/curves/utils.js";
import type { Database, Statement } from "better-sqlite3";

import type { Ed25519PrivateKey, Ed25519PublicKey } from "./signer.js";

/**
 * The RFC 8032 §5.1.5 width of BOTH Ed25519 halves — the public key, and the
 * secret SEED that `signer.ts` types as `Ed25519PrivateKey`. One constant
 * rather than two because one number is being spelled: the schema comment on
 * `daemon_signing_keys.public_key` says "Ed25519 32-byte public key", and
 * `signer.ts` pins the same 32 for its own read-side guard.
 */
const ED25519_KEY_LENGTH = 32;

// --------------------------------------------------------------------------
// The injected seal boundary.
// --------------------------------------------------------------------------

/**
 * Seals and unseals a daemon signing key's private half under the OS-keystore-
 * managed daemon master key, whose custody ladder is `Spec-022 §Daemon Master
 * Key`.
 *
 * DECLARED HERE, IMPLEMENTED ELSEWHERE — see the header's "What is NOT here"
 * note for why the byte format is not this module's to fix. The contract this
 * interface DOES fix is the round trip:
 * `unseal(sessionId, await seal(sessionId, key))` resolves to bytes equal to
 * `key`. Everything else — the AEAD, the nonce placement, the envelope layout,
 * the version byte — is the implementor's, and the stored blob is opaque to
 * every caller here.
 *
 * `sessionId` IS PASSED ON BOTH SIDES, AND WHAT THAT DOES AND DOES NOT MEAN.
 * It is passed so an implementation CAN bind it as AEAD associated data, which
 * is the shape Plan-022's participant wrap already uses (its AAD leads with
 * `participant_id`); with the binding, a `sealed_private_key` blob copied from
 * one row to another fails to unseal instead of silently authenticating the
 * wrong session's rows. This interface does NOT claim the binding happens —
 * it cannot, having fixed no format — so an implementation that ignores the
 * argument satisfies these types.
 *
 * WHAT SUCH AN IMPLEMENTATION NO LONGER DOES IS DEFEAT THAT PROPERTY SILENTLY.
 * {@link DaemonSigningKeySource.read} derives the public half of whatever
 * `unseal` hands back and refuses it unless it matches that row's own
 * `daemon_signing_keys.public_key`, so a copied blob surfaces as a refusal
 * naming the row rather than as rows signed under another session's key. The
 * AAD binding is still the better failure and still worth asking for: an AEAD
 * that will not open at all never produces the key material in the first place,
 * where the check downstream produces it and then refuses. Naming the parameter
 * is what makes that obligation reviewable at the implementation site.
 *
 * ASYNCHRONOUS BECAUSE UNSEALING CAN BLOCK ON A HUMAN.
 * `Spec-022 §Daemon Master Key` wipes the in-memory master on an idle timer and
 * re-unwraps "via keystore + PRF assertion (desktop) or passphrase prompt
 * (CLI) on next access", so the first `unseal` after an idle wipe can await a
 * WebAuthn ceremony. A synchronous signature would foreclose that ladder
 * outright.
 */
export interface DaemonSigningKeySealer {
  /** Seals a freshly generated 32-byte Ed25519 secret seed. */
  seal(sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array>;
  /**
   * Reverses {@link DaemonSigningKeySealer.seal} for the same `sessionId`.
   *
   * THE RESULT MAY BE A BUFFER THE IMPLEMENTATION REUSES. `read` copies these
   * bytes before branding them, so an implementation is free to unseal into a
   * scratch array it overwrites on its next call — this consumer retains no
   * view over it. That is a promise this module keeps rather than a licence it
   * takes, and it is the one the copy actually covers; see the note on the
   * private-key narrowing site for the silent failure it prevents.
   */
  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array>;
}

// --------------------------------------------------------------------------
// The custody surface, split by what each side of the boundary may reach.
// --------------------------------------------------------------------------

/**
 * The PUBLIC-KEY-ONLY half of daemon signing-key custody — the type Plan-002's
 * session-create call site is annotated with (CP-006-7).
 *
 * This is the narrow surface the header's structural argument rests on: it
 * declares `create` and nothing else, so a holder cannot reach
 * {@link DaemonSigningKeySource.read}. Read that note for what the split does
 * NOT enforce.
 */
export interface DaemonSigningKeyProvisioner {
  /**
   * Generates this session's Ed25519 keypair, seals the private half, persists
   * both to `daemon_signing_keys`, and resolves to the PUBLIC key — which the
   * caller registers in the session participant roster per
   * `docs/architecture/security-architecture.md §Per-Event Daemon Signature`.
   *
   * EXACTLY ONCE PER SESSION, ENFORCED BY THE SCHEMA. `session_id` is the
   * table's PRIMARY KEY, so a second `create` for a live session raises a
   * SQLite constraint error rather than re-keying. That is the whole reason
   * the Plan-006 T2.7 row classes this task `manual_reconcile_only`: a fresh
   * keypair is not a retry of the previous one, and quietly replacing the row
   * would strand every `daemon_signature` already written under the old key —
   * they would verify against a public key the roster no longer holds, i.e.
   * an untampered log that fails forever. Failing loudly leaves the operator
   * an intact chain to reconcile.
   */
  create(sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }>;
}

/**
 * Full daemon signing-key custody: provisioning plus the signer-local unseal
 * path.
 *
 * Wire ONLY the signing side to this type — the append path (T3.1), the
 * compactor's `stub_signature` minting (T3.2), and the Merkle-anchor service's
 * `root_signature` (T3.3). Everything else takes
 * {@link DaemonSigningKeyProvisioner}.
 */
export interface DaemonSigningKeySource extends DaemonSigningKeyProvisioner {
  /**
   * Resolves this session's Ed25519 private key, unsealing it on the way out.
   *
   * The result is a live secret, and a FRESH array the implementation owns
   * rather than a view over the sealer's buffer (see the private-key narrowing
   * site for why). Hand it straight to `signRow` (or to
   * `mintParticipantSignature`) as the parameter it takes; do not cache it, log
   * it, or copy it into a longer-lived structure — every extra holder is one
   * more place a master-key wipe cannot reach, and under this RETURN-A-VALUE
   * signature the resolver cannot scrub the array on the caller's behalf. That
   * last clause is a property of the SIGNATURE rather than of the resolver: the
   * private-key narrowing site names the borrow-scoped `read(sessionId, use)`
   * shape that would let it scrub, and why that shape is not taken here.
   *
   * Rejects when the session has no row: `create` was never called, or the row
   * was removed. Deliberately NOT create-on-read — minting a second keypair
   * behind a read would produce signatures no roster-registered public key
   * verifies, which is the failure `create`'s exactly-once note describes,
   * reached silently instead of loudly.
   *
   * ALSO REJECTS WHAT IT RESOLVES BUT CANNOT VOUCH FOR, and that half is the one
   * a caller cannot retry its way out of — including a stored
   * `sealed_private_key` that is not a BLOB, a stored `public_key` that is not a
   * 32-byte BLOB, an unsealed seed of the wrong width, and an unsealed seed
   * whose public half is not the `public_key` the same `create` wrote beside it.
   * Each is a custody failure rather than a transient one — `create`'s
   * `manual_reconcile_only` register — so a caller that retries a rejected
   * `read` retries it forever, and the operator response is reconciliation, not
   * a backoff. The implementation's own note on the last of those carries what
   * it catches and what it does not.
   */
  read(sessionId: SessionId): Promise<Ed25519PrivateKey>;
}

// --------------------------------------------------------------------------
// Private row interface (snake_case, raw DB shape) — the RuntimeBindingStore /
// SessionService register. BOTH members are typed `unknown` rather than
// `Uint8Array` deliberately: each column is declared `BLOB NOT NULL`, but that
// declaration is a claim TypeScript never checked, and `read` is where both
// checks happen.
// --------------------------------------------------------------------------

interface DaemonSigningKeyRow {
  readonly public_key: unknown;
  readonly sealed_private_key: unknown;
}

// --------------------------------------------------------------------------
// OsKeystoreSealedDaemonSigningKeySource
// --------------------------------------------------------------------------

/**
 * The V1 {@link DaemonSigningKeySource}: fresh per-session Ed25519 keypair,
 * private half sealed by the injected {@link DaemonSigningKeySealer}, both
 * halves persisted to the local-SQLite `daemon_signing_keys` table.
 *
 * NAMED FOR THE CUSTODY MODEL IT COMPOSES OVER, NOT FOR CODE IT CONTAINS. The
 * "OsKeystoreSealed" prefix is the Plan-006 T2.7 row's own name for this class
 * and describes where the sealing master key comes from — the OS-keystore
 * tier-1 rung of `Spec-022 §Daemon Master Key`, reached through the sealer the
 * composition root injects. This class holds NO keystore code: no
 * `@napi-rs/keyring` import, no backend probe, no AEAD, no master key. Read the
 * header's "What is NOT here" note before adding any.
 *
 * LOCAL SQLITE, NOT SHARED POSTGRES, per `ADR-004 §Decision`. A daemon signing
 * key attests that THIS node emitted a row, so replicating it would defeat the
 * attestation and put daemon-private material in the control plane. The
 * canonical DDL is
 * `docs/architecture/schemas/local-sqlite-schema.md §Audit Log Crypto Tables (Plan-006)`,
 * mirrored by `migrations/0005-daemon-signing-keys.ts`.
 *
 * NO ROTATE OPERATION IN V1. `daemon_signing_keys.rotated_at` exists in the
 * canonical DDL against the ADR-010 rotation its column comment names, and
 * nothing here writes it — consistent with `participant_keys.rotated_at`, which
 * `Spec-022 §Participant Keys` pins NULL for V1 (I-022-10). Rotating a signing
 * key is not a re-key in isolation: it needs a roster update and a rule for
 * verifying rows signed under the superseded key, neither of which V1
 * specifies.
 */
export class OsKeystoreSealedDaemonSigningKeySource implements DaemonSigningKeySource {
  // Only the prepared statements are retained, never the raw handle — the
  // RuntimeBindingStore / NodeRegistry / SessionService discipline (a prepared
  // statement internally keeps its parent connection alive).
  readonly #insertStmt: Statement;
  readonly #selectKeyRowStmt: Statement;
  readonly #sealer: DaemonSigningKeySealer;
  /** Injected wall clock, for deterministic tests. */
  readonly #now: () => string;

  constructor(
    database: Database,
    sealer: DaemonSigningKeySealer,
    deps: { now?: () => string } = {},
  ) {
    this.#sealer = sealer;
    this.#now = deps.now ?? ((): string => new Date().toISOString());

    // Plain INSERT, never INSERT OR REPLACE / ON CONFLICT: the `session_id`
    // PRIMARY KEY collision IS the exactly-once guard (see `create`), and it
    // is checked atomically by SQLite rather than by a read-then-write this
    // module would have to race against. `rotated_at` is omitted, so it
    // defaults to NULL.
    this.#insertStmt = database.prepare(
      `INSERT INTO daemon_signing_keys
         (session_id, public_key, sealed_private_key, created_at)
       VALUES
         (@session_id, @public_key, @sealed_private_key, @created_at)`,
    );
    // BOTH halves, not just the sealed one: `create` wrote them from a single
    // `ed25519.keygen()` result in one INSERT, so the row carries its own answer
    // to "is the key that comes back out the key that went in" — see `read`.
    // The public column costs one 32-byte read on a row the query already
    // fetches.
    this.#selectKeyRowStmt = database.prepare(
      `SELECT public_key, sealed_private_key
         FROM daemon_signing_keys
        WHERE session_id = ?`,
    );
  }

  async create(sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    // noble's convenience helper — `{ secretKey, publicKey }`, the same call
    // `crypto-paseto`'s `generateV4PublicKeyPair` makes. The secret is a
    // 32-byte RFC 8032 seed drawn from the platform CSPRNG.
    const keyPair = ed25519.keygen();
    const publicKey = toEd25519PublicKey(keyPair.publicKey);

    try {
      // Sealed BEFORE the INSERT so a sealer failure leaves no row at all: the
      // alternative — write, then seal — could persist a session whose private
      // half was never sealed, and the PRIMARY KEY would then block the retry.
      const sealedPrivateKey = await this.#sealer.seal(sessionId, keyPair.secretKey);

      // better-sqlite3 binds a `Buffer` as the BLOB value — the register
      // `session-service.ts` uses (`Buffer.alloc`) for the chain columns.
      // `Buffer.from(typedArray)` COPIES, where the `Buffer.from(arrayBuffer)`
      // overload would share memory with its argument. The copy is NOT
      // load-bearing today — both arrays are local here and nothing mutates
      // them before `.run()` returns — but it is the overload to keep: a
      // sealer handing back a view over a scratch buffer it later reuses
      // would corrupt a shared-memory bind, surfacing as an unsealable row.
      this.#insertStmt.run({
        session_id: sessionId,
        public_key: Buffer.from(publicKey),
        sealed_private_key: Buffer.from(sealedPrivateKey),
        created_at: this.#now(),
      });
    } finally {
      // Best-effort scrub of the generated secret, which this method never
      // returns and no longer needs. The `try` opens BEFORE the seal, not
      // between it and the INSERT, so both throwing paths reach this line —
      // a failed seal is exactly where the plaintext seed would otherwise
      // stay reachable while the error unwinds.
      //
      // HONEST LIMIT — this is hygiene, not a guarantee, and the ways it falls
      // short are all outside this line's reach. V8 may have copied the buffer
      // during a GC move, the page is not `sodium_mlock`ed so it can reach
      // swap (`Spec-022 §Daemon Master Key` scopes mlock to the master key,
      // not to per-session keys), and a sealer that retained a reference to
      // the array keeps its own copy. Shrinking that last one is the
      // implementor's obligation, not something these types can express.
      keyPair.secretKey.fill(0);
    }

    return { publicKey };
  }

  async read(sessionId: SessionId): Promise<Ed25519PrivateKey> {
    const row = this.#selectKeyRowStmt.get(sessionId) as DaemonSigningKeyRow | undefined;
    if (row === undefined) {
      throw new Error(
        `No daemon signing key for session ${sessionId}: DaemonSigningKeyProvisioner.create must run at session creation (CP-006-7) before any row is signed. Reading does not mint a key — a second keypair would produce signatures the roster-registered public key cannot verify.`,
      );
    }

    // The declared column is `BLOB NOT NULL`, and that declaration is a claim
    // TypeScript never checked — the same read-side stance `signer.ts`'s
    // `verifyRow` takes toward `session_events`. SQLite's BLOB declared type
    // gives BLOB AFFINITY with no coercion, so anything with write access to
    // the file can leave a TEXT value here; better-sqlite3 hands that back as
    // a JS `string`, which would reach the sealer as a non-`Uint8Array` and
    // surface as whatever that implementation happens to throw. Refuse it
    // here, where the diagnostic still names the column.
    //
    // A THROW AND NOT A VERDICT, and the asymmetry with `verifyRow` is
    // deliberate: a malformed stored ROW is a tamper symptom the verifier must
    // REPORT, whereas a malformed stored KEY is a custody failure with no
    // signature to adjudicate — there is nothing to return `false` about, and
    // the append path cannot proceed either way.
    const sealedPrivateKey = row.sealed_private_key;
    if (!(sealedPrivateKey instanceof Uint8Array)) {
      throw new Error(
        `daemon_signing_keys.sealed_private_key for session ${sessionId} is not a BLOB: got ${describeByteShape(sealedPrivateKey)}. The column is declared BLOB NOT NULL, so a non-byte value means the row was written or altered outside this module.`,
      );
    }

    // The same read-side stance toward the sibling column, for the check below.
    // Written out rather than delegated to `assertEd25519KeyWidth` for the
    // reason the guard above is: that helper's message names the ROLE and the
    // RFC width, and a value read out of a COLUMN needs a diagnostic that names
    // the column.
    //
    // WIDTH AS WELL AS BYTE-NESS, and here the width clause is what keeps the
    // diagnostic honest rather than merely early. A non-byte value would reach
    // `equalBytes`, whose `abytes` raises a `TypeError` naming noble instead of
    // this row. A wrong-WIDTH one would not throw at all: `equalBytes` returns
    // `false` on a length mismatch, so a truncated `public_key` would fall
    // through to the derivation check below and be reported as a key that does
    // not match its row — a wrong-VALUE verdict on a wrong-SHAPE row, which
    // sends the reader hunting a copied blob that was never there.
    const storedPublicKey = row.public_key;
    if (!(storedPublicKey instanceof Uint8Array) || storedPublicKey.length !== ED25519_KEY_LENGTH) {
      throw new Error(
        `daemon_signing_keys.public_key for session ${sessionId} is not a ${ED25519_KEY_LENGTH}-byte BLOB: got ${describeByteShape(storedPublicKey)}. The column is declared BLOB NOT NULL and create writes ed25519.keygen()'s 32-byte public half, so a wrong-shaped value means the row was written or altered outside this module.`,
      );
    }

    // BOTH COLUMN GUARDS RUN AHEAD OF THE UNSEAL, WHICH IS A COST ARGUMENT AND
    // NOT ONLY A DIAGNOSTIC ONE. `Spec-022 §Daemon Master Key` wipes the
    // in-memory master on an idle timer and re-unwraps via a keystore + PRF
    // assertion or a passphrase prompt on next access, so the first `unseal`
    // after a wipe can await a human. Prompting for a ceremony to open a row
    // that is going to be refused either way is the wrong trade — the same
    // register in which `pii-indirection.ts` refuses a mis-shaped key before its
    // encrypt step so a rejected append costs no AES-256-GCM nonce.
    const unsealedSeed: Uint8Array = await this.#sealer.unseal(sessionId, sealedPrivateKey);

    // ------------------------------------------------------------------
    // THE UNSEALED SEED MUST BE THIS ROW'S SEED, AND THE ROW IS WHAT SAYS SO.
    // ------------------------------------------------------------------
    //
    // `create` wrote `public_key` and `sealed_private_key` from ONE
    // `ed25519.keygen()` result in ONE INSERT, so a coherent row is the only
    // kind it produces — and it is this package's only writer of the table,
    // since no rotate operation is published. Deriving the public half of what
    // came back out and comparing it against the column is therefore a check
    // with no legitimate failure case, which is what makes failing CLOSED on it
    // correct rather than merely defensive.
    //
    // WHAT IT CLOSES. {@link DaemonSigningKeySealer} documents `sessionId` as
    // available for AEAD associated data and explicitly does NOT require the
    // binding, having fixed no byte format — so an implementation that ignores
    // the argument satisfies the interface. Under such a sealer a
    // `sealed_private_key` blob copied from one row onto another unseals
    // cleanly, and without this check `read` would brand and return the OTHER
    // session's key. Every row this session then appended would be signed under
    // a key the roster does not hold for this node.
    //
    // WHY THAT ROUTES THE WRONG HUMAN. Unrefused, the failure surfaces at the
    // verifier as `signature_mismatch` per
    // `docs/architecture/security-architecture.md §Verification Rules` rule 2 —
    // on every row signed with the wrong key — which is the possible-tampering
    // verdict that warrants security incident response. Unlike `signer.ts`'s
    // `verifyEd25519` public-key throw, the premise here is NOT "a plumbing bug,
    // not a tamper": a copied blob IS an at-rest edit, so tampering is one of
    // the live causes. What the refusal buys is the OBSERVABLE. At the verifier
    // the two causes are one indistinguishable verdict arriving a session's
    // worth of rows later; here the diagnostic names the row and the column that
    // produced it, before a single unverifiable row is written.
    //
    // WHAT IT DOES NOT CLOSE. An adversary who rewrites BOTH columns installs a
    // coherent foreign keypair and passes this check. Nothing local can refuse
    // that row — it is self-consistent — and what refuses it is the roster,
    // which is separate storage: `create`'s returned public key is what CP-006-7
    // registers per
    // `docs/architecture/security-architecture.md §Per-Event Daemon Signature`,
    // and a verifier resolves THAT copy by `NodeId`. This check binds the seed
    // to its row; it does not make the row self-authenticating.
    //
    // THE WIDTH ASSERT IS THE FIRST OF THREE ON THIS VALUE AND EARNS ITS PLACE.
    // It runs here because `ed25519.getPublicKey` refuses a wrong-width seed
    // with a message naming noble rather than the unseal that produced it;
    // {@link toEd25519PrivateKey} runs it again at the mint site, where it is a
    // property of the BRAND rather than of this caller, and `ed25519.sign` is
    // the third, at use. Deleting the mint-site one because this line exists
    // would make the brand's guarantee rest on a check a dozen lines up in its
    // only current caller.
    //
    // COST AND FREQUENCY, TRACED RATHER THAN ASSUMED. `read` has no non-test
    // consumer in this workspace today; the unlanded ones this module's notes
    // name are T3.1's append path, T3.2's compactor and T3.3's anchor service,
    // and under this interface's own "do not cache it" obligation an append path
    // calls `read` once per row. So price it per row: one fixed-base scalar
    // multiplication (RFC 8032 §5.1.5's `A = [s]B`), the same shape of operation
    // `ed25519.sign` already performs once per row for its own `R = [r]B`
    // (§5.1.6) — on a path that has just awaited an unseal the note above allows
    // to block on a WebAuthn ceremony.
    //
    // `equalBytes` AND DELIBERATELY NOT `timingSafeEqual`. Both operands
    // are public: the stored one is a column held in the clear whose value
    // `create` hands Plan-002 for the participant roster, and the derived one is
    // by construction the public half of the key, so neither is a secret a timing
    // channel could leak and holding either grants no signing ability. The
    // primitive is still the right default — `equalBytes` accumulates across the
    // whole array rather than early-exiting on the first differing byte — and it
    // keeps this module on `signer.ts`'s one byte-utility source with no
    // `node:crypto` import. `node:crypto.timingSafeEqual` would additionally
    // THROW on a length mismatch, resting its no-throw property on the two
    // guards above rather than on itself.
    //
    // The message carries no key bytes, matching `pii-indirection.ts`'s rule for
    // its own refusals: the columns are named, the values are not.
    assertEd25519KeyWidth(unsealedSeed, "private key");
    const derivedPublicKey: Uint8Array = ed25519.getPublicKey(unsealedSeed);
    if (!equalBytes(derivedPublicKey, storedPublicKey)) {
      throw new Error(
        `daemon_signing_keys.sealed_private_key for session ${sessionId} unsealed to a key whose public half is not this row's public_key. Signing with it would mint daemon_signature values that fail against the NodeId-resolved roster key per Spec-006 §Canonical Serialization Rules, reported as signature_mismatch on every row signed with it. The row is inconsistent: a sealed blob copied from another row unseals cleanly under a sealer that does not bind sessionId as AEAD associated data, and an unseal that returns some other 32 bytes lands here identically.`,
      );
    }

    return toEd25519PrivateKey(unsealedSeed);
  }
}

// --------------------------------------------------------------------------
// Internals — the two narrowing sites, and nothing else.
// --------------------------------------------------------------------------

/**
 * The ONLY place an `Ed25519PublicKey` is minted. Not exported: `signer.ts`
 * withholds a brand constructor precisely so this stays the single site, and
 * re-exporting one from here would reopen the hole one module over.
 *
 * DOES NOT COPY, unlike its private-key sibling, and needs no equivalent note:
 * its input is `ed25519.keygen()`'s own fresh output, allocated inside `create`
 * and aliased by nothing that outlives the call — and a public key is not
 * secret material in the first place.
 */
function toEd25519PublicKey(bytes: Uint8Array): Ed25519PublicKey {
  assertEd25519KeyWidth(bytes, "public key");
  return bytes as Ed25519PublicKey;
}

/**
 * The ONLY place an `Ed25519PrivateKey` is minted — see
 * {@link toEd25519PublicKey}.
 *
 * The width check earns its keep on THIS side more than on the other. The input
 * is whatever {@link DaemonSigningKeySealer.unseal} returned, so a truncating
 * envelope bug, an off-by-one slice, or a blob sealed under some other format
 * lands here as bytes of the wrong length. Unchecked, that reaches
 * `ed25519.sign`, which refuses a wrong-length secret — but only after the
 * value has been laundered into a branded type and passed through the append
 * path, so the throw names the signer rather than the unseal that produced it.
 *
 * IT IS NOW THE SECOND SUCH CHECK ON THE SAME VALUE, AND THAT IS THE POINT.
 * `read` asserts the width itself before deriving the public key it compares
 * against the row, for a reason local to that derivation — see its note. This
 * one stays because the guarantee belongs to the BRAND rather than to today's
 * only caller: dropping it would leave "no `Ed25519PrivateKey` in this workspace
 * was minted from bytes of the wrong width" resting on a line a dozen up in one
 * call site, and silently false the moment a second one appears.
 *
 * THE BYTES ARE COPIED, NEVER BRANDED IN PLACE — the read-side counterpart of
 * the `Buffer.from(sealedPrivateKey)` copy `create` makes, and load-bearing
 * where that one is merely the overload to keep. `unseal` may hand back a LIVE
 * VIEW over a scratch buffer it reuses; `read` is async, so every caller holds
 * the branded key across an `await`, and a concurrent or subsequent `unseal`
 * then overwrites the bytes underneath it. `ed25519.sign` signs with a
 * different scalar and mints signatures no roster-registered public key
 * verifies — silent, and indistinguishable at the verifier from tampering.
 * Doing this at the MINT SITE rather than at the call site makes it a property
 * of the brand: no `Ed25519PrivateKey` in this workspace is a view over memory
 * this module does not own. `new Uint8Array(...)` and deliberately not
 * `.slice()` — `signer.ts` takes the same care with its `prevHash` echo and for
 * the same reason: `Buffer.prototype.slice` returns a view onto the same
 * memory, and a sealer reading from a keystore plausibly returns a `Buffer`.
 *
 * WHY A COPY AND NOT AN OBLIGATION ON THE INTERFACE. This module already
 * refuses to trust `unseal`'s result for byte-ness and width, because it
 * crosses an injection boundary nothing here checked; trusting that same
 * boundary not to retain a view would be incoherent. A stated obligation is the
 * right instrument for a property these types CANNOT enforce — the `sessionId`
 * AAD binding is exactly that: having fixed no byte format, nothing here can
 * make a sealer bind it. This one is enforceable, and the failure it prevents is
 * silent.
 *
 * THAT EXAMPLE HAS SINCE NARROWED, AND THE TWO NOTES SHOULD BE READ TOGETHER.
 * The obligation is still the only instrument for the BINDING — but the
 * OUTCOME it was there to buy is no longer left to it: `read` derives the public
 * half of whatever `unseal` returned and refuses it unless it matches the row's
 * own `public_key`, so a sealer that declines the binding produces a refusal
 * naming the row rather than a silent wrong-session key. What the obligation
 * still buys is the earlier and cleaner failure — an AEAD that will not open at
 * all never produces the key material to refuse.
 *
 * THE PRICE, STATED RATHER THAN GLOSSED: a SECOND unscrubbed allocation of
 * private key material. It is not scrubbed under the current return-a-value
 * signature — it IS the returned value, and a function that RETURNS a secret
 * cannot know when its caller is done with one; the only thing shortening its
 * life today is {@link DaemonSigningKeySource.read}'s "hand it straight to
 * `signRow`, do not cache it" obligation.
 *
 * THAT IS A PROPERTY OF THE SIGNATURE, NOT OF THIS MODULE, AND THE SEAM HAS A
 * SHAPE. A borrow-style `read(sessionId, use)` — branded key handed to a
 * caller-supplied callback, scrubbed in a `finally` — would turn this copy into
 * the one allocation of the two that CAN be retired. THE BORROW SCOPE IS THE
 * CONSUMER'S, NOT `signRow`'S, AND THE IN-TREE CONSUMER SPANS AN AWAIT.
 * `signRow` ITSELF is synchronous, so a borrow around the sign call alone would
 * close within one synchronous call — but reaching that shape from the PII write
 * path means changing what `writeEventWithPii` takes (this SOURCE rather than a
 * key), which is a SECOND published-signature change, on T2.4's surface rather
 * than this one. As written, T2.4's `writeEventWithPii` takes the key as a
 * PARAMETER and holds it across `await encryptor.encrypt(...)` before it reaches
 * `signRow`, so a borrow wrapping that consumer takes an async callback whose
 * `finally` waits on an injected, Plan-022-owned AEAD to settle. That is the
 * async-caller shape the copy argument above already rests on, and the seam
 * survives it: a lexical scope would bound the borrow where this signature
 * leaves the key's lifetime to a caller obligation. Price the reversal at an
 * encrypt, not at one synchronous call. Nor is the migration expensive TODAY —
 * {@link DaemonSigningKeySource} has no non-test consumer at all
 * (`writeEventWithPii` consumes the KEY, not this interface), T3.1's append
 * path, T3.2's compactor, and T3.3's anchor service being unlanded — and that
 * cost is monotonic in consumers, so it only rises from here. Deliberately NOT
 * taken in this round: the interface is a published contract surface, and its
 * shape is not a comment's to change.
 *
 * WHERE THE SEALER TREATS ITS BUFFER AS SCRATCH — the "THE BYTES ARE COPIED"
 * premise above, and the whole reason this copy exists — THIS COPY IS THE
 * LONGER-LIVED OF THE TWO SECRETS, which makes it the higher-value scrub target
 * rather than the unscrubbable one. The claim is scoped on purpose: under the
 * OTHER implementation {@link DaemonSigningKeySealer} contemplates, the caching
 * one, the sealer's array outlives this copy instead — and the next paragraph is
 * why that array goes unscrubbed under either premise.
 *
 * Nor is the SEALER's array scrubbed
 * on the way out, deliberately: `create` scrubs only what it allocated, and
 * {@link DaemonSigningKeySealer} explicitly contemplates an implementation that
 * caches to avoid re-prompting a WebAuthn ceremony after an idle master-key
 * wipe — zeroing its buffer would corrupt that cache. The sealer's own
 * allocation exists either way; what the copy adds is one 32-byte array.
 */
function toEd25519PrivateKey(bytes: Uint8Array): Ed25519PrivateKey {
  assertEd25519KeyWidth(bytes, "private key");
  const privateKeyCopy: Uint8Array = new Uint8Array(bytes);
  return privateKeyCopy as Ed25519PrivateKey;
}

/**
 * Byte-ness AND width, on `unknown` rather than `Uint8Array` — the same reason
 * `signer.ts`'s `isBytesOfLength` takes `unknown`: every call site holds a
 * value whose DECLARED type is already `Uint8Array`, and that declaration is a
 * claim the compiler could not check. `keygen()`'s output crossed a library
 * boundary and `unseal`'s crossed an interface an implementation outside this
 * package satisfies.
 *
 * NARROWER THAN NOBLE'S `abytes`, AND THAT DIRECTION IS THE GUARANTEE: every
 * value this accepts is one the library accepts, so a divergence can only refuse
 * EARLIER here — never admit a value that later trips a library-side `abytes`.
 * `signer.ts`'s `isBytesOfLength` carries the full argument (what noble
 * additionally admits, and why equivalence was never needed). A better-sqlite3
 * `Buffer` passes both, since `Buffer extends Uint8Array`.
 */
function assertEd25519KeyWidth(value: unknown, role: string): void {
  if (!(value instanceof Uint8Array) || value.length !== ED25519_KEY_LENGTH) {
    throw new Error(
      `Ed25519 ${role} must be ${ED25519_KEY_LENGTH} bytes per RFC 8032 §5.1.5; received ${describeByteShape(value)}.`,
    );
  }
}

/**
 * Renders a refused value for a throw message without trusting its declared
 * type — `value.length` on a `string` would report a character count as a byte
 * count and send the reader after the wrong bug. Mirrors `signer.ts`'s helper
 * of the same name; kept module-local rather than shared, since neither module
 * exports it and a shared byte-shape utility is a surface the plan did not ask
 * for.
 */
function describeByteShape(value: unknown): string {
  return value instanceof Uint8Array
    ? `${value.length} bytes`
    : `a non-Uint8Array value of type ${typeof value}`;
}
