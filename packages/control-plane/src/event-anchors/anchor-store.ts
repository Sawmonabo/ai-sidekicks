// Plan-006 T3.3 — the control-plane write path for event-log anchors.
//
// One operation: persist a daemon-signed Merkle anchor into `event_log_anchors`,
// idempotently. The table is the control plane's ENTIRE participation in
// Plan-006's integrity protocol — it witnesses that a daemon committed to a
// range, and stores nothing about what the range contains (ADR-017; I-006-3-02,
// enforced structurally by `AnchorPayload`'s exact seven-member `.strict()`
// schema in `@ai-sidekicks/contracts`).
//
// ----------------------------------------------------------------------------
// Idempotency: `ON CONFLICT DO NOTHING`, and why zero rows is SUCCESS
// ----------------------------------------------------------------------------
//
// A daemon retries an upload whenever the previous attempt's outcome is
// unknown to it — a dropped connection after the server committed is
// indistinguishable, from the client, from a dropped connection before it. So
// re-uploading an already-witnessed anchor is NORMAL, not exceptional, and the
// write must absorb it.
//
// `ON CONFLICT (session_id, node_id, start_sequence, end_sequence) DO NOTHING`
// does that at the statement level, which matters more than it might seem: the
// alternative — SELECT, then INSERT if absent — has a window between the two
// where a concurrent retry lands, and the loser then raises a raw `23505` that
// this store would have to classify. With `DO NOTHING` there is no window and
// no exception to classify.
//
// THE ZERO-ROW ARM IS NOT AN ERROR, and this is the one place a reviewer
// familiar with the signing-key registrar's 409 logic could reasonably reach
// for the wrong precedent. That path refuses a SECOND, DIFFERENT key for a
// `(session, node)` pair because re-keying strands every already-signed row —
// a genuine conflict, correctly a 409. Here the conflicting row is BYTE-
// IDENTICAL by construction: the key covers the full range identity, and
// Ed25519 is deterministic (RFC 8032 §5.1.6), so the same daemon signing the
// same root produces the same 64 bytes. There is nothing to refuse. `stored:
// false` reports "already witnessed" so the daemon can log a re-fire distinctly
// from a first landing, and both arms mean "this anchor is durably held; stop
// retrying it".
//
// Note what the key does NOT collapse: a cadence anchor over [1,1000] and a
// wider compaction-covering anchor over [1,5000] share a `start_sequence` and
// BOTH land, because `end_sequence` is in the key. See the DDL's own comment.
//
// ----------------------------------------------------------------------------
// `anchored_at` is the DAEMON's timestamp, always
// ----------------------------------------------------------------------------
//
// The column carries `DEFAULT now()`, and that default must never fire on this
// path: `anchored_at` is the DAEMON's reading of when it computed the anchor,
// and a control-plane ARRIVAL time silently standing in for it would describe a
// different event — one that says nothing about when the range was witnessed.
//
// WHAT IT IS NOT: part of the signed commitment, and the distinction is easy to
// overstate. `root_signature` covers the Merkle ROOT alone (the DDL's own column
// comment in `shared-postgres-schema.md` says so), so no verifier can detect a
// wrong `anchored_at` cryptographically. The two copies are not byte-comparable
// either: the daemon holds ISO-8601 TEXT in `pending_anchor_uploads` while this
// side holds `timestamptz`, and a Postgres round-trip re-spells the value.
//
// The honest property is narrower and still worth the explicit column list: the
// daemon's own value is durably recorded on BOTH sides, so the pair corroborates
// as INSTANTS — parse, then compare — rather than as bytes or as a signature.
// So the INSERT names all seven columns explicitly and the default exists only
// for a hypothetical direct-SQL writer.
//
// Refs: Plan-006 T3.3, ADR-017,
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors
// (Plan-006 — Integrity Witness).

import {
  AnchorPayloadSchema,
  type AnchorPayload,
  type EventAnchorUploadResponse,
} from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";

/**
 * Raised when the anchor names a session the control plane does not know.
 *
 * A PLAIN `Error` SUBCLASS, deliberately not an `AisWireException`. The wire
 * error CODES are a governed vocabulary (`error-contracts.md`) and this
 * condition has no row there; minting one here would put an uncatalogued code
 * on the wire. The router maps this to a bare tRPC `NOT_FOUND` instead — the
 * same shape `session.join`'s self-check uses for its bare `UNAUTHORIZED`.
 */
export class UnknownAnchorSessionError extends Error {
  constructor(sessionId: string) {
    super(
      `event_log_anchors references session ${sessionId}, which does not exist in the control ` +
        "plane. An anchor can only witness a session the control plane knows: either the session " +
        "was never created here, or the daemon is uploading a node-scope (sentinel-partitioned) " +
        "anchor, which is locally-witnessed-only in V1 (ADR-017 §Node-Scope Anchor Witnessing).",
    );
    this.name = "UnknownAnchorSessionError";
  }
}

// Postgres FK-violation SQLSTATE. Compared against the portable
// `{ code }` surface rather than a driver class, so the same branch works under
// `pg` and PGlite.
const FOREIGN_KEY_VIOLATION = "23503";

function asDatabaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

// Base64 -> bytes WITHOUT `Buffer`.
//
// This module sits in the Worker import graph and `wrangler.toml` declares no
// `nodejs_compat` flag, so `Buffer` is not a global at runtime there — a
// `Buffer.from` here is a `ReferenceError` on the deployed control plane while
// every Node-hosted test passes. `atob` is the Worker-available primitive, and
// it is the same one `event-anchor.ts` uses to measure these fields' decoded
// widths, for the same reason.
//
// No try/catch: the caller decodes only AFTER `AnchorPayloadSchema.parse`, which
// has already rejected anything `atob` would throw on and pinned the decoded
// width at 32 or 64 bytes.
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Persists daemon-signed Merkle anchors into `event_log_anchors`.
 *
 * Constructor-injected `Querier` per I-008-3 #1 — the class touches no `pg`
 * type directly, so the same instance runs against a Hyperdrive-backed Pool in
 * production and PGlite in tests.
 */
export class EventLogAnchorStore {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Witnesses one anchor.
   *
   * @returns `{ stored: true }` when this call inserted the row, `{ stored:
   * false }` when the identical range was already witnessed. Both are success.
   * @throws {UnknownAnchorSessionError} when `sessionId` names no session.
   */
  async upload(anchor: AnchorPayload): Promise<EventAnchorUploadResponse> {
    // Trust-boundary validation — parse rather than trust the caller, mirroring
    // `attach` / `detach` / `readRoster`. This is also where I-006-3-02 is
    // ENFORCED rather than assumed: the schema is `.strict()`, so a body that
    // smuggled a `payload` / `events` / `pii_payload` member is refused here
    // even if the router's own `.input()` parse were ever loosened.
    const validated: AnchorPayload = AnchorPayloadSchema.parse(anchor);

    // Base64 on the wire (the tRPC root runs `transformer: false`, so bytes
    // cannot cross as `Uint8Array`), raw bytes in `bytea`. The schema already
    // pinned the decoded widths at 32 and 64, so this decode cannot silently
    // store a truncated commitment.
    const merkleRoot = decodeBase64(validated.merkleRoot);
    const rootSignature = decodeBase64(validated.rootSignature);

    try {
      // `RETURNING id` is the idempotency discriminator: `DO NOTHING` suppresses
      // the row, so an already-witnessed anchor comes back with zero rows.
      //
      // Only `id` is returned, and that is deliberate. `start_sequence` /
      // `end_sequence` are BIGINT, which `pg` hydrates as STRINGS to avoid
      // silent precision loss (the same reason `hasMigrationApplied` casts its
      // `COUNT(*)::text`) — echoing them back would need a normalization step
      // whose only purpose would be to un-do a hydration this method has no
      // reason to trigger.
      const inserted = await this.#querier.query<{ id: string }>(
        `INSERT INTO event_log_anchors
           (session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (session_id, node_id, start_sequence, end_sequence) DO NOTHING
         RETURNING id`,
        [
          validated.sessionId,
          validated.nodeId,
          validated.startSequence,
          validated.endSequence,
          merkleRoot,
          rootSignature,
          validated.anchoredAt,
        ],
      );

      return { stored: inserted.rows.length > 0 };
    } catch (error) {
      if (asDatabaseErrorCode(error) === FOREIGN_KEY_VIOLATION) {
        throw new UnknownAnchorSessionError(validated.sessionId);
      }
      throw error;
    }
  }
}
