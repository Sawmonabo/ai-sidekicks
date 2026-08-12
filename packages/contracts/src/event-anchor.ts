// Plan-006 T3.3 — the Merkle-anchor wire contract.
//
// ONE shape, shared by three surfaces that must agree byte-for-byte or the
// integrity witness is worthless:
//
//   1. the daemon's `MerkleAnchorService` (`runtime-daemon/src/events/
//      merkle-anchor-service.ts`), which computes + signs the anchor and
//      queues it in `pending_anchor_uploads`;
//   2. the control-plane `eventanchor.upload` procedure
//      (`control-plane/src/event-anchors/anchor-router.ts`), which persists it
//      into `event_log_anchors`;
//   3. Phase 4's audit reader, which resolves the emitting daemon's Ed25519
//      public key by `nodeId` and checks `rootSignature` over the RFC 8785
//      anchor claim — the five coordinate members and the root together
//      (`Spec-006 §Anchoring Cadence`, 2026-08-11 amendment; the one preimage
//      builder is `buildAnchorClaimBytes` in the daemon's
//      `merkle-anchor-service.ts`).
//
// The member set is the seven non-generated columns of the canonical
// `event_log_anchors` DDL in
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors
// (Plan-006 — Integrity Witness) — `id` is excluded because Postgres mints it
// (`DEFAULT gen_random_uuid()`), and it names no row the daemon knows.
// `Spec-006 §Anchoring Cadence` states the same seven as the anchor payload:
// "(session_id, node_id, start_sequence, end_sequence, merkle_root,
// root_signature, anchored_at) — metadata only".
//
// ----------------------------------------------------------------------------
// I-006-3-02 — metadata-only, enforced at the type level
// ----------------------------------------------------------------------------
//
// ADR-017 rejected a shared event log for V1: the control plane witnesses
// integrity, it does not store events. That is an INVARIANT, not a convention,
// and this module is where it becomes unbreakable rather than merely
// documented. Two mechanisms carry it, and both are load-bearing:
//
//   * `AnchorPayload` declares no `payload`, no `events`, no `pii_payload`
//     member — a caller that tries to attach one fails to compile.
//   * `AnchorPayloadSchema` is `.strict()`, so a value that reached the wire as
//     untyped JSON with an extra member is REJECTED at parse rather than
//     silently stripped. Without `.strict()` the schema would accept a body
//     carrying event bytes and quietly drop them — the invariant would then be
//     asserted by nothing, since the type-level half cannot see a value that
//     never passed through TypeScript. `__tests__/event-anchor.test.ts` pins
//     both halves, including the three named negative arms.
//
// ----------------------------------------------------------------------------
// Why the two 32/64-byte fields are base64 STRINGS
// ----------------------------------------------------------------------------
//
// The control-plane tRPC root runs `transformer: false`
// (`control-plane/src/sessions/trpc.ts`), so the wire is plain JSON and a
// `Uint8Array` cannot cross it — it would arrive as `{"0":12,"1":…}`. Both
// byte fields are therefore carried base64-encoded, the same convention
// `pty-host-protocol.ts` states for its `bytes` field.
//
// DECODE WITH `atob` ON THE CONTROL-PLANE SIDE, not `Buffer`. The Worker
// runtime has no `Buffer` global and `wrangler.toml` declares no
// `nodejs_compat`, so a `Buffer.from` in that import graph type-checks, passes
// every Node-hosted test, and throws `ReferenceError` only once deployed —
// which is how it reached review once already. The daemon side is plain Node
// and may use either.
//
// The length check is on the DECODED byte count, not the string length: a
// 44-character string is not necessarily 32 bytes, and the schema-doc comments
// ("32 bytes", "64 bytes") are the constraint that actually matters. A
// wrong-width root or signature is a corrupt witness, and catching it at the
// wire boundary is strictly better than storing it and failing verification
// years later when the audit runs.
//
// Spec coverage: `Spec-006 §Anchoring Cadence` (the seven-member anchor
// payload). Verifies invariant: I-006-3-02 (metadata-only witness).
// Refs: Plan-006 T3.3, ADR-017, `docs/architecture/schemas/shared-postgres-schema.md`
// §Event Log Anchors (Plan-006 — Integrity Witness).

import { z } from "zod";

import { EVENT_ENVELOPE_SEQUENCE_MAX } from "./event.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { SessionIdSchema, type SessionId } from "./session.js";

/** Decoded width of a BLAKE3 Merkle root, in bytes. */
export const MERKLE_ROOT_BYTE_LENGTH = 32;

/** Decoded width of an Ed25519 signature (RFC 8032 §5.1.6), in bytes. */
export const ROOT_SIGNATURE_BYTE_LENGTH = 64;

// Decoded byte count of a standard-alphabet base64 string, or -1 if the value
// does not decode at all.
//
// `atob` (not `Buffer`) because this package is consumed by the Worker-hosted
// control plane as well as the daemon, and `Buffer` is not a Worker global.
//
// The try/catch is NOT defensive padding: zod evaluates every check on a
// schema and aggregates the issues rather than short-circuiting at the first
// failure, so this refinement runs even when the `z.base64()` charset check
// has already rejected the input — and `atob` THROWS `InvalidCharacterError`
// on a non-base64 string. Without the catch, a garbage `merkleRoot` escapes as
// a raw DOMException out of `safeParse`, which is exactly the call that
// promised never to throw. Returning -1 keeps the failure inside the ZodError,
// where the caller is looking for it.
function decodedByteLength(base64Value: string): number {
  try {
    return atob(base64Value).length;
  } catch {
    return -1;
  }
}

function base64OfExactly(byteLength: number, fieldLabel: string): z.ZodType<string, string> {
  return z.base64().refine((value) => decodedByteLength(value) === byteLength, {
    message: `${fieldLabel} must decode to exactly ${byteLength} bytes`,
  });
}

// An anchor range endpoint — a `session_events.sequence` value. Takes the same
// ceiling the envelope's own `sequence` takes ({@link EVENT_ENVELOPE_SEQUENCE_MAX}):
// an endpoint that cannot be represented faithfully cannot name the row it
// bounds, and the anchor would commit to a range nobody can re-derive.
const anchorSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
    message: `An anchor range endpoint must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER), the same injectivity ceiling EventEnvelope.sequence takes.`,
  });

/**
 * A signed Merkle-root commitment over a contiguous range of one daemon's
 * `session_events` rows — the metadata-only integrity witness the control
 * plane stores in `event_log_anchors`.
 *
 * EXACTLY seven members, mirroring the seven non-generated columns of the
 * canonical DDL. Nothing about the events themselves crosses this boundary:
 * no payload, no event bodies, no PII (I-006-3-02 / ADR-017).
 */
export interface AnchorPayload {
  /**
   * The anchored chain's session. V1 witnesses SESSION-scoped anchors only —
   * node-scope (sentinel-partitioned) chains queue locally and are not upload
   * candidates, because `event_log_anchors.session_id` carries a non-null FK
   * to `sessions(id)` that the sentinel cannot satisfy (ADR-017 §Node-Scope
   * Anchor Witnessing makes control-plane node-scope witnessing a V1.1
   * extension).
   */
  readonly sessionId: SessionId;
  /** The emitting daemon's NodeId — the roster key an audit reader resolves the verification public key by. */
  readonly nodeId: NodeId;
  /** First `session_events.sequence` covered by this anchor, inclusive. */
  readonly startSequence: number;
  /** Last `session_events.sequence` covered by this anchor, inclusive. */
  readonly endSequence: number;
  /** Base64 of the 32-byte BLAKE3 Merkle root over the range's `row_hash` leaves. */
  readonly merkleRoot: string;
  /**
   * Base64 of the 64-byte Ed25519 signature over the UTF-8 bytes of the
   * RFC 8785 canonicalization of the five-member anchor claim —
   * `{endSequence, merkleRoot (base64), nodeId, sessionId, startSequence}` —
   * per `Spec-006 §Anchoring Cadence` (2026-08-11 amendment). The coordinates
   * are inside the signature, so a stored or carried record whose span or log
   * identity was relabeled fails verification rather than passing a coverage
   * test on unsigned coordinates.
   */
  readonly rootSignature: string;
  /** Daemon-local timestamp at anchor computation, RFC 3339 with an explicit offset. */
  readonly anchoredAt: string;
}

/**
 * Runtime validator for {@link AnchorPayload}.
 *
 * `.strict()` is the I-006-3-02 enforcement (see the module header): an
 * unknown member — `payload`, `events`, `pii_payload`, anything — is a parse
 * FAILURE, not a silent strip.
 *
 * The `endSequence >= startSequence` refinement mirrors the DDL's
 * `CHECK (end_sequence >= start_sequence)`. Checking it here too means a
 * malformed range is refused before it reaches a database that would refuse it
 * anyway — with a message naming the contract instead of a Postgres `23514`.
 */
export const AnchorPayloadSchema: z.ZodType<AnchorPayload, AnchorPayload> = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    startSequence: anchorSequenceSchema,
    endSequence: anchorSequenceSchema,
    merkleRoot: base64OfExactly(MERKLE_ROOT_BYTE_LENGTH, "merkleRoot"),
    rootSignature: base64OfExactly(ROOT_SIGNATURE_BYTE_LENGTH, "rootSignature"),
    // RFC 3339 with a REQUIRED offset. A naked local timestamp would make
    // `anchored_at` ambiguous across the daemon's and the control plane's
    // timezones, and the two stored copies are compared as INSTANTS — an
    // offsetless spelling names no instant at all.
    //
    // They are NOT byte-comparable, and not signed. `anchoredAt` sits outside
    // the anchor claim `rootSignature` covers (`Spec-006 §Anchoring Cadence` —
    // a receipt timestamp, not an integrity coordinate), and the control plane
    // stores this value as `timestamptz`, whose round-trip re-spells it.
    // Corroboration here means parse-then-compare, which is exactly why the
    // offset has to be there.
    anchoredAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((anchor) => anchor.endSequence >= anchor.startSequence, {
    message: "endSequence must be greater than or equal to startSequence",
    path: ["endSequence"],
  });

/**
 * Wire input for the control-plane `eventanchor.upload` procedure — the
 * anchor payload itself, unwrapped.
 *
 * Aliased rather than re-declared so the upload boundary can never drift from
 * the shape the daemon signed: there is one anchor contract, and both ends
 * parse the same schema object.
 */
export type EventAnchorUploadRequest = AnchorPayload;

/** Runtime validator for {@link EventAnchorUploadRequest}. */
export const EventAnchorUploadRequestSchema: z.ZodType<
  EventAnchorUploadRequest,
  EventAnchorUploadRequest
> = AnchorPayloadSchema;

/**
 * Wire result of `eventanchor.upload`.
 *
 * `stored` distinguishes the two SUCCESS arms of an idempotent upload, and
 * neither is an error:
 *
 *   * `true`  — this call inserted the row.
 *   * `false` — an anchor with the identical `(sessionId, nodeId,
 *     startSequence, endSequence)` key was already witnessed, so the
 *     `ON CONFLICT DO NOTHING` insert affected no row.
 *
 * Reporting the discrimination rather than hiding it lets the daemon's upload
 * worker log a genuine re-fire distinctly from a first landing while treating
 * both as "flush this queue entry". A caller that does not care can ignore the
 * field; a caller that treats `false` as a failure would break idempotency,
 * which is why the field is a boolean and not an error code.
 */
export interface EventAnchorUploadResponse {
  readonly stored: boolean;
}

/** Runtime validator for {@link EventAnchorUploadResponse}. */
export const EventAnchorUploadResponseSchema: z.ZodType<
  EventAnchorUploadResponse,
  EventAnchorUploadResponse
> = z.object({ stored: z.boolean() }).strict();
