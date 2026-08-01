// BLAKE3 hash-chain + Ed25519 row signer — the two tamper-evidence
// commitments every `session_events` row carries (Plan-006 T2.2).
//
// `Spec-006 §Integrity Protocol` makes each row chained to its predecessor AND
// signed by the emitting daemon over the SAME canonical byte string, and
// `Spec-006 §Canonical Serialization Rules` fixes the verification recipe:
// recompute `canonical_bytes(row)`, recompute
// `BLAKE3(prev_hash || canonical_bytes(row))`, compare to the stored
// `row_hash`, then verify `daemon_signature` against those same canonical
// bytes using the `NodeId`-resolved public key from the session participant
// roster. This module owns both halves of that recipe — write side and read
// side — and deliberately nothing else.
//
// I-006-2-06 — ONE CANONICALIZATION PER ROW — is enforced structurally rather
// than by discipline: `signRow` ACCEPTS `CanonicalBytes` and never produces
// them. It calls no canonicalizer, re-serializes nothing between hashing and
// signing, and hands the identical `Uint8Array` to BLAKE3 and to
// `ed25519.sign`. The parameter type is the type-level half — T2.1's brand is
// constructible only inside `canonicalizer.ts`, so bytes that skipped
// canonicalization are a TypeScript error here rather than a runtime integrity
// bug. Widening that parameter to a bare `Uint8Array` would void the guarantee
// for every caller at once, which is why it is not widened for anyone.
//
// KEY CUSTODY IS NOT HERE. Every entry point takes its key as a PARAMETER, so
// this module needs the key TYPE and never the key SOURCE: it constructs,
// loads, unseals, and persists nothing. T2.7's `signing-key-source.ts` owns
// custody and imports `Ed25519PrivateKey` / `Ed25519PublicKey` from here, so
// the BUILD-time edge runs T2.2 → T2.7 even though T2.7 is also a runtime
// consumer — that second direction is a composition-root dependency,
// discharged by injecting the key at the call site.
//
// THIS MODULE SIGNS ROWS. Two sibling Phase-3 signatures are Ed25519 over a
// DIFFERENT message class and are not served by widening anything here: T3.3's
// `root_signature` covers a Merkle root (not canonical bytes at all), and
// T3.2's `stub_signature` covers an audit-stub projection with no hash-chain
// link — neither is a `SignedRow`, and both are scoped to their own Plan-006
// T3.2 / T3.3 rows rather than to this one.
//
// In-package surface for now: `src/index.ts` does not re-export this module,
// matching T2.1.
//
// Refs: `Spec-006 §Integrity Protocol`, `Spec-006 §Canonical Serialization Rules`,
// `Plan-006 §Hash Chain`, `Plan-006 §Ed25519 Signatures`,
// `Security Architecture §Audit Log Integrity`.
import { ed25519 } from "@noble/curves/ed25519.js";
import { equalBytes } from "@noble/curves/utils.js";
import { blake3 } from "@noble/hashes/blake3.js";
import type { CanonicalBytes } from "./canonicalizer.js";

/**
 * BLAKE3's default digest width, and the width of both chain columns —
 * `0001-initial.ts` declares `prev_hash` / `row_hash` as `BLOB` under
 * `CHECK(length(…) = 32)`, normative per `Security Architecture §Audit Log Integrity`.
 */
const CHAIN_HASH_LENGTH = 32;

/**
 * The RFC 8032 §5.1.5 Ed25519 public-key width — also the width noble enforces
 * itself, as `lengths.publicKey` in `abstract/edwards.js`. Spelled here so
 * {@link verifyEd25519} can refuse a mis-plumbed key BEFORE noble does; that
 * function's guard explains why the two refusals are not interchangeable.
 */
const ED25519_PUBLIC_KEY_LENGTH = 32;

/**
 * The RFC 8032 §5.1.6 Ed25519 signature width — `R || S`, 32 bytes each — and
 * the width `0001-initial.ts` enforces on the column, which declares
 * `daemon_signature` as `BLOB` under `CHECK(length(daemon_signature) = 64)`.
 *
 * Spelled here for {@link verifyRow}'s placeholder check ONLY. It is
 * deliberately not applied as a general shape guard on a stored signature: a
 * wrong-width one is adversarial data whose verdict is `signature_mismatch`,
 * which {@link verifyEd25519}'s catch already produces.
 */
const ED25519_SIGNATURE_LENGTH = 64;

// --------------------------------------------------------------------------
// Key types — deliberately this module's own, not crypto-paseto's.
// --------------------------------------------------------------------------

/**
 * A 32-byte RFC 8032 Ed25519 secret-key seed authorized to sign audit-log
 * material.
 *
 * Deliberately NOT `crypto-paseto`'s `V4PublicKeyPair.secretKey`, and the
 * divergence is the point rather than an oversight: that type is UNBRANDED,
 * length-checked only by a runtime assert, and semantically bound to PASETO
 * `v4.public` TOKENS. These are audit-log SIGNING keys. Cryptographic key
 * separation says a key — and the type that names it — should not cross
 * protocols, so reusing the token keypair type would make handing an auth
 * token's secret to `signRow` a well-typed call.
 *
 * Brand shape mirrors the contracts-package convention (`SessionId`,
 * `EventEnvelopeVersion`) and T2.1's `CanonicalBytes`. There is deliberately NO
 * exported constructor, mint helper, or brand symbol: key material must enter
 * the type system at exactly one greppable site — the single narrowing inside
 * T2.7's `signing-key-source.ts`, the only module with key custody. An exported
 * `toEd25519PrivateKey(bytes)` would let any module mint a signing key from
 * arbitrary bytes, which is precisely the property the brand exists to deny.
 * The 32-byte width needs no constructor either: `ed25519.sign` refuses a
 * wrong-length secret, the same use-site register `v4-public.ts` applies.
 */
export type Ed25519PrivateKey = Uint8Array & { readonly __brand: "Ed25519PrivateKey" };

/**
 * A 32-byte RFC 8032 Ed25519 public key used to verify audit-log material —
 * the `NodeId`-resolved roster key for `daemon_signature`, or the participant's
 * own key for `participant_signature`.
 *
 * Same brand rationale as {@link Ed25519PrivateKey}, minus the custody
 * argument: the brand here buys call-site clarity (a public key can never be
 * transposed with a private one) and keeps the resolved-from-the-roster
 * provenance visible in the type.
 */
export type Ed25519PublicKey = Uint8Array & { readonly __brand: "Ed25519PublicKey" };

// --------------------------------------------------------------------------
// Chain seed.
// --------------------------------------------------------------------------

/**
 * The `prev_hash` seed for a chain's genesis row — 32 zero bytes.
 *
 * `Spec-006 §Integrity Protocol` delegates the genesis value to
 * `Security Architecture §Audit Log Integrity`, which fixes it: "For
 * `sequence = 0` the value is 32 zero bytes." Exported so the write side
 * (T3.1's append path, seeding a chain) and the read side (T4.1's linkage walk,
 * checking that seed) take the value from one place rather than each
 * re-deriving `new Uint8Array(32)` (I-006-2-04).
 *
 * CALLER OBLIGATION — TREAT AS READ-ONLY, AT THE IMPORT SITE. This is a shared
 * `Uint8Array` and JavaScript cannot make it immutable: `Object.freeze` throws
 * `TypeError: Cannot freeze array buffer views with elements` on a non-empty
 * typed array, so the usual const-export protection is unavailable here. A
 * module that writes into this array corrupts every genesis `row_hash`
 * computed afterward in the process. Copy before mutating; nothing in this
 * module mutates it.
 *
 * That import site is now the WHOLE of the hazard. The downstream leg is closed
 * structurally: {@link SignedRow.prevHash} is a defensive COPY rather than an
 * echo of the input, so a `SignedRow` minted from this constant does not alias
 * it, and a persistence layer that zero-pads or normalizes `signedRow.prevHash`
 * in place can no longer reach back here.
 */
export const GENESIS_PREV_HASH: Uint8Array = new Uint8Array(CHAIN_HASH_LENGTH);

// --------------------------------------------------------------------------
// Row commitments.
// --------------------------------------------------------------------------

/**
 * The three integrity columns {@link signRow} mints for one `session_events`
 * row — exactly what the function computes, no more.
 *
 * `participantSignature` is deliberately ABSENT even though the row may carry
 * one: `signRow` holds no participant key and structurally cannot populate it,
 * and a type whose sole producer can never fill a member is a type that lies
 * about its own shape.
 * `Plan-006 §Open Authoring Decisions (Category 2 — Audit-Surfaced)` settles the
 * composition — the second attestation comes from a SEPARATE call
 * ({@link mintParticipantSignature}), not from a `signRow` parameter — and the
 * append path (T3.1) assembles the two. The canonical bytes are absent for the
 * same reason they are not a column: the row does not persist them, the
 * verifier recomputes them, and every caller already holds them because it
 * passed them in.
 *
 * `prevHash` IS echoed back — as a defensive COPY of the input, never the
 * caller's own array — and the echo is an AFFORDANCE, not an enforcement. What
 * it provides: the three columns arrive as one unit whose members are known to
 * agree, frozen at the instant `signRow` returned, so no later write into the
 * caller's array (or into {@link GENESIS_PREV_HASH}) can make the echoed
 * `prev_hash` disagree with the bytes that fed the digest. What it cannot do is
 * bind the INSERT: this module reaches no persistence layer, and a caller still
 * holding the array it passed in can hand THAT to the INSERT instead.
 *
 * CALLER OBLIGATION — PERSIST `prevHash`, `rowHash`, AND `daemonSignature` FROM
 * THE RETURNED `SignedRow` AS A UNIT. Storing some other still-32-byte,
 * still-`CHECK`-passing `prev_hash` mints an untampered row that can never
 * verify, because the verifier recomputes the digest from the STORED value. The
 * obligation lands on T3.1's append path, which owns the INSERT. This is a
 * register the module distinguishes deliberately: the `CanonicalBytes` brand
 * makes its own misuse a compile error, and this is not that.
 */
export interface SignedRow {
  /** 32 bytes — a defensive copy of the chain link that fed the digest. */
  readonly prevHash: Uint8Array;
  /** 32 bytes — `BLAKE3(prev_hash || canonical_bytes(row))`. */
  readonly rowHash: Uint8Array;
  /** 64 bytes — `Ed25519(daemon_signing_key, canonical_bytes(row))`. */
  readonly daemonSignature: Uint8Array;
}

/**
 * The outcome of {@link verifyRow} — a verdict, and never a throw, for every
 * input the ROW itself supplies.
 *
 * A verification FAILURE is the expected output of a verifier, so it is
 * returned rather than raised, and NO shape of adversarial STORED data changes
 * that: a tampered `prev_hash` / `row_hash` / `daemon_signature` — wrong bytes,
 * wrong width, or not bytes at all once it has crossed the SQLite boundary —
 * lands as a `failureMode`, so T4.1 always has something to report.
 *
 * This module's TWO throws both guard a CALLER-RESOLVED input instead, never a
 * stored one: a wrong-shaped `prevHash` handed to {@link signRow} on the write
 * side, and a wrong-shaped public key handed to {@link verifyRow} or
 * {@link verifyParticipantSignature} on the read side. Neither is a tamper
 * signal — the caller mints the first and resolves the second from the
 * participant roster — so folding either into a `failureMode` would page an
 * operator for a plumbing bug and discard the real cause.
 *
 * `failureMode` carries the two literals
 * `Security Architecture §Verification Rules` names for the per-row checks a
 * SIGNED row can fail — rule 1's `hash_mismatch` and rule 2's
 * `signature_mismatch` — so T4.1's
 * verifier maps them straight through to
 * `audit_integrity_failed { failureMode, failurePath }` instead of re-deriving
 * WHICH check failed by running the two halves separately, which would
 * reintroduce exactly the two-call shape I-006-2-06 exists to prevent.
 *
 * `signature_placeholder` is the THIRD literal, and its provenance runs in the
 * opposite direction to the other two. Spec-006 ORIGINATED it — a twelfth value
 * on that spec's `failureMode` enum, landing as an additive-MINOR enum
 * extension under `ADR-018 §Decision` — and
 * `Security Architecture §Verification Rules` MIRRORS it rather than
 * introducing it: rule 2 now opens with the placeholder precondition, emitting
 * `signature_placeholder` with `failurePath: 'signature'` and stopping before
 * any Ed25519 verification, and rule 1 carries the matching carve-out that
 * keeps an all-placeholder row out of `hash_mismatch`. Which way round that
 * runs is worth keeping straight: the spec is the authority, the architecture
 * doc agrees with it, and neither is inferring the value from the other. The
 * verdict reports a row whose THREE integrity columns are all still Plan-001's
 * zero-fill placeholder. {@link verifyRow}'s stage-2 note argues why the
 * predicate needs all three columns and why the verdict must not collapse into
 * `signature_mismatch`.
 *
 * This union is a SUBSET of the sixteen-value `failureMode` enum in
 * `Spec-006 §Audit Integrity (audit_integrity)`, and the other thirteen (sixteen,
 * less this union's three — RE-DERIVE both numbers on any enum change rather
 * than incrementing one of them) sit outside
 * it for FIVE different reasons rather than one. `anchor_*`, the proof modes,
 * and the log-file modes are RANGE-level: they are computed over a span of rows
 * against an uploaded Merkle anchor, and this function is handed neither.
 * `stub_signature_invalid` and `stub_scalar_mismatch` are PER-ROW —
 * `Security Architecture §Verification Rules` rule 4 scopes them "for each
 * `retention_class = 'audit_stub'` row" and calls the commitment "the per-row
 * `stub_signature`", as does I-006-3-03 — so what puts them out of scope is the
 * row CLASS, not the granularity: this function is handed one UNCOMPACTED row
 * (`retention_class IS NULL`) plus its canonical bytes, and a compacted row has
 * neither (compaction discarded the original bytes; rule 4 verifies the stub
 * projection stored in `payload`). Rule 4 therefore lives with T4.1's
 * compacted-row branch, not in a widened version of this function.
 * `occurred_at_not_canonical` is the third reason, and the only one that is NOT
 * about what this function is handed — it is handed everything that check
 * needs. What excludes it is that it is not a verification outcome at all. A
 * row whose `occurred_at` was respelled at rest into another spelling of the
 * same instant still hashes and verifies correctly, genuinely rather than by
 * oversight, so reporting it here would make this discriminant carry two
 * incompatible meanings at once: "this row does not verify" and "this row DOES
 * verify, but its stored spelling is not the one the signature committed to".
 * T2.1 exports `isCanonicalOccurredAt` for the second question and T4.1
 * composes the two; that predicate's contract explains why the composition —
 * not either half alone — is what byte-binds the column.
 * The PII PAIR — `pii_ciphertext_digest_unbound` and `pii_owner_stamp_unbound`
 * — is the fourth reason, and it is the two previous ones at once, which is why
 * it gets its own: like `occurred_at_not_canonical` both are findings ON a row
 * that genuinely verifies, and like the range modes both need an input this
 * function is never handed — `verifyRow` receives canonical bytes and the three
 * integrity columns, never the `pii_payload` column and never the PII owner
 * stamp, so it could not make either comparison even if the discriminant had
 * room for them. That is not an accident of the signature: the canonical form
 * EXCLUDES `pii_payload` on purpose and binds it indirectly through a digest
 * member, and it binds the owner by the same indirection through a stamp member,
 * so both columns are structurally outside everything this function sees. They
 * are ONE reason and TWO modes because they bind different things — the digest
 * binds the ciphertext BYTES, the stamp binds WHOSE data they are, and after a
 * `Spec-022 §Shred Fan-Out` Path 1 shred the second question has no other
 * evidence left to answer it. T2.4 exports `isCiphertextDigestBound` and
 * `isPiiOwnerStampBound` for them and T4.1 runs both as postconditions of a
 * green verdict here.
 * `signing_key_slot_conflict` is the fifth reason: it is not a read-side
 * verification outcome at ALL. No row and no range is being verified when it
 * fires — T4.10's daemon-side registrar appends it when the control plane
 * refuses its re-registration 409 for a `(session_id, node_id)` slot already
 * holding a DIFFERENT key, so its emitter is the registrar's conflict handler
 * rather than any verifier, and this function could never report it.
 * That enum is Phase-4 contracts work and has not landed, so
 * the literals are spelled here and T4.1 owns the widening.
 */
export type RowVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly failureMode: "hash_mismatch" | "signature_mismatch" | "signature_placeholder";
    };

/**
 * Mints the hash-chain digest and the daemon signature for one row, both over
 * the SAME `canonical` bytes — the structural half of I-006-2-06.
 *
 * `prevHash` is `Plan-006 §Hash Chain`'s link: the `row_hash` of the
 * immediately-prior row for the same `session_id`, or {@link GENESIS_PREV_HASH}
 * at `sequence = 0`.
 *
 * Deterministic per RFC 8032 §5.1.6 — Ed25519 derives its per-signature nonce
 * from the secret key and the message, never from an RNG, so re-signing
 * identical inputs yields byte-identical output. That is what makes this task
 * `idempotent`: re-running it over the same row reproduces the same three
 * columns rather than minting a second, differing signature.
 *
 * Refuses a `prevHash` that is not 32 bytes of `Uint8Array` (see the guard's
 * note below), and COPIES it into the returned {@link SignedRow} rather than
 * aliasing the caller's array.
 */
export function signRow(
  canonical: CanonicalBytes,
  prevHash: Uint8Array,
  daemonSigningKey: Ed25519PrivateKey,
): SignedRow {
  // `canonical` is brand-protected and `daemonSigningKey` is brand-protected;
  // `prevHash` is a bare `Uint8Array` — the shape Plan-006's T2.2 row fixes for
  // it, since a chain link is just the previous row's digest — and so it is the
  // one input nothing upstream constrains. A wrong-width value hashes perfectly
  // happily and mints a signature over a chain input no verifier can ever
  // reproduce: an untampered row that fails forever. `0001-initial.ts` would
  // also reject the row at INSERT via `CHECK(length(prev_hash) = 32)`, but only
  // AFTER the signature was minted, and it would surface as a SQLite constraint
  // error rather than as the chain bug it is. Refuse at the boundary instead,
  // in I-006-2-04's own vocabulary.
  //
  // The guard tests BYTE-NESS as well as width, and the declared `Uint8Array`
  // does not make that redundant: the caller appending row n reads row n-1's
  // `row_hash` back out of SQLite to use as this `prevHash`, and a `BLOB`
  // column can hand back a JS `string` — see {@link verifyRow}'s read-side
  // guard for why. A 32-CHARACTER string clears a bare length check
  // and then coerces to near-zero bytes through `TypedArray.prototype.set`,
  // which is the silent spelling of the very failure this guard refuses loudly.
  //
  // Plain `Error` matches the deliberate deferral `canonicalizer.ts` documents
  // for this package: the migration target, when a caller first needs to
  // discriminate a refusal from any other throw, is `ipc/domain-error.ts`'s
  // `DaemonDomainError` under an `event.*` code registered in
  // `docs/architecture/contracts/error-contracts.md §Error Codes`.
  if (!isBytesOfLength(prevHash, CHAIN_HASH_LENGTH)) {
    throw new Error(
      `signRow requires a ${CHAIN_HASH_LENGTH}-byte Uint8Array prev_hash — the previous row_hash for this session, or GENESIS_PREV_HASH at sequence 0 — per Spec-006 §Integrity Protocol; received ${describeByteShape(prevHash)}.`,
    );
  }

  // ONE value of `canonical`, read twice and re-derived never. The two
  // annotations below — and `recomputedRowHash` in {@link verifyRow} — pin each
  // local to the plain `Uint8Array` the persisted column holds rather than to
  // whatever intersection the library's return type widens to. They document a
  // shape; they guard nothing, because the explicit return types on this
  // module's exported functions already fix every value that leaves it.
  const rowHash: Uint8Array = blake3(buildChainInput(prevHash, canonical));
  const daemonSignature: Uint8Array = ed25519.sign(canonical, daemonSigningKey);

  // `prevHash` is COPIED into the result, never aliased. The caller keeps its
  // array and may reuse or mutate it, and at `sequence = 0` that array is
  // `GENESIS_PREV_HASH` — a shared module-level constant every genesis row is
  // minted from. Echoing by reference would leave a window between this return
  // and the INSERT in which a write into either makes the persisted `prev_hash`
  // disagree with the bytes just hashed: the exact divergence the echo exists
  // to prevent, and in the genesis case a corruption of every later genesis
  // `row_hash` in the process. Cost is one 32-byte allocation per row.
  // `new Uint8Array(...)` and deliberately NOT `.slice()`:
  // `Buffer.prototype.slice` returns a VIEW onto the same memory, and a
  // `prevHash` read out of a SQLite `BLOB` is a `Buffer`.
  return { prevHash: new Uint8Array(prevHash), rowHash, daemonSignature };
}

/**
 * The read-side inverse of {@link signRow} — rules 1 and 2 of
 * `Security Architecture §Verification Rules`, run against one uncompacted row
 * (`retention_class IS NULL`).
 *
 * The caller supplies `canonical` by re-canonicalizing the stored row through
 * T2.1, and `daemonPublicKey` by resolving the row's `NodeId` against the
 * session participant roster per `Spec-006 §Canonical Serialization Rules`.
 * Neither resolution belongs here: this module knows the recipe, not the
 * roster.
 *
 * CHECK ORDER IS OBSERVABLE, AND IT IS FOUR STAGES RATHER THAN TWO. First
 * failure wins, so this order IS the verdict for any row failing more than one
 * check:
 *
 *   1. STRUCTURAL — `prevHash` / `rowHash` are 32 bytes of `Uint8Array`;
 *      otherwise `hash_mismatch`.
 *   2. PLACEHOLDER — ALL THREE integrity columns are zero-filled (`prevHash`
 *      and `rowHash` 32 zeros each, `daemonSignature` 64 zeros); if so,
 *      `signature_placeholder`.
 *   3. CHAIN — recompute `BLAKE3(prev_hash || canonical)` and compare;
 *      otherwise `hash_mismatch`.
 *   4. SIGNATURE — verify `daemon_signature` over `canonical`; otherwise
 *      `signature_mismatch`.
 *
 * Stages 3 and 4 are SPEC order (`Security Architecture §Verification Rules`
 * rule 1, then rule 2): a row failing both reports `hash_mismatch` and never
 * `signature_mismatch`. Either failure halts replay at the same sequence, so
 * evaluating rule 2 after rule 1 has already failed would tell the caller
 * nothing it can act on and cost a scalar multiplication.
 *
 * STAGE 2 SITS WHERE IT DOES BECAUSE ANYWHERE LATER IS DEAD CODE, and that is
 * the one thing to preserve if this function is ever restructured. A
 * placeholder row zero-fills ALL THREE integrity columns, so it fails stage 3
 * as well; placing the placeholder check after the hash compare means it never
 * runs and `signature_placeholder` can never be returned.
 * `Security Architecture §Verification Rules` now MANDATES this ordering rather
 * than merely permitting it — rule 1 excepts the all-placeholder row from
 * `hash_mismatch` precisely so rule 2's precondition stays reachable — so
 * reordering these two stages would put this function out of conformance, not
 * just make it worse. It sits AFTER stage 1
 * rather than before it for two reasons: a non-byte or wrong-width chain column
 * is a corruption / plumbing problem that must keep surfacing as
 * `hash_mismatch`, and stage 1's guard is what makes both stage 2's
 * chain-column reads and stage 3's recompute safe in the first place.
 *
 * SCOPE — THIS IS AN INTRA-ROW CHECK, AND `valid: true` CLAIMS LESS THAN IT
 * READS. It proves one row's three integrity columns agree with its own
 * canonical bytes; it can prove nothing about the row's neighbours, because it
 * is handed none. I-006-2-04's second clause — `prev_hash[n] = row_hash[n-1]`,
 * and {@link GENESIS_PREV_HASH} at `sequence = 0` — is LINKAGE and is the
 * range-walking caller's obligation (T4.1's verifier; the persistence-layer
 * assertion). The gap is not theoretical: DELETE a middle row
 * and every surviving row still has mutually consistent columns and a
 * signature that verifies, because nothing was forged, so a per-row pass over
 * the remainder returns `valid: true` throughout. Only the linkage walk sees
 * the hole.
 *
 * A TAMPERED CHAIN COLUMN IS A VERDICT EVEN WHEN IT IS NOT BYTES. `row.prevHash`
 * and `row.rowHash` are declared `Uint8Array`, but they reach here across the
 * SQLite boundary, where that declaration is a claim TypeScript never checked.
 * SQLite's `BLOB` declared type gives BLOB AFFINITY with no coercion, and
 * `length()` counts CHARACTERS for a TEXT value — so the at-rest adversary this
 * protocol is written against (write access to the DB, no signing key) can
 * `UPDATE session_events SET row_hash = '00000000000000000000000000000000'`,
 * satisfy `0001-initial.ts`'s `CHECK(length(row_hash) = 32)` with 32
 * CHARACTERS, and have better-sqlite3 hand back a JS `string`. Unguarded, that
 * string reaches `equalBytes`, whose `abytes` raises `TypeError`, and the throw
 * escapes this function — so T4.1 emits NO `audit_integrity_failed` and the
 * tamper goes UNREPORTED, which is precisely the outcome the return-a-verdict
 * design exists to prevent, reached by a different route. Both members are
 * therefore shape-guarded to `hash_mismatch` below. The honest path costs
 * nothing: better-sqlite3 returns a `Buffer` for a real BLOB, and
 * `Buffer extends Uint8Array`.
 *
 * The asymmetry with `signRow` survives that and is still the correct one: on
 * the WRITE side a bad `prev_hash` is a caller bug to refuse before minting a
 * doomed signature, while on the READ side it is a tamper SYMPTOM and belongs
 * in the verdict. `daemonPublicKey` is the read-side exception that proves the
 * rule — the caller RESOLVES it from the participant roster rather than reading
 * it off the row, so a wrong-shaped one throws (see {@link verifyEd25519}).
 */
export function verifyRow(
  canonical: CanonicalBytes,
  row: SignedRow,
  daemonPublicKey: Ed25519PublicKey,
): RowVerification {
  // The shape guard the note above describes. `hash_mismatch` rather than a
  // third failure mode, because `Spec-006 §Audit Integrity (audit_integrity)`'s
  // enum has no malformed-stored-row arm and rule 1 is the check these two
  // columns belong to.
  //
  // BYTE-NESS is the clause that closes a hole, and it closes a different one
  // per member: a non-byte `rowHash` makes `equalBytes` THROW, while a non-byte
  // `prevHash` is silently COERCED by `TypedArray.prototype.set` inside
  // `buildChainInput` (the ArrayLike path runs `ToNumber` per character, so a
  // hex string lands as mostly zeros). WIDTH closes nothing — a 31-byte
  // `rowHash` already makes `equalBytes` return `false`, and a wrong-width
  // `prevHash` already changes the preimage — and is guarded so the guarantee
  // above holds as WRITTEN, in one clause, rather than resting on two separate
  // arguments a reader has to reconstruct.
  if (
    !isBytesOfLength(row.prevHash, CHAIN_HASH_LENGTH) ||
    !isBytesOfLength(row.rowHash, CHAIN_HASH_LENGTH)
  ) {
    return { valid: false, failureMode: "hash_mismatch" };
  }

  // STAGE 2 — PLAN-001'S ZERO-FILL PLACEHOLDER, NAMED RATHER THAN INFERRED.
  //
  // `session/session-service.ts` — Plan-001's append path — writes all three
  // integrity columns as zero-fill (32-byte `ZERO_HASH` for `prev_hash` AND
  // `row_hash`, 64-byte `ZERO_SIGNATURE` for `daemon_signature`) so the
  // NOT NULL and `CHECK(length(…))` constraints are satisfied without claiming
  // hash-chain semantics that path does not implement. A row it wrote is
  // neither tampered nor corrupt: it is a row a PRE-SIGNING code path put into
  // a real database, which is an engineering SEQUENCING bug. No such row is
  // known to exist — the first code that will ever durably write one is T3.1,
  // and T3.1 signs — so this is a fail-closed safety net for the one way the
  // case can still arise: wiring the daemon to a real database before T3.1
  // lands.
  //
  // THE PREDICATE IS ALL THREE COLUMNS, NOT THE SIGNATURE ALONE, AND THAT IS A
  // SEVERITY ARGUMENT RATHER THAN A TIDINESS ONE. Keying on `daemon_signature`
  // by itself would also fire on a row that is genuinely TAMPERED and merely
  // happens to carry a zeroed signature, reporting "engineering bug, not an
  // attack" for something that IS an attack — a severity DOWNGRADE in exactly
  // the direction this branch exists to prevent. Requiring all three sends that
  // row on to stage 3, where its surviving non-zero hashes produce the truthful
  // `hash_mismatch`. All three is also the EXACT fingerprint of the write path
  // above, which emits the trio together and never a mix, so the tighter
  // predicate is strictly more precise rather than merely more conservative.
  //
  // IT NARROWS THE DOWNGRADE RATHER THAN REMOVING IT, and the residual is worth
  // naming. An adversary who zero-fills all three columns produces a row
  // BYTE-IDENTICAL to the placeholder write, so no per-row check can tell the
  // two apart and this branch reports the placeholder verdict for both. What
  // CAN catch that row is LINKAGE rather than this function: a zero `prev_hash`
  // at `sequence > 0` breaks I-006-2-04's `prev_hash[n] = row_hash[n-1]`, which
  // the range-walking caller checks — see the SCOPE note above for why that
  // obligation lives there and not here.
  //
  // RE-LINKING IS FREE TO THAT ADVERSARY, SO THE LINKAGE WALK CONSTRAINS ONLY
  // ONE WHO DOES NOT RE-LINK. `row_hash` is UNKEYED BLAKE3 — this module's
  // `blake3` calls pass neither `key` nor `context` — over
  // `prev_hash || canonical`, values a verifier recomputes from the stored row.
  // The commitment that DOES need the key, `ed25519.sign(canonical, …)`, covers
  // the canonical bytes alone, and `prev_hash` is not among
  // `canonicalizeEvent`'s eleven members.
  //
  // A PLACEHOLDER ROW'S `sequence` IS UNCOMMITTED, SO CONTIGUITY IS NOT A
  // BACKSTOP. `sequence` IS one of those eleven members, so a SIGNED row's
  // signature binds it — but a row with three zero-filled integrity columns has
  // no daemon signature, and Plan-001 writes `participant_signature` NULL
  // beside them, so nothing on such a row commits its `sequence`: placeholder
  // rows can be fabricated, deleted, and renumbered. Nor is there a schema rule
  // to fall back on. `0001-initial.ts` documents the column "monotonic per
  // session" under `UNIQUE(session_id, sequence)`, as does
  // `local-sqlite-schema.md`, and neither adds a contiguity constraint.
  //
  // AN UPLOADED ANCHOR PUTS A COMMITMENT OFF THIS MACHINE, AND SOME SPANS NEVER
  // GET ONE. That is what the `anchor_*` range modes verify against: an
  // UPLOADED Merkle anchor (T3.3) commits to real `row_hash` values in the
  // control plane's `event_log_anchors`, a Postgres table rather than this
  // database. An anchor still QUEUED is not that — `pending_anchor_uploads` is
  // a local SQLite table sitting beside `session_events`. V1 node-scope
  // (sentinel `session_id`) rows are not upload candidates at all and keep
  // `uploaded_at` NULL by design, and rows appended since the last anchor sit
  // in no anchor's tree.
  //
  // THIS NOTE DOES NOT BOUND WHICH TAMPERING SHAPES SURVIVE, AND T4.1 MUST NOT
  // READ IT AS IF IT DID. The facts above are mechanical properties of this
  // module, not a threat model: they COMPOSE, and a list of the compositions is
  // not something a comment can keep correct. None is attempted for that
  // reason, and one added later would be a defect rather than an improvement —
  // T4.1 owes the range walk a threat model derived on its own terms.
  //
  // A LEGITIMATE GENESIS ROW MUST NOT TRIP THIS, AND THAT IS NOT OBVIOUS.
  // `0001-initial.ts` documents `prev_hash` as "32 bytes; zero-filled at
  // sequence=0" and {@link GENESIS_PREV_HASH} is that value, so a REAL genesis
  // row signed by T3.1 carries a zero `prev_hash` beside a real `row_hash` and
  // a real signature. The `row_hash` conjunct is what keeps it out: drop that
  // one clause while keeping the `prev_hash` one and every genesis row in the
  // database reports `signature_placeholder`.
  //
  // WHY THE VERDICT MUST BE DISTINCT — DO NOT COLLAPSE THIS BRANCH INTO
  // `signature_mismatch` TO "SIMPLIFY" IT. The two verdicts route to different
  // humans. `signature_mismatch` means POSSIBLE TAMPERING and warrants security
  // incident response; `signature_placeholder` means a build-ordering mistake
  // and warrants a code fix. Conflating them pages the wrong on-call. That is
  // the same wrong-audit-verdict class that already justified two other
  // branches in this module: {@link verifyEd25519}'s public-key THROW (a
  // key-resolution bug reported as a tamper would fire on every row of every
  // session) and stage 1's non-byte chain-column mapping (a tamper reported as
  // a throw would fire on none of them, and go unreported).
  //
  // WITHOUT THIS CHECK THE REFUSAL IS INCIDENTAL, NOT GUARANTEED — AND IT IS
  // MIS-LABELLED EITHER WAY. An all-zero 64-byte signature is SYNTACTICALLY
  // WELL-FORMED: `R` = 32 zero bytes decodes to a valid curve point (y = 0,
  // x = sqrt(-1)) of order 4, and `S` = 0 is a canonical scalar below the group
  // order, so nothing refuses it on shape. What refuses it is the verification
  // equation — with `S` = 0 the left side is the identity, so the equation
  // holds only if `[8][k]A` is the identity too, which for a PRIME-ORDER `A`
  // requires `k ≡ 0 mod L`. The refusal is therefore contingent on the resolved
  // key rather than on any named rule: against a SMALL-ORDER key noble's
  // ZIP-215 default accepts the identical all-zero signature, and only this
  // module's `{ zip215: false }` refuses it there (see {@link verifyEd25519}).
  // Contingent-and-mis-labelled is the whole argument for naming it here.
  //
  // THE SIGNATURE CONJUNCT IS SCOPED TO EXACTLY 64 BYTES, WHICH IS NOT AN
  // OVERSIGHT. `CHECK(length(daemon_signature) = 64)` means a wrong-width
  // all-zero value cannot have come through the INSERT — so it is corruption
  // rather than a placeholder, and it keeps the `signature_mismatch` verdict
  // every other wrong-shaped stored signature gets. The `isBytesOfLength` half
  // also makes this check TOTAL, and it has to stay AHEAD of the all-zero test
  // on that same column: stage 1 validates only the two CHAIN columns, so
  // `daemonSignature` arrives here with its `Uint8Array` declaration still
  // unchecked across the SQLite boundary, and a stored string has no `.every`
  // to call. Guarded, a non-byte value falls through to stage 4 exactly as it
  // did before.
  //
  // The two CHAIN conjuncts deliberately carry no such guard: stage 1 has
  // already proved both are 32-byte `Uint8Array`s, so repeating
  // `isBytesOfLength` here would be dead weight that reads like a live
  // precondition.
  //
  // Deliberately NOT a constant-time comparison. Both operands are public — the
  // placeholder value is fixed and spelled openly in Plan-001's source — and
  // there is no secret to leak, so `.every` is the honest primitive rather than
  // a masked compare. Deliberately not `equalBytes` against shared zero constants
  // either: those would be two more mutable module-level `Uint8Array`s
  // carrying {@link GENESIS_PREV_HASH}'s caller-obligation hazard, bought for
  // nothing.
  if (
    isAllZeroBytes(row.prevHash) &&
    isAllZeroBytes(row.rowHash) &&
    isBytesOfLength(row.daemonSignature, ED25519_SIGNATURE_LENGTH) &&
    isAllZeroBytes(row.daemonSignature)
  ) {
    return { valid: false, failureMode: "signature_placeholder" };
  }

  const recomputedRowHash: Uint8Array = blake3(buildChainInput(row.prevHash, canonical));

  // `equalBytes` accumulates a difference across the whole array instead of
  // early-exiting on the first mismatching byte. Both operands are PUBLIC here
  // — anyone able to tamper with the stored row already holds its `row_hash` —
  // so the non-early-exit form is hygiene rather than a load-bearing control.
  // It is still the right default, and explicitly NOT the register
  // `v4-public.ts` scopes its `bytesEqualStructural` to: that helper is
  // documented for public footer METADATA, whereas this comparison IS an
  // authentication decision. The one thing `equalBytes` leaks is length, which
  // is fixed at 32 and published in the schema. Deliberately not
  // `node:crypto.timingSafeEqual`, which THROWS on a length mismatch: the shape
  // guard above makes both operands 32 bytes, so that throw is unreachable HERE
  // — but only because of the guard, and a comparison whose no-throw property
  // rests on a precondition a dozen lines up is the wrong primitive for a
  // function contracted to REPORT a malformed row rather than raise on it.
  // `equalBytes` also keeps this module on one byte-utility source, with no
  // `node:crypto` import.
  if (!equalBytes(recomputedRowHash, row.rowHash)) {
    return { valid: false, failureMode: "hash_mismatch" };
  }

  return verifyEd25519(canonical, row.daemonSignature, daemonPublicKey)
    ? { valid: true }
    : { valid: false, failureMode: "signature_mismatch" };
}

// --------------------------------------------------------------------------
// Participant attestation — the optional second signature.
// --------------------------------------------------------------------------

/**
 * Mints `participant_signature` = `Ed25519(participant_signing_key,
 * canonical_bytes(row))` per `Plan-006 §Ed25519 Signatures`, over the SAME
 * canonical bytes {@link signRow} hashed and daemon-signed — so I-006-2-06
 * holds across both attestations on a row, not just the daemon's.
 *
 * WRITE-SIDE MECHANISM ONLY.
 * `Plan-006 §Open Authoring Decisions (Category 2 — Audit-Surfaced)` puts the
 * WHEN-to-mint decision in Plan-002 / Plan-022 territory; this function decides
 * it not at all, refuses no category, and consults no registry. The
 * WHICH-events-are-sensitive enum is contracts-package territory that has NOT
 * landed: Plan-006 T4.6 owns it, and owes a taxonomy derivation before it can
 * be written, because the source of truth is PROSE rather than an enumeration —
 * `Security Architecture §Per-Event Daemon Signature` describes the sensitive
 * set as approvals, policy changes, and membership revocations, with the column
 * NULL for events that need no participant attestation. Nothing in this plan
 * needs the enum before Phase 4:
 * `Security Architecture §Verification Rules` rule 2 verifies a participant
 * signature only "if present".
 *
 * KEY-CONFUSION RESIDUE, left open at this layer on purpose, and smaller than
 * the parameter type first suggests. This function takes the same
 * {@link Ed25519PrivateKey} as `signRow`'s daemon key, so passing the DAEMON key
 * here mints a `participant_signature` over bytes `daemon_signature` already
 * covers. On its own that forges nothing: the read side resolves the
 * PARTICIPANT's public key ({@link verifyParticipantSignature}), and a
 * daemon-key signature does not verify against it. The single-sided write bug
 * is therefore FAIL-CLOSED — it surfaces as `signature_mismatch` on every
 * sensitive event, which is noisy and misattributed rather than a silent
 * forgery. Collapsing the independent second attestation into a duplicate of
 * the first takes BOTH sides mis-plumbed, which is why the closure site is the
 * one layer that owns both — the caller routing keys: Plan-002 / Plan-022.
 *
 * A distinct `ParticipantSigningKey` brand would close the write side by
 * construction and is NOT minted here because it would pre-commit surfaces that
 * do not exist yet: T2.7's published interface types its unseal path as
 * `Ed25519PrivateKey`, and the participant key has two unimplemented
 * derivations — the WebAuthn PRF-derived key on desktop and ADR-021's at-rest
 * identity key on CLI, per
 * `Security Architecture §Per-Event Daemon Signature`.
 */
export function mintParticipantSignature(
  canonical: CanonicalBytes,
  participantSigningKey: Ed25519PrivateKey,
): Uint8Array {
  return ed25519.sign(canonical, participantSigningKey);
}

/**
 * Read-side counterpart of {@link mintParticipantSignature} — the second clause
 * of `Security Architecture §Verification Rules` rule 2: "If
 * `participant_signature` is present, verify it with the participant's public
 * key."
 *
 * Returns a boolean rather than a {@link RowVerification} because there is
 * nothing to discriminate: a participant-signature failure maps onto the same
 * `signature_mismatch` mode rule 2 already carries, and this check has no chain
 * half. ABSENCE is not this function's business either — the column is NULL for
 * every event needing no participant attestation, so whether a missing
 * signature is legitimate is the caller's question, and callers invoke this only
 * for a signature that is present. Answering that question is what the
 * WHICH-events-are-sensitive enum is for, and it has not landed: T4.6 owns it,
 * per {@link mintParticipantSignature}'s note.
 */
export function verifyParticipantSignature(
  canonical: CanonicalBytes,
  participantSignature: Uint8Array,
  participantPublicKey: Ed25519PublicKey,
): boolean {
  return verifyEd25519(canonical, participantSignature, participantPublicKey);
}

// --------------------------------------------------------------------------
// Internals.
// --------------------------------------------------------------------------

/**
 * Materializes `prev_hash || canonical_bytes(row)` — the BLAKE3 preimage
 * `Plan-006 §Hash Chain` specifies.
 *
 * Explicit concatenation rather than a streaming
 * `blake3.create().update(prevHash).update(canonical).digest()`. The two are
 * byte-identical (BLAKE3 absorbs one stream, so a split absorb IS the
 * concatenation) and the streaming form would avoid copying the canonical
 * bytes, but this module exists for byte agreement with independent verifiers,
 * so the code is written the way the spec's formula reads and that equivalence
 * is not something a reviewer has to take on faith. The cost is one transient
 * allocation per row, against canonical bytes the same call already hands to
 * `ed25519.sign` uncopied.
 */
function buildChainInput(prevHash: Uint8Array, canonical: CanonicalBytes): Uint8Array {
  const chainInput = new Uint8Array(prevHash.length + canonical.length);
  chainInput.set(prevHash, 0);
  chainInput.set(canonical, prevHash.length);
  return chainInput;
}

/**
 * `ed25519.verify` under STRICT RFC 8032 rules, with a decode failure folded
 * into `false` and a mis-plumbed public key raised as a throw.
 *
 * STRICT, NOT ZIP-215, AND THE OPTION IS LOAD-BEARING. noble's ed25519 wrapper
 * is constructed with ZIP-215 semantics for consensus compatibility
 * (`Object.assign({ adjustScalarBytes, zip215: true }, opts)` in `ed25519.js`),
 * so a bare `ed25519.verify(sig, msg, pk)` runs the PERMISSIVE rules. Two of
 * their relaxations are unacceptable for an audit log:
 *
 * - SMALL-ORDER PUBLIC KEYS. Strict mode rejects a small-order `A'`, and
 *   noble's own comment says why: "for SBS-style non-repudiation and to avoid
 *   ambiguous verification outcomes where unusual low-order keys can make
 *   distinct key/signature/message combinations verify." Non-repudiation is
 *   exactly this module's job — an audit-log signature attests that ONE daemon
 *   emitted ONE row. Let a small-order public key be registered for a `NodeId`
 *   and the `[8][k]A` term vanishes from the cofactored equation, so a single
 *   fixed `(R, S)` verifies against ANY canonical bytes: universal forgery for
 *   that node, every forged row reported `valid: true`.
 * - NON-CANONICAL ENCODINGS. ZIP-215 widens the accepted `y` range from
 *   `0 <= y < P` to `0 <= y < 2^256`, so it accepts encodings an RFC 8032
 *   verifier refuses. `Security Architecture §Per-Event Daemon Signature` makes
 *   RFC 8032 §5.1 normative and `Spec-006 §Canonical Serialization Rules` exists
 *   so independent implementations agree byte-for-byte; a verdict reproducible
 *   only by OUR verifier is not a verdict this protocol can make.
 *
 * Pure tightening with no false-negative risk: noble's `sign` always emits a
 * canonical `R` and a reduced `S`, and a public key derived from a clamped
 * scalar is never small-order, so every honestly-produced signature verifies
 * identically under both rule sets.
 *
 * A WRONG-SHAPED PUBLIC KEY THROWS; EVERYTHING ELSE IS A VERDICT. noble does NOT
 * let a decode failure escape — `abstract/edwards.js` wraps
 * `Point.fromBytes(publicKey)`, `Point.fromBytes(r)`, and
 * `BASE.multiplyUnsafe(s)` in its own `try { … } catch { return false }`. What
 * escapes is the `abytes(...)` type/width validation running OUTSIDE that try,
 * on all three arguments. For the SIGNATURE, converting that throw to `false` is
 * the right verdict and the catch below keeps it: a signature comes off the
 * STORED row, so a wrong-width or non-byte one IS adversarial data and
 * `signature_mismatch` is what T4.1 should report. For the PUBLIC KEY it is not:
 * the caller RESOLVES it from the participant roster, so a wrong-shaped one is a
 * plumbing bug — T2.7's unvalidated `as Ed25519PublicKey` cast, a truncated
 * keystore read, a mis-sliced roster record — and folding it into
 * `signature_mismatch` would make T4.1 emit `audit_integrity_failed` on EVERY
 * row of EVERY session, halting replay and paging an operator for a tamper that
 * never happened, with the real cause discarded. The guard lives HERE and not in
 * {@link verifyRow} because {@link verifyParticipantSignature} reaches this same
 * helper, and it runs BEFORE the call so a request carrying both a bad key and a
 * bad signature reports the caller bug, which dominates.
 *
 * The catch stays for the signature verdict and as forward insulation — noble's
 * internal try is an implementation detail of the pinned version, not a
 * documented contract. `crypto-paseto`'s `verifyV4Public`
 * (`packages/crypto-paseto/src/v4-public.ts`) wraps the same call in the same
 * try/catch, with the OPPOSITE outcome: it re-raises as
 * `InvalidTokenError("signature decode failed")`, because that module's
 * vocabulary for a bad token is a typed error, whereas this module's vocabulary
 * for a bad row is a verification outcome. A signature that cannot be DECODED is
 * a signature that does not VERIFY, and
 * `Spec-006 §Audit Integrity (audit_integrity)`'s `failureMode` enum has no
 * malformed-input arm, so there is no third outcome to report.
 */
function verifyEd25519(
  message: CanonicalBytes,
  signature: Uint8Array,
  publicKey: Ed25519PublicKey,
): boolean {
  if (!isBytesOfLength(publicKey, ED25519_PUBLIC_KEY_LENGTH)) {
    throw new Error(
      `Ed25519 verification requires a ${ED25519_PUBLIC_KEY_LENGTH}-byte Uint8Array public key — the NodeId-resolved key from the session participant roster per Spec-006 §Canonical Serialization Rules — but received ${describeByteShape(publicKey)}. That is a key-resolution bug, not a tampered row: reporting it as signature_mismatch would raise audit_integrity_failed on every row it touches.`,
    );
  }

  try {
    // `{ zip215: false }` is the whole strictness decision — see the note above.
    // It is NOT the library default for this curve.
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Byte-ness AND width, taking `unknown` rather than `Uint8Array` deliberately.
 *
 * Every call site holds a value whose DECLARED type is already `Uint8Array`,
 * and that is the point: the declaration is a claim the compiler could not
 * check. `row.prevHash` / `row.rowHash` / `row.daemonSignature` crossed the
 * SQLite boundary; `publicKey` crossed a roster lookup and T2.7's cast;
 * `signRow`'s `prevHash` can itself be a stored `row_hash` read back out of
 * SQLite. An `unknown` parameter keeps the check honest — nothing is narrowed
 * on the way in — and keeps the `instanceof` from reading as redundant against
 * a type nothing enforced.
 *
 * NARROWER THAN NOBLE'S `abytes`, AND THAT DIRECTION IS THE WHOLE GUARANTEE.
 * `abytes` delegates to `isBytes` (`@noble/hashes@2.2.0`'s `utils.js`, the same
 * function `@noble/curves` re-exports), which accepts `instanceof Uint8Array` OR
 * any `ArrayBuffer` view whose `constructor.name` is `Uint8Array` with
 * `BYTES_PER_ELEMENT === 1` — so noble also admits a cross-realm view
 * `instanceof` refuses. Containment runs one way: every value this accepts is
 * one noble accepts, so the divergence can only produce an EARLIER, more
 * conservative refusal HERE, never a value that clears this check and then trips
 * a library-side type refusal. That is the only direction the call sites need;
 * equivalence was never required. A better-sqlite3 `Buffer` passes both, since
 * `Buffer extends Uint8Array`.
 */
function isBytesOfLength(value: unknown, expectedLength: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === expectedLength;
}

/**
 * Every byte is zero — {@link verifyRow}'s stage-2 predicate, applied to each
 * of the three integrity columns in turn.
 *
 * Takes `Uint8Array` rather than `unknown`, unlike {@link isBytesOfLength}, and
 * that asymmetry is deliberate: this helper CANNOT establish byte-ness, because
 * `.every` does not exist on a stored `string` and calling it would throw. It
 * is safe only behind a byte-ness proof, which at every call site is either
 * stage 1 (the two chain columns) or an `isBytesOfLength` conjunct evaluated
 * first (the signature). Widening it to `unknown` would hide that obligation.
 *
 * An empty array returns `true` by `.every`'s vacuous-truth rule; no call site
 * can reach it, since all three are length-proved before they get here.
 */
function isAllZeroBytes(candidateBytes: Uint8Array): boolean {
  return candidateBytes.every((byteValue) => byteValue === 0);
}

/**
 * Renders a refused value for a throw message without trusting its declared
 * type — `value.length` on a `string` would report a character count as a byte
 * count and send the reader after the wrong bug.
 */
function describeByteShape(value: unknown): string {
  return value instanceof Uint8Array
    ? `${value.length} bytes`
    : `a non-Uint8Array value of type ${typeof value}`;
}
