// PII indirection codec — the sole producer of non-null
// `session_events.pii_payload` bytes (Plan-006 T2.4).
//
// `Plan-006 §Encrypt-Then-Digest-Then-Sign Order` fixes a seven-step write
// recipe whose ORDER carries the entire safety argument: encrypt → digest →
// embed → canonicalize → sign. `Spec-022 §Signature Safety Under Shred` proves
// that a crypto-shredded row STILL verifies, and the proof rests on exactly one
// property — the signature commits to `pii_ciphertext_digest`, a BLAKE3 digest
// living inside `payload`, and never to the ciphertext column. Sign the
// ciphertext directly and the proof collapses in the wrong direction: signed
// bytes derived from PII would outlive the shred, handing an attacker length
// and structure oracles over data the shred was supposed to erase.
//
// ORDER IS ENFORCED BY TYPES, NOT BY DISCIPLINE (I-006-2-01). Each stage
// consumes a phantom brand only the previous stage can mint, so running the
// pipeline out of order is a TypeScript error rather than a runtime integrity
// bug:
//
//   `RawEventInput`
//     → `PiiPayloadCiphertext`   (minted here, and only here)
//     → `EventWithPiiDigest`     (minted here, and only here)
//     → `CanonicalBytes`         (minted only inside `canonicalizer.ts`)
//     → `SignedRow`              (minted only by `signer.ts`'s `signRow`)
//
// NO CONSTRUCTOR, CAST HELPER, FACTORY, OR BRAND SYMBOL IS EXPORTED for either
// brand this module mints — the same stance `canonicalizer.ts` takes for
// `CanonicalBytes` and `signer.ts` takes for `Ed25519PrivateKey`. One exported
// mint helper would void the guarantee for every downstream caller at once.
//
// THIS MODULE PRODUCES `pii_payload`; IT DOES NOT PERSIST IT (I-006-2-02). The
// brand is what makes that split enforceable: a persistence helper typing its
// column parameter `PiiPayloadCiphertext | null` can be handed a non-null value
// only by code that ran this pipeline, so "sole write path" becomes a compile
// error for everyone else instead of a convention. Plan-001's shipped
// `SessionService.append` hardcodes `pii_payload = NULL` (no ciphertext
// parameter exists yet); T3.1's `EventLogService.append` — the sole append path,
// holder of the per-session append lock — is the module that grows that
// parameter and writes the row.
//
// T3.1 INHERITS A SECOND, LESS OBVIOUS COLUMN OBLIGATION: the participant-id
// stamp on {@link PiiEventWriteResult}. `Spec-022 §Shred Fan-Out` Path 1 states
// that the shred selector "uses the durable participant-id stamp on the event
// row, not the ciphertext (which is opaque)", and `0001-initial.ts` has no such
// column — `session_events.actor` is documented there as "participant_id or
// agent_id or NULL for system", which is a different value with a different
// meaning (see {@link PiiEncryptionRequest.participantId}). Unlike `pii_payload`,
// which at least exists and is written NULL, the stamp column does not exist at
// all; adding it is an additive migration under the `session_events` row of
// `docs/architecture/cross-plan-dependencies.md §1. Table Ownership Map`, and
// this module holds no lock, writes no row, and owns no migration. So the value
// leaves here in the RETURN TYPE and stops there — the same produce-here /
// persist-there split the paragraph above draws for the ciphertext itself.
//
// LAYER 2 OF I-006-3-01 LIVES HERE. `audit_integrity` and `event_maintenance`
// events are never compacted and never crypto-shredded
// (`Plan-006 §Audit Integrity Invariant`; declared symmetrically in
// `Spec-006 §Audit Integrity (audit_integrity)` and
// `Spec-006 §Event Maintenance (event_maintenance)`), so their `pii_payload` is
// NULL by construction. Both halves of that rule ship: `RawEventInput` makes
// attaching PII to those categories a compile error (I-006-2-07) and
// `writeEventWithPii` refuses the categories outright at runtime. The
// runtime half is not redundant — the compile-time half is a claim about values
// TypeScript actually checked, and an event arriving across a serialization
// boundary or an `as` cast is a value where that claim is simply untrue. The
// sibling `signer.ts` needed byte-guards for the same reason: a `BLOB` column
// can hand back a JS `string` past a `Uint8Array`-typed signature.
//
// IDEMPOTENCY CLASS: `manual_reconcile_only`, and deliberately NOT `idempotent`.
// The PII cipher is AES-256-GCM under a fresh random 96-bit nonce per write
// (`Spec-022 §PII Payload Column Pattern`), which NIST SP 800-38D §8.2 requires
// precisely because nonce reuse under one key is catastrophic — so a re-run
// produces different ciphertext, a different digest, different canonical bytes,
// and a different `row_hash` / `daemon_signature`. Re-running this codec after a
// partial failure therefore mints a SECOND, unrelated commitment rather than
// reproducing the first; recovery is operator-driven reconciliation. The
// contrast with `signer.ts` is exact and worth holding onto: Ed25519 derives its
// nonce from the key and the message (RFC 8032 §5.1.6), so T2.2 IS `idempotent`
// and its re-runs reproduce bytes. For that reason the refusals this module can
// raise FROM THE INPUT ALONE are ordered before the encrypt step, so a rejected
// append costs no nonce — three of them hoisted out of the downstream stages
// that still run them: T2.1's sequence guard, T2.2's `prevHash` guard, and the
// signing-key shape check `ed25519.sign` performs at the bottom of T2.2's own
// signature call. That third one fronts a LIBRARY guard rather than a sibling
// module's, which makes it the one hoist that is NARROWER than what it stands
// in for instead of identical to it; the guard itself says why that is still
// only ever an early refusal. TWO CLASSES STAY BEHIND THE ENCRYPT and
// `writeEventWithPii` names both: the shape of the encryptor's own RESULT,
// which does not exist until it has run, and `payload`'s own RFC 8785 refusals.
// Those last are not one story — the nesting ceiling admits no honest pre-check
// short of a second canonicalization of the same row, while T2.1's RFC 8785
// §3.2.2.2 well-formedness guard COULD be pre-checked exactly and simply is not;
// `writeEventWithPii`'s own note draws that line rather than letting the harder
// case speak for both.
//
// CP-006-1 — THE PLAN-022 BOUNDARY. `PiiEncryptor` is an INTERFACE owned here;
// Plan-022 (Tier 5) ships the AES-256-GCM implementation in
// `crypto/pii-codec.ts` and the composition root injects it. Plan-006 cannot
// import from Plan-022 — it sits a tier below — so nothing in this file reaches
// for that module, and the same holds for the `splitPii` partition Plan-022
// owns: `RawEventInput` is SHAPED to receive its `{payload, piiPayload}`
// output, and this module never calls it. CP-006-1 also obliges the composition
// root to inject the real codec — never a test stub — with a runtime assertion
// against the stub outside tests. Neither the stub nor that assertion lives in
// this file: T2.5 owns a test-only stub and the daemon bootstrap owns the
// assertion.
//
// Refusals here throw a plain `Error`, matching the deliberate deferral
// `canonicalizer.ts` documents for this package: the migration target, when a
// caller first needs to discriminate a refusal from any other throw, is
// `ipc/domain-error.ts`'s `DaemonDomainError` under an `event.*` code registered
// in `docs/architecture/contracts/error-contracts.md §Error Codes`.
//
// In-package surface for now: `src/index.ts` does not re-export this module,
// matching T2.1 and T2.2.
//
// Refs: `Plan-006 §PII Columns`, `Plan-006 §Encrypt-Then-Digest-Then-Sign Order`,
// `Plan-006 §Audit Integrity Invariant`, `Spec-006 §Canonical Serialization Rules`,
// `Spec-022 §PII Payload Column Pattern`, `Spec-022 §Signature Safety Under Shred`,
// `Spec-022 §Ordering And Atomicity`.
import type { EventCategory, EventEnvelope } from "@ai-sidekicks/contracts";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CanonicalBytes } from "./canonicalizer.js";
import { canonicalizeEvent, canonicalizeJson, normalizeOccurredAt } from "./canonicalizer.js";
import type { Ed25519PrivateKey, SignedRow } from "./signer.js";
import { signRow } from "./signer.js";

/**
 * The `payload` member name carrying the BLAKE3 digest of the ciphertext.
 *
 * `Spec-006 §Canonical Serialization Rules` names this key verbatim and in
 * snake_case, so it is spelled exactly as the spec does rather than folded to
 * the surrounding camelCase: it is a WIRE name that lands inside the signed
 * canonical bytes, and every independent verifier reads it by that spelling.
 *
 * Exported because two downstream tasks assert on it rather than re-typing the
 * literal: T3.1's append path refuses any `append()` whose `payload` carries a
 * PII-tagged field WITHOUT this key, and T2.5's post-shred property suite reads
 * it back out of the canonical bytes. Declared `as const` — the idiom contracts
 * uses for `SOURCE_EPOCH_PAYLOAD_KEY`, its sibling payload-key registration — so
 * the type stays the literal rather than widening to `string`, which is what
 * keeps the computed-key write below exactly typed.
 */
export const PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY = "pii_ciphertext_digest" as const;

// --------------------------------------------------------------------------
// Brands.
// --------------------------------------------------------------------------

/**
 * The encrypted bytes destined for the `session_events.pii_payload` column —
 * the AEAD output of the injected {@link PiiEncryptor}, admitted into the type
 * system at exactly one site: {@link writeEventWithPii}, below.
 *
 * That single site IS I-006-2-02. A persistence helper typing its column
 * parameter `PiiPayloadCiphertext | null` can then only receive a non-null value
 * from code that ran encrypt → digest → embed → canonicalize → sign in order,
 * because nothing else can produce the brand. This is also why
 * {@link PiiEncryptor} returns a BARE `Uint8Array`: were the interface to return
 * the brand, its Plan-022 implementation would have to mint one to satisfy the
 * signature, and any caller could then invoke the codec directly and hand the
 * result to the INSERT — bypassing the digest, the embed, and the signature in a
 * single well-typed call, defeating I-006-2-01 and I-006-2-02 together.
 *
 * Brand shape mirrors the contracts-package convention (`SessionId`,
 * `EventEnvelopeVersion`), T2.1's `CanonicalBytes`, and T2.2's
 * `Ed25519PrivateKey`. No constructor, mint helper, or brand symbol is exported.
 */
export type PiiPayloadCiphertext = Uint8Array & { readonly __brand: "PiiPayloadCiphertext" };

/**
 * An {@link EventEnvelope} whose `payload` already carries
 * {@link PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} and whose `occurredAt` is already in
 * the canonical RFC 3339 UTC millisecond form — i.e. the exact envelope whose
 * canonical bytes were hashed and signed.
 *
 * The third link in the I-006-2-01 chain, and the one that leaves the module:
 * the persisting caller (T3.1) is handed THIS type rather than a bare
 * `EventEnvelope`, so "the row I am about to write is the row that was signed"
 * is carried in the type instead of asserted in a comment. Producible only by
 * the embed stage below, which itself requires a {@link PiiPayloadCiphertext}
 * and so cannot run before the encrypt stage.
 *
 * PERSIST THIS ENVELOPE, NOT THE CALLER'S INPUT. `occurredAt` normalization is
 * many-to-one and `payload` gained a member, so the input envelope and this one
 * are different rows; only this one reproduces the signed bytes on verification.
 */
export type EventWithPiiDigest = EventEnvelope & { readonly __brand: "EventWithPiiDigest" };

// --------------------------------------------------------------------------
// CP-006-1 — the injected encryptor boundary.
// --------------------------------------------------------------------------

/**
 * One PII encryption request. The two identifier members exist to be BOUND, not
 * merely logged: `Spec-022 §PII Payload Column Pattern` fixes the AEAD's
 * associated data as `participant_id || event_id`, which is what makes a
 * ciphertext non-replayable onto another participant or another event.
 */
export interface PiiEncryptionRequest {
  /**
   * The participant whose content key encrypts this PII, and the row whose
   * DELETE from `participant_keys` crypto-shreds it. Supplied explicitly rather
   * than derived from the envelope's `actor`, which may be an agent id or
   * `null` for a system event and so cannot name a key holder.
   */
  readonly participantId: string;
  /** The `EventEnvelope.id` of the event this ciphertext belongs to. */
  readonly eventId: string;
  /**
   * The PII partition serialized to RFC 8785 canonical JSON, UTF-8 encoded.
   *
   * The serialization is fixed HERE, by this module, so the eventual decrypt
   * counterpart has a written convention to mirror rather than a shape to guess.
   * It is deliberately the same serializer the canonical bytes use (T2.1's
   * `canonicalizeJson`) rather than `JSON.stringify`: one serializer in this
   * module, and the RFC 8785 path refuses `NaN` / `Infinity` / a value with no
   * JSON representation loudly where `JSON.stringify` would emit `null` or
   * nothing at all — silent mangling is the wrong failure mode for data that is
   * about to become irrecoverable. It also inherits `canonicalizeJson`'s nesting
   * ceiling, which no realistic PII partition approaches.
   */
  readonly plaintext: Uint8Array;
}

/**
 * The AEAD seam Plan-022 fills (CP-006-1 / CP-022-1) — declared here, injected
 * at the composition root, implemented in `crypto/pii-codec.ts` at Tier 5.
 *
 * Returns BARE bytes on purpose; see {@link PiiPayloadCiphertext} for why the
 * brand must not cross this boundary. The implementation owns the wire format
 * (`iv || ciphertext || tag`), the 96-bit random nonce, the AAD binding, and the
 * per-participant key lookup; this module owns none of those and asserts nothing
 * about the returned width, since the interface does not fix an AEAD.
 *
 * DECRYPT IS NOT DECLARED HERE. This module is the write path, and a read-side
 * method on a write-side interface would be surface no caller in this phase can
 * use. The read path (`Plan-006 §PII Columns`, and the Phase-4 task that
 * implements it) declares its own counterpart against the plaintext convention
 * documented on {@link PiiEncryptionRequest.plaintext}.
 */
export interface PiiEncryptor {
  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array>;
}

// --------------------------------------------------------------------------
// RawEventInput — the I-006-2-07 discriminated union.
// --------------------------------------------------------------------------

/**
 * The two categories that carry no participant PII, ever
 * (`Plan-006 §Audit Integrity Invariant`).
 */
export type PiiRefusedCategory = "audit_integrity" | "event_maintenance";

/**
 * Every other category. Derived by `Exclude` rather than enumerated, so a
 * category added to contracts is PII-eligible by default — which is the correct
 * default: the closed set is the refused one, named by the invariant, and a new
 * category that should join it is an invariant amendment, not an omission here.
 */
export type PiiEligibleCategory = Exclude<EventCategory, PiiRefusedCategory>;

/**
 * The canonical envelope members every input carries, tracked against
 * `EventEnvelope` by `Omit` so a twelfth member added in contracts arrives here
 * automatically instead of silently going unwritten.
 *
 * `actor` is re-declared NARROWER than the envelope's `string | null | undefined`
 * — it is required and two-state. `canonicalizeEvent` documents a PRECONDITION
 * that `actor` already be in its storage-representable shape, because
 * `session_events.actor` collapses absent and `null` onto one row while the
 * canonical bytes distinguish them: signing an ABSENT `actor` for a row that
 * persists SQL NULL emits bytes no verifier can reproduce from the stored row.
 * Making the narrowing a precondition of THIS type discharges it at compile time
 * for the PII path, at zero cost — the caller must produce the narrowed value
 * anyway. `correlationId` / `causationId` carry no such hazard (the envelope
 * types them non-nullable, so storage round-trips force `undefined` on both
 * sides) and are left in lockstep with contracts.
 */
interface RawEventCommonFields extends Readonly<Omit<EventEnvelope, "category" | "actor">> {
  readonly actor: string | null;
}

/**
 * An event whose category may carry PII, together with the partition to encrypt.
 *
 * `payload` and `piiPayload` are the two halves of Plan-022's `splitPii`
 * partition, which the EMITTER runs at the call site (a pure classification per
 * Plan-022's own invariant). This module consumes the partition and never
 * performs it — the split is Plan-022-owned and Plan-006 cannot import from a
 * higher tier.
 *
 * `piiPayload` is REQUIRED, not optional: this codec is the PII write path, and
 * an event with no PII has no business here. T3.1's plain append path handles
 * every event whose `pii_payload` stays NULL.
 */
export interface PiiCarryingEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiParticipantId: string;
  readonly piiPayload: Record<string, unknown>;
}

/**
 * An `audit_integrity` / `event_maintenance` event — the arm that exists to be
 * REFUSED (I-006-2-07).
 *
 * `piiPayload?: never` is precise about what it buys and what it does not.
 * It buys the compile-time half: an object literal in either category that
 * attaches a PII partition fails to type-check, so no well-typed producer can
 * route participant PII into a never-shredded row. It does NOT make the arm
 * unconstructible — a caller can still build a PII-free value of these
 * categories and pass it — which is exactly why {@link writeEventWithPii} refuses
 * the categories at runtime as well (I-006-3-01 layer 2).
 *
 * That inhabitability is why both members are OPTIONAL `never` rather than
 * required `never`. A required `never` member has no inhabitant at all, so no
 * value of this arm could be built and nothing could reach the runtime guard
 * *through the type* — the arm would be a type-level ghost instead of the input
 * the guard exists to refuse, and layer 2 would be left guarding only values
 * that bypassed the type system entirely.
 */
export interface PiiRefusedEventInput extends RawEventCommonFields {
  readonly category: PiiRefusedCategory;
  readonly piiParticipantId?: never;
  readonly piiPayload?: never;
}

/**
 * The codec's input — a discriminated union on `category` (I-006-2-07).
 *
 * Keyed off the real `EventCategory` union from contracts rather than loose
 * string literals, so a category rename or removal in the wire contract surfaces
 * here as a type error instead of a silently unreachable branch.
 */
export type RawEventInput = PiiCarryingEventInput | PiiRefusedEventInput;

/**
 * Everything the caller needs to persist one PII-carrying row, frozen at the
 * moment the signature was minted.
 *
 * Composed rather than an extension of `SignedRow`: that type documents itself
 * as "exactly what {@link signRow} computes, no more", and hanging an envelope
 * and a ciphertext off it would make it lie about its own shape — the same
 * reasoning by which it omits `participantSignature`.
 *
 * CALLER OBLIGATION — PERSIST THESE FOUR AS A UNIT. `envelope` supplies
 * `payload` (carrying the digest) and the normalized `occurredAt`; `piiPayload`
 * is the `pii_payload` column; `signedRow` supplies `prev_hash` / `row_hash` /
 * `daemon_signature`; `piiParticipantId` is the stamp the shred selector reads.
 * Substituting one of the first three — a re-canonicalized envelope, a
 * re-encrypted ciphertext, a `prev_hash` read again after the signature was
 * minted — produces an untampered row that can never verify, because the
 * verifier recomputes the digest and the signature from what was STORED.
 * `piiParticipantId` fails DIFFERENTLY, which is why it is spelled out here
 * rather than folded into that list: it sits outside the canonical bytes by
 * design, so a wrong or missing value verifies cleanly forever while naming the
 * wrong key. This is step 7 of `Plan-006 §Encrypt-Then-Digest-Then-Sign Order`
 * and it belongs to T3.1, which owns the INSERT and the lock.
 *
 * CALLER OBLIGATION — TREAT `payload` AS FROZEN FROM THIS RETURN UNTIL THE
 * INSERT COMMITS. `envelope.payload` is a SHALLOW copy of the caller's: this
 * module adds the digest key and nothing else, so every nested structure inside
 * it is still the caller's own object, reachable from both sides of the split.
 * The canonical bytes walked that tree ONCE, at the instant of signing, so a
 * write into `input.payload.someNested.field` after this return persists bytes
 * the signature does not cover — the same untampered-but-unverifiable row as a
 * substitution, by a quieter route. T2.2 buys its way out of the analogous
 * hazard with a defensive copy of `prevHash`, but that is 32 fixed bytes; a
 * payload tree of unbounded depth is not the same purchase, and deep-copying
 * would charge every append for it while only moving the alias to the caller's
 * side. Like T2.2's echo, this is an obligation and not an enforcement: the
 * brands make ORDER a compile error, and this is not that.
 */
export interface PiiEventWriteResult {
  readonly envelope: EventWithPiiDigest;
  /**
   * The participant whose content key sealed `piiPayload` — echoed out of
   * {@link PiiEncryptionRequest.participantId} as it was bound into the AEAD's
   * associated data (`participant_id || event_id`,
   * `Spec-022 §PII Payload Column Pattern`).
   *
   * ECHOED RATHER THAN LEFT FOR THE CALLER TO RE-READ OFF ITS OWN INPUT. The
   * caller does still hold `input.piiParticipantId`, so this is not the only
   * reachable copy — it is the only one the persistence contract admits.
   * {@link EventWithPiiDigest} already says PERSIST THIS ENVELOPE, NOT THE
   * CALLER'S INPUT, and a result that made T3.1 reach back into the input for
   * one of the four column values it writes would reopen exactly the reach-back
   * that rule closes. `signer.ts` makes the same call for `SignedRow.prevHash`,
   * which the caller also still holds.
   *
   * NOTHING ELSE ON THE ROW RECOVERS IT. `actor` is a different value —
   * `0001-initial.ts` documents that column "participant_id or agent_id or NULL
   * for system", and {@link PiiEncryptionRequest.participantId} says why the key
   * holder cannot be derived from it. The ciphertext does not carry it either:
   * AEAD associated data is authenticated, not transported, so `participant_id`
   * is an INPUT to any future decrypt rather than an output of it. Persist no
   * stamp and the row is unreadable once its key is gone AND invisible to the
   * Path-1 selector in `Spec-022 §Shred Fan-Out` that was supposed to shred it.
   *
   * NOT IN THE CANONICAL BYTES, DELIBERATELY. `embedCiphertextDigest` projects
   * envelope members one at a time and never spreads the input, so this value
   * cannot reach the signature — and should not: it is row metadata, and signing
   * a participant identifier would leave it legible in bytes that outlive the
   * shred, which is the shape of hazard `Spec-022 §Signature Safety Under Shred`
   * exists to keep out of the signed form.
   *
   * Plain `string`, matching {@link PiiEncryptionRequest.participantId} and
   * `session/types.ts`'s `MembershipProjection.participantId`, rather than the
   * contracts-side branded `ParticipantId`: nothing on this path mints that
   * brand, and its schema requires a UUID this module has no standing to demand
   * of an injected key holder.
   */
  readonly piiParticipantId: string;
  readonly piiPayload: PiiPayloadCiphertext;
  readonly signedRow: SignedRow;
}

/**
 * The `prev_hash` width `signer.ts`'s `signRow` enforces, re-spelled here for
 * the pre-encrypt guard in {@link writeEventWithPii} rather than imported —
 * `signer.ts` keeps its own `CHAIN_HASH_LENGTH` module-private, and widening
 * that module's export surface for one integer buys less than it costs.
 * `signer.golden.test.ts` re-declares the same constant for the same reason.
 *
 * DRIFT HERE IS ONE-DIRECTIONAL AND LOUD, which is what makes the second
 * spelling safe. This value is only ever consulted to refuse EARLY, and
 * `signRow`'s own guard still runs afterwards over the same argument, so a
 * stale value here can produce a false refusal — never a signature over a
 * wrong-width chain link.
 */
const CHAIN_HASH_LENGTH = 32;

/**
 * The RFC 8032 §5.1.5 secret-seed width, re-spelled here for the pre-encrypt
 * `daemonSigningKey` guard on exactly {@link CHAIN_HASH_LENGTH}'s terms. Neither
 * sibling offers it to import: `signer.ts` fixes no SECRET-seed constant at all
 * — its `Ed25519PrivateKey` note defers the width to `ed25519.sign` on purpose —
 * and T2.7's `signing-key-source.ts` keeps its own `ED25519_KEY_LENGTH`
 * module-private, so reaching either would mean widening a sibling's export
 * surface for one integer.
 *
 * THE LIBRARY DOES OFFER ONE, AND DECLINING IT IS A CHOICE RATHER THAN AN
 * OVERSIGHT. `ed25519.lengths` is a frozen member of the frozen curve object
 * noble returns, and the very guard this constant fronts reads it: `sign` →
 * `getExtendedPublicKey` → `getPrivateScalar`, which calls
 * `abytes(key, lengths.secretKey, 'secretKey')` in `abstract/edwards.js`. So
 * `ed25519.lengths.secretKey` would read the authority itself and retire the
 * drift hazard instead of bounding it. Declined on the house precedent
 * `signer.ts` sets one module over: its `ED25519_PUBLIC_KEY_LENGTH` hardcodes 32
 * and CITES `lengths.publicKey` rather than reading it. Reading the library
 * constant is worth doing in all three 32-byte spellings at once rather than in
 * this one alone — and until then, the note below is what makes the hardcode
 * safe.
 *
 * DRIFT HERE IS ONE-DIRECTIONAL AND LOUD, for the same reason it is on the
 * chain-hash constant: this value is only ever consulted to refuse EARLY, and
 * `ed25519.sign` re-checks the same argument at recipe step 6, so a stale value
 * here can produce a false refusal — never a signature under a wrong-width key.
 */
const ED25519_PRIVATE_KEY_LENGTH = 32;

// The refused set, spelled once for the refusal message. Its annotation and its
// per-literal `satisfies` pins are two drift guards on two different axes, and
// between them the three spellings of the refused set cannot drift apart
// unnoticed:
//
//   - The annotation catches a NARROWED `PiiRefusedCategory`. Drop a name from
//     the type and this literal stops assigning. That direction is invisible to
//     the guard inside `writeEventWithPii`, whose `case` clause for the dropped
//     name stays perfectly well-typed — the name is still an `EventCategory`, so
//     it is still comparable to the switch expression — even though `Exclude`
//     has just moved that category into `PiiEligibleCategory`: the codec would
//     go on refusing at runtime an event the types now call eligible.
//   - A WIDENED `PiiRefusedCategory` is caught at the guard instead: a name
//     added to the type with no matching `case` leaves the refused arm's
//     discriminant still overlapping what the switch leaves behind, so the arm
//     stays in the union, `input` stays un-narrowed, and the `encrypt` call
//     below fails to compile.
//   - The `satisfies EventCategory` pins catch the third axis. If either name
//     ever stops being a member of the contracts enum, the pin fails, rather
//     than this invariant quietly guarding a category that no longer exists.
//
// The guard switches on the discriminant rather than consulting this array
// because this array cannot narrow anything: a membership test narrows nothing,
// and neither — less obviously — does a chained `===` / `||` over the same
// literals. See the guard for why.
const PII_REFUSED_CATEGORY_NAMES: readonly PiiRefusedCategory[] = [
  "audit_integrity" satisfies EventCategory,
  "event_maintenance" satisfies EventCategory,
];

/**
 * Runs `Plan-006 §Encrypt-Then-Digest-Then-Sign Order` steps 2–6 for one
 * PII-carrying event and returns everything T3.1 needs for step 7. Step 1 — the
 * PII / non-PII split — belongs to the EMITTER and has already happened by the
 * time this function is called; see {@link PiiCarryingEventInput}.
 *
 * Stages, numbered as that recipe numbers them, in the only order the types
 * permit:
 *
 *   2. ENCRYPT — the injected {@link PiiEncryptor} seals the `piiPayload`
 *      partition under the participant's key. The result is branded
 *      {@link PiiPayloadCiphertext} here and nowhere else.
 *   3. DIGEST — `BLAKE3(ciphertext)` over exactly the bytes that will occupy the
 *      `pii_payload` column, lowercase hex.
 *   4. EMBED — the digest becomes a `payload` member, which is what puts it
 *      INSIDE the canonical form (`Spec-006 §Canonical Serialization Rules`
 *      excludes `pii_payload` itself and requires the digest in its place).
 *   5. CANONICALIZE — T2.1, over the digest-bearing envelope.
 *   6. SIGN — T2.2, over those canonical bytes: `row_hash` and
 *      `daemon_signature` in one call, one canonicalization per row
 *      (I-006-2-06).
 *
 * `prevHash` is `Plan-006 §Hash Chain`'s link — the immediately-prior row's
 * `row_hash` for this `session_id`, or `GENESIS_PREV_HASH` at `sequence = 0` —
 * and it is a PARAMETER because reading it is only correct under the per-session
 * append lock T3.1 owns. This module holds no lock and touches no database, so
 * resolving the link here would race every concurrent append. `signRow` refuses
 * a `prevHash` that is not 32 bytes and remains the authority on that width;
 * this function refuses the same value EARLIER, for the reason below.
 *
 * REFUSALS ANSWERABLE FROM THE INPUT ALONE PRECEDE THE ENCRYPT STEP. It is the
 * one irreversible stage (a consumed random nonce, `manual_reconcile_only`), so
 * throwing after it burns that nonce and leaves a half-built commitment for an
 * operator to reconcile. Refusal order is OBSERVABLE — first to fire is the only
 * one the caller sees — so it is fixed here rather than left to the reading
 * order of the body:
 *
 *   1. A refused category (I-006-3-01 layer 2).
 *   2. A `payload` that already claims `pii_ciphertext_digest`.
 *   3. A `sequence` that is not a safe integer. HOISTED from T2.1's
 *      `assertRepresentableSequence`, and placed ahead of 4 rather than after it
 *      because `canonicalizeEvent`'s own REFUSAL ORDER note fixes that same
 *      precedence: an envelope defective in both members must report the
 *      sequence refusal on this path too, or the PII write path and the plain
 *      one would answer differently for one row.
 *   4. A non-canonical `occurredAt` (T2.1's `normalizeOccurredAt`), then the PII
 *      partition's own serialization refusals (T2.1's `canonicalizeJson` over
 *      `piiPayload`: its nesting ceiling, its RFC 8785 §3.2.2.2 Unicode
 *      well-formedness guard, its no-JSON-representation guard, and
 *      `canonicalize@3.0.0`'s `NaN` / `Infinity` / circular-reference throws,
 *      which the PII partition newly exposes).
 *   5. A `prevHash` that is not 32 bytes. HOISTED from T2.2's `signRow`, and
 *      placed behind every refusal that predates the hoist, so bringing it
 *      forward reordered nothing: it moved from after the signature to just
 *      before the encrypt, and every other refusal kept its relative position.
 *   6. A `daemonSigningKey` that is not 32 bytes. HOISTED from `ed25519.sign`'s
 *      own `abytes` — a LIBRARY guard rather than a sibling module's, because
 *      `signRow` guards `prevHash` and nothing else — and placed after 5 on the
 *      same no-reordering ground: it fired dead last of every refusal on this
 *      path before the hoist, being the deepest call on the sign path, and of
 *      the three hoists it still fires last.
 *   7. A `piiParticipantId` that is not a non-empty string. NOT A HOIST — the
 *      one refusal on this path that fronts nothing, because nothing downstream
 *      re-checks the value: `signRow` never sees it, step 5 excludes it from the
 *      canonical bytes by design, and the single component that does consume it
 *      — the injected {@link PiiEncryptor} — is across CP-006-1, where this
 *      module owns no implementation and may therefore require no behavior of
 *      one. Placed last so it reorders nothing that shipped before it: any input
 *      that drew a refusal without this guard draws the identical refusal with
 *      it, since 1–6 are answerable from members it does not read.
 *
 * 3, 5, AND 6 ARE EARLY COPIES, NEVER REPLACEMENTS.
 * `assertRepresentableSequence`, `signRow`'s guard, and `ed25519.sign`'s
 * `abytes` all still run downstream and stay authoritative, so a copy that ever
 * drifted could only refuse early — never admit late. 3 and 5 are BYTE-IDENTICAL
 * to the guards they front; 6 is deliberately narrower, and its own note says
 * both why and in which direction.
 *
 * 7 IS NOT IN THAT SET, and the sentence above must not be read as covering it.
 * It is the first and last word on its own value, so there is no downstream
 * authority to be an early copy OF and no drift for a late guard to catch. That
 * is an argument for the guard rather than against it: the failure it refuses is
 * silent, permanent, and invisible to every other check in the pipeline — the
 * guard's own note carries the reasoning.
 *
 * TWO CLASSES REMAIN BEHIND THE ENCRYPT, AND NEITHER MOVES HONESTLY:
 *
 *   - THE ENCRYPTOR-RESULT SHAPE GUARD judges a value that does not exist until
 *     the encryptor has run.
 *   - `input.payload`'s OWN RFC 8785 REFUSALS — T2.1's nesting ceiling, its
 *     RFC 8785 §3.2.2.2 Unicode well-formedness guard, and
 *     `canonicalize@3.0.0`'s `NaN` / `Infinity` / circular-reference throws —
 *     fire inside `canonicalizeEvent`, at recipe step 5. They ARE answerable
 *     from the input, and are left here anyway: T2.1 exports no depth checker,
 *     so a pre-check is either a SECOND full canonicalization of the row (the
 *     cost this module pays once, paid twice, on every append) or a duplicate of
 *     T2.1's iterative walk carrying a DEPTH-OFFSET correction —
 *     `canonicalizeEvent` seeds that walk at the envelope, which puts `payload`
 *     one level down, so a standalone walk over `input.payload` disagrees with
 *     the real guard at exactly the ceiling: a payload whose deepest container
 *     sits at standalone depth 64 sits at 65 inside the envelope. A pre-check
 *     that disagrees with the guard it stands in for would make the ordering
 *     claim above FALSE for the boundary case, which is worse than refusing late
 *     and saying so. THAT DEPTH-OFFSET ARGUMENT DOES NOT CARRY THE
 *     WELL-FORMEDNESS GUARD, and it is not stretched to: well-formedness is a
 *     property of each string alone, so a standalone walk over `input.payload`
 *     would agree with the real guard exactly, at every input. It stays late for
 *     the weaker reason only — T2.1 exports no well-formedness checker either,
 *     and hoisting one would reorder a refusal sequence this block fixes
 *     deliberately — which is a residual worth naming rather than a forced
 *     placement. `canonicalizeJson`'s no-JSON-representation guard is NOT in
 *     this class: it fires only for a TOP-LEVEL value with no JSON
 *     representation, and `canonicalizeEvent` always hands it an object, so it
 *     is reachable only through the `piiPayload` call at 4 — above the encrypt.
 *
 * NOT IDEMPOTENT — see the module header. Re-running after a partial failure
 * mints a second, unrelated ciphertext and a second, unrelated signature.
 */
export async function writeEventWithPii(
  input: RawEventInput,
  prevHash: Uint8Array,
  encryptor: PiiEncryptor,
  daemonSigningKey: Ed25519PrivateKey,
): Promise<PiiEventWriteResult> {
  // I-006-3-01 LAYER 2 — and the narrowing the rest of this function stands on.
  //
  // A `switch` over the discriminant, NOT a chained `===` / `||` over the same
  // two literals: the chained form does not narrow `input` at all. Each
  // comparison is applied on its own, and neither literal ALONE excludes an arm
  // whose discriminant is both of them, so `PiiRefusedEventInput` survives both
  // steps and `piiPayload` / `piiParticipantId` stay optional. The switch strikes
  // both literals from the discriminant in one step, which leaves the refused
  // arm's `category` disjoint from what remains and drops the arm — so the code
  // below sees `PiiCarryingEventInput`. A membership test over
  // `PII_REFUSED_CATEGORY_NAMES` narrows nothing whatsoever, which is why the
  // names are spelled out here as well as in that array.
  //
  // THAT NARROWING IS NOT A BELIEF ABOUT THE COMPILER — it is re-checked on every
  // build. The refused arm declares both members optional `never`, so without the
  // narrowing they read as `undefined`-bearing, and every site below that DEMANDS
  // the real value stops compiling: `participantId: input.piiParticipantId` in
  // the encrypt call, the `embedCiphertextDigest(input, ...)` argument, and the
  // `piiParticipantId` echoed into the return. Those errors are the widening half
  // of the drift guard documented on `PII_REFUSED_CATEGORY_NAMES`.
  //
  // TWO SITES BELOW READ THESE MEMBERS AND ARE NOT PART OF THAT GUARD, which is
  // worth naming so neither is mistaken for one: refusal 7 tests
  // `input.piiParticipantId` for shape at RUNTIME and is deliberately tolerant of
  // a wider static type, and `canonicalizeJson(input.piiPayload)` takes
  // `unknown`. Both would keep compiling if the narrowing broke.
  //
  // No `default:` clause, deliberately. The case body throws, so the only
  // reachable path past the switch is "no case matched" — that flow edge is what
  // carries the narrowing — and refusing 2 of 20 categories keeps the path
  // reachable rather than collapsing `input` to `never`. The comparison still
  // runs literal-by-literal at RUNTIME, which is the entire point of layer 2: a
  // category that arrived across a serialization boundary is a value TypeScript
  // never checked.
  switch (input.category) {
    case "audit_integrity":
    case "event_maintenance":
      throw new Error(
        `writeEventWithPii refuses category ${JSON.stringify(input.category)}: ${PII_REFUSED_CATEGORY_NAMES.join(" and ")} events are never compacted and never crypto-shredded per Plan-006 §Audit Integrity Invariant, so their pii_payload is NULL by construction. Append this event through the plain append path instead.`,
      );
  }

  // A payload that ALREADY carries the digest key is refused rather than
  // overwritten. Both ways of arriving here are bugs worth surfacing: a re-run
  // of this codec (which cannot reproduce the first ciphertext — see the
  // idempotency note) or a producer supplying its own digest, which would be a
  // value the signature then vouches for without anything having verified it.
  // Silently replacing the member would hide the first and silently trusting it
  // would sign the second.
  if (Object.hasOwn(input.payload, PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY)) {
    throw new Error(
      `writeEventWithPii refuses an event whose payload already carries ${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}: this codec is the only producer of that member (Spec-006 §Canonical Serialization Rules), and it is not re-runnable — AES-256-GCM uses a fresh random nonce per write, so a second pass would mint an unrelated ciphertext and digest.`,
    );
  }

  // REFUSAL 3 of the order documented above — T2.1's
  // `assertRepresentableSequence`, hoisted ahead of the encrypt. `sequence`
  // travels as an IEEE-754 double and holds integers faithfully only to
  // 2^53 − 1; past that two genuinely different events canonicalize to identical
  // bytes and collide inside the very chain `Spec-006 §Integrity Protocol`
  // builds to make tampering detectable. That verdict is answerable from
  // `input.sequence` and nothing else, and the predicate is
  // `Number.isSafeInteger` — precisely T2.1's, and total — so the early copy
  // cannot disagree with the late one on any input. T2.1's guard still runs
  // inside `canonicalizeEvent` at recipe step 5 and stays the authority.
  //
  // AHEAD OF `normalizeOccurredAt`, deliberately: `canonicalizeEvent` runs its
  // sequence guard first, and the PII path must not invert that.
  if (!Number.isSafeInteger(input.sequence)) {
    throw new Error(
      `writeEventWithPii refuses sequence ${String(input.sequence)}: it is not a safe integer (|value| must be at most ${String(Number.MAX_SAFE_INTEGER)}, and it must be an integer), so distinct sequences would collapse onto one IEEE-754 double and two different events would produce an identical row_hash — a collision in the chain Spec-006 §Integrity Protocol relies on being injective. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce.`,
    );
  }

  // Normalized BEFORE encrypting so a malformed `occurredAt` costs no nonce, and
  // captured so the returned envelope carries the normalized string. T2.1's
  // `canonicalizeEvent` normalizes into a local of its own, which would leave the
  // producer's raw spelling on the envelope this function hands back — and
  // `session_events.occurred_at` is declared RFC 3339 UTC at millisecond
  // precision while the wire schema admits `+05:00` offsets and omitted seconds.
  // Normalizing here is free of double-normalization risk: the canonical form is
  // a fixed point, so T2.1's second pass returns the identical string.
  const normalizedOccurredAt: string = normalizeOccurredAt(input.occurredAt);

  // --- Step 2: ENCRYPT ------------------------------------------------------
  // `canonicalizeJson` returns `CanonicalBytes`; the annotation widens it back to
  // plain bytes deliberately. These are the PII PLAINTEXT bytes, not the row's
  // canonical bytes, and the brand must not suggest otherwise.
  const piiPlaintext: Uint8Array = canonicalizeJson(input.piiPayload);

  // REFUSAL 5 of the order documented above — T2.2's `prevHash` guard, hoisted
  // to just ahead of the encrypt. A wrong-width link hashes happily and
  // mints a signature over a chain input no verifier can ever reproduce: an
  // untampered row that fails forever. `signRow` refuses it, but only after the
  // nonce is spent, which on a `manual_reconcile_only` codec is a half-built
  // commitment bought for a defect the caller handed in.
  //
  // NOT HYPOTHETICAL AT THE CALL SITE THIS CODEC IS FOR. T3.1 supplies this
  // argument by reading the previous row's `row_hash` back out of SQLite, and a
  // `BLOB` column can hand back a JS `string` — which is why the test is
  // BYTE-NESS as well as width, the same conjunction `signRow` documents. A
  // 32-CHARACTER string clears a bare length check and then coerces to near-zero
  // bytes through `TypedArray.prototype.set`.
  //
  // POSITIONED HERE, after the PII partition has been serialized, so that
  // hoisting it changed no existing refusal's relative order — it moved from
  // after the signature to just before the encrypt, and nothing else moved.
  // `signRow` re-checks the same argument at recipe step 6 and stays authoritative.
  if (!(prevHash instanceof Uint8Array) || prevHash.length !== CHAIN_HASH_LENGTH) {
    throw new Error(
      `writeEventWithPii requires a ${CHAIN_HASH_LENGTH}-byte Uint8Array prev_hash — the previous row_hash for this session, or GENESIS_PREV_HASH at sequence 0 — per Spec-006 §Integrity Protocol; received ${describeByteShape(prevHash)}. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce; signRow re-checks the same value when the row is signed.`,
    );
  }

  // REFUSAL 6 of the order documented above — the signing-key shape check
  // `ed25519.sign` runs, hoisted ahead of the encrypt. `signRow` guards
  // `prevHash` and nothing else, so an ill-shaped key travels un-inspected from
  // this parameter down to `abytes(key, 32)` at recipe step 6 — past the nonce,
  // on a `manual_reconcile_only` codec, which is the cost the whole ordering
  // argument above exists to avoid. It is the last refusal that was BOTH
  // answerable from the inputs and free to answer early: the RFC 8785 class the
  // docstring leaves behind the encrypt is answerable too, and stays there
  // because no honest pre-check of it is free.
  //
  // REACHABLE ONLY THROUGH A CAST, WHICH IS THE POINT RATHER THAN AN OBJECTION.
  // `Ed25519PrivateKey` has exactly one mint site in the workspace — T2.7's
  // `toEd25519PrivateKey` — and that site already validates byte-ness and width,
  // so a mis-shaped value arriving here came through an `as Ed25519PrivateKey`
  // cast. That is the same boundary-crossing class this module's header invokes
  // to justify its runtime category guard, and the one `signer.ts`'s
  // `verifyEd25519` names for the public half ("T2.7's unvalidated
  // `as Ed25519PublicKey` cast").
  //
  // NARROWER THAN WHAT IT FRONTS, UNLIKE 3 AND 5 — stated rather than glossed,
  // because this is the only hoist standing in for a LIBRARY guard. noble's
  // `abytes` tests `isBytes`, which also admits a cross-realm `Uint8Array` view
  // that `instanceof` refuses. The predicates therefore agree on every key the
  // single mint site can produce — it returns `new Uint8Array(...)` allocated in
  // this realm — and can diverge only on a cast-in value, where the divergence is
  // a REFUSAL. The containment the ordering claim actually needs holds: a key
  // this admits is a key the library admits, so the guard cannot let a doomed
  // signature through and can only ever refuse before the nonce is spent.
  //
  // `describeByteShape` reports a length or a `typeof` and never a byte, so a
  // refused key does not reach the message; keep it that way.
  if (
    !(daemonSigningKey instanceof Uint8Array) ||
    daemonSigningKey.length !== ED25519_PRIVATE_KEY_LENGTH
  ) {
    throw new Error(
      `writeEventWithPii requires a ${ED25519_PRIVATE_KEY_LENGTH}-byte Uint8Array daemon signing key per RFC 8032 §5.1.5; received ${describeByteShape(daemonSigningKey)}. That is a key-custody or key-routing bug — T2.7's signing-key-source.ts is the only site that may mint this type. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce; ed25519.sign re-checks the same value when the row is signed.`,
    );
  }

  // REFUSAL 7 of the order documented above — the one guard on this path that is
  // an AUTHORITY rather than an early copy, because nothing downstream ever
  // looks at this value again.
  //
  // `piiParticipantId` selects the content key that seals this row and supplies
  // half of the AEAD's associated data (`participant_id || event_id`,
  // `Spec-022 §PII Payload Column Pattern`). An empty or non-string value breaks
  // the row in two directions and is loud in neither: the ciphertext is sealed
  // against associated data no decrypt can reconstruct, and the Path-1 selector
  // in `Spec-022 §Shred Fan-Out` — which matches the durable participant-id
  // stamp, never the opaque ciphertext — has nothing to find when the
  // participant asks to be erased. Every other check still passes. The digest
  // agrees, the signature verifies, the chain links, and what lands is a
  // healthy-looking row holding PII that can be neither read nor shredded.
  //
  // A SHAPE GUARD, NOT AN EXISTENCE CHECK, and the distinction is load-bearing:
  // whether `participant_keys` holds a row for this id is answerable only across
  // CP-006-1, inside an implementation this module does not own, import, or
  // share a database handle with. A well-shaped id naming no key holder still
  // passes here — that verdict belongs to the encryptor.
  //
  // The predicate is `session-projector.ts`'s test for a participant id arriving
  // off a payload: non-string OR empty, because an empty string names no key
  // holder while satisfying every `string` in the pipeline. Reachable only
  // through a cast or an untyped boundary, like refusal 6 —
  // `PiiCarryingEventInput` declares the member a required `string`.
  if (typeof input.piiParticipantId !== "string" || input.piiParticipantId.length === 0) {
    throw new Error(
      `writeEventWithPii requires a non-empty piiParticipantId: it names the participant whose content key seals this row and whose participant_keys DELETE crypto-shreds it, and it is the stamp the Spec-022 §Shred Fan-Out Path 1 selector matches on; received ${describeParticipantIdShape(input.piiParticipantId)}. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce; unlike the guards above it, nothing downstream re-checks this value.`,
    );
  }

  const encryptorResult: Uint8Array = await encryptor.encrypt({
    participantId: input.piiParticipantId,
    eventId: input.id,
    plaintext: piiPlaintext,
  });

  // The declared `Uint8Array` is a claim about a value that crossed the CP-006-1
  // injection boundary — an implementation this module does not own, does not
  // import, and (per CP-006-1) may briefly be a stub. That is at least as
  // untrusted as the SQLite boundary both sibling modules guard, and the failure
  // is silent in a costly way: a non-byte result would be digested as whatever
  // BLAKE3 coerces it to and then persisted into a `BLOB` column, producing a row
  // whose digest commits to bytes that are not the stored ciphertext. Empty is
  // refused too — no AEAD emits a zero-length output, so it means the
  // implementation returned nothing while claiming success. Width is NOT checked:
  // this interface does not fix an AEAD, so its ciphertext has no width this
  // module is entitled to assert.
  if (!(encryptorResult instanceof Uint8Array) || encryptorResult.length === 0) {
    throw new Error(
      `PiiEncryptor.encrypt must return non-empty Uint8Array ciphertext for the session_events.pii_payload column per Spec-022 §PII Payload Column Pattern; received ${describeByteShape(encryptorResult)}. That is an injection bug at the CP-006-1 boundary, not a tampered row.`,
    );
  }

  // The ONE site where `PiiPayloadCiphertext` enters the type system
  // (I-006-2-02) — and it brands an OWNED COPY, not the encryptor's own array.
  //
  // `PiiEncryptor` is an injection boundary (CP-006-1): it fixes a return TYPE
  // and says nothing about the LIFETIME of the buffer behind it, so a conforming
  // implementation may hand back a reusable scratch array and overwrite it on
  // its next call. Nothing here can forbid that — Plan-022 owns the
  // implementation, sits a tier above, and never consults this file. The row it
  // would produce is the nastiest kind: the digest below commits to the bytes as
  // of NOW and the signature commits to that digest, so a later encrypt writing
  // through the same array leaves the caller persisting different bytes into
  // `pii_payload` — an honest row that fails verification forever, with the
  // defect in a module no verifier will ever look at. Copying costs one
  // allocation of the ciphertext's width per PII append; no width is named here
  // because the interface fixes no AEAD.
  //
  // `new Uint8Array(...)` and deliberately NOT `.slice()`, exactly as
  // `signer.ts` copies `prevHash`: `Buffer.prototype.slice` returns a VIEW onto
  // the same memory, so it would copy nothing while reading as though it had.
  //
  // AFTER THE SHAPE GUARD, NEVER BEFORE IT. This constructor admits far more
  // than the guard does and COERCES where the guard refuses, differently
  // depending on the value: `new Uint8Array(null)` and `new Uint8Array("abc")`
  // allocate zero bytes, `new Uint8Array("3")` allocates three zero bytes — a
  // non-empty all-zero ciphertext that a length check waves straight through —
  // and a long numeric-looking string is read as a LENGTH, which is why the hex
  // string this suite injects at the shape guard raises `RangeError: Array
  // buffer allocation failed` rather than producing anything at all. Copying
  // first would trade one refusal that names the CP-006-1 boundary and routes to
  // the encryptor's author for one of those, so the guard runs first and this
  // line only ever copies bytes it has already been told are bytes.
  //
  // CLOSES THE ENCRYPTOR-SIDE ALIAS ONLY. A caller that writes into the array on
  // this result before its INSERT commits reproduces the same disagreement from
  // the other side, and no copy taken here can prevent it; that one is the
  // obligation {@link PiiEventWriteResult} states, on the same footing as the
  // one `signer.ts` states for `SignedRow.prevHash`.
  const piiPayload: PiiPayloadCiphertext = new Uint8Array(encryptorResult) as PiiPayloadCiphertext;

  // --- Steps 3 + 4: DIGEST, then EMBED --------------------------------------
  const envelope: EventWithPiiDigest = embedCiphertextDigest(
    input,
    normalizedOccurredAt,
    piiPayload,
  );

  // --- Steps 5 + 6: CANONICALIZE, then SIGN ---------------------------------
  const canonical: CanonicalBytes = canonicalizeDigestBearingEvent(envelope);
  const signedRow: SignedRow = signRow(canonical, prevHash, daemonSigningKey);

  // `piiParticipantId` rides out with the other three: it is a column value T3.1
  // must write, and the input is not a source the persistence contract admits.
  // Safe to echo by reference where the ciphertext was not — a `string` is
  // immutable, so there is no aliasing hazard to close.
  return { envelope, piiParticipantId: input.piiParticipantId, piiPayload, signedRow };
}

// --------------------------------------------------------------------------
// Pipeline steps.
// --------------------------------------------------------------------------

/**
 * Steps 3 and 4 — digest the ciphertext, then embed the digest in `payload`.
 *
 * Taking {@link PiiPayloadCiphertext} rather than `Uint8Array` is the type-level
 * half of I-006-2-01 at this link: the brand exists only downstream of the
 * encrypt stage, so this function is unreachable before it. Kept as one function
 * because the digest has no legitimate existence apart from the embed — a
 * digest computed and then NOT embedded is precisely the failure the ordering
 * invariant exists to prevent.
 *
 * The digest covers the ciphertext EXACTLY as the column will hold it. Digesting
 * anything else — the plaintext, a prefix, a re-encoded copy — would leave the
 * signature committing to a value a post-shred verifier cannot relate to the row
 * it is holding, which is the whole content of
 * `Spec-022 §Signature Safety Under Shred`.
 *
 * LOWERCASE HEX IS A ONE-WAY DOOR. The digest lands inside the signed canonical
 * bytes, so its encoding is part of the contract with every independent verifier
 * and with every row already on disk — unlike, say, T2.1's nesting ceiling, which
 * no persisted byte depends on. Hex over base64 because it is unpadded,
 * case-fixed, and the encoding `bytesToHex` already produces for the shared
 * channel-id derivation in contracts; raw bytes are not an option at all, since
 * the member has to survive JSON.
 */
function embedCiphertextDigest(
  input: PiiCarryingEventInput,
  normalizedOccurredAt: string,
  piiPayload: PiiPayloadCiphertext,
): EventWithPiiDigest {
  const payloadWithDigest: Record<string, unknown> = {
    ...input.payload,
    [PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY]: bytesToHex(blake3(piiPayload)),
  };

  // Projected member-by-member, never spread from `input`: `input` carries
  // `piiParticipantId` and `piiPayload`, and neither is an envelope member.
  // Spreading would put the PII partition itself into the canonical bytes — the
  // exact leak this whole codec exists to prevent — and the signature would then
  // pin plaintext PII on disk for as long as the row survives the shred. The
  // value-typed mapped annotation is the drift guard, in the same register T2.1
  // uses: `-?` makes every member required, so a twelfth envelope member added in
  // contracts breaks this literal instead of silently vanishing, and
  // `EventEnvelope[MemberName]` pins each value's type, so a member wired to a
  // DIFFERENTLY-typed source (`sequence: input.id`, `payload: input.actor`) is a
  // compile error. Its limit, stated rather than glossed: same-typed neighbours
  // are not covered — `id` / `type` / `occurredAt` are all plain `string` and
  // `correlationId` / `causationId` are both `string | undefined`, so swapping a
  // pair inside either group type-checks. For those, reading this literal against
  // the `EventEnvelope` declaration is the only guard there is.
  const canonicalMembers: { [MemberName in keyof EventEnvelope]-?: EventEnvelope[MemberName] } = {
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    occurredAt: normalizedOccurredAt,
    category: input.category,
    type: input.type,
    actor: input.actor,
    payload: payloadWithDigest,
    correlationId: input.correlationId,
    causationId: input.causationId,
    version: input.version,
  };

  // The intermediate annotation keeps the brand assertion a plain widening of
  // `EventEnvelope` rather than a double cast — T2.1's register.
  const envelope: EventEnvelope = canonicalMembers;
  return envelope as EventWithPiiDigest;
}

/**
 * Step 5 — canonicalize, narrowed to accept ONLY a digest-bearing envelope.
 *
 * T2.1's `canonicalizeEvent` accepts any `EventEnvelope`, correctly: it serves
 * the whole daemon, and most events carry no PII. This one-line wrapper is what
 * closes the {@link EventWithPiiDigest} → `CanonicalBytes` link of I-006-2-01 on
 * the PII path without narrowing that shared entry point for everyone else, and
 * `canonicalizer.ts` stays untouched.
 *
 * SCOPE, STATED HONESTLY: what is a type error is calling THIS function before
 * the embed stage — its parameter admits nothing but a digest-bearing envelope.
 * It is not a module-wide prohibition, since T2.1's wider entry point must be
 * imported here in order to be called at all. The wrapper closes the write
 * path's own canonicalization site, which is the site the write path runs.
 */
function canonicalizeDigestBearingEvent(envelope: EventWithPiiDigest): CanonicalBytes {
  return canonicalizeEvent(envelope);
}

/**
 * Renders a refused byte-shaped value for a throw message without trusting its
 * declared type — `value.length` on a `string` would report a character count as
 * a byte count and send the reader after the wrong bug. Serves every refusal
 * over a BYTE-shaped value: the encryptor's result, and the two hoisted byte
 * guards (`prevHash` and `daemonSigningKey`). Refusal 7's value is a `string` by
 * contract rather than bytes, so it is described by
 * {@link describeParticipantIdShape} instead — the two split by the shape of the
 * subject, not by call site.
 * Deliberately local, and named for the sibling helpers rather than for any one
 * call site: `signer.ts` and `signing-key-source.ts` each keep a
 * `describeByteShape` of their own, and a shared byte-shape describer is not a
 * seam any of the three has asked for.
 */
function describeByteShape(value: unknown): string {
  if (value instanceof Uint8Array) {
    return value.length === 0 ? "an empty Uint8Array" : `${value.length} bytes`;
  }
  return `a non-Uint8Array value of type ${typeof value}`;
}

/**
 * Renders a refused participant id for a throw message without reproducing it.
 *
 * NOT withheld on privacy grounds — the id is a column value T3.1 persists and a
 * shred erases the KEY rather than the stamp, so a throw message is not where it
 * would leak. It is withheld because there is nothing to print: refusal 7 reaches
 * this only with a non-string or the empty string, so a type — plus a character
 * count where there are characters to count — is the whole of what a reader can
 * act on. The sibling {@link describeByteShape} answers in that same shape for a
 * genuinely different reason: a refused signing key IS secret material.
 *
 * Total rather than narrowed to the values refusal 7 refuses, so it will not
 * start lying if a second call site ever appears. That is what the non-empty
 * branch is for; refusal 7 never reaches it.
 */
function describeParticipantIdShape(value: unknown): string {
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : `a ${value.length}-character string`;
  }
  return `a non-string value of type ${typeof value}`;
}
