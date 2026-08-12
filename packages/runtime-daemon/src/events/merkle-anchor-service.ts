// Plan-006 T3.3 — the Merkle-anchor service.
//
// Produces the integrity witness for a daemon's local event log: a BLAKE3
// Merkle root over a contiguous range of `session_events.row_hash` values,
// signed with the daemon's Ed25519 key, durably queued in
// `pending_anchor_uploads`, and eventually uploaded to the control plane's
// `event_log_anchors` as metadata only.
//
// Three entry points, one mechanism underneath:
//
//   * {@link MerkleAnchorService.onEventAppended} — the CADENCE path. Called by
//     the append path after each committed row; fires an anchor on the earlier
//     of `ANCHOR_INTERVAL_EVENTS` rows or `ANCHOR_INTERVAL_SECONDS` seconds
//     (`Spec-006 §Anchoring Cadence`).
//   * {@link MerkleAnchorService.anchorRange} — the FORCE-FIRE path. Called by
//     the compactor before it discards canonical bytes, so that a covering
//     anchor exists for the range being compacted
//     (`Spec-006 §Post-Compaction Integrity`).
//   * {@link MerkleAnchorService.uploadPendingAnchors} — the DRAIN path. Ships
//     queued anchors to the control plane through {@link AnchorUploadTransport},
//     one freshly-minted DPoP credential per attempt, under the retry backoff
//     described below. Called on a schedule and on reconnect, never per row.
//
// The transport itself is part of this module's surface:
// {@link AnchorUploadTransport} is the seam, and
// {@link TrpcFetchAnchorUploadTransport} is the shipped `eventanchor.upload`
// caller — kept here rather than in a sibling file because its `htm`/`htu`
// binding is only correct in agreement with the request it decorates, and that
// agreement is easiest to keep honest when both live side by side.
//
// ----------------------------------------------------------------------------
// The Merkle construction — RFC 9162 §2.1.1 MTH, conformant
// ----------------------------------------------------------------------------
//
// Phase 4's verifier and any external audit reader must recompute this root
// EXACTLY, from stored bytes, years later. The tree is RFC 9162 §2.1.1's Merkle
// Tree Hash with BLAKE3 as HASH, over the range's `session_events.row_hash`
// values as the data entries `d[i]`:
//
//   1. LEAF HASH IS `BLAKE3(0x00 || row_hash)`. The 32-byte `row_hash` is the
//      data entry, not the leaf hash — `Spec-006 §Post-Compaction Integrity`
//      step 2 names `row_hash` as the leaf BASIS, and the hook signature carries
//      `rowHash` for that reason.
//   2. AN INTERIOR NODE IS `BLAKE3(0x01 || left || right)`.
//   3. FOR n > 1 THE LIST SPLITS AT `k`, THE LARGEST POWER OF TWO SMALLER THAN
//      `n` (so `k < n <= 2k`), and the root is
//      `MTH(D_n) = HASH(0x01 || MTH(D[0:k]) || MTH(D[k:n]))`. The tree is
//      therefore not balanced for non-power-of-two `n`, which is intended: per
//      the RFC, "its shape is uniquely determined by the number of leaves".
//   4. A SINGLE-ENTRY RANGE'S ROOT IS ITS LEAF HASH — `MTH({d[0]}) =
//      HASH(0x00 || d[0])`, not the bare `row_hash`.
//   5. AN EMPTY LEAF LIST IS REFUSED rather than hashed. The RFC defines
//      `MTH({}) = HASH()` because a transparency log legitimately starts empty;
//      an anchor does not. `anchorRange` takes an INCLUSIVE `[fromSeq, toSeq]`,
//      and the schema's `CHECK (end_sequence >= start_sequence)` refuses an
//      INVERTED one — inclusive plus non-inverted means the interval always
//      spans at least one sequence number, so zero leaves cannot mean "an empty
//      range". It means rows the range covers are missing from `session_events`.
//      Hashing the empty string there would mint a valid signature over a
//      commitment to nothing; refusing surfaces it as the integrity finding it is.
//
// THE 0x00/0x01 PREFIXES ARE LOAD-BEARING, not decoration. The RFC states that
// "the hash calculations for leaves and nodes differ; this domain separation is
// required to give second preimage resistance" — without it an attacker who
// finds a `row_hash` equal to some interior node can present a different leaf
// list with the same root. `merkle-root.test.ts` kills prefix-removal mutants
// for exactly this reason.
//
// GLOSS REPAIR (2026-08-04). Before this date the canonical DDL comment on
// `pending_anchor_uploads.merkle_root` in
// `docs/architecture/schemas/local-sqlite-schema.md` read "RFC 9162 §2.1
// odd-leaf duplication", and `Spec-006 §Post-Compaction Integrity` carried the
// same parenthetical. That prescription was self-contradictory: §2.1.1 splits at
// the largest power of two and domain-separates, while odd-leaf duplication is
// the Bitcoin construction, which admits the CVE-2012-2459 root collapse the RFC
// exists to avoid. Resolved in favour of the cited RFC — the citation was the
// intent, the wording was the defect. No production anchors existed, so the
// signed format was free.
//
// A FOURTH surface carried a DIFFERENT wrong construction and was repaired in
// the same pass: `security-architecture.md` §Merkle Anchors described plain
// `left‖right` concatenation and stated outright that "RFC 9162's leaf-prefix is
// omitted because this is an internal log, not a CT log". It is the doc a
// verifier implementer reads for this protocol, so it now carries the §2.1.1
// statement and a dated correction note. Changing the construction again is a
// corpus edit first (schema doc + Spec-006 + security architecture), then this
// file, then T4.1's verifier, in that order.
//
// PREIMAGE AMENDMENT (2026-08-12; Codex PR #323 round 2, landed by that
// corpus-first order). `root_signature` covers the UTF-8 bytes of the RFC 8785
// canonicalization of the five-member ANCHOR CLAIM — {endSequence, merkleRoot
// (base64, the upload wire spelling), nodeId, sessionId, startSequence} — and
// never the raw root alone. Under the root-only preimage every coordinate that
// makes a root meaningful (whose log, which span) was writable by whoever
// stored or carried the record, and `Spec-008 §Peer History Backfill On Join
// (V1)`'s entry-carried covering anchor made that a live relabeling attack: an
// authentic root re-presentable over any range. The claim puts the coordinates
// inside the signature; `anchored_at` stays outside deliberately (a receipt
// timestamp, not an integrity coordinate), and the claim's member set is
// disjoint from every event canonical form and stub projection, so no claim
// byte string doubles as a signed-event or signed-stub byte string. Amended
// pre-first-release with no production anchors in existence. Canonical text:
// `Spec-006 §Anchoring Cadence`; {@link buildAnchorClaimBytes} is the one
// preimage builder, exported so T4.1's verifier consumes it rather than
// re-deriving the shape.
//
// ----------------------------------------------------------------------------
// Why leaves are read from the DATABASE and never accumulated in memory
// ----------------------------------------------------------------------------
//
// The obvious implementation buffers each `rowHash` the hook receives and
// hashes the buffer when the threshold trips. It is wrong for a reason worth
// stating: an anchor's only value is that a verifier can RECOMPUTE it from
// stored `row_hash` values. In-memory leaves that ever diverge from disk — a
// rolled-back transaction, a restart mid-window, a re-entrant caller — produce
// a root that is correct about nothing and that no verifier can reproduce. The
// failure is silent and permanent: the signature is valid, so the anchor looks
// healthy until an audit years later reports a range that will not verify.
//
// So both entry points use ONE leaf source, `#readLeaves`, reading
// `session_events.row_hash` in `sequence` order. The hook's `rowHash` keeps two
// jobs it can do honestly — it is the trigger, and it is cross-checked against
// the stored hash at the same sequence, which catches a caller wired to the
// wrong session before the mismatch becomes an unverifiable anchor.
//
// The same reasoning fixes where the cadence WINDOW comes from: the QUEUE, not
// a counter in process memory. A restart therefore resumes exactly where the
// unwitnessed rows begin, and needs no separate backfill path.
//
// WHICH SEQUENCE THAT IS, PRECISELY: the lowest stored sequence not covered by
// any queued anchor for this `(session, node)` — NOT `MAX(end_sequence) + 1`.
// The two agree only while every anchor is contiguous, and the compactor is a
// named, legitimate producer of non-contiguous ones. A force-fire over
// [2000,3000] landing after a cadence anchor over [1,1000] pushes
// `MAX(end_sequence)` to 3000, and a window starting at 3001 would leave
// 1001-1999 unwitnessed by every future anchor — permanently, and silently,
// since nothing downstream asks whether a range was skipped. Deriving the start
// from the first UNCOVERED sequence heals that gap on the next cadence fire
// instead: the window becomes [1001, current], which overlaps [2000,3000].
//
// OVERLAPPING ANCHORS ARE THEREFORE EXPECTED, and nothing objects to them. The
// UNIQUE key is on the exact range, coverage is a `start <= x AND end >= y`
// test rather than an exact match, and a verifier checking a range needs SOME
// covering anchor, not a partition. The no-gap property is now unconditional;
// the no-overlap one was never load-bearing and is gone.
//
// ----------------------------------------------------------------------------
// Idempotency — two independent mechanisms, deliberately
// ----------------------------------------------------------------------------
//
// `IdempotencyClass: idempotent` on the T3.3 plan row is carried by both:
//
//   * A COVERAGE pre-check short-circuits before any signing work when an
//     existing anchor already covers the requested range
//     (`start_sequence <= fromSeq AND end_sequence >= toSeq`). This is the
//     `Spec-006 §Post-Compaction Integrity` step-1 test and is deliberately NOT
//     an exact-start match: an anchor over [1,5000] covers a compaction of
//     [2000,3000], and an exact-match probe would miss it and force a redundant
//     re-anchor.
//   * The `UNIQUE (session_id, node_id, start_sequence, end_sequence)` key makes
//     a genuine re-fire of an IDENTICAL range a no-op insert; the service then
//     reads the queued row back and returns it rather than re-signing. (Ed25519
//     is deterministic per RFC 8032 §5.1.6, so re-signing would produce the same
//     bytes — the point is that the queue must not accumulate duplicate rows,
//     and that the returned `anchoredAt` must be the ORIGINAL commitment's, not
//     a fresh timestamp.)
//
// Distinct ranges sharing a `start_sequence` are NOT collapsed by either
// mechanism — see the migration header for why that matters.
//
// ----------------------------------------------------------------------------
// Upload is decoupled from anchoring, and that is a durability property
// ----------------------------------------------------------------------------
//
// `anchorRange` returns once the row is QUEUED. It does not await, or even
// attempt, a control-plane upload. `Spec-006 §Post-Compaction Integrity` step 3
// pins that landing in `pending_anchor_uploads` — not a successful upload — is
// what satisfies the compactor's precondition, and Plan-006 §Merkle Anchor
// Emission makes queue-locally-flush-on-reconnect the partition-tolerance
// contract. A daemon partitioned from the control plane keeps anchoring and
// keeps compacting; the witness copies converge when the link returns.
//
// Spec coverage: `Spec-006 §Anchoring Cadence` (ANCHOR_INTERVAL_EVENTS),
// `Spec-006 §Post-Compaction Integrity` (force-fire; pending_anchor_uploads).
// Verifies invariant: I-006-3-02 (the uploaded shape is metadata-only —
// structurally enforced by `AnchorPayload` in `@ai-sidekicks/contracts`).
// Refs: Plan-006 T3.3, Plan-006 §Merkle Anchor Emission, ADR-017,
// `docs/architecture/schemas/local-sqlite-schema.md`.

import {
  AnchorPayloadSchema,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  type AnchorPayload,
  type EventAnchorUploadResponse,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import type { Database, Statement } from "better-sqlite3";

import { canonicalizeJson, type CanonicalBytes } from "./canonicalizer.js";
import {
  assertDpopCredentialMaterial,
  type DaemonCredentialProvider,
} from "./daemon-credential-provider.js";
import type { DaemonSigningKeySource } from "./signing-key-source.js";

/**
 * The Ed25519 preimage of `root_signature` — the RFC 8785 canonicalization of
 * the five-member anchor claim per `Spec-006 §Anchoring Cadence` (2026-08-11
 * amendment; see the module header's PREIMAGE AMENDMENT note).
 *
 * `merkleRoot` enters the claim in the base64 spelling the upload wire carries
 * ({@link AnchorPayload}`.merkleRoot`), the sequences as JSON numbers, the ids
 * as their wire strings. RFC 8785 orders members itself; the literal below is
 * written pre-sorted for the reader. Exported as the ONE preimage builder so
 * the T4.1 verifier and the golden tests consume this construction rather than
 * re-deriving it — a second builder that drifted would mint signatures nothing
 * can verify.
 */
export function buildAnchorClaimBytes(claim: {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly merkleRoot: Uint8Array;
}): CanonicalBytes {
  return canonicalizeJson({
    endSequence: claim.endSequence,
    merkleRoot: Buffer.from(claim.merkleRoot).toString("base64"),
    nodeId: claim.nodeId,
    sessionId: claim.sessionId,
    startSequence: claim.startSequence,
  });
}

/**
 * Rows per cadence anchor — `Spec-006 §Anchoring Cadence`
 * (`ANCHOR_INTERVAL_EVENTS = 1000`).
 */
export const ANCHOR_INTERVAL_EVENTS: number = 1000;

/**
 * Seconds since the previous anchor after which the cadence fires regardless of
 * row count — `Spec-006 §Anchoring Cadence` (`ANCHOR_INTERVAL_SECONDS = 300`).
 *
 * The two thresholds are an EARLIER-OF, not an AND: a quiet session still gets
 * a witness every five minutes, and a busy one every thousand rows.
 */
export const ANCHOR_INTERVAL_SECONDS: number = 300;

/** Width of a `session_events.row_hash` leaf and of a Merkle root, in bytes. */
const MERKLE_NODE_LENGTH = 32;

/** Width of an Ed25519 signature (RFC 8032 §5.1.6), in bytes. */
const ED25519_SIGNATURE_LENGTH = 64;

/** Delay before the FIRST retry of a failed upload, in seconds. */
export const UPLOAD_RETRY_BASE_SECONDS: number = 30;

/**
 * Ceiling on the exponential retry delay, in seconds (one hour).
 *
 * A CAP RATHER THAN A GIVE-UP, and the difference is the whole design. There is
 * no dead-letter state and no attempt ceiling: an anchor that stops being
 * retried is an integrity witness silently abandoned, and `pending_anchor_uploads`
 * has no column that could record such a decision for an operator to find. So a
 * permanently-failing row — a terminal 404 from a control plane that never
 * learned the session — keeps retrying at this cadence forever. That is a
 * deliberate residual, not an oversight: a bounded slow drip costs one request
 * an hour and stays visible in `last_error`, whereas dropping the row loses the
 * witness with no trace. A real dead-letter column is a later phase's call.
 */
export const UPLOAD_RETRY_MAX_SECONDS: number = 3600;

/**
 * How long a failed upload waits before its next attempt — capped exponential
 * backoff over `pending_anchor_uploads.attempt_count`.
 *
 * A PURE FUNCTION, EXPORTED, because the alternative was arithmetic buried in a
 * SQL string where no test can reach it and no reviewer can check it against
 * the constants above.
 *
 * `attemptCount` is the count of attempts ALREADY made, so 0 (never attempted)
 * yields no delay at all. The same guard absorbs a corrupt `attempt_count` that
 * is negative or non-finite: those return 0 rather than `NaN`, because a `NaN`
 * delay makes the `waited >= delay` eligibility comparison false forever and
 * strands the row.
 *
 * Growth is `base * 2^(attempts - 1)`, capped at {@link UPLOAD_RETRY_MAX_SECONDS}.
 * The exponent is bounded at 32 to keep `2 ** doublings` a finite double for an
 * absurd `attempt_count` — there is no shift anywhere here (`**`, not `<<`), so
 * nothing can wrap into a negative delay. That bound is DEFENSIVE ONLY and is
 * not observable in the returned value: unbounded, a huge exponent yields
 * `Infinity`, and `Math.min(Infinity, UPLOAD_RETRY_MAX_SECONDS)` is the cap —
 * the same second the bounded path returns. It is kept so this expression stays
 * in finite arithmetic instead of depending on `Infinity` surviving a future
 * edit to it, and the tests below pin the two things that ARE observable: the
 * guard's zero and the cap boundary.
 */
export function uploadRetryDelaySeconds(attemptCount: number): number {
  if (!Number.isFinite(attemptCount) || attemptCount <= 0) return 0;
  const doublings = Math.min(Math.floor(attemptCount) - 1, 32);
  return Math.min(UPLOAD_RETRY_BASE_SECONDS * 2 ** doublings, UPLOAD_RETRY_MAX_SECONDS);
}

// --------------------------------------------------------------------------
// The Merkle tree
// --------------------------------------------------------------------------

/** RFC 9162 §2.1.1 leaf-hash domain-separation prefix. */
const MERKLE_LEAF_PREFIX = 0x00;

/** RFC 9162 §2.1.1 interior-node domain-separation prefix. */
const MERKLE_INTERIOR_PREFIX = 0x01;

/**
 * Computes the RFC 9162 §2.1.1 Merkle Tree Hash over an ordered list of 32-byte
 * `session_events.row_hash` data entries, with BLAKE3 as HASH.
 *
 * EXPORTED FOR THE VERIFIER. Phase 4's audit reader must recompute this exact
 * value from stored `row_hash` bytes; giving it the same function rather than a
 * prose description of the algorithm is the difference between an interop
 * contract and an interop hope.
 *
 * @throws Error on an empty entry list (see construction rule 5 in the module
 * header), or on any entry that is not 32 bytes.
 */
export function computeMerkleRoot(leaves: ReadonlyArray<Uint8Array>): Uint8Array {
  if (leaves.length === 0) {
    throw new Error(
      "computeMerkleRoot requires at least one leaf: an anchor range is inclusive and non-empty " +
        "by construction, so zero leaves means rows the range covers are missing from " +
        "session_events. Hashing the empty string here would sign a commitment to nothing.",
    );
  }
  for (const [index, leaf] of leaves.entries()) {
    if (leaf.length !== MERKLE_NODE_LENGTH) {
      throw new Error(
        `computeMerkleRoot leaf ${index} is ${leaf.length} bytes; every leaf must be the ` +
          `${MERKLE_NODE_LENGTH}-byte session_events.row_hash. A short or long leaf means the ` +
          "stored chain hash is corrupt, which is an integrity finding rather than a bad argument.",
      );
    }
  }
  // Index bounds rather than array slices: the recursion visits O(n log n)
  // sub-ranges, and copying at each one turns an audit-path walk over a large
  // compaction range into needless garbage.
  return merkleTreeHash(leaves, 0, leaves.length);
}

/** `MTH(D[start:end])` — RFC 9162 §2.1.1, over the half-open index range. */
function merkleTreeHash(
  entries: ReadonlyArray<Uint8Array>,
  start: number,
  end: number,
): Uint8Array {
  const width = end - start;
  if (width === 1) {
    const entry = entries[start];
    if (entry === undefined) {
      // Unreachable: callers bound `start` by `entries.length`. Typed rather
      // than asserted so the narrowing stays honest.
      throw new Error(`merkleTreeHash read past the end of the entry list at index ${start}`);
    }
    return hashWithPrefix(MERKLE_LEAF_PREFIX, entry);
  }
  const split = start + largestPowerOfTwoBelow(width);
  return hashWithPrefix(
    MERKLE_INTERIOR_PREFIX,
    merkleTreeHash(entries, start, split),
    merkleTreeHash(entries, split, end),
  );
}

/** `HASH(prefix || parts…)` — one allocation, no intermediate concatenations. */
function hashWithPrefix(prefix: number, ...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let width = 1;
  for (const part of parts) width += part.length;
  const buffer = new Uint8Array(width);
  buffer[0] = prefix;
  let offset = 1;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return blake3(buffer);
}

/**
 * The largest power of two strictly smaller than `width` — the RFC's `k`, where
 * `k < n <= 2k`. Defined only for `width > 1`, which is the sole call site.
 */
function largestPowerOfTwoBelow(width: number): number {
  return 1 << (31 - Math.clz32(width - 1));
}

// --------------------------------------------------------------------------
// Upload transport
// --------------------------------------------------------------------------

/**
 * Ships one anchor to the control plane.
 *
 * An INTERFACE rather than an inlined `fetch` call, for two reasons. It keeps
 * the exact tRPC request/response envelope out of the service's own logic (the
 * service cares that the anchor landed, not how), and it lets the queue-drain
 * behaviour be exercised without a live HTTP server.
 */
export interface AnchorUploadTransport {
  upload(anchor: AnchorPayload): Promise<EventAnchorUploadResponse>;
}

/** Construction deps for {@link TrpcFetchAnchorUploadTransport}. */
export interface TrpcFetchAnchorUploadTransportDeps {
  /**
   * The control plane's tRPC endpoint base, with no trailing slash — e.g.
   * `https://control.example/trpc`. The procedure path is appended to it.
   */
  readonly endpoint: string;
  /** This daemon's NodeId, carried into the credential attempt. */
  readonly nodeId: NodeId;
  /** Mints the per-attempt DPoP credential headers (CP-006-13). */
  readonly credentialProvider: DaemonCredentialProvider;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The canonical procedure name for anchor upload — the `event-anchors/` router
 * namespace plus its single mutation.
 *
 * Spelled as one lowercase word to match the shipped `runtimenode.*` namespace
 * convention, and deliberately distinct from the daemon-side `event.*`
 * JSON-RPC namespace, which is a different transport carrying different
 * methods.
 */
export const ANCHOR_UPLOAD_PROCEDURE = "eventanchor.upload";

/**
 * Merges provider-supplied headers over a set of defaults, matching names
 * case-insensitively (RFC 9110 §5.1).
 *
 * A plain object spread would compare names by BYTES. A provider that derives
 * its material from a `Headers` instance hands back lowercase names, so
 * `{...defaults, ...material}` can emit `Content-Type` AND `content-type` as two
 * distinct keys — the same header twice, with the recipient's resolution left to
 * chance. Overriding case-insensitively means the provider wins outright, which
 * is what "merge the minted headers onto the request" is supposed to mean.
 */
function mergeRequestHeaders(
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaults };
  for (const [name, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(merged)) {
      if (existing !== name && existing.toLowerCase() === name.toLowerCase()) {
        delete merged[existing];
      }
    }
    merged[name] = value;
  }
  return merged;
}

/**
 * The thin, single-procedure tRPC caller for `eventanchor.upload`.
 *
 * DELIBERATELY NOT `@trpc/client`. The daemon does not depend on it, this is
 * one unbatched mutation, and the control-plane root runs `transformer: false`
 * — so the request body is the input JSON verbatim and the response is
 * `{"result":{"data":…}}`. A typed client would add a dependency and an
 * inference chain to save constructing one URL.
 *
 * THE CREDENTIAL IS MINTED PER ATTEMPT, INSIDE THIS METHOD, and the `htm`/`htu`
 * handed to the provider are the method and URI of the very request being
 * built one line later. That co-location is the point: RFC 9449 §4.3 binds the
 * proof to those two values, so a proof minted against anything else is a proof
 * of nothing, and the only way to keep them in agreement is to derive both from
 * the same place.
 */
export class TrpcFetchAnchorUploadTransport implements AnchorUploadTransport {
  readonly #endpoint: string;
  readonly #nodeId: NodeId;
  readonly #credentialProvider: DaemonCredentialProvider;
  readonly #fetchImpl: typeof fetch;

  constructor(deps: TrpcFetchAnchorUploadTransportDeps) {
    this.#endpoint = deps.endpoint.replace(/\/+$/, "");
    this.#nodeId = deps.nodeId;
    this.#credentialProvider = deps.credentialProvider;
    this.#fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  async upload(anchor: AnchorPayload): Promise<EventAnchorUploadResponse> {
    // No query string and no fragment: an unbatched tRPC mutation POSTs its
    // input as the body, so this URL is already the `htu` RFC 9449 §4.3 wants.
    const requestUri = `${this.#endpoint}/${ANCHOR_UPLOAD_PROCEDURE}`;
    const method = "POST";

    const material = await this.#credentialProvider.mintForAttempt({
      sessionId: anchor.sessionId,
      nodeId: this.#nodeId,
      htm: method,
      htu: requestUri,
    });
    // Refuse a bearer-schemed or proofless credential before it reaches the
    // wire — see `assertDpopCredentialMaterial` for why this is checked at the
    // consumer rather than trusted from the injected provider.
    assertDpopCredentialMaterial(material);

    const response = await this.#fetchImpl(requestUri, {
      method,
      headers: mergeRequestHeaders({ "Content-Type": "application/json" }, material.headers),
      body: JSON.stringify(anchor),
    });

    if (!response.ok) {
      throw new Error(
        `${ANCHOR_UPLOAD_PROCEDURE} failed with HTTP ${response.status} ${response.statusText}`,
      );
    }

    const envelope: unknown = await response.json();
    const stored = readUploadStoredFlag(envelope);
    return { stored };
  }
}

// Narrows the tRPC success envelope `{"result":{"data":{"stored":boolean}}}`.
// Written as a guard rather than a cast because this is untrusted input from
// the network: a control plane that changed its envelope should surface here,
// naming the shape, instead of yielding `undefined` that reads as `false`.
//
// STRUCTURALLY LENIENT ON PURPOSE, and this is where it differs from
// `EventAnchorUploadResponseSchema`, which is `.strict()`. That schema governs
// the control plane's own boundary, where an unexpected member means a caller
// sent something nobody declared. Here the peer is a SEPARATELY DEPLOYED
// service that may legitimately be a version ahead: a control plane that starts
// returning `{stored, anchorId}` has added a field, not broken the contract,
// and refusing it would strand every anchor in the queue until the daemon was
// upgraded. So this reads the one member it needs and ignores the rest — while
// still refusing an envelope that lacks that member, which IS a break.
function readUploadStoredFlag(envelope: unknown): boolean {
  if (typeof envelope === "object" && envelope !== null && "result" in envelope) {
    const result: unknown = (envelope as { result: unknown }).result;
    if (typeof result === "object" && result !== null && "data" in result) {
      const data: unknown = (result as { data: unknown }).data;
      if (typeof data === "object" && data !== null && "stored" in data) {
        const stored: unknown = (data as { stored: unknown }).stored;
        if (typeof stored === "boolean") return stored;
      }
    }
  }
  throw new Error(
    `${ANCHOR_UPLOAD_PROCEDURE} returned an unrecognized response envelope; expected ` +
      `{"result":{"data":{"stored":boolean}}}.`,
  );
}

// --------------------------------------------------------------------------
// The service
// --------------------------------------------------------------------------

/** What {@link MerkleAnchorService.onEventAppended} is told about a committed row. */
export interface AnchorCadenceTrigger {
  readonly sessionId: SessionId;
  /** The `sequence` the append path allocated — `EventLogAppendReceipt.sequence`. */
  readonly sequence: number;
  /** The 32-byte chain head the same append produced — `EventLogAppendReceipt.rowHash`. */
  readonly rowHash: Uint8Array;
}

/** The range {@link MerkleAnchorService.anchorRange} is asked to witness, inclusive at both ends. */
export interface AnchorRangeRequest {
  readonly sessionId: SessionId;
  readonly fromSeq: number;
  readonly toSeq: number;
}

/** What one {@link MerkleAnchorService.uploadPendingAnchors} drain did. */
export interface AnchorDrainResult {
  /** Anchors the control plane accepted or already held on THIS call. */
  readonly flushed: number;
  /**
   * Queued rows skipped whole because their own identity columns would not
   * bind, so not even their failure could be recorded. A counted bucket rather
   * than a silent `continue` — the compactor reports its equivalent as
   * `sessionsUnreadable`, and for the same reason: these rows leave no trace in
   * `last_error`, so this count is the ONLY signal they exist.
   */
  readonly anchorsUnreadable: number;
}

/** Construction deps for {@link MerkleAnchorService}. */
export interface MerkleAnchorServiceDeps {
  /** The daemon's local SQLite handle, migrated through version 8. */
  readonly db: Database;
  /** This daemon's NodeId — the `node_id` every anchor is attributed to. */
  readonly nodeId: NodeId;
  /** Resolves the session's Ed25519 private key for `root_signature`. */
  readonly signingKeySource: DaemonSigningKeySource;
  /**
   * Optional control-plane transport. ABSENT means anchors queue and never
   * flush, which is the correct behaviour before Tier 5 wires a credential
   * provider — and is indistinguishable, by design, from an indefinite
   * partition.
   */
  readonly uploadTransport?: AnchorUploadTransport;
  /**
   * Clock seam. ONE seam yields both values the service needs — the instant
   * the 300-second threshold compares against, and the ISO spelling written to
   * `anchored_at` — so the two can never disagree about when an anchor
   * happened. Tests inject a controlled clock; never assert against real time.
   */
  readonly now?: () => Date;
  /** Mints `pending_anchor_uploads.id`; defaults to `crypto.randomUUID()`. */
  readonly anchorIdFactory?: () => string;
}

// The durable cadence window for one (session, node) pair, derived from the
// queue in a single read (see `#readCadenceWindow`).
interface CadenceWindow {
  /**
   * Lowest stored `session_events.sequence` no queued anchor covers — where the
   * next cadence anchor begins. `undefined` when the session has no rows.
   */
  readonly startSequence: number | undefined;
  /**
   * `anchored_at` of the anchor whose coverage ends at `startSequence - 1` —
   * i.e. the last time the row immediately BEFORE this window was witnessed.
   * `undefined` when no anchor covers the log's first sequence.
   */
  readonly coveredThroughAt: Date | undefined;
}

// Raw `pending_anchor_uploads` row shape. Every member is `unknown` because the
// column declarations are claims TypeScript never checked and the read boundary
// is where they get checked.
interface PendingAnchorRow {
  readonly session_id: unknown;
  readonly node_id: unknown;
  readonly start_sequence: unknown;
  readonly end_sequence: unknown;
  readonly merkle_root: unknown;
  readonly root_signature: unknown;
  readonly anchored_at: unknown;
}

// The drain reads two more columns than the anchor payload needs: they carry
// the retry state the backoff gate consults (`uploadRetryDelaySeconds`).
interface PendingUploadRow extends PendingAnchorRow {
  readonly attempt_count: unknown;
  readonly last_attempt_at: unknown;
}

// One anchor's coverage extent, hydrated for the window walk.
interface AnchorExtentRow {
  readonly start_sequence: unknown;
  readonly end_sequence: unknown;
  readonly anchored_at: unknown;
}

export class MerkleAnchorService {
  readonly #db: Database;
  readonly #nodeId: NodeId;
  readonly #signingKeySource: DaemonSigningKeySource;
  readonly #uploadTransport: AnchorUploadTransport | undefined;
  readonly #now: () => Date;
  readonly #anchorIdFactory: () => string;

  // Prepared once; better-sqlite3 statements are reusable and re-preparing per
  // call would dominate the cost of a path the append path calls on every row.
  readonly #selectCoveringAnchor: Statement;
  readonly #selectExactAnchor: Statement;
  readonly #selectAnchorExtents: Statement;
  readonly #selectLeaves: Statement;
  readonly #selectFirstSequence: Statement;
  readonly #selectRowHashAt: Statement;
  readonly #insertAnchor: Statement;
  readonly #selectPendingUploads: Statement;
  readonly #markUploaded: Statement;
  readonly #recordUploadFailure: Statement;

  // The 300-second reference for a window NO anchor precedes — a session whose
  // log has never been witnessed at all. There is no durable timestamp to
  // measure from in that case, so the reference is the first append this
  // process observed for the window, which is the only defensible reading of
  // "since the previous anchor" when there is none.
  //
  // KEYED BY WINDOW START, and that is what keeps it honest. An entry is read
  // only while `startSequence` still matches, so a window that advances (or
  // moves BACKWARD, which gap-healing makes possible when a non-contiguous
  // force-fire lands) invalidates the reference by simply not matching it. No
  // explicit invalidation is needed anywhere, and in particular `anchorRange`
  // must NOT clear this: an anchor that does not advance the window would then
  // reset the reference it has no business resetting, suppressing for another
  // 300 seconds exactly the catch-up anchor the gap-healing exists to produce.
  //
  // A CACHE, not the source of truth: one entry per (session, node), replaced
  // rather than accumulated, and losing it costs a delayed anchor rather than a
  // wrong one.
  readonly #windowObservationByCadenceKey = new Map<
    string,
    { readonly windowStart: number; readonly observedAt: Date }
  >();

  constructor(deps: MerkleAnchorServiceDeps) {
    this.#db = deps.db;
    this.#nodeId = deps.nodeId;
    this.#signingKeySource = deps.signingKeySource;
    this.#uploadTransport = deps.uploadTransport;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#anchorIdFactory = deps.anchorIdFactory ?? ((): string => crypto.randomUUID());

    // The COVERAGE query (`Spec-006 §Post-Compaction Integrity` step 1): an
    // anchor covers a range when it starts at or before it and ends at or after
    // it. Narrowest covering anchor first, so the short-circuit returns the
    // tightest witness rather than an arbitrary one.
    this.#selectCoveringAnchor = this.#db.prepare(
      `SELECT session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at
         FROM pending_anchor_uploads
        WHERE session_id = ? AND node_id = ?
          AND start_sequence <= ? AND end_sequence >= ?
        ORDER BY (end_sequence - start_sequence) ASC
        LIMIT 1`,
    );
    this.#selectExactAnchor = this.#db.prepare(
      `SELECT session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at
         FROM pending_anchor_uploads
        WHERE session_id = ? AND node_id = ? AND start_sequence = ? AND end_sequence = ?`,
    );
    // Every anchor's extent for this pair, in coverage order. The window walk
    // needs the whole set rather than the newest row: `MAX(end_sequence)` names
    // the FURTHEST witnessed point, and the cadence window starts at the FIRST
    // UNWITNESSED one, which are different sequences the moment any anchor is
    // non-contiguous.
    this.#selectAnchorExtents = this.#db.prepare(
      `SELECT start_sequence, end_sequence, anchored_at
         FROM pending_anchor_uploads
        WHERE session_id = ? AND node_id = ?
        ORDER BY start_sequence ASC`,
    );
    this.#selectLeaves = this.#db.prepare(
      `SELECT row_hash FROM session_events
        WHERE session_id = ? AND sequence BETWEEN ? AND ?
        ORDER BY sequence ASC`,
    );
    this.#selectFirstSequence = this.#db.prepare(
      `SELECT MIN(sequence) AS first_sequence FROM session_events WHERE session_id = ?`,
    );
    this.#selectRowHashAt = this.#db.prepare(
      `SELECT row_hash FROM session_events WHERE session_id = ? AND sequence = ?`,
    );
    // OR IGNORE, not a pre-check: the UNIQUE key is what makes a concurrent or
    // retried force-fire a no-op, and doing it in one statement means there is
    // no window between checking and inserting.
    this.#insertAnchor = this.#db.prepare(
      `INSERT OR IGNORE INTO pending_anchor_uploads
         (id, session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Sentinel-partitioned (node-scope) rows are excluded: they have no
    // `sessions(id)` row for `event_log_anchors` to FK against, and node-scope
    // witnessing is a V1.1 extension (ADR-017 §Node-Scope Anchor Witnessing).
    // Their `uploaded_at` stays NULL by design, so this filter is what keeps
    // them from being retried forever.
    // `attempt_count` and `last_attempt_at` come along because the drain's
    // backoff gate reads them (`uploadRetryDelaySeconds`). The eligibility
    // arithmetic itself stays in TypeScript rather than in this string: a retry
    // policy expressed in SQL is one no unit test can reach and no reviewer can
    // check against the exported constants.
    this.#selectPendingUploads = this.#db.prepare(
      `SELECT session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature,
              anchored_at, attempt_count, last_attempt_at
         FROM pending_anchor_uploads
        WHERE uploaded_at IS NULL AND session_id <> ?
        ORDER BY anchored_at ASC`,
    );
    this.#markUploaded = this.#db.prepare(
      `UPDATE pending_anchor_uploads
          SET uploaded_at = ?, attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = NULL
        WHERE session_id = ? AND node_id = ? AND start_sequence = ? AND end_sequence = ?`,
    );
    this.#recordUploadFailure = this.#db.prepare(
      `UPDATE pending_anchor_uploads
          SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
        WHERE session_id = ? AND node_id = ? AND start_sequence = ? AND end_sequence = ?`,
    );
  }

  /**
   * Cadence hook — call after every committed append.
   *
   * Fires an anchor over `[windowStart, sequence]` on the earlier of
   * `ANCHOR_INTERVAL_EVENTS` rows or `ANCHOR_INTERVAL_SECONDS` seconds since the
   * previous anchor (`Spec-006 §Anchoring Cadence`). Below both thresholds it
   * resolves without touching the queue.
   *
   * PROPAGATES ITS FAILURES rather than swallowing them. An anchor that cannot
   * be produced means the integrity witness has stopped being written, and a
   * daemon that continues appending while silently emitting no witness is
   * accumulating a range no audit can ever verify. The caller decides whether
   * that fails the append or is logged and retried — but it must be told.
   */
  async onEventAppended(trigger: AnchorCadenceTrigger): Promise<void> {
    // Cross-check the trigger against the stored row at that sequence. This is
    // cheap and catches a genuinely bad wiring — a hook fed another session's
    // receipt — at the moment it happens, rather than as an unverifiable anchor
    // discovered at audit time.
    this.#assertTriggerMatchesStoredRow(trigger);

    // ONE window read, feeding BOTH thresholds. Reading it twice would not just
    // double the query cost on a path the append path runs per row — it would
    // let the two decisions disagree, since a concurrent force-fire landing
    // between the reads would move the window under the second one.
    const window = this.#readCadenceWindow(trigger.sessionId);
    const windowStartSequence = window.startSequence;
    if (windowStartSequence === undefined || trigger.sequence < windowStartSequence) {
      // Nothing unanchored in this window (the row is already covered by a
      // wider anchor, or the session has no rows the queue does not witness).
      return;
    }

    const pendingRowCount = trigger.sequence - windowStartSequence + 1;
    const elapsedSeconds = this.#elapsedSecondsSinceWindowStart(trigger.sessionId, window);

    if (pendingRowCount < ANCHOR_INTERVAL_EVENTS && elapsedSeconds < ANCHOR_INTERVAL_SECONDS) {
      return;
    }

    await this.anchorRange({
      sessionId: trigger.sessionId,
      fromSeq: windowStartSequence,
      toSeq: trigger.sequence,
    });
  }

  /**
   * Force-fire — computes, signs, and durably queues an anchor over
   * `[fromSeq, toSeq]`, then returns it.
   *
   * RETURNS ONCE QUEUED. No control-plane upload is attempted or awaited; see
   * the module header for why that is a durability property rather than a
   * shortcut.
   *
   * Idempotent by both mechanisms the header describes: a covering anchor
   * short-circuits before any signing, and a re-fire of an identical range
   * returns the already-queued row without re-signing.
   *
   * @throws Error when the range is malformed or the stored rows do not cover it.
   */
  async anchorRange(request: AnchorRangeRequest): Promise<AnchorPayload> {
    const { sessionId, fromSeq, toSeq } = request;
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 0) {
      throw new Error(
        `anchorRange requires non-negative integer bounds; received [${fromSeq}, ${toSeq}].`,
      );
    }
    if (toSeq < fromSeq) {
      throw new Error(
        `anchorRange requires toSeq >= fromSeq; received [${fromSeq}, ${toSeq}]. An inverted ` +
          "range names no rows, and an anchor over no rows commits to nothing.",
      );
    }

    // Coverage pre-check — before reading leaves, before touching the key.
    const covering = this.#selectCoveringAnchor.get(sessionId, this.#nodeId, fromSeq, toSeq) as
      | PendingAnchorRow
      | undefined;
    if (covering !== undefined) {
      return toAnchorPayload(covering);
    }

    const leaves = this.#readLeaves(sessionId, fromSeq, toSeq);
    const expectedLeafCount = toSeq - fromSeq + 1;
    if (leaves.length !== expectedLeafCount) {
      // REFUSE LOUDLY rather than anchoring what happens to be there. A caller
      // asking to witness [2000,3000] and getting 900 rows is asking about a
      // range that does not exist as stated; signing the 900 would produce a
      // commitment whose stated bounds are a lie, and the compactor calling
      // this needs a refusal it can act on, not a fabricated witness.
      throw new Error(
        `anchorRange found ${leaves.length} rows for session ${sessionId} range ` +
          `[${fromSeq}, ${toSeq}], expected ${expectedLeafCount}. The range is not fully stored ` +
          "(already compacted, never appended, or a sequence gap), so no anchor can honestly " +
          "commit to it.",
      );
    }

    const merkleRoot = computeMerkleRoot(leaves);
    const daemonSigningKey = await this.#signingKeySource.read(sessionId);
    const anchorClaimBytes = buildAnchorClaimBytes({
      sessionId,
      nodeId: this.#nodeId,
      startSequence: fromSeq,
      endSequence: toSeq,
      merkleRoot,
    });
    const rootSignature = ed25519.sign(anchorClaimBytes, daemonSigningKey);
    if (rootSignature.length !== ED25519_SIGNATURE_LENGTH) {
      throw new Error(
        `Ed25519 signature over the anchor claim is ${rootSignature.length} bytes, expected ` +
          `${ED25519_SIGNATURE_LENGTH}.`,
      );
    }

    const anchoredAt = this.#now();
    const anchoredAtIso = anchoredAt.toISOString();
    const anchorId = this.#anchorIdFactory();

    // One synchronous transaction, dispatched `.immediate()` so the BEGIN takes
    // the RESERVED writer-intent lock rather than colliding at write-upgrade
    // time — the same primitive the migration runner uses and for the same
    // reason. The coverage re-check inside closes the window between the
    // pre-check above and this write: a concurrent force-fire that landed a
    // covering anchor in between is observed here, and we return ITS row rather
    // than queueing a redundant one.
    const stored = this.#db
      .transaction((): PendingAnchorRow => {
        const raced = this.#selectCoveringAnchor.get(sessionId, this.#nodeId, fromSeq, toSeq) as
          | PendingAnchorRow
          | undefined;
        if (raced !== undefined) return raced;

        this.#insertAnchor.run(
          anchorId,
          sessionId,
          this.#nodeId,
          fromSeq,
          toSeq,
          Buffer.from(merkleRoot),
          Buffer.from(rootSignature),
          anchoredAtIso,
        );

        // Read back rather than returning what we just built. On the OR IGNORE
        // no-op path the winning row is someone else's, and its `anchored_at` is
        // the ORIGINAL commitment's — returning our fresh timestamp would report
        // an anchoring that did not happen.
        const persisted = this.#selectExactAnchor.get(sessionId, this.#nodeId, fromSeq, toSeq) as
          | PendingAnchorRow
          | undefined;
        if (persisted === undefined) {
          throw new Error(
            `anchorRange inserted an anchor for session ${sessionId} range [${fromSeq}, ${toSeq}] ` +
              "but could not read it back in the same transaction.",
          );
        }
        return persisted;
      })
      .immediate() as PendingAnchorRow;

    // NO CACHE INVALIDATION HERE, deliberately. `#windowObservationByCadenceKey`
    // is keyed by window start, so an anchor that advanced the window is already
    // unreachable through the new key, and an anchor that did NOT advance it —
    // a non-contiguous force-fire — keeps the reference it must keep. Clearing
    // unconditionally would reset the 300-second clock on exactly the case
    // gap-healing exists to serve.
    return toAnchorPayload(stored);
  }

  /**
   * Drains the queue to the control plane — the flush half of
   * queue-locally-flush-on-reconnect.
   *
   * Each row is a separate attempt with its own freshly-minted DPoP credential
   * (a proof is bound to one request; reusing one across rows would be replay).
   * A failed row records its error and attempt count durably and the drain
   * CONTINUES: one session's credential problem must not stall every other
   * session's witness. That contract is why EVERY per-row step — hydration
   * included — sits inside the per-row `try`. Hydrating outside it would let a
   * single corrupt row abort the drain for every session, which is the failure
   * this paragraph promises does not happen.
   *
   * A row whose previous attempt failed is SKIPPED until
   * {@link uploadRetryDelaySeconds} has elapsed since `last_attempt_at`. Without
   * that gate the retry state was written and never read: a terminal failure —
   * a 404 for a session the control plane never learned — re-attempted at the
   * caller's full drain frequency forever.
   *
   * @returns an {@link AnchorDrainResult}. A ZERO `flushed` DOES NOT MEAN THE
   * QUEUE IS EMPTY: it is equally the answer when every pending row is still
   * inside its backoff window, and a scheduler that reads it as "nothing left to
   * flush" will be wrong for as long as an hour at a time. Callers wanting queue
   * depth must query the table; these numbers report work DONE, not work
   * REMAINING. A non-zero `anchorsUnreadable` is an operator signal, not a
   * transient: those rows stay pending and will be re-skipped every drain.
   */
  async uploadPendingAnchors(): Promise<AnchorDrainResult> {
    if (this.#uploadTransport === undefined) return { flushed: 0, anchorsUnreadable: 0 };

    const pending = this.#selectPendingUploads.all(
      DAEMON_SCOPE_SENTINEL_SESSION_ID,
    ) as ReadonlyArray<PendingUploadRow>;

    let flushed = 0;
    let anchorsUnreadable = 0;
    for (const row of pending) {
      const now = this.#now();
      if (!isUploadRetryDue(row, now)) continue;

      const attemptedAt = now.toISOString();
      const identity = readAnchorIdentity(row);
      try {
        // Inside the try: a corrupt column here is this ROW's problem.
        const anchor = toAnchorPayload(row);
        await this.#uploadTransport.upload(anchor);
        // Both `stored` arms are success: `false` means the control plane
        // already held this exact range, which is the idempotent-re-upload
        // case, not a failure to flush.
        this.#markUploaded.run(
          attemptedAt,
          attemptedAt,
          anchor.sessionId,
          anchor.nodeId,
          anchor.startSequence,
          anchor.endSequence,
        );
        flushed += 1;
      } catch (uploadError) {
        // Bookkeeping is keyed off the RAW columns, not the hydrated payload:
        // on the hydration-failure arm there is no payload to key off, and that
        // arm is precisely the one that most needs its error recorded.
        //
        // A row whose own identity columns will not bind is the one case that
        // cannot be recorded at all — writing the failure would need the same
        // values that are corrupt. It is left pending and the drain moves on,
        // rather than throwing and stalling every later row. COUNTED rather
        // than silently skipped: `last_error` is exactly the channel this arm
        // cannot reach, so without the count the row is invisible to everyone.
        if (identity === undefined) {
          anchorsUnreadable += 1;
          continue;
        }
        this.#recordUploadFailure.run(
          attemptedAt,
          uploadError instanceof Error ? uploadError.message : String(uploadError),
          identity.sessionId,
          identity.nodeId,
          identity.startSequence,
          identity.endSequence,
        );
      }
    }
    return { flushed, anchorsUnreadable };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  // NUL separates the two components because neither a UUID nor a node id can
  // contain it, so no (session, node) pair can forge another pair's key. Written
  // as an escape rather than a literal byte: a raw NUL makes diff, GitHub, and
  // every other line-oriented tool treat this whole file as binary.
  #cadenceKey(sessionId: SessionId): string {
    return `${sessionId}\u0000${this.#nodeId}`;
  }

  // Where the next cadence anchor starts, and when the row before it was last
  // witnessed. Derived from the QUEUE rather than from process state, so a
  // restart resumes exactly where the unwitnessed rows begin.
  //
  // THE WALK. Anchors arrive sorted by `start_sequence` ascending, and a cursor
  // advances through the covered prefix from the log's first sequence. The
  // ordering is what makes an early exit sound: every anchor after the current
  // one starts at or after it, so the FIRST anchor starting beyond the cursor
  // proves nothing later can cover the cursor either. Do not "fix" this into a
  // full scan.
  //
  // Three dispositions, and the middle one is the reason this is a walk rather
  // than `MAX(end_sequence) + 1`:
  //
  //   * `start > cursor`      — a gap. The cursor IS the first uncovered
  //                             sequence; stop.
  //   * `end >= cursor`       — extends the covered prefix; advance past it.
  //   * otherwise             — an anchor entirely behind the cursor (a
  //                             narrower range nested in one already walked).
  //                             Skip it; it neither extends nor interrupts.
  //
  // Cost is O(anchors in the covered prefix) per call, which is why
  // `onEventAppended` reads it exactly once. Bounding it further would need an
  // index the canonical DDL does not declare, and adding one is a schema change
  // rather than a fix — named here so the trade-off is visible rather than
  // discovered.
  //
  // ACCEPTED RESIDUAL: an unparseable `anchored_at` on the anchor that ends the
  // covered prefix leaves `coveredThroughAt` undefined while the cursor still
  // advances correctly. Elapsed time then falls back to first-observation of the
  // window, resetting the 300-second clock on a window that may already be
  // overdue — a delayed witness, the direction this file otherwise refuses. It
  // is left unhandled because the column is NOT NULL and daemon-written, so the
  // only path there is local database corruption, and a witness-timing repair
  // built on corrupt state would be guessing.
  #readCadenceWindow(sessionId: SessionId): CadenceWindow {
    const firstRow = this.#selectFirstSequence.get(sessionId) as
      | { first_sequence: unknown }
      | undefined;
    const firstSequence = firstRow?.first_sequence;
    // MIN() over an empty set is NULL — a session with no rows has no window.
    if (typeof firstSequence !== "number") {
      return { startSequence: undefined, coveredThroughAt: undefined };
    }

    const anchors = this.#selectAnchorExtents.all(
      sessionId,
      this.#nodeId,
    ) as ReadonlyArray<AnchorExtentRow>;

    let cursor = firstSequence;
    let coveredThroughAt: Date | undefined;
    for (const anchor of anchors) {
      const start = anchor.start_sequence;
      const end = anchor.end_sequence;
      if (typeof start !== "number" || typeof end !== "number") continue;
      if (start > cursor) break;
      if (end >= cursor) {
        cursor = end + 1;
        coveredThroughAt = parseStoredInstant(anchor.anchored_at);
      }
    }
    return { startSequence: cursor, coveredThroughAt };
  }

  // Seconds since the reference the 300-second threshold measures from.
  //
  // THE REFERENCE IS THE WINDOW'S OWN PREDECESSOR, not the newest anchor in the
  // session, and the distinction is load-bearing after a non-contiguous
  // force-fire. Say a cadence anchor covered [1,1000] at T1 and a compaction
  // force-fire covered [2000,3000] at a much later T2. The window is [1001, …],
  // and its reference is T1 — deliberately stale. Measuring from T2 instead
  // would restart the clock on rows that have been waiting since T1 and
  // suppress the catch-up anchor for another five minutes. A reviewer reading
  // T1 as a bug has the sign backwards: those rows really are that overdue.
  //
  // Reading the reference from the QUEUE is also what closes the restart hole:
  // a daemon that restarts with a ten-minute-old anchor and one new row anchors
  // it immediately, because 300 seconds have genuinely elapsed since the last
  // witness and that row is genuinely unwitnessed.
  #elapsedSecondsSinceWindowStart(sessionId: SessionId, window: CadenceWindow): number {
    const now = this.#now();
    if (window.coveredThroughAt !== undefined) {
      return (now.getTime() - window.coveredThroughAt.getTime()) / 1000;
    }
    // No anchor precedes this window — the log has never been witnessed from
    // its start. The only available reference is when this process first saw
    // the window, and the entry is keyed by window start so a window that moves
    // simply stops matching (see the field's own comment).
    const windowStart = window.startSequence;
    if (windowStart === undefined) return 0;
    const key = this.#cadenceKey(sessionId);
    const observation = this.#windowObservationByCadenceKey.get(key);
    if (observation === undefined || observation.windowStart !== windowStart) {
      this.#windowObservationByCadenceKey.set(key, { windowStart, observedAt: now });
      return 0;
    }
    return (now.getTime() - observation.observedAt.getTime()) / 1000;
  }

  #assertTriggerMatchesStoredRow(trigger: AnchorCadenceTrigger): void {
    const row = this.#selectRowHashAt.get(trigger.sessionId, trigger.sequence) as
      | { row_hash: unknown }
      | undefined;
    if (row === undefined) {
      throw new Error(
        `onEventAppended was told about session ${trigger.sessionId} sequence ${trigger.sequence}, ` +
          "which is not stored. The hook must be called AFTER the append commits — anchoring an " +
          "uncommitted row would commit to bytes that may never land.",
      );
    }
    const storedRowHash = toBytes(row.row_hash, "session_events.row_hash");
    if (!bytesEqual(storedRowHash, trigger.rowHash)) {
      throw new Error(
        `onEventAppended's rowHash does not match the stored row_hash at session ` +
          `${trigger.sessionId} sequence ${trigger.sequence}. The hook is wired to a different ` +
          "chain than the one it is anchoring, and every anchor it produced would be " +
          "unverifiable.",
      );
    }
  }

  #readLeaves(sessionId: SessionId, fromSeq: number, toSeq: number): ReadonlyArray<Uint8Array> {
    const rows = this.#selectLeaves.all(sessionId, fromSeq, toSeq) as ReadonlyArray<{
      row_hash: unknown;
    }>;
    return rows.map((row) => toBytes(row.row_hash, "session_events.row_hash"));
  }
}

// --------------------------------------------------------------------------
// Row / byte helpers
// --------------------------------------------------------------------------

// Hydrates a stored anchor row into the wire contract. The two BLOB columns
// become base64 because that is what crosses `transformer: false` tRPC — see
// the `AnchorPayload` header in `@ai-sidekicks/contracts`.
//
// PARSED, NOT CAST. The branded members would otherwise be minted by two `as`
// assertions, and `anchoredAt` would reach the wire on the strength of being a
// string — neither of which the stored row has earned. `AnchorPayloadSchema` is
// the same validator the control-plane store runs, so a row that cannot cross
// the boundary is refused HERE, at the daemon that owns the defect, rather than
// as a remote 400 whose cause is a database this process can see and the
// control plane cannot.
function toAnchorPayload(row: PendingAnchorRow): AnchorPayload {
  return AnchorPayloadSchema.parse({
    sessionId: expectString(row.session_id, "pending_anchor_uploads.session_id"),
    nodeId: expectString(row.node_id, "pending_anchor_uploads.node_id"),
    startSequence: expectNumber(row.start_sequence, "pending_anchor_uploads.start_sequence"),
    endSequence: expectNumber(row.end_sequence, "pending_anchor_uploads.end_sequence"),
    merkleRoot: Buffer.from(
      toBytes(row.merkle_root, "pending_anchor_uploads.merkle_root"),
    ).toString("base64"),
    rootSignature: Buffer.from(
      toBytes(row.root_signature, "pending_anchor_uploads.root_signature"),
    ).toString("base64"),
    anchoredAt: expectString(row.anchored_at, "pending_anchor_uploads.anchored_at"),
  });
}

// The four identity columns, read defensively for failure bookkeeping on a row
// whose payload hydration threw. `undefined` when they cannot be bound at all —
// the one case the drain cannot record (see `uploadPendingAnchors`).
function readAnchorIdentity(row: PendingAnchorRow):
  | {
      readonly sessionId: string;
      readonly nodeId: string;
      readonly startSequence: number;
      readonly endSequence: number;
    }
  | undefined {
  const { session_id: sessionId, node_id: nodeId } = row;
  const { start_sequence: startSequence, end_sequence: endSequence } = row;
  if (typeof sessionId !== "string" || typeof nodeId !== "string") return undefined;
  if (typeof startSequence !== "number" || typeof endSequence !== "number") return undefined;
  return { sessionId, nodeId, startSequence, endSequence };
}

// Whether a queued row is due for another upload attempt.
//
// FAILS OPEN, deliberately: a row with no recorded attempt, or with an
// unparseable `last_attempt_at`, is treated as due. The cost of an early retry
// is one request; the cost of a wrongly-suppressed one is an integrity witness
// that never reaches the control plane, and nothing downstream would report it.
function isUploadRetryDue(row: PendingUploadRow, now: Date): boolean {
  const attemptCount = typeof row.attempt_count === "number" ? row.attempt_count : 0;
  if (attemptCount <= 0) return true;
  const lastAttemptAt = parseStoredInstant(row.last_attempt_at);
  if (lastAttemptAt === undefined) return true;
  const waitedSeconds = (now.getTime() - lastAttemptAt.getTime()) / 1000;
  return waitedSeconds >= uploadRetryDelaySeconds(attemptCount);
}

// A stored ISO-8601 TEXT column as a `Date`, or `undefined` when the column is
// absent or does not parse. `new Date(…)` yields an Invalid Date rather than
// throwing, and an Invalid Date propagates as `NaN` through every comparison —
// silently, and as `false`, which is the wrong default for both callers.
function parseStoredInstant(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`${column} is not TEXT (got ${typeof value}); the stored row is corrupt.`);
  }
  return value;
}

function expectNumber(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `${column} is not an INTEGER (got ${typeof value}); the stored row is corrupt.`,
    );
  }
  return value;
}

// SQLite BLOB columns hydrate as `Buffer` under better-sqlite3. The check is a
// real one rather than a cast: BLOB affinity does NOT coerce a stored TEXT
// value, so a row written with a base64 STRING in a BLOB column reads back as
// text and would silently produce a wrong root or a failed verification.
function toBytes(value: unknown, column: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(
    `${column} is not a BLOB (got ${typeof value}); the stored row is corrupt or was written ` +
      "with a text value under a BLOB-declared column.",
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
