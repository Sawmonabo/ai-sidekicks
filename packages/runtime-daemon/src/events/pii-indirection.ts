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
// this module holds no lock, writes no row, and owns no migration.
//
// THE STAMP LEAVES HERE TWICE, AND THAT IS THE POINT. It rides out in the RETURN
// TYPE, for T3.1 to write into that column — and it is ALSO projected into
// `payload` under `pii_participant_id` at the embed step, which puts it inside
// the canonical bytes the signature covers. The two copies are what let a
// read-side verifier hold the stored column to the signed claim
// ({@link isPiiOwnerStampBound}); a stamp that left here only in the return type
// would be a column nothing vouches for. That matters most exactly where the
// ciphertext stops helping: once Path 1 destroys the key, no decrypt can ever
// re-attribute the retained bytes, so the stamp becomes the SOLE surviving
// evidence of whose data the row held. Signing it spends no confidentiality the
// canonical form does not already spend — `actor` is a canonical member and
// already carries participant ids — and the produce-here / persist-there split
// the paragraph above draws for the ciphertext is unchanged: this module still
// writes no row. The binding therefore lands across three phases, and only the
// first of them is in this file: Phase 2 mints the SIGNED half, T3.1 creates the
// column it will be compared against, T4.1 performs the comparison and reports
// the verdict. Minting the signed half first is what makes the other two cheap —
// no row carrying a `pii_payload` has ever been written, so the canonical form
// can still change with no migration and no backfill.
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
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EventCategory, EventEnvelope, SessionEvent } from "@ai-sidekicks/contracts";
import {
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  PII_PARTICIPANT_ID_PAYLOAD_KEY,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
} from "@ai-sidekicks/contracts";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CanonicalBytes } from "./canonicalizer.js";
import { canonicalizeEvent, canonicalizeJson, normalizeOccurredAt } from "./canonicalizer.js";
import type { Ed25519PrivateKey, SignedRow } from "./signer.js";
import { signRow } from "./signer.js";

// --------------------------------------------------------------------------
// The two PII payload-member names — DECLARED IN CONTRACTS, re-exported here.
// --------------------------------------------------------------------------
//
// Both keys used to be declared in this module, because this module was their
// only reader. They moved to `packages/contracts/src/event.ts` when the strict
// layer REGISTERED them as optional members on every payload variant that may
// carry a PII partition: a literal a lower-tier package indexes a schema by
// belongs in that package, which is the `CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY`
// / `SOURCE_EPOCH_PAYLOAD_KEY` convention stated on those declarations. The
// re-export keeps every consumer in this package — the append service, the
// `0007` migration, the verifier, and the post-shred suites — importing from
// where they always did, so exactly one spelling of each string exists.
//
// WHAT MOVED WITH THEM, and what stayed. The wire-contract reasoning is on the
// contracts declarations: why both are snake_case (`Spec-006 §Canonical
// Serialization Rules` names them verbatim, they land inside the SIGNED
// canonical bytes, and every independent verifier reads them by that spelling —
// a fold to the surrounding camelCase would not tidy anything, it would break
// verification on every existing PII row), and why the digest's ENCODING is
// deliberately unpinned. What stays here is the reasoning that is about this
// codec:
//
//   * THE OWNER STAMP IS NOT REDUNDANT WITH `actor`, which is the first thing a
//     reader will ask, since `actor` is already a canonical member and already
//     carries participant ids. They answer different questions. `actor` names
//     WHO EMITTED the row — `0001-initial.ts` documents that column as
//     "participant_id or agent_id or NULL for system". The stamp names WHOSE
//     CONTENT KEY SEALED the ciphertext. The two coincide often and diverge
//     exactly where the divergence is expensive: an agent-emitted row (`actor` =
//     an `agent_id`) or a system-emitted one (`actor` NULL) can still carry a
//     participant's PII, and on those rows `actor` cannot answer the question
//     `Spec-022 §Shred Fan-Out`'s scope selector asks. Same KIND of datum as
//     `actor`, different FACT — which is what keeps the disclosure argument
//     honest.
//   * WHY THE MEMBER EXISTS AT ALL, given T3.1 also persists the value as a
//     column: a column alone is signed by nothing. `Spec-022 §Shred Fan-Out`
//     Path 1 destroys the per-participant key and overwrites no column, so after
//     a shred the ciphertext can never again be attributed to an owner by
//     decryption and this stamp is the only surviving evidence of whose data the
//     row held. A tampered stamp does not stop the key DELETE from erasing the
//     data — that operation is global to the participant — but it corrupts the
//     SCOPE SELECTOR, falsifying the `affectedSessionIds[]` / `piiPayloadsCleared`
//     an `event.shredded` event records as compliance evidence, on a row
//     `Spec-006 §Event Maintenance (event_maintenance)` retains indefinitely and
//     never shreds.
//   * BOTH ARE `as const`, so each type stays its literal rather than widening
//     to `string` — which is what keeps the computed-key writes in
//     {@link embedCiphertextDigest} exactly typed.
export { PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY, PII_PARTICIPANT_ID_PAYLOAD_KEY };

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
 * An {@link EventEnvelope} whose `payload` already carries both PII bindings —
 * {@link PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} and
 * {@link PII_PARTICIPANT_ID_PAYLOAD_KEY} — and whose `occurredAt` is already in
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
 * many-to-one and `payload` gained two members, so the input envelope and this
 * one are different rows; only this one reproduces the signed bytes on
 * verification.
 */
export type EventWithPiiDigest = EventEnvelope & { readonly __brand: "EventWithPiiDigest" };

// --------------------------------------------------------------------------
// The machine-authored content partition (Plan-006 T3.6).
// --------------------------------------------------------------------------
//
// The second partition this module seals, and the reason it is HERE rather than
// in a module of its own: this is where the Encrypt-Then-Digest-Then-Sign order
// lives, and a second sealing module would be a second place for that order to
// drift. `Plan-006 §Content Payload Column (Machine-Authored Prose)` states the rule as a sole-write-path
// obligation — callers MUST NOT produce `content_payload` bytes anywhere else.
//
// The two partitions divide one row's text BY AUTHORSHIP: `pii_payload` holds
// participant-authored text under that participant's own key and is a
// crypto-shred path; `content_payload` holds machine-authored session work
// product under a SESSION-scoped key and is deliberately not a per-participant
// erasure path. A row may carry both, one, or neither — and a row carrying both
// runs the order ONCE over both partitions, so I-006-2-06's one-canonicalization
// -per-row rule is not weakened by a second ciphertext.

/**
 * The sealed machine-authored body, exactly as `session_events.content_payload`
 * will hold it: `iv || ciphertext || tag`, AES-256-GCM under the session content
 * key with AAD `session_id || event_id`.
 *
 * Branded on the {@link PiiPayloadCiphertext} precedent and for the identical
 * reason: the brand exists only downstream of the seal, so nothing can reach the
 * embed step — or the caller's INSERT — with bytes this module did not produce.
 */
export type ContentPayloadCiphertext = Uint8Array & {
  readonly __brand: "ContentPayloadCiphertext";
};

/** AES-256-GCM initialization-vector width — 96 bits, the NIST SP 800-38D size. */
const CONTENT_SEAL_IV_BYTES = 12;

/** AES-256-GCM authentication-tag width. */
const CONTENT_SEAL_TAG_BYTES = 16;

/** Width of the session content key this module seals under. */
const CONTENT_SEAL_KEY_BYTES = 32;

/**
 * The machine-authored body to seal, and the key to seal it under.
 *
 * THE KEY ARRIVES AS MATERIAL, NOT AS A LOOKUP. Resolving it means reading
 * `session_content_keys` and unwrapping under the daemon master key, which can
 * block on a human; the caller does that once, ahead of this call, and hands the
 * bytes in. Taking a store here would put a database handle and a custody ladder
 * into the module that owns the canonicalization order, for no gain — the same
 * boundary reasoning that keeps {@link PiiEncryptor} an injected interface.
 */
export interface EventContentInput {
  /**
   * The machine-authored prose — an assistant message body, a reasoning-update
   * body, or a tool call's arguments / result / error body.
   *
   * MAY EXCEED {@link CONTENT_PAYLOAD_PLAINTEXT_MAX}. An over-bound body is
   * truncated at a codepoint boundary rather than refused: refusing the append
   * would drop the turn, which is a worse and less honest outcome than storing a
   * prefix that says it is one.
   */
  readonly body: string;
  /** The 32-byte session content key, already unwrapped. */
  readonly contentKey: Uint8Array;
}

/** What the seal stage produces, carried to the embed stage. */
interface SealedContentPartition {
  readonly ciphertext: ContentPayloadCiphertext;
  /** PRE-truncation UTF-8 byte length of {@link EventContentInput.body}. */
  readonly contentLength: number;
  readonly truncated: boolean;
}

/**
 * The three `payload` members the SEALING CODEC owns and no producer may supply
 * — each determined at the seal step from the body actually sealed.
 *
 * `contentType` is deliberately absent: the producer knows the media type of
 * what it emitted, and this codec never could. The split is what makes the
 * refusal arm checkable by name rather than by judgement.
 */
const CODEC_OWNED_CONTENT_PAYLOAD_KEYS: readonly string[] = [
  CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

/**
 * Thrown when a producer pre-seeds a payload with a member the sealing codec
 * alone determines. Carries the offending KEY, never the value.
 *
 * A named subclass rather than a bare `Error` so the two consumers below can be
 * told apart from an incidental throw by a test or a caller, while
 * `instanceof Error` and the message text stay exactly what they were.
 */
export class CodecOwnedContentKeyError extends Error {
  readonly seededKey: string;

  constructor(refuser: string, seededKey: string) {
    super(
      `${refuser} refuses an event whose payload already carries ${seededKey}: this codec is the only producer of ${CODEC_OWNED_CONTENT_PAYLOAD_KEYS.join(", ")} (Spec-006 §Canonical Serialization Rules), each determined at the seal step from the body it actually sealed. Pass the prose as content.body; contentType is the producer's member and is unaffected.`,
    );
    this.name = "CodecOwnedContentKeyError";
    this.seededKey = seededKey;
  }
}

/**
 * Refuse a payload that pre-seeds any of the three members the sealing codec
 * owns — ONE definition, consumed at BOTH ends of the sole durable append path.
 *
 * WHAT "BOTH" MEANS, counted rather than asserted. `EventLogService.append` is
 * the only durable writer into `session_events`, and it reaches the table by two
 * BRANCHES: a plain append that signs the caller's payload as given, and a
 * sealing append that routes through this codec. The guard is called once at the
 * top of that path — ahead of the branch choice — and once inside the codec, so
 * neither branch can be entered with a forged claim and the codec still refuses
 * for a caller that invokes it directly.
 *
 * THE ONE OTHER `INSERT INTO session_events` IN THE TREE IS EXEMPT, and the
 * reason is not a judgement call: `SessionService.append` writes zero-filled
 * `prev_hash` / `row_hash` / `daemon_signature` placeholders, throws unless the
 * service was constructed with the identity-checked
 * `UnsignedPlaceholderAppendToken` (so it is unreachable from a production
 * composition root), and does not name `content_payload` in its INSERT at all.
 * The defect this guard exists to prevent is a SIGNED forged claim; that path
 * signs nothing, and integrity verification already refuses everything it writes
 * fail-closed as `signature_placeholder`.
 *
 * WHY IT IS SHARED RATHER THAN CODEC-SCOPED. An earlier draft of this module
 * argued the opposite in prose: that the guard belonged to the codec alone,
 * because "a planted content digest is an integrity claim the read-side binding
 * check is built to catch and report." Codex round 3 on PR #386 refuted that,
 * and the refutation is accepted here. The read-side check DETECTS; it does not
 * PREVENT. Its detection is terminal: `isContentCiphertextDigestBound` compares
 * the signed digest against the stored column, so a row signed with a forged
 * digest and a NULL `content_payload` is classified `digest_unbound` on every
 * read, forever. The signature is over the forged claim, so nothing can repair
 * the row without breaking the chain. Detecting a permanent defect at read time
 * is not a substitute for refusing to mint it at write time.
 *
 * The concrete hole it left: a caller that omits `options.content` but seeds
 * `contentCiphertextDigest` (or `contentLength`, or `contentTruncated`) takes
 * `EventLogService.append`'s PLAIN branch, never reaches this codec, and — since
 * the round-2 strict variants now admit these members by schema — parses,
 * canonicalizes, and signs. The append path is therefore the guard's second
 * consumer, ahead of its plain-vs-codec branch choice.
 *
 * TOLERANT CARRIERS ARE GUARDED TOO — decided explicitly, not by omission. An
 * unregistered census type still travels `ADR-018 §Decision`'s accept-and-stub
 * envelope path, and that tolerance is deliberately preserved for what it is
 * about: a reader "MUST persist an envelope whose `type` it cannot interpret as
 * a version stub — never drop or reject it". It is about TYPES, never about
 * admitting reserved codec-owned MEMBERS. The discriminator is mechanical:
 * {@link isContentCiphertextDigestBound} performs no type check whatsoever, so a
 * forged digest on an unregistered type mints exactly the same permanent
 * `digest_unbound` row as one on a registered type. Guarding only registered
 * types would leave the identical defect reachable through the one arm that
 * cannot be schema-checked. So this guard runs on EVERY payload, and it refuses
 * a member rather than a type — no envelope is dropped for being uninterpretable.
 *
 * WHY AN INTERNAL ERROR AND NOT A WIRE CODE. `daemon.pii_split_bypass` is
 * registered in `docs/architecture/contracts/error-contracts.md` narrowly — it
 * refuses "a write whose `payload` carries a PII-tagged field with no
 * `pii_ciphertext_digest`" — and its `DaemonPiiSplitBypassDetailsSchema` is
 * `.strict()` on `fieldPath` alone. Reusing that code for a content-key refusal
 * would make a registered contract describe something it does not describe. This
 * branch mints no wire error code, so the refusal lands as an internal typed
 * error — the same disposition {@link assertRegisteredVariantParses} already
 * takes on this same append path for the same class of caller-supplied defect.
 *
 * The key is echoed; no payload VALUE ever reaches the message. The keys are
 * module constants, so no caller content can be carried out by this throw.
 */
export function assertNoCodecOwnedContentKeys(
  payload: Record<string, unknown>,
  refuser: string,
): void {
  const seededContentKey = CODEC_OWNED_CONTENT_PAYLOAD_KEYS.find((key) =>
    Object.hasOwn(payload, key),
  );
  if (seededContentKey !== undefined) {
    throw new CodecOwnedContentKeyError(refuser, seededContentKey);
  }
}

/**
 * Every `SessionEvent` variant whose registered payload declares the codec's
 * content-digest member — DERIVED from the contracts union rather than listed.
 *
 * The derivation is the point. A hand-written list of five type strings is a
 * second registration of a decision contracts already made, free to drift the
 * moment a sixth body-bearing variant lands, and drifting silently in the one
 * direction that matters: a variant whose payload declares
 * `contentCiphertextDigest` but which this module refuses would have its prose
 * dropped at the append path with a message about the wrong thing. Reading the
 * union instead means the closed set cannot disagree with the schemas.
 *
 * The conditional distributes over the union because `Variant` is a naked type
 * parameter, so each arm is tested on its own and the result is the union of the
 * `type` literals that pass. `keyof` includes OPTIONAL members, which is what
 * makes the test work at all — every member of `MachineContentDescriptor` is
 * optional, since a body-bearing row that carried no body is still a valid row.
 */
type EventTypeCarryingContentDigest<Variant> = Variant extends {
  type: infer VariantType;
  payload: infer VariantPayload;
}
  ? typeof CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY extends keyof VariantPayload
    ? VariantType
    : never
  : never;

/**
 * The five event types that may carry a machine-authored content partition.
 *
 * Exported so the test suite asserts against the registration-derived set
 * itself rather than against a re-typed copy of it — a re-typed copy being the
 * second source of truth this whole derivation exists to avoid.
 */
export type BodyBearingEventType = EventTypeCarryingContentDigest<SessionEvent>;

/**
 * The runtime half of the same closed set, and a BIDIRECTIONAL drift guard.
 *
 * The `Readonly<Record<BodyBearingEventType, true>>` annotation fails the build
 * in both directions rather than only one: a variant that GAINS a content
 * descriptor in contracts leaves a required key missing here, and a key here
 * that names no such variant is an excess property on the literal. So a future
 * variant growth is a `pnpm typecheck` failure at the moment it lands, not a
 * silent divergence discovered by whoever first tries to seal a body under it.
 *
 * An object rather than a `Set` or an array, so the annotation can do that work:
 * `readonly BodyBearingEventType[]` would catch a WRONG member and never a
 * MISSING one, which is the direction that loses prose.
 */
export const BODY_BEARING_EVENT_TYPES: Readonly<Record<BodyBearingEventType, true>> = {
  "assistant.message": true,
  "assistant.thinking_update": true,
  "tool.invoked": true,
  "tool.result": true,
  "tool.error": true,
};

/**
 * The event types with a registered `SessionEventSchema` payload variant, as a
 * set — the dispatch refusal 9 runs on.
 *
 * DERIVED from the contracts package's own `SESSION_EVENT_TYPES` roster rather
 * than restated here, exactly as both driver normalizers derive their emission
 * readiness from it. That roster is annotated `readonly SessionEvent["type"][]`,
 * which binds its membership to the live union at COMPILE time, and contracts'
 * own non-vacuity guard asserts set-equality between the roster and the union's
 * branches — so this set widens by itself the moment a plan registers a variant,
 * and no mirror of the registered set exists in this module to drift.
 *
 * Typed `ReadonlySet<string>` rather than `ReadonlySet<SessionEventType>`
 * because the value tested against it is `EventEnvelope.type`, a bounded
 * free-form `string`: the tolerant carrier a higher-MINOR producer relies on.
 * Narrowing the set's parameter would force a cast at the one call site and make
 * the membership test read as a question about a census literal, which is
 * exactly what it is not.
 */
const REGISTERED_STRICT_VARIANT_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_TYPES,
);

/** What the PII encrypt stage produces, carried to the embed stage. */
interface SealedPiiPartition {
  readonly ciphertext: PiiPayloadCiphertext;
  readonly participantId: string;
}

/**
 * The AEAD associated data both partitions bind, `session_id || event_id`.
 *
 * Record-binding, exactly as `Spec-022 §PII Payload Column Pattern` fixes it for
 * the participant partition: a ciphertext sealed under this cannot be replayed
 * onto another row or another session. Unambiguous under the id grammars in play
 * — `session_id` is fixed-width UUID form (or the reserved daemon-scope
 * sentinel) and `event_id` follows it — so no length prefix is needed to keep
 * two distinct pairs from colliding.
 */
function buildContentSealAad(sessionId: string, eventId: string): Uint8Array {
  return new TextEncoder().encode(`${sessionId}${eventId}`);
}

/**
 * The UTF-8 width of one code point, from its scalar value alone.
 *
 * Total over every UTF-16 unit value, INCLUDING an unpaired surrogate, which is
 * deliberate rather than incidental: the walk below must not be able to throw or
 * to return a wrong length on an input the caller has not yet refused. Three
 * bytes is also the honest answer for that case — `TextEncoder` substitutes
 * U+FFFD, which encodes to exactly three — so the reported length stays true
 * even on a body refusal 8 is about to reject.
 */
function utf8ByteWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * The UTF-16 index of the first unpaired surrogate in `value`, or `-1` when the
 * string is well-formed — the predicate behind refusal 8's third arm.
 *
 * WHAT IT STANDS IN FOR, AND WHY IT IS NOT THAT. ECMAScript's own answer is
 * `String.prototype.isWellFormed()`, which is ES2024; this workspace pins
 * `lib: ["es2023"]` in `tsconfig.node22.json`, so the method exists at runtime
 * under Node 22 and is absent from the type surface. The alternatives were
 * widening every package's ambient lib for one call site or casting past the
 * type system on the exact value the guard exists to distrust. A twelve-line
 * total scan is neither, and it buys the refusal message an INDEX, which the
 * standard predicate does not report.
 *
 * The scan is deliberately the same shape as {@link applyPlaintextBound}'s: one
 * pass over UTF-16 units, no allocation, and a high surrogate consumes its
 * trailing unit only when that unit is a low surrogate. Anything else — a low
 * surrogate reached first, a high surrogate at the end of the string, a high
 * surrogate followed by a non-surrogate — is the unpaired case.
 */
function findUnpairedSurrogateIndex(value: string): number {
  for (let unitIndex = 0; unitIndex < value.length; unitIndex += 1) {
    const unit = value.charCodeAt(unitIndex);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    if (unit > 0xdbff) {
      return unitIndex;
    }
    const trailingUnit = unitIndex + 1 < value.length ? value.charCodeAt(unitIndex + 1) : -1;
    if (trailingUnit < 0xdc00 || trailingUnit > 0xdfff) {
      return unitIndex;
    }
    unitIndex += 1;
  }
  return -1;
}

/**
 * Applies the plaintext bound, cutting at a UTF-8 CODEPOINT boundary.
 *
 * ENCODES A BOUNDED PREFIX AND NEVER THE WHOLE BODY. `EventContentInput.body`
 * is an arbitrarily large caller-supplied string — a tool result is routinely a
 * file dump, which is the reason the ceiling exists at all — so encoding first
 * and cutting afterwards would materialize the entire encoding before learning
 * it must be thrown away, allocating without bound on exactly the input the
 * bound exists to contain. Instead the walk below computes the PRE-truncation
 * byte length in O(1) space, summing per-code-point UTF-8 widths, and only then
 * encodes at most {@link CONTENT_PAYLOAD_PLAINTEXT_MAX} bytes' worth of prefix.
 *
 * THE CUT IS BYTE-IDENTICAL TO THE ENCODE-THEN-WALK-BACK RULE IT REPLACES, and
 * that equivalence is what lets the truncation arms stay unmodified: both
 * produce the LONGEST WHOLE-CODE-POINT PREFIX whose UTF-8 length is at most the
 * budget. The walk simply refuses the first code point that would cross the
 * budget instead of encoding past it and stepping back over continuation bytes.
 * A body whose encoding lands exactly on the budget is NOT truncated, under both
 * rules.
 *
 * Cutting mid-codepoint is what the walk exists to prevent, and the consequence
 * is not cosmetic: a lone surrogate or a truncated multi-byte sequence would
 * either fail the RFC 8785 §3.2.2.2 well-formed-strings guard downstream or
 * decode to a replacement character on read, silently corrupting the last
 * character of every truncated body.
 *
 * REFUSAL 8'S WELL-FORMEDNESS ARM IS THIS FUNCTION'S PRECONDITION, and moving
 * that guard would silently change what this reports. {@link utf8ByteWidth}
 * answers for an unpaired surrogate rather than throwing, so the length stays
 * true either way — but the SURROGATE-PAIR step below advances two UTF-16 units
 * only for a well-formed pair, and a caller that admitted ill-formed text would
 * be sealing bytes `TextEncoder` had already replaced with U+FFFD while the
 * signature vouched for them as the prose that went in.
 *
 * `contentLength` reports the PRE-truncation length, so the size of what was
 * dropped stays recoverable from the audit log.
 */
function applyPlaintextBound(body: string): {
  readonly bytes: Uint8Array;
  readonly contentLength: number;
  readonly truncated: boolean;
} {
  // `boundedUnitCount` is the UTF-16 length of the longest prefix that fits, and
  // `-1` means "nothing has crossed the budget yet" — which at the end of the
  // walk is exactly the untruncated case, including the body that lands on the
  // budget to the byte.
  let contentLength = 0;
  let boundedUnitCount = -1;
  for (let unitIndex = 0; unitIndex < body.length; ) {
    const unit = body.charCodeAt(unitIndex);
    let unitWidth = 1;
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff && unitIndex + 1 < body.length) {
      const trailingUnit = body.charCodeAt(unitIndex + 1);
      if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (trailingUnit - 0xdc00) + 0x10000;
        unitWidth = 2;
      }
    }
    const byteWidth = utf8ByteWidth(codePoint);
    if (boundedUnitCount < 0 && contentLength + byteWidth > CONTENT_PAYLOAD_PLAINTEXT_MAX) {
      boundedUnitCount = unitIndex;
    }
    contentLength += byteWidth;
    unitIndex += unitWidth;
  }

  if (boundedUnitCount < 0) {
    return { bytes: new TextEncoder().encode(body), contentLength, truncated: false };
  }
  // `slice` copies at most the budget's worth of characters, and the encode
  // below therefore allocates at most the budget's worth of bytes — the whole
  // point of finding the cut before encoding rather than after.
  return {
    bytes: new TextEncoder().encode(body.slice(0, boundedUnitCount)),
    contentLength,
    truncated: true,
  };
}

/**
 * Seals the bounded plaintext under the session content key.
 *
 * Local rather than injected, unlike {@link PiiEncryptor}: the session content
 * key has no per-participant custody question behind it — the key store hands
 * over 32 bytes — and the wire format is fixed by
 * `docs/architecture/schemas/local-sqlite-schema.md §Session Events (Plan-001, extended by Plans 006, 008, 015)` rather than
 * left to an implementor. Housing it here is what makes "one place the
 * write-path order lives" true for both partitions.
 */
function sealContentPartition(
  content: EventContentInput,
  sessionId: string,
  eventId: string,
): SealedContentPartition {
  const bounded = applyPlaintextBound(content.body);
  const iv = new Uint8Array(randomBytes(CONTENT_SEAL_IV_BYTES));
  const cipher = createCipheriv("aes-256-gcm", content.contentKey, iv);
  cipher.setAAD(buildContentSealAad(sessionId, eventId));
  const body = Buffer.concat([cipher.update(bounded.bytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  const sealed = new Uint8Array(iv.length + body.length + tag.length);
  sealed.set(iv, 0);
  sealed.set(body, iv.length);
  sealed.set(tag, iv.length + body.length);
  return {
    ciphertext: sealed as ContentPayloadCiphertext,
    contentLength: bounded.contentLength,
    truncated: bounded.truncated,
  };
}

/**
 * Opens a stored `content_payload` — the read-side counterpart of
 * {@link sealContentPartition}, housed beside it so the envelope format has one
 * home rather than two.
 *
 * THROWS on any failure, and the caller is expected to classify rather than
 * propagate: `content-read.ts` maps every throw here onto the closed
 * `HydratedContentUnavailableReason` union. A wrong key, a tampered tag, a
 * truncated blob, and a body that is not valid UTF-8 are deliberately not
 * distinguished in the thrown message beyond what is safe to say — the AEAD
 * itself does not distinguish the first three, and guessing between them would
 * put a cause in the record that nothing established.
 *
 * NEVER RETURNS A PARTIAL BODY. `decipher.final()` is what verifies the tag, so
 * skipping it — or reading `update()`'s output alone — would hand back
 * unauthenticated plaintext, which is the classic GCM misuse.
 */
export function openContentPayload(
  storedContentPayload: Uint8Array,
  contentKey: Uint8Array,
  sessionId: string,
  eventId: string,
): string {
  const floor = CONTENT_SEAL_IV_BYTES + CONTENT_SEAL_TAG_BYTES;
  if (storedContentPayload.length < floor) {
    throw new Error(
      `stored content_payload is ${String(storedContentPayload.length)} bytes, under the ${String(floor)}-byte iv+tag floor`,
    );
  }
  if (contentKey.length !== CONTENT_SEAL_KEY_BYTES) {
    throw new Error(
      `session content key is ${String(contentKey.length)} bytes, expected ${String(CONTENT_SEAL_KEY_BYTES)}`,
    );
  }
  const iv = storedContentPayload.subarray(0, CONTENT_SEAL_IV_BYTES);
  const tag = storedContentPayload.subarray(storedContentPayload.length - CONTENT_SEAL_TAG_BYTES);
  const body = storedContentPayload.subarray(
    CONTENT_SEAL_IV_BYTES,
    storedContentPayload.length - CONTENT_SEAL_TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", contentKey, iv);
  decipher.setAAD(buildContentSealAad(sessionId, eventId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  // `fatal: true` so an invalid sequence throws instead of decoding to U+FFFD.
  // The seal cuts at a codepoint boundary, so invalid UTF-8 out of an
  // authenticated open means the plaintext that went IN was already malformed —
  // worth a refusal rather than a silently mangled body.
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

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
  /**
   * OPTIONAL here, because a row may carry both partitions. An
   * `assistant.message` that quotes a participant carries machine prose in
   * `content_payload` and the quoted participant text in `pii_payload`, and the
   * order runs ONCE over both.
   */
  readonly content?: EventContentInput;
}

/**
 * An event carrying MACHINE-authored prose and no participant PII — the common
 * case for `assistant.*` and `tool.*` rows, and the arm without which those rows
 * would have no path through this codec at all.
 *
 * `content` is REQUIRED on this arm for the reason `piiPayload` is required on
 * its sibling: an input carrying neither partition has no business in a codec
 * whose entire job is sealing one. The plain append path handles every event
 * whose `pii_payload` AND `content_payload` both stay NULL.
 *
 * `piiPayload?: never` is what makes `input.piiPayload !== undefined` a real
 * narrowing after the category switch below, so the write path can branch on the
 * presence of a partition rather than on a flag it would have to keep in sync.
 */
export interface ContentOnlyEventInput extends RawEventCommonFields {
  readonly category: PiiEligibleCategory;
  readonly piiParticipantId?: never;
  readonly piiPayload?: never;
  readonly content: EventContentInput;
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
  /**
   * `content?: never` IS the unconstructibility mechanism I-006-3-05 names, and
   * it is the same one I-006-2-07 already uses for the PII partition. A
   * destroyable body on a never-compacted, never-shredded row would be a body no
   * mechanism in this plan may ever destroy — so an object literal in either
   * category that attaches one fails to type-check, and the runtime category
   * guard below refuses the value a cast could still build.
   */
  readonly content?: never;
}

/**
 * The codec's input — a discriminated union on `category` (I-006-2-07).
 *
 * Keyed off the real `EventCategory` union from contracts rather than loose
 * string literals, so a category rename or removal in the wire contract surfaces
 * here as a type error instead of a silently unreachable branch.
 */
export type RawEventInput = PiiCarryingEventInput | ContentOnlyEventInput | PiiRefusedEventInput;

/**
 * The two arms that survive the category switch — the input this codec actually
 * seals. Module-local: callers construct a {@link RawEventInput}, and narrowing
 * to this is the write path's own business.
 */
type SealableEventInput = PiiCarryingEventInput | ContentOnlyEventInput;

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
 * `payload` (carrying the digest and the owner stamp) and the normalized
 * `occurredAt`; `piiPayload` is the `pii_payload` column; `signedRow` supplies
 * `prev_hash` / `row_hash` / `daemon_signature`; `piiParticipantId` is the value
 * for the stamp column T3.1 adds, which the shred selector will read.
 * Substituting ANY of the four — a re-canonicalized envelope, a re-encrypted
 * ciphertext, a `prev_hash` read again after the signature was minted, a stamp
 * taken from anywhere but this result — produces an untampered row that can
 * never verify, because the verifier recomputes the digest and the signature
 * from what was STORED and compares the stored stamp against the claim the
 * signature carries ({@link isPiiOwnerStampBound}). `piiParticipantId` USED TO FAIL DIFFERENTLY
 * and no longer does: it is projected into `payload` at the embed step, so it is
 * inside the signed bytes rather than beside them, and a wrong or missing value
 * is now a detectable divergence instead of one that verifies cleanly forever.
 * This is step 7 of `Plan-006 §Encrypt-Then-Digest-Then-Sign Order` and it
 * belongs to T3.1, which owns the INSERT and the lock.
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
 *
 * `canonicalByteLength` is the one member that is NOT a persistable — a
 * measurement of the canonical bytes `signedRow` covers, carried out for the
 * caller's `EVENT_CANONICAL_BYTES_MAX` ceiling check (its own doc comment has
 * the why). "These four" above deliberately does not count it: nothing about
 * it is written to the row.
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
   * IN THE CANONICAL BYTES, DELIBERATELY — a REVERSAL of what this module
   * shipped with, and the reversal is the point. `embedCiphertextDigest`
   * projects this value into `payload` under
   * {@link PII_PARTICIPANT_ID_PAYLOAD_KEY}, so the signature commits to it and
   * {@link isPiiOwnerStampBound} can hold the stored column to the signed claim.
   *
   * The exclusion it replaces rested on a confidentiality argument that was
   * false, and it is worth stating why so it is not re-argued. `actor` is
   * ALREADY a canonical member and already carries participant ids — the same
   * `0001-initial.ts` line quoted above, "participant_id or agent_id or NULL for
   * system" — so the canonical form has signed participant identifiers since it
   * shipped. Adding the stamp introduces no new CLASS of disclosure, only the
   * same kind of datum in a second position, which means the confidentiality
   * argument bought exactly nothing. `Spec-022 §Signature Safety Under Shred` is
   * about the CIPHERTEXT: signed bytes derived from the PII partition would hand
   * an attacker length and structure oracles over erased data, and an identifier
   * that the shred does not erase in the first place is not that hazard.
   * `Spec-022 §Shred Fan-Out` Path 1 destroys the KEY and overwrites no column,
   * so the stamp was always going to outlive the shred — see
   * {@link describeParticipantIdShape}, which has said so all along.
   *
   * WHAT THE EXCLUSION DID COST is the post-shred sole-evidence property. Once
   * the key is gone the ciphertext can never again be attributed to an owner by
   * decryption, so this stamp is the only surviving evidence of whose data the
   * row held — and nothing signed it. A tampered stamp does not stop Path 1's
   * global `DELETE FROM participant_keys` from erasing that participant's data,
   * but it corrupts the SCOPE SELECTOR: the `affectedSessionIds[]` /
   * `piiPayloadsCleared` an `event.shredded` event records are falsified, and
   * the row is mis-attributed to whichever participant the stamp now names. That
   * event is `event_maintenance`, which `Spec-006 §Event Maintenance
   * (event_maintenance)` never compacts and never shreds, so the falsified
   * compliance evidence is retained indefinitely.
   *
   * Plain `string`, matching {@link PiiEncryptionRequest.participantId} and
   * `session/types.ts`'s `MembershipProjection.participantId`, rather than the
   * contracts-side branded `ParticipantId`: nothing on this path mints that
   * brand, and its schema requires a UUID this module has no standing to demand
   * of an injected key holder.
   *
   * `undefined` ON A CONTENT-ONLY ROW, which is the shape change Phase 3B makes
   * to this result. The member is declared `string | undefined` rather than
   * optional so it stays in every caller's destructuring surface: T3.1 writes it
   * into a column on every append, and a member that could be silently omitted
   * is one an INSERT could silently stop binding.
   */
  readonly piiParticipantId: string | undefined;
  readonly piiPayload: PiiPayloadCiphertext | undefined;
  /**
   * The sealed machine-authored body for `session_events.content_payload`, or
   * `undefined` on a row that carries none.
   *
   * Under the SAME caller obligation as `piiPayload`: persist these bytes, not a
   * re-seal. The digest inside the signed `payload` commits to exactly this
   * array, and AES-256-GCM takes a fresh random IV per write, so a second seal
   * would mint an unrelated ciphertext whose digest no verifier can reconcile
   * with the row it is holding.
   */
  readonly contentPayload: ContentPayloadCiphertext | undefined;
  readonly signedRow: SignedRow;
  /**
   * Byte length of the RFC 8785 canonical form `signedRow` covers — measured
   * at step 5, where the bytes exist, and echoed out because this result
   * carries no other trace of them (nothing persists canonical bytes; a
   * verifier recomputes them from the stored columns). T3.1 holds this figure
   * to `EVENT_CANONICAL_BYTES_MAX` (`Spec-006 §Canonical Serialization
   * Rules`, 2026-08-11 amendment) rather than re-canonicalizing the envelope,
   * which would stand up a second authority over bytes this module already
   * produced once.
   *
   * On this path the ceiling is measurable only AFTER the encrypt and embed
   * steps — the digest member exists only downstream of them — so a
   * ceiling-exceeded append spends one AEAD seal and one signature before the
   * caller refuses it. Deliberate: the refusal is a rare structural defect
   * (the payload catalog is metadata-shaped, sitting orders of magnitude
   * under the bound), and a pre-encrypt estimate would either under-count and
   * admit unservable rows or duplicate the canonicalizer as an approximation.
   */
  readonly canonicalByteLength: number;
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
 * Runs `Plan-006 §Encrypt-Then-Digest-Then-Sign Order` steps 2–6 for one event
 * carrying a participant PII partition, a machine-authored content partition,
 * or BOTH, and returns everything T3.1 needs for step 7. Step 1 — the
 * PII / non-PII split — belongs to the EMITTER and has already happened by the
 * time this function is called; see {@link PiiCarryingEventInput}.
 *
 * ONE RECIPE OVER BOTH PARTITIONS, never two runs of it. A row carrying both is
 * canonicalized once and signed once (I-006-2-06), with both digests embedded in
 * the same step — which is why the stages below name each partition rather than
 * splitting into two numbered lists.
 *
 * Stages, numbered as that recipe numbers them, in the only order the types
 * permit:
 *
 *   2. ENCRYPT — the injected {@link PiiEncryptor} seals the `piiPayload`
 *      partition under the participant's key. The result is branded
 *      {@link PiiPayloadCiphertext} here and nowhere else. The content
 *      partition is BOUNDED and then sealed in the same stage by
 *      {@link sealContentPartition} — AES-256-GCM under the session content key
 *      the caller resolved, branded {@link ContentPayloadCiphertext} there and
 *      nowhere else — and it runs AFTER the PII encrypt so a row carrying both
 *      spends its nonces in a fixed order.
 *   3. DIGEST — `BLAKE3(ciphertext)` over exactly the bytes that will occupy the
 *      `pii_payload` column, lowercase hex, and the same over exactly the bytes
 *      that will occupy `content_payload`.
 *   4. EMBED — each digest becomes a `payload` member, which is what puts it
 *      INSIDE the canonical form (`Spec-006 §Canonical Serialization Rules`
 *      excludes both columns themselves and requires the digest in their
 *      place). The content partition embeds two further members the seal step
 *      determines — `contentLength`, and `contentTruncated` only when the bound
 *      fired.
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
 *   1. A STRUCTURAL DEFECT IN THE INPUT'S PARTITIONING, in FOUR arms, in this
 *      order: a refused category (I-006-3-01 layer 2), then an input carrying
 *      NEITHER partition, then a HALF-PRESENT PII partition
 *      (`piiParticipantId` with no `piiPayload`), then a CONTENT partition on an
 *      event type outside the body-bearing five
 *      ({@link BODY_BEARING_EVENT_TYPES}). Arms two and three were added
 *      with the content partition and neither reorders anything that could
 *      reach the shipped code: before a second partition existed, "neither" was
 *      unreachable and the half-present shape threw much later and about the
 *      wrong thing, inside `canonicalizeJson(undefined)`. Each arm's own note
 *      carries why it refuses rather than degrades.
 *
 *      ARM FOUR IS PLACED LAST OF THE FOUR so neither sibling's message moves
 *      for an input that drew one. It DOES reorder an input that was already
 *      being refused — a content partition on an unregistered type that ALSO
 *      pre-seeds a reserved member drew refusal 2 before and draws this now —
 *      which is the reserved-stamp arm's precedent, named rather than denied and
 *      benign for the same reason: the input is invalid either way and both
 *      answers are refusals before the nonce. Every input carrying content on
 *      one of the five answers exactly as it did.
 *   2. A `payload` that already claims a RESERVED member, in THREE arms over
 *      FIVE members: `pii_ciphertext_digest` first, then `pii_participant_id`,
 *      then one arm over the three content members
 *      ({@link CODEC_OWNED_CONTENT_PAYLOAD_KEYS}). The embed step projects all
 *      five and nothing else produces any of them, so a pre-seeded one is a
 *      value the signature would vouch for with nothing behind it. The order is
 *      fixed so the digest arm keeps the message it shipped with, a payload
 *      carrying both PII members reports the digest, and no input that drew
 *      either PII arm's message before the content arm existed draws a
 *      different one now. `contentType` is deliberately NOT reserved — the
 *      producer knows the media type and this codec never could.
 *
 *      THE STAMP ARM IS NEW and touches exactly two classes of input, both of
 *      which carry a member no legitimate producer emits. (a) Pre-seeded stamp,
 *      otherwise-valid envelope: previously NOT refused at all — the member rode
 *      in as an ordinary payload key and was signed — and now refused here,
 *      which is the entire point of the arm. (b) Pre-seeded stamp AND a defect
 *      at 3–7: previously drew that later refusal and now draws this one. That
 *      IS a reordering of an input that already drew a refusal, named rather
 *      than denied, and it is benign — the input is invalid either way and both
 *      answers are refusals before the nonce. Every input free of a pre-seeded
 *      `pii_participant_id` answers exactly as it did before. The placement is
 *      its sibling's rather than a new choice: the digest arm has always sat at
 *      2, ahead of `sequence`, and refusal 3's cross-path precedence argument is
 *      about `canonicalizeEvent`, which has no notion of a reserved PII member.
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
 *   7. A `piiParticipantId` that is not a non-empty string. STILL NOT A HOIST,
 *      though the value no longer stops at the encryptor: nothing downstream
 *      judges its SHAPE. It now reaches three consumers and not one of them
 *      does — the injected {@link PiiEncryptor}, across CP-006-1, where this
 *      module owns no implementation and may therefore require no behavior of
 *      one; the embed step, which projects it into `payload` under
 *      {@link PII_PARTICIPANT_ID_PAYLOAD_KEY}; and the read side, which compares
 *      the stored column against that projected claim. The embed step is the
 *      nearest thing to a downstream guard and it is not one: `canonicalizeJson`
 *      would throw on a `NaN` stamp but emits `null` for a `null` one and a bare
 *      number for `0`, so it refuses a few malformed stamps and signs the rest.
 *      Placed after 6 so it reorders nothing that shipped before it: any input
 *      that drew a refusal without this guard draws the identical refusal with
 *      it, since 1–6 are answerable from members it does not read.
 *   8. A malformed CONTENT partition — a non-string `content.body`, then a
 *      `content.contentKey` that is not 32 bytes, then a `content.body` that is
 *      not WELL-FORMED UTF-16. Placed LAST, on the same
 *      no-reordering ground: nothing at 1–7 reads `content`, so every input
 *      that could reach the code before this partition existed answers exactly
 *      as it did. All three are silent when wrong — `TextEncoder` stringifies
 *      a non-string rather than refusing, a wrong-width key reaches
 *      `createCipheriv` only after the PII nonce is already spent, and an
 *      unpaired surrogate is SUBSTITUTED with U+FFFD rather than rejected — and
 *      the guard's own note carries the rest. The well-formedness arm is
 *      APPENDED LAST WITHIN 8, behind the key-width check, so no input that drew
 *      either sibling's message draws a different one now.
 *   9. A COMPOSED ENVELOPE ITS OWN REGISTERED VARIANT REJECTS — a category that
 *      does not match its `type`, or a `payload` the type's registered schema
 *      refuses. THE ONE ENTRY IN THIS LIST THAT FIRES BEHIND THE ENCRYPT, and it
 *      is in the list anyway because the list is the observable refusal ORDER
 *      and this refusal is observable: it is simply last. It cannot be hoisted —
 *      its subject is the envelope AFTER the embed step, which does not exist
 *      until the seal has run — so it is also the third member of the
 *      behind-the-encrypt set below. {@link assertRegisteredVariantParses}
 *      carries the whole argument: why it parses the composed form rather than
 *      the input, why a type with no registered variant is skipped, and why the
 *      subject needs nothing projected away. That function is SHARED with
 *      `EventLogService.append`'s plain branch, which reaches the same guard
 *      from its own position. Placed after 8, in the only
 *      position it could occupy, so it reorders nothing: an input defective at
 *      1–8 draws the message it drew before, and only inputs that were
 *      previously ADMITTED can reach it at all.
 *
 * 3, 5, AND 6 ARE EARLY COPIES, NEVER REPLACEMENTS.
 * `assertRepresentableSequence`, `signRow`'s guard, and `ed25519.sign`'s
 * `abytes` all still run downstream and stay authoritative, so a copy that ever
 * drifted could only refuse early — never admit late. 3 and 5 are BYTE-IDENTICAL
 * to the guards they front; 6 is deliberately narrower, and its own note says
 * both why and in which direction.
 *
 * 7 AND 8 ARE NOT IN THAT SET, and the sentence above must not be read as
 * covering either. Each is the first and last word on its own value's SHAPE, so
 * there is no downstream authority to be an early copy OF and no drift for a
 * late guard to catch. What follows argues 7; 8's own note argues 8, on the
 * same ground and for three checks over two values instead of one check over
 * one. 8's WELL-FORMEDNESS arm is the sharpest case of that: the read side's
 * `TextDecoder` runs `fatal: true`, which would catch invalid UTF-8 — and
 * `TextEncoder` never emits any, because it substitutes U+FFFD for an unpaired
 * surrogate rather than producing a malformed sequence. So the ill-formed body
 * round-trips green forever, and nothing but this guard ever sees
 * it. That is an argument for the guard rather than against it, and the
 * argument got STRONGER when the stamp joined the canonical bytes: a malformed
 * stamp reaching the embed step is signed, so the signature vouches for it and
 * {@link isPiiOwnerStampBound} reports the row BOUND — correctly, since the
 * column and the claim would agree. Bound is not well-shaped, and nothing after
 * this guard asks the second question. The guard's own note carries the rest.
 *
 * THREE CLASSES REMAIN BEHIND THE ENCRYPT, AND NONE MOVES HONESTLY. THE CONTENT
 * PARTITION'S SEAL ADDS NONE OF THEM: {@link sealContentPartition} refuses
 * nothing of its own, because 8 has already checked both values it consumes —
 * including the well-formedness {@link applyPlaintextBound} names as its
 * precondition — and the bound TRUNCATES rather than refusing, so a body over
 * the ceiling is a stored row with `contentTruncated` set and never a rejected
 * append. The three:
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
 *   - REFUSAL 9's COMPOSED-VARIANT PARSE, whose subject — the embedded envelope
 *     — does not exist until the seal has run. It is the one member of this set
 *     that is answerable from the input IN PRINCIPLE and is still placed here on
 *     purpose: reconstructing the subject early would mean substituting a
 *     placeholder for each digest, which is the same
 *     pre-check-that-disagrees-with-its-guard hazard the depth-offset argument
 *     above refuses for the nesting ceiling, and on a value the strict layer is
 *     free to start constraining without telling this module. The cost is named
 *     rather than hidden — a row refused at 9 has already spent its AEAD nonces
 *     on both partitions — and what it buys is a guard that judges exactly the
 *     members the signature is about to cover.
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
        `writeEventWithPii refuses category ${JSON.stringify(input.category)}: ${PII_REFUSED_CATEGORY_NAMES.join(" and ")} events are never compacted and never crypto-shredded per Plan-006 §Audit Integrity Invariant, so their pii_payload and content_payload are NULL by construction. Append this event through the plain append path instead.`,
      );
  }

  // REFUSAL 1's SECOND ARM — an input carrying NEITHER partition.
  //
  // Unreachable through the type system: the PII arm requires `piiPayload` and
  // the content arm requires `content`, so no well-typed value lands here. It is
  // guarded anyway on layer 2's own logic — a value that crossed a serialization
  // boundary is a value TypeScript never checked — and it reorders nothing,
  // because no input that could reach the shipped code lacked a partition.
  //
  // Refusing rather than degrading to a plain signed row is the point: this
  // codec's entire job is sealing a partition, and a caller that reached it with
  // nothing to seal has routed the append to the wrong path. Signing it here
  // would hide that, and would put a second producer of ordinary rows behind an
  // entry point documented as the sole PII and content write path.
  if (input.piiPayload === undefined && input.content === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying neither a PII partition nor a content partition: this codec is the write path for pii_payload and content_payload, and a row with neither belongs on the plain append path. Pass piiPayload, content, or both.",
    );
  }

  // REFUSAL 1's THIRD ARM — a HALF-PRESENT PII partition.
  //
  // The narrowing below discriminates on `piiPayload` alone, so a value
  // carrying `piiParticipantId` with no `piiPayload` reads as the content-only
  // arm and its participant half is DROPPED — sealed nowhere, stamped nowhere,
  // and reported nowhere. That is the one failure this module refuses to have:
  // every other guard here exists so participant PII is never lost or persisted
  // outside the split, and a silent drop is both at once.
  //
  // Unreachable through the type system in either direction — the PII arm
  // requires `piiPayload` and the content arm types `piiParticipantId` as
  // `never` — so this is layer 2 again: a value that crossed a serialization
  // boundary is a value TypeScript never checked.
  //
  // PLACED IMMEDIATELY AFTER THE NEITHER-PARTITION ARM, which keeps its message
  // for the input that carries neither, and BEFORE the narrowing so no later
  // site has to re-ask. It reorders nothing that could previously reach the
  // shipped code: before the content partition existed this shape reached
  // `canonicalizeJson(undefined)` and threw there, much later and about the
  // wrong thing.
  if (input.piiParticipantId !== undefined && input.piiPayload === undefined) {
    throw new Error(
      "writeEventWithPii refuses an event carrying piiParticipantId with no piiPayload: the two are halves of one partition, and admitting the pair would route the row as content-only and drop the participant half silently — sealed nowhere and invisible to the shred selector. Pass both, or neither.",
    );
  }

  // REFUSAL 1's FOURTH ARM — a CONTENT partition on an event type that declares
  // no place to record one.
  //
  // The closed set is `BODY_BEARING_EVENT_TYPES`, derived from the contracts
  // union rather than listed here, so this guard cannot disagree with the
  // schemas it enforces. Its own note carries that argument.
  //
  // IN THE CODEC RATHER THAN AT THE APPEND PATH, deliberately, and that is the
  // whole value of the arm. `EventLogService.append` is one caller; this module
  // is the SOLE WRITE PATH for `content_payload` (I-006-2-02), so a check that
  // lived above it would be bypassed by the next caller to reach the codec
  // directly — and the append path already routes `options.content` straight
  // through. One guard on the write path is worth more than a guard on each
  // caller, because the second kind is only ever as complete as the last review.
  //
  // WHY REFUSE RATHER THAN SEAL ANYWAY. The embed step projects
  // `contentCiphertextDigest`, `contentLength`, and `contentTruncated` into
  // `payload`, which lands them inside the signed canonical bytes. On a type
  // whose registered payload schema is `.strict()` and declares none of the
  // three, the row this codec produced would then fail its OWN schema on the way
  // back out — a signed, chained, permanently unparseable row. Refusing costs a
  // rejected append; admitting costs a row nothing can ever read back.
  //
  // Layer 2 again in kind: `type` is a `string` on the envelope (the tolerant
  // carrier a higher-MINOR producer relies on), so this is a runtime question
  // that no narrowing here could answer. `Object.hasOwn` rather than a property
  // read, so a `type` of `"constructor"` or `"__proto__"` cannot borrow a
  // prototype member and pass.
  if (input.content !== undefined && !Object.hasOwn(BODY_BEARING_EVENT_TYPES, input.type)) {
    throw new Error(
      `writeEventWithPii refuses a content partition on event type ${JSON.stringify(input.type)}: machine-authored prose is sealed only for ${Object.keys(BODY_BEARING_EVENT_TYPES).join(", ")}, the types whose registered payload declares the codec's content members (Spec-006 §Canonical Serialization Rules). Any other type would be signed carrying members its own schema rejects. Append this event through the plain append path instead.`,
    );
  }

  // The narrowed PII half, captured once. `piiPayload` is typed `never` on the
  // content-only arm, so this ternary is ordinary discriminated-union narrowing
  // rather than a cast — and capturing it here keeps every later PII site from
  // re-deriving the same narrowing under a slightly different condition.
  const piiCarrying: PiiCarryingEventInput | undefined =
    input.piiPayload === undefined ? undefined : input;
  const contentInput: EventContentInput | undefined = input.content;

  // REFUSAL 2 of the order documented above, in TWO ARMS over the two reserved
  // payload members the embed step projects. Both are refused rather than
  // overwritten, on one logic: this codec is the sole producer of each, so a
  // pre-seeded value is either a re-run of a codec that cannot reproduce its own
  // output or a producer supplying a claim of its own. Silently replacing the
  // member would hide the first; silently trusting it would sign the second.
  //
  // The arms are separate rather than a loop over a reserved-key array because
  // the two answer for different things and a merged message would say neither:
  // a stale digest is a claim about BYTES, a caller-supplied stamp is a claim
  // about WHOSE data the row holds. The digest arm runs first and keeps its
  // shipped wording verbatim.
  if (Object.hasOwn(input.payload, PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY)) {
    throw new Error(
      `writeEventWithPii refuses an event whose payload already carries ${PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY}: this codec is the only producer of that member (Spec-006 §Canonical Serialization Rules), and it is not re-runnable — AES-256-GCM uses a fresh random nonce per write, so a second pass would mint an unrelated ciphertext and digest.`,
    );
  }

  // The stamp arm. Distinct from the digest arm in what it protects: the embed
  // step projects `input.piiParticipantId` into this member so the signature
  // binds the row's PII owner, and a caller-supplied value would be signed in
  // its place — the SAME signed-but-unchecked hole the projection exists to
  // close, reopened from the input side. It also disagrees with the stamp T3.1
  // writes into the column, which is precisely the divergence
  // {@link isPiiOwnerStampBound} reports.
  if (Object.hasOwn(input.payload, PII_PARTICIPANT_ID_PAYLOAD_KEY)) {
    throw new Error(
      `writeEventWithPii refuses an event whose payload already carries ${PII_PARTICIPANT_ID_PAYLOAD_KEY}: this codec is the only producer of that member — it projects the PII owner stamp from input.piiParticipantId so the signature binds it, and a caller-supplied value would be signed in place of the stamp T3.1 writes into the column. Pass the owner as piiParticipantId, not as a payload member.`,
    );
  }

  // The CONTENT arm — refusal 2's third, added by Phase 3B and placed LAST of
  // the three so neither PII arm's message moves for any input that drew one.
  //
  // One arm over THREE members rather than three arms, because they answer for
  // the same thing: what this codec sealed. The digest is a claim about bytes,
  // `contentLength` a claim about how many there were before the bound was
  // applied, and `contentTruncated` a claim about whether the bound fired — all
  // three determined at the seal step, none of them knowable to a producer, and
  // all three inside the signed canonical bytes. `contentType` is deliberately
  // NOT in this set: the producer knows the media type of what it emitted and
  // this codec never could.
  //
  // Refused rather than overwritten, on the sibling arms' logic: silently
  // replacing a pre-seeded value hides a codec re-run that cannot reproduce its
  // own output, and silently trusting one signs a producer's claim about work it
  // did not do.
  //
  // DELEGATED, not inlined. This arm and `EventLogService.append`'s step (2) are
  // the same refusal at the two ends of the sole durable append path — step (2)
  // ahead of its plain-vs-codec branch choice, this one for a caller that
  // invokes the codec directly — and
  // {@link assertNoCodecOwnedContentKeys} is its one definition — see that
  // function for why the guard is NOT codec-scoped (an earlier draft of this
  // comment argued that it should be, and was wrong), why tolerant carriers are
  // guarded identically, and why the throw is internal rather than wire-typed.
  // The `refuser` argument reproduces this arm's message verbatim, so the
  // refusal order the codec's tests pin does not move.
  assertNoCodecOwnedContentKeys(input.payload, "writeEventWithPii");

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
  const piiPlaintext: Uint8Array | undefined =
    piiCarrying === undefined ? undefined : canonicalizeJson(piiCarrying.piiPayload);

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
  // an AUTHORITY rather than an early copy, because nothing downstream judges
  // this value's shape. Three stages consume it now (encryptor, embed, read-side
  // binding check) and all three take whatever they are handed.
  //
  // `piiParticipantId` selects the content key that seals this row, supplies
  // half of the AEAD's associated data (`participant_id || event_id`,
  // `Spec-022 §PII Payload Column Pattern`), and is projected into the signed
  // canonical bytes as the row's owner stamp. An empty or non-string value
  // breaks the row in three directions and is loud in none: the ciphertext is
  // sealed against associated data no decrypt can reconstruct, the Path-1
  // selector in `Spec-022 §Shred Fan-Out` — which matches the durable
  // participant-id stamp, never the opaque ciphertext — has nothing to find when
  // the participant asks to be erased, and the signature commits to the
  // malformed stamp, so the binding check finds the column and the claim in
  // perfect agreement on a value that names nobody. Every other check still
  // passes. The digest agrees, the signature verifies, the chain links, and what
  // lands is a healthy-looking row holding PII that can be neither read nor
  // shredded nor attributed.
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
  if (
    piiCarrying !== undefined &&
    (typeof piiCarrying.piiParticipantId !== "string" || piiCarrying.piiParticipantId.length === 0)
  ) {
    throw new Error(
      `writeEventWithPii requires a non-empty piiParticipantId: it names the participant whose content key seals this row and whose participant_keys DELETE crypto-shreds it, and it is the stamp the Spec-022 §Shred Fan-Out Path 1 selector matches on and the value projected into the signed canonical bytes as ${PII_PARTICIPANT_ID_PAYLOAD_KEY}; received ${describeParticipantIdShape(piiCarrying.piiParticipantId)}. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce; unlike the guards above it, nothing downstream re-checks this value's shape.`,
    );
  }

  // REFUSAL 8 of the order documented above — the content partition's own shape
  // guard, and the second on this path that is an AUTHORITY rather than an early
  // copy. Placed LAST so it reorders nothing: any input that drew a refusal at
  // 1–7 draws the identical one, since none of those reads `content`.
  //
  // Both members break the row silently if they are wrong. A non-string `body`
  // reaches `TextEncoder.encode`, which stringifies rather than refusing — `null`
  // becomes the four bytes of "null" and an object becomes "[object Object]" —
  // so a defect would be sealed, digested, and signed as though it were prose,
  // and would read back later as a body the assistant never wrote. A wrong-width
  // key is worse: `createCipheriv` throws for most widths, but the throw would
  // land after the PII nonce is already spent, on a codec the module header
  // documents as `manual_reconcile_only`.
  //
  // Nothing downstream judges either value. `createCipheriv` checks the key
  // width and not the body's type, and no read-side check can recover a body
  // that was malformed before it was sealed — the digest will agree, the
  // signature will verify, and the row will be a healthy-looking commitment to
  // "[object Object]".
  if (contentInput !== undefined) {
    if (typeof contentInput.body !== "string") {
      throw new Error(
        `writeEventWithPii requires content.body to be a string — it is the machine-authored prose sealed into session_events.content_payload; received ${describeParticipantIdShape(contentInput.body)}. TextEncoder would stringify a non-string rather than refuse it, so the row would carry a signed commitment to a coerced value; nothing downstream re-checks this shape.`,
      );
    }
    if (
      !(contentInput.contentKey instanceof Uint8Array) ||
      contentInput.contentKey.length !== CONTENT_SEAL_KEY_BYTES
    ) {
      throw new Error(
        `writeEventWithPii requires a ${CONTENT_SEAL_KEY_BYTES}-byte Uint8Array content.contentKey — the session content key from session-content-key-store.ts, already unwrapped; received ${describeByteShape(contentInput.contentKey)}. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce on either partition.`,
      );
    }
    // REFUSAL 8's THIRD ARM — an ill-formed body, appended LAST within 8 so no
    // input that drew either sibling's message draws a different one now.
    //
    // `TextEncoder` does not refuse an unpaired surrogate; it SUBSTITUTES
    // U+FFFD. So a body containing one would be sealed, digested, and signed as
    // three bytes of replacement character standing where the producer's text
    // was, and every layer above would read a clean row: the AEAD tag
    // authenticates, the digest matches the ciphertext, the signature verifies,
    // and the read side's `fatal: true` decoder is satisfied because the stored
    // UTF-8 IS valid — the corruption happened on the way in. The signature
    // would vouch for text nobody wrote.
    //
    // The canonical payload path already treats ill-formed strings this way:
    // T2.1's `canonicalizeJson` runs the RFC 8785 §3.2.2.2 well-formedness guard
    // and refuses rather than substituting. This arm holds the CONTENT partition
    // to the same rule, which is what keeps one row's two text partitions
    // answering the same way about the same defect.
    //
    // AN AUTHORITY, NOT AN EARLY COPY, on refusal 7's terms: `content.body`
    // never enters `payload`, so `canonicalizeEvent`'s well-formedness guard
    // never sees it and there is no downstream check to be a copy of.
    const unpairedSurrogateIndex = findUnpairedSurrogateIndex(contentInput.body);
    if (unpairedSurrogateIndex >= 0) {
      throw new Error(
        `writeEventWithPii requires content.body to be well-formed UTF-16; it carries an unpaired surrogate at UTF-16 index ${String(unpairedSurrogateIndex)}. TextEncoder substitutes U+FFFD rather than refusing, so the row would carry a signed, digested commitment to a replacement character in place of the producer's text, and every later check would pass. Refused before the encrypt step so a rejected append costs no AES-256-GCM nonce on either partition.`,
      );
    }
  }

  // --- Step 2: ENCRYPT (PII partition) --------------------------------------
  // Skipped entirely on a content-only row: there is no participant partition to
  // seal, and the injected encryptor is never called for one.
  let piiPartition: SealedPiiPartition | undefined;
  if (piiCarrying !== undefined && piiPlaintext !== undefined) {
    const encryptorResult: Uint8Array = await encryptor.encrypt({
      participantId: piiCarrying.piiParticipantId,
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
    const piiPayload: PiiPayloadCiphertext = new Uint8Array(
      encryptorResult,
    ) as PiiPayloadCiphertext;
    piiPartition = { ciphertext: piiPayload, participantId: piiCarrying.piiParticipantId };
  }

  // --- Step 2 (content partition): BOUND, then SEAL -------------------------
  //
  // TRUNCATE BEFORE SEALING, never after. The digest commits to the STORED
  // ciphertext, so a body shortened after the seal would leave a commitment to
  // bytes the column does not hold; and `contentLength` reports the
  // pre-truncation figure precisely because the plaintext is measured before the
  // cut. Sealing a full body and storing a prefix of the ciphertext would not
  // even decrypt.
  //
  // AFTER the PII encrypt so a row carrying both partitions spends its nonces in
  // a fixed order, and after every refusal so neither is spent on a defect.
  const contentPartition: SealedContentPartition | undefined =
    contentInput === undefined
      ? undefined
      : sealContentPartition(contentInput, input.sessionId, input.id);

  // --- Steps 3 + 4: DIGEST, then EMBED --------------------------------------
  // ONE embed over BOTH partitions, which is what keeps I-006-2-06's
  // one-canonicalization-per-row rule true for a row that carries both.
  const envelope: EventWithPiiDigest = embedCiphertextDigest(
    input,
    normalizedOccurredAt,
    piiPartition,
    contentPartition,
  );

  // --- Refusal 9: PARSE WHAT WILL BE SIGNED ---------------------------------
  //
  // Between the embed and the canonicalization, which is the ONLY window in
  // which the subject exists: this codec's members are in place with their real
  // values, and no byte has been serialized or signed yet. Hoisting it ahead of
  // the encrypt would mean judging a reconstruction rather than the row, which
  // {@link assertRegisteredVariantParses} argues against at length. The plain
  // append branch calls the SAME function from its own position.
  assertRegisteredVariantParses(envelope, {
    name: "writeEventWithPii",
    timing:
      "Refused after the seal and before the signature, which is the only window in which the signed form exists to be checked.",
  });

  // --- Steps 5 + 6: CANONICALIZE, then SIGN ---------------------------------
  const canonical: CanonicalBytes = canonicalizeDigestBearingEvent(envelope);
  const signedRow: SignedRow = signRow(canonical, prevHash, daemonSigningKey);

  // `piiParticipantId` rides out with the other three: it is a column value T3.1
  // must write, and the input is not a source the persistence contract admits.
  // The identical string is also inside `envelope.payload` and therefore inside
  // the signature, which is what makes the column checkable later; echoing it
  // here is what keeps T3.1 from resolving the column from a second source that
  // could disagree with the signed one. Safe to echo by reference where the
  // ciphertext was not — a `string` is immutable, so there is no aliasing hazard
  // to close.
  return {
    canonicalByteLength: canonical.length,
    contentPayload: contentPartition?.ciphertext,
    envelope,
    piiParticipantId: piiPartition?.participantId,
    piiPayload: piiPartition?.ciphertext,
    signedRow,
  };
}

// --------------------------------------------------------------------------
// Pipeline steps.
// --------------------------------------------------------------------------

/**
 * Steps 3 and 4 — digest the ciphertext, then embed BOTH PII bindings in
 * `payload`: the digest, and the owner stamp.
 *
 * The name is narrower than the job by one member, kept because it is cited from
 * this file, from T2.5's suite, and from `Plan-006`. What it embeds is the pair:
 * `pii_ciphertext_digest` binds the signature to the ciphertext BYTES,
 * `pii_participant_id` binds it to the row's OWNER. The two are the same
 * mechanism applied to the two halves of the PII partition's exposure — the
 * content and whose content it is — and neither is recoverable from the other
 * once a shred has destroyed the key.
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
  input: SealableEventInput,
  normalizedOccurredAt: string,
  piiPartition: SealedPiiPartition | undefined,
  contentPartition: SealedContentPartition | undefined,
): EventWithPiiDigest {
  // The two PII bindings, added to a SHALLOW copy of the caller's payload.
  //
  // THE OWNER STAMP IS IN THE SIGNED BYTES ON PURPOSE, and the scope of
  // I-006-2-05 is what makes that consistent rather than a contradiction. That
  // invariant — and T2.5 leg 1's title, "carries `pii_ciphertext_digest` and
  // nothing PII" — is about the PII PARTITION'S CONTENT: the plaintext and the
  // ciphertext, which is why the invariant reads "commit to
  // `pii_ciphertext_digest`, not raw ciphertext". It was never a rule against
  // identifiers, and could not have been: `actor` is a canonical member and
  // `0001-initial.ts` documents that column as "participant_id or agent_id or
  // NULL for system", so the canonical form has signed participant ids since it
  // shipped. Projecting the stamp is therefore a CLARIFICATION of that
  // invariant's scope, not an amendment to it — recorded here so the question is
  // not reopened. The partition itself stays out, and leg 1's sentinel
  // assertions are what keep it out.
  //
  // AND THE STAMP IS NOT REDUNDANT WITH `actor`, which is the rebuttal the
  // sentence above invites. The two carry the same KIND of datum and answer
  // different questions: `actor` names WHO EMITTED the row — `0001-initial.ts`
  // documents that column as "participant_id or agent_id or NULL for system" —
  // while the stamp names WHOSE CONTENT KEY SEALED the ciphertext. They coincide
  // often, and diverge exactly where the divergence is expensive: an
  // agent-emitted row (`actor` = an `agent_id`) or a system-emitted one (`actor`
  // NULL) can still carry a participant's PII, and on those rows `actor` cannot
  // answer the question `Spec-022 §Shred Fan-Out`'s scope selector asks. Both
  // halves are load-bearing — "no new class of disclosure" is what makes the
  // projection safe, and this is what makes it necessary.
  const payloadWithPiiBindings: Record<string, unknown> = { ...input.payload };
  if (piiPartition !== undefined) {
    payloadWithPiiBindings[PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY] = bytesToHex(
      blake3(piiPartition.ciphertext),
    );
    payloadWithPiiBindings[PII_PARTICIPANT_ID_PAYLOAD_KEY] = piiPartition.participantId;
  }

  // THE CONTENT PARTITION EMBEDS ONE BINDING AND TWO DESCRIPTIONS, and the
  // asymmetry with the PII pair above is the substance rather than an oversight.
  // There is no content owner stamp because there is nothing left to bind: the
  // sealing key is SESSION-scoped and `session_id` is already a canonical signed
  // member, which is why this column costs one column and not two and why no
  // `content_owner_stamp_unbound` check pairs with `pii_owner_stamp_unbound`.
  //
  // `contentTruncated` is written ONLY when the bound fired. Absence is the
  // completeness signal, so writing `false` on a complete row would put bytes
  // into the canonical serialization that every complete row before this change
  // did not have — and JCS orders and emits every present member, so the omission
  // is the difference between two byte strings rather than a cosmetic choice.
  if (contentPartition !== undefined) {
    payloadWithPiiBindings[CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY] = bytesToHex(
      blake3(contentPartition.ciphertext),
    );
    payloadWithPiiBindings[CONTENT_LENGTH_PAYLOAD_KEY] = contentPartition.contentLength;
    if (contentPartition.truncated) {
      payloadWithPiiBindings[CONTENT_TRUNCATED_PAYLOAD_KEY] = true;
    }
  }

  // Envelope members projected one at a time, never spread from `input`:
  // `input` carries `piiPayload`, which is not an envelope member and must never
  // become one. Spreading would put the PII partition itself into the canonical
  // bytes — the exact leak this whole codec exists to prevent — and the
  // signature would then pin plaintext PII on disk for as long as the row
  // survives the shred. `piiParticipantId` is not an envelope member either, and
  // it reaches the canonical bytes only through the deliberate projection above,
  // under its own wire name, inside `payload`. The
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
    payload: payloadWithPiiBindings,
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
 * Read-side counterpart to the DIGEST half of {@link embedCiphertextDigest}:
 * does the ciphertext a row is actually holding still hash to the digest its
 * signature committed to? {@link isPiiOwnerStampBound} asks the same question of
 * the owner stamp, and a verifier runs both — they bind different things.
 *
 * Deliberately adjacent to the mint. The digest was signed from the day this
 * codec shipped and NOTHING ever compared it back — a signed-but-unchecked
 * binding, the same shape as the `occurred_at` hole T2.1's
 * `isCanonicalOccurredAt` closes. Keeping mint and check in one place is the
 * structural half of the fix: a future editor cannot touch one without the other
 * in view.
 *
 * NOT part of `verifyRow`. That function is handed already-canonicalized bytes
 * and is never given the `pii_payload` column at all, so it is structurally
 * unable to make this comparison — the check has to run over the column AS
 * STORED, which is the read-side verifier's position. Emitting the verdict is
 * `Security Architecture §Verification Rules` rule 2's job, as a POSTcondition
 * rather than a precondition: the digest lives inside the signed payload, so it
 * is only worth trusting once the Ed25519 verification has passed.
 *
 * TOTAL AND NEVER-THROWING, and here that is a hard requirement rather than
 * defensive style — a verifier consumes this inside a range walk, and one throw
 * would abort the walk and silence audit of the entire remaining tail. Both
 * parameters are `unknown` because both arrive from SQLite: a `BLOB`-affinity
 * column can hand back a JS `string`, and noble's `abytes` throws on one.
 *
 * The four states, all decided, none needing a caller-side guard:
 *
 * | stored `pii_payload` | signed digest | verdict                                  |
 * | -------------------- | ------------- | ---------------------------------------- |
 * | bytes                | present       | compare — the ordinary live PII row      |
 * | NULL                 | absent        | bound: no PII, or a compacted stub       |
 * | bytes                | absent        | UNBOUND — violates the non-NULL MUST     |
 * | NULL                 | present       | UNBOUND — ciphertext destroyed at rest   |
 *
 * The fourth row is the one worth naming, because it is not what a reviewer
 * asks for when they ask for a digest comparison: a signed digest with no
 * ciphertext under it means the column was emptied AFTER signing, and the
 * signature still verifies green over the digest that outlived its subject.
 * That is evidence destruction, and comparing hashes alone would never see it.
 * A legitimately compacted row does not land here — `Spec-006 §Compacted Event
 * Format` NULLs `pii_payload` and replaces `payload` with a stub projection that
 * carries no digest, so it lands in row two.
 *
 * ONE BOUNDARY ON THAT READING IS PINNED RATHER THAN SILENT: it holds for rows
 * this daemon ORIGINATED. `Spec-008 §Peer History Backfill On Join (V1)` names
 * the verifier conflict (2026-08-03): a row received from a peer — live-relayed
 * or backfilled — lands in row four BY DESIGN, because `pii_payload` never
 * crosses the machine boundary while the signed digest inside the canonical
 * payload does, so nothing was destroyed anywhere. The resolution — a durable
 * received-row provenance marker that origin-scopes row four — amends
 * `Spec-006 §Integrity Protocol` and rides Plan-008's backfill task; until that
 * lands, no cross-daemon receive path is wired and every row this predicate can
 * see is origin-authored, so the table above is total as written. A future
 * caller wiring a receive path must land the provenance marker first, not
 * soften this row.
 *
 * A crypto-shredded row lands in row ONE and passes. `Spec-022 §Shred Fan-Out`
 * Path 1 destroys the per-participant key and overwrites no column, so the
 * ciphertext bytes are still there and still hash to the signed digest — which
 * is exactly why this check needs no shred-state carve-out.
 *
 * Fail-closed on a shape it cannot digest: a non-`Uint8Array`, non-NULL column
 * value is reported UNBOUND rather than skipped, because a verifier that cannot
 * confirm the binding has not confirmed it. Hex comparison is exact and
 * case-sensitive by contract — {@link embedCiphertextDigest} pins lowercase as a
 * one-way door, so an uppercase digest is itself a divergence.
 */
export function isCiphertextDigestBound(
  storedPiiPayload: unknown,
  signedPayload: unknown,
): boolean {
  return isColumnDigestBound(storedPiiPayload, signedPayload, PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY);
}

/**
 * The COLUMN-AND-KEY-PARAMETERIZED core both ciphertext-digest checks run
 * (Plan-006 T3.8).
 *
 * Factored out rather than copied, and the difference matters more than it
 * usually would: the four-state compare below IS the check, so a second copy for
 * the content column would be a second implementation of one verifier rule, free
 * to drift in exactly the direction that turns a tamper report into a loss
 * report. There is one implementation and two thin bindings.
 *
 * The four states, for either column:
 *
 * | stored column | signed claim | verdict                                     |
 * | ------------- | ------------ | ------------------------------------------- |
 * | bytes         | present      | compare — the ordinary sealed row           |
 * | NULL          | absent       | bound: this row carried no such partition   |
 * | bytes         | absent       | UNBOUND — ciphertext nothing vouches for    |
 * | NULL          | present      | UNBOUND — the column was cleared after signing |
 *
 * Fail-closed on a shape it cannot digest: a non-`Uint8Array`, non-NULL column
 * value is reported UNBOUND rather than skipped, because a verifier that cannot
 * confirm the binding has not confirmed it.
 *
 * TOTAL AND NEVER-THROWING, on the I-006-2-10 ground its callers document: a
 * verifier consumes it inside a range walk, where one throw would abort the walk
 * and silence audit of the entire remaining tail.
 */
function isColumnDigestBound(
  storedColumn: unknown,
  signedPayload: unknown,
  digestPayloadKey: string,
): boolean {
  const signedDigest =
    typeof signedPayload === "object" && signedPayload !== null
      ? (signedPayload as Record<string, unknown>)[digestPayloadKey]
      : undefined;
  const claimedDigest = typeof signedDigest === "string" ? signedDigest : undefined;

  // `== null` is the deliberate loose form: it catches SQLite's NULL and an
  // absent property in one test, and nothing else.
  if (storedColumn == null) {
    return claimedDigest === undefined;
  }
  if (claimedDigest === undefined) {
    return false;
  }
  if (!(storedColumn instanceof Uint8Array)) {
    return false;
  }
  return bytesToHex(blake3(storedColumn)) === claimedDigest;
}

/**
 * The MACHINE-AUTHORED half of the same question — does the stored
 * `content_payload` still digest to what the row's signature committed to?
 * (I-006-3-07, the sixteenth verification mode
 * `content_ciphertext_digest_unbound`.)
 *
 * WHY IT NEEDS ASKING AT ALL, when a body that will not decrypt already reports
 * itself unavailable. Without this check a ciphertext REPLACED after signing
 * leaves the row's signature green and surfaces only as an unreadable body — so
 * at-rest tampering would be silently reclassified as ordinary transcript loss,
 * and the canonical-transcript fold's `'turn_content_unavailable'` would absorb
 * a security event. That would make the loss vocabulary unsound: a report that
 * can mean either "the key is gone" or "someone edited the column" means neither.
 *
 * NO OWNER-STAMP SIBLING PAIRS WITH THIS ONE, deliberately. The PII pair needs
 * two checks because the participant whose key sealed the bytes is recoverable
 * from nothing else once the key is destroyed. The content partition's owner is
 * the SESSION, and `session_id` is a canonical member the signature already
 * covers — there is nothing left to bind, which is why this home costs one
 * column and not two.
 *
 * THE ORIGIN-ROW ARM, AND ONLY THAT ARM. The sixteenth mode is
 * PROVENANCE-DISPATCHED, exactly as the fourteenth and fifteenth are, and the
 * dispatch itself lives one function down in
 * {@link isContentCiphertextDigestBoundUnderProvenance} rather than here — this
 * is the four-state compare, which is what the origin arm runs, and factoring
 * the two apart is what keeps a caller from reaching the compare without
 * deciding provenance first.
 *
 * DELIBERATELY UNWIRED, on the I-006-2-10 precedent its two PII siblings follow:
 * this module exports the pure predicate and the verifier task emits the verdict.
 * Emitting one from here would be Phase-3 code deciding a Phase-4 question, and
 * `verifyRow` is handed canonical bytes and the three integrity columns, so it
 * could not see this column even if the layering allowed it. This is a
 * POSTcondition of a green signature verdict — the claim lives inside the signed
 * payload, so it is worth trusting only once Ed25519 verification has passed.
 *
 * THE COMPACTED ROW NEEDS NO CARVE-OUT, unlike the owner stamp's open
 * disposition. Compaction clears BOTH sides at once — `content_payload` goes
 * NULL and `payload` is replaced by a stub projection that carries no digest —
 * so a compacted row lands in the second state and reads bound. That is stated
 * at mint time rather than left to a later amendment, which is the lesson the
 * corpus paid for once already with `pii_participant_id`.
 */
export function isContentCiphertextDigestBound(
  storedContentPayload: unknown,
  signedPayload: unknown,
): boolean {
  return isColumnDigestBound(
    storedContentPayload,
    signedPayload,
    CONTENT_CIPHERTEXT_DIGEST_PAYLOAD_KEY,
  );
}

/**
 * THE SIXTEENTH VERIFICATION MODE'S WHOLE DECISION — the content-digest binding
 * with its `received_from_node_id` provenance dispatch applied
 * (`content_ciphertext_digest_unbound`, I-006-3-07).
 *
 * THE DISPATCH EXISTS BECAUSE ONE ROW SHAPE MEANS TWO OPPOSITE THINGS.
 * `content_payload` is node-local: it is excluded from the canonical bytes and
 * so never crosses a machine boundary, while the signed
 * `contentCiphertextDigest` inside those bytes does. A signed digest with the
 * column empty is therefore EVIDENCE DESTRUCTION on a row this daemon authored
 * and the ORDINARY, CORRECT shape of a row carried from a peer. No predicate
 * over two arguments can tell those apart, which is why this one takes three.
 *
 * ORIGIN ROWS COMPARE. `received_from_node_id IS NULL` is the origin marker, so
 * the null-ish arm runs {@link isContentCiphertextDigestBound}'s four-state
 * compare unchanged and the mode keeps every verdict it had.
 *
 * RECEIVED ROWS REQUIRE THE COLUMN ABSENT — a stricter arm, not a softer one.
 * The digest a received row carries is the ORIGIN daemon's claim about bytes
 * that never travelled, so any local ciphertext under it is precisely what a
 * planted value would be made to match: comparing would report BOUND for an
 * attacker's row and would be the one fail-open in this file. Absent is the only
 * shape a received row may hold.
 *
 * THE UNRECOGNIZED MARKER TAKES THE RECEIVED ARM, and the asymmetry is
 * deliberate rather than a default falling out of `==`. Both misroutes report
 * UNBOUND — an origin row judged received fails every body-bearing row, a
 * received row judged origin fails every one carrying a claim — so neither is a
 * fail-OPEN in itself. The one genuine fail-open is the planted-ciphertext case
 * above, and it lives only on the origin arm. So exactly NULL and `undefined`
 * mean origin, and every other value, of every shape, means received.
 *
 * TOTAL AND NEVER-THROWING, on the I-006-2-10 ground the whole family shares: a
 * verifier consumes this inside a range walk, where one throw would abort the
 * walk and silence audit of the entire remaining tail. All three parameters are
 * `unknown` because all three arrive from SQLite — and the third arrives from a
 * column no migration in this package has created yet, which is exactly the
 * shape `isPiiOwnerStampBound` documents for the stamp column T3.1 adds.
 *
 * STILL UNWIRED TO A VERDICT. Like its siblings this reports a boolean and names
 * no `failureMode`; `integrity-verifier.ts` is T4.1's file and does not exist.
 * `content-read.ts` consumes this predicate for the READ projection's
 * `digest_unbound` reason, which is a projection of the same fact and not the
 * audit verdict.
 */
export function isContentCiphertextDigestBoundUnderProvenance(
  storedContentPayload: unknown,
  signedPayload: unknown,
  receivedFromNodeId: unknown,
): boolean {
  // `== null` is the deliberate loose form the sibling predicates use: SQLite's
  // NULL and an absent property in one test, and nothing else.
  if (receivedFromNodeId == null) {
    return isContentCiphertextDigestBound(storedContentPayload, signedPayload);
  }
  return storedContentPayload == null;
}

/**
 * The owner-stamp half of the same question {@link isCiphertextDigestBound}
 * asks of the ciphertext: does the participant id a row is actually stamped with
 * still equal the one its signature committed to?
 *
 * WHY IT NEEDS ASKING, when the digest check already covers the PII column. The
 * two bind different things and neither implies the other. The digest answers
 * "are these the bytes that were sealed"; this answers "whose data are they".
 * After a `Spec-022 §Shred Fan-Out` Path 1 shred the second question has no
 * other answer left: the key is destroyed, so no decrypt can re-attribute the
 * retained ciphertext, and the stamp is the sole surviving evidence. A tampered
 * stamp cannot stop the shred itself — Path 1 deletes the participant's key
 * globally — but it corrupts the SCOPE SELECTOR that decides which rows the
 * operation reports, so the `affectedSessionIds[]` / `piiPayloadsCleared` of an
 * `event.shredded` event are falsified on a row `Spec-006 §Event Maintenance
 * (event_maintenance)` retains indefinitely as compliance evidence.
 *
 * THE STORED SIDE IS T3.1'S COLUMN AND IT DOES NOT EXIST YET, which is why this
 * takes `unknown` rather than naming a row type. `0001-initial.ts` declares
 * `pii_payload` and `actor` and no PII-owner stamp; adding that column is the
 * obligation this module's header hands T3.1. Phase 2 mints the SIGNED half
 * here, T3.1 creates the column the signed half will be compared against, and
 * T4.1 performs the comparison and reports the verdict. Nothing in this phase
 * can run this predicate against a real row, and nothing in this phase should.
 *
 * DELIBERATELY UNWIRED, ON THE I-006-2-10 PRECEDENT. That invariant fixes the
 * pattern for T2.1's `isCanonicalOccurredAt`, the sibling forward-facing
 * predicate: exported pure from Phase 2 and "deliberately NOT wired into
 * `canonicalizeEvent` or `verifyRow`, since emitting a verdict from Phase 2
 * would be T2 code deciding a T4.1 question". The same holds here, with one
 * extra structural reason: `verifyRow` is handed canonical bytes and the three
 * integrity columns, so it could not see the stamp column even if the layering
 * allowed it. This is a POSTcondition of a green signature verdict — the claim
 * lives inside the signed payload, so it is worth trusting only once the
 * Ed25519 verification has passed.
 *
 * TOTAL AND NEVER-THROWING, load-bearing rather than defensive style for the
 * reason I-006-2-10 gives: T4.1 consumes it inside a range walk, where one throw
 * would abort the walk and silence audit of the entire remaining tail. Both
 * parameters are `unknown` because both will arrive from SQLite. Sited adjacent
 * to the mint, so mint and check cannot drift apart.
 *
 * The four states:
 *
 * | stored stamp | signed claim | verdict                                     |
 * | ------------ | ------------ | ------------------------------------------- |
 * | string       | present      | compare — the ordinary PII row              |
 * | NULL         | absent       | bound: no PII on this row                   |
 * | string       | absent       | UNBOUND — an owner nothing vouches for      |
 * | NULL         | present      | UNBOUND — the stamp was cleared after signing |
 *
 * THE COMPACTED ROW IS AN OPEN DISPOSITION, and it is the one asymmetry with the
 * digest check rather than a copy of it. Compaction clears BOTH sides of the
 * digest pair — `Spec-006 §Compacted Event Format` sets `pii_payload` NULL and
 * replaces `payload` with a stub projection carrying no digest — so a compacted
 * row lands in row two there. The stamp has no such guarantee: the stub
 * projection carries no `pii_participant_id` either, so the CLAIM is gone, and
 * whether the COLUMN goes with it is undecided, because that column does not
 * exist yet and the spec's removal list therefore cannot mention it. This
 * predicate assumes the compactor clears the stamp alongside `pii_payload` —
 * they are the two halves of the same PII partition, and once the ciphertext is
 * destroyed outright the stamp has no remaining consumer (Path 1's own scope is
 * rows with a NON-NULL `pii_payload`). T3.1's migration and a matching
 * `Spec-006 §Compacted Event Format` amendment own that decision. If it goes the
 * other way and the stamp is retained on compacted rows, this predicate reports
 * every one of them UNBOUND, and the CALLER must scope it to
 * `retention_class IS NULL` — the same way `isCiphertextDigestBound` is scoped
 * out of `verifyRow`. Do not "fix" that by softening row three: an absent claim
 * beside a present stamp is the exact tamper this check exists to catch.
 *
 * Fail-closed on a shape it cannot compare: a non-string, non-NULL column value
 * is reported UNBOUND rather than skipped, because a verifier that cannot
 * confirm the binding has not confirmed it. The type test is `typeof === "string"`
 * and not a byte test — the stamp is a participant id and T3.1's column will be
 * `TEXT`, where the sibling's `instanceof Uint8Array` would refuse every
 * legitimate value. Comparison is exact: the stamp is an opaque id, so this
 * module normalizes no case and trims no whitespace.
 *
 * ONE SHARED RESIDUAL WITH THE SIBLING, stated rather than diverged from: a
 * signed claim of the wrong TYPE (a number where a string belongs) folds to "no
 * claim", so it reads as row two beside a NULL column and row three beside a
 * present one. Only the first is arguably wrong, and it is unreachable through
 * this module — refusal 2 rejects a pre-seeded member and the projection writes
 * a guarded string. Both predicates answer the same way on a malformed member,
 * which is worth more here than closing an exotic fail-open in one of them.
 */
export function isPiiOwnerStampBound(
  storedPiiParticipantId: unknown,
  signedPayload: unknown,
): boolean {
  const signedStamp =
    typeof signedPayload === "object" && signedPayload !== null
      ? (signedPayload as Record<string, unknown>)[PII_PARTICIPANT_ID_PAYLOAD_KEY]
      : undefined;
  const claimedStamp = typeof signedStamp === "string" ? signedStamp : undefined;

  // `== null` is the deliberate loose form, as in the sibling: SQLite's NULL and
  // an absent property in one test, and nothing else.
  if (storedPiiParticipantId == null) {
    return claimedStamp === undefined;
  }
  if (claimedStamp === undefined) {
    return false;
  }
  if (typeof storedPiiParticipantId !== "string") {
    return false;
  }
  return storedPiiParticipantId === claimedStamp;
}

/**
 * One issue from the strict layer's own parse result.
 *
 * Read off `safeParse`'s return type rather than imported from `zod`: the shape
 * is whatever the version contracts compiles against produces, so a Zod major
 * that renames an issue member breaks {@link describeStrictLayerIssues} at
 * `pnpm typecheck` instead of at the one throw a caller was relying on. This
 * module imports no validator and gains none here.
 */
type StrictLayerParseIssue = Extract<
  ReturnType<typeof SessionEventSchema.safeParse>,
  { success: false }
>["error"]["issues"][number];

/**
 * How many parse issues a refusal message renders before eliding the rest.
 *
 * A defective payload can raise one issue per member, and a throw message is
 * read by a person: the first few name the defect and the tail is noise. The
 * elided COUNT is still reported, so the message never implies the list was
 * complete when it was not.
 */
const STRICT_LAYER_ISSUES_RENDERED_MAX = 5;

/**
 * Renders refusal 9's parse issues as PATHS AND CODES, never as values.
 *
 * The withholding is the point, and it is this module's standing rule rather
 * than a new one: {@link describeByteShape} reports a length or a `typeof` and
 * never a byte, {@link describeParticipantIdShape} reports a type and a
 * character count, and `EventLogService`'s reserved-key refusal reports a KEY
 * PATH and never the value under it. A payload member is the one place on this
 * path a participant's or a model's words can sit, so Zod's own `message` —
 * which quotes received values for several issue codes — is deliberately not
 * forwarded. A path plus a code is what a caller acts on; the value is what a
 * log must not keep.
 *
 * `unrecognized_keys` is the one code that carries something more, and what it
 * carries is member NAMES: the same class of datum as the path itself, and the
 * only way the message can say WHICH member the strict layer does not know.
 * Narrowing on the literal code is what types `issue.keys` — the reason the
 * issue union is read off the parse result rather than flattened to a
 * hand-written shape.
 */
function describeStrictLayerIssues(issues: readonly StrictLayerParseIssue[]): string {
  const rendered: string[] = issues
    .slice(0, STRICT_LAYER_ISSUES_RENDERED_MAX)
    .map((issue: StrictLayerParseIssue) => {
      const memberPath =
        issue.path.length === 0
          ? "<envelope>"
          : issue.path.map((segment) => String(segment)).join(".");
      return issue.code === "unrecognized_keys"
        ? `${memberPath} (${issue.code}: ${issue.keys.join(", ")})`
        : `${memberPath} (${issue.code})`;
    });
  const elidedCount = issues.length - rendered.length;
  return elidedCount === 0
    ? rendered.join("; ")
    : `${rendered.join("; ")}; and ${String(elidedCount)} further issue(s)`;
}

/**
 * Which seam is refusing, and where in its own order the refusal lands.
 *
 * Carried as data rather than inferred, because the two callers reach the guard
 * at genuinely different points and a message that guessed would be wrong on one
 * of them: the sealing path refuses BEHIND the encrypt, the plain path refuses
 * before anything. A reader who greps the thrown text has to land on the seam
 * that actually threw.
 */
export interface StrictLayerParseSeam {
  /** The function a reader would grep for, spelled as it is declared. */
  readonly name: string;
  /** One sentence placing the refusal in that seam's own order. */
  readonly timing: string;
}

/**
 * PARSE WHAT WILL BE SIGNED — the last thing that happens to any row before it
 * is canonicalized, on either of the daemon's two write paths.
 *
 * THE ONE DEFINITION OF THIS SEAM. It is refusal 9 of {@link writeEventWithPii}
 * and the pre-canonicalization guard of `EventLogService.append`'s plain branch,
 * and those are two CALLERS of one function rather than two implementations: a
 * copy would be a second answer to "which rows may be signed", and the two
 * answers would diverge on the first variant that lands. It lives in this module
 * because the Encrypt-Then-Digest-Then-Sign ordering argument that fixes WHERE
 * it may run lives here; it is named for what it does rather than for this
 * module's partition, because the plain path seals nothing.
 *
 * The two callers differ only in WHEN their subject comes into existence. On the
 * sealing path it does not exist until the embed step has run, which is why this
 * is the one refusal in that function's numbered order that fires behind the
 * encrypt. On the plain path the caller's own payload IS the subject, so the
 * guard runs before anything at all.
 *
 * WHAT IT ANSWERS THAT NOTHING ELSE DOES. Refusal 1's fourth arm reads
 * `input.type` and nothing else, so it stops a body on a type that declares no
 * place for one and stops nothing else. A caller may still hand this codec a
 * body on `assistant.message` under the WRONG category, or with a `payload` that
 * type's own registered schema refuses — a missing `sessionId`, a `tool.result`
 * with no `toolName`, a member no variant declares. The embed step then projects
 * `contentCiphertextDigest` and `contentLength` into that payload, the
 * canonicalizer serializes it, and the signature vouches for the result: a
 * signed, chained row that fails its own schema on the way back out and can
 * never be read as anything but a stub. That is the identical harm arm four
 * names, reached through a defect arm four cannot see.
 *
 * PARSE WHAT YOU SIGN — which is why the sealing caller runs it where it does.
 * Its subject is the exact object {@link canonicalizeDigestBearingEvent} is
 * about to serialize, with this codec's members already embedded and their real
 * values in place. Composing an equivalent subject before the encrypt would mean
 * substituting a placeholder for each digest, and {@link writeEventWithPii}'s
 * refusal-order note has already settled what this module thinks of a pre-check
 * that can disagree with the guard it stands in for: refusing late and saying so
 * beats a cheap check that is wrong at the boundary. That path's order is
 * therefore ENCRYPT → DIGEST → EMBED → *parse* → CANONICALIZE → SIGN, the
 * Encrypt-Then-Digest-Then-Sign recipe with one step inserted where its subject
 * first exists. The plain path has no such constraint and runs it immediately
 * before `canonicalizeEvent`, which is the same position — last, over the object
 * about to be serialized — reached by a shorter route.
 *
 * ONE PARSE PER APPEND OF A REGISTERED TYPE, and by construction never in a hot
 * loop: an append runs once per row under the per-session append lock, and a row
 * that reaches this line is about to pay for an Ed25519 signature — and, on the
 * sealing path, has already paid for an AES-256-GCM seal. A schema parse is not
 * the cost on either path. Acceptable by construction, not by measurement.
 *
 * ONE SEAM, EVERY ROW THE APPEND PATH SIGNS. The pii-only route reaches it on the
 * same terms as the content-only and both-partition ones, and the partitionless
 * plain branch on the same terms as all three, because the defect is a property
 * of the ROW rather than of which column was written: a row on a registered type
 * whose payload its own variant rejects is signed and unparseable whether it
 * carries a sealed partition or nothing at all. No shipped doctrine exempts any
 * of them — `packages/contracts/src/event.ts` scopes the DISPATCH (below) and
 * says nothing about partitions — and scoping the guard to the partition that
 * happened to prompt it would make its reach an accident of which finding was
 * filed.
 *
 * WHAT THAT CLAIM DOES NOT COVER, named rather than glossed. It covers the
 * APPEND path, both branches of it. It does not cover the compactor, which
 * replaces a row's `payload` with the audit-stub projection and re-signs it
 * through its own canonicalize-and-sign under an `UPDATE` — a projection that is
 * deliberately NOT its type's registered variant shape, so parsing it here would
 * refuse every compacted row. That row's integrity is held by the stub's own
 * bound projection and by `stub_scalar_mismatch` instead, and the boundary is
 * stated so a later reader does not take the heading for a property of every
 * signature the daemon produces.
 *
 * ONE DELIBERATE NARROWING, forced by a fact rather than chosen:
 *
 *   - A TYPE WITH NO REGISTERED VARIANT IS SKIPPED. `packages/contracts/src/event.ts`
 *     is explicit that a reader "MUST persist an envelope whose `type` it cannot
 *     interpret as a version stub — never drop or reject it", and that the
 *     STRICT layer is "the interpretation surface, where unknown types and
 *     category/type mismatches fail loud at parse time". A codec that refused
 *     every unregistered type would reject exactly the envelopes the stub path
 *     exists to preserve, and would make this module the one place in the daemon
 *     where the tolerant carrier is not tolerated. The dispatch scopes the guard
 *     to the types the strict layer actually claims to interpret, and it widens
 *     by itself as variants land. The CONTENT route needs no dispatch of its own
 *     — the body-bearing types are registered by construction, since
 *     {@link BODY_BEARING_EVENT_TYPES} is derived from the same union — so the
 *     dispatch exists to carry the PII route.
 *
 * WHAT THE GUARD THEREFORE CLAIMS, stated so it cannot be over-read: not "no
 * unparseable row is ever signed", which the narrowing makes false, but "no row
 * is signed that fails the strict layer on grounds the strict layer actually
 * expresses".
 *
 * THE SUBJECT IS THE ENVELOPE ITSELF, member-for-member and value-for-value,
 * with nothing projected away. That is a property of the CONTRACTS layer rather
 * than of this function: `packages/contracts/src/event.ts` registers
 * {@link PII_CIPHERTEXT_DIGEST_PAYLOAD_KEY} and
 * {@link PII_PARTICIPANT_ID_PAYLOAD_KEY} as schema-optional members on every
 * payload variant whose category may carry a PII partition, which is what
 * `Spec-006 §Canonical Serialization Rules` requires of any row whose
 * `pii_payload` is non-NULL. An earlier revision of this guard excised the pair
 * before parsing, because no variant declared them and every payload schema is
 * `.strict()`, so a verbatim parse would have refused 100% of the PII route. The
 * registration removed the reason rather than the symptom: there is now nothing
 * to excise, and the guard judges the signed row exactly as it will be read
 * back.
 */
export function assertRegisteredVariantParses(
  envelope: EventEnvelope,
  seam: StrictLayerParseSeam,
): void {
  if (!REGISTERED_STRICT_VARIANT_EVENT_TYPES.has(envelope.type)) {
    return;
  }

  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return;
  }

  throw new Error(
    `${seam.name} refuses to sign an event of type ${JSON.stringify(envelope.type)} that its own registered SessionEventSchema variant rejects: ${describeStrictLayerIssues(parsed.error.issues)}. Signing it would chain a row that fails the strict layer on the way back out — permanently unreadable as anything but a stub (Spec-006 §Canonical Serialization Rules). ${seam.timing}`,
  );
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
 * NOT withheld on privacy grounds — the id is a column value T3.1 persists AND a
 * member of the signed canonical bytes, and a shred erases the KEY rather than
 * either, so a throw message is not where it would leak. It is withheld because
 * there is nothing to print: refusal 7 reaches
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
