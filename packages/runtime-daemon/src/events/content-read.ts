/**
 * THE READ PROJECTION FOR MACHINE-AUTHORED PROSE — pairs a verified event with
 * the body its `session_events.content_payload` column holds, WITHOUT ever
 * altering the event (Plan-006 T3.8, invariant I-006-3-08).
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROHIBITION THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 *
 * The body is NEVER merged into `payload`. It is not spliced in before
 * verification, not after it, and not "just for the projection". Three separate
 * things break if it is:
 *
 *   1. `payload` is the canonicalized, hash-chained, Ed25519-signed record. A
 *      member added on read changes the canonical bytes, so every hash and every
 *      signature over that row stops verifying — the projection would break the
 *      integrity protocol in the act of displaying it.
 *   2. The body is EXCLUDED from the canonical bytes by construction, precisely
 *      so a 256 KiB tool result cannot push a row past
 *      `EVENT_CANONICAL_BYTES_MAX`. Splicing it back in re-imports the ceiling
 *      problem the partition was built to avoid.
 *   3. A caller handed a payload-with-body cannot tell which members the daemon
 *      signed and which a read path added. That distinction is the whole basis
 *      on which anything downstream may trust a member.
 *
 * So the projection is a PAIR — {@link HydratedSessionEvent} carries the event
 * unmodified beside a separate content arm — and this module returns a fresh
 * object rather than mutating its input.
 *
 * ---------------------------------------------------------------------------
 * NEVER A FABRICATED EMPTY BODY
 * ---------------------------------------------------------------------------
 *
 * Every path that cannot produce the body says so, by name, on the
 * `unavailable` arm. None of them returns `{ status: "available", body: "" }`.
 * An empty body reads as "the assistant said nothing", which is a claim about
 * the transcript; "the key could not be read" is a claim about this daemon. The
 * canonical-transcript fold consumes exactly this distinction (a body it cannot
 * read is declared lost rather than rendered as silence), so collapsing the two
 * here would put a false transcript downstream of a working one.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE — WHAT IS WIRED AND WHAT IS STILL OWED
 * ---------------------------------------------------------------------------
 *
 * `content_payload` is node-local: it is excluded from the canonical bytes and
 * so never crosses a machine boundary, while the signed
 * `contentCiphertextDigest` inside those bytes does. A row received from a peer
 * therefore holds the claim with no ciphertext under it — the exact shape that
 * on a row THIS daemon authored means the column was emptied after signing.
 *
 * THE DISPATCH IS WIRED. The binding step below runs
 * `isContentCiphertextDigestBoundUnderProvenance`, which compares on origin rows
 * (`received_from_node_id IS NULL`) and requires the column ABSENT on received
 * ones; {@link StoredEventContentRow.receivedFromNodeId} is where the caller
 * supplies the marker. It is a REQUIRED member rather than an optional one on
 * purpose: a caller that has not decided provenance must say so explicitly by
 * passing `null`, not by leaving a field off and inheriting an arm.
 *
 * NO COLUMN BACKS IT YET, and that is stated rather than implied.
 * `received_from_node_id` is registered in the corpus and created by no
 * migration in this package, so every caller today passes `null` and every row
 * this module can be handed is origin-authored. The dispatch ships ahead of the
 * column because the alternative — wiring peer history and THEN adding the
 * dispatch — is the ordering in which received rows are reported as tampered
 * first and corrected afterwards.
 *
 * ONE THING IS STILL OWED. A received row whose column is absent passes the
 * binding check and then lands on `absent`, which is true (there is no body
 * here) but does not say WHY there is none. The swap that wires peer history and
 * distributes session content keys owes that row a reason of its own; minting
 * one now would add a member to a closed wire union ahead of any producer that
 * could emit it. Softening the digest arm instead would trade a tamper report
 * for silence on every row, which is the one direction that cannot be undone by
 * a later fix.
 */

import type {
  EventEnvelope,
  HydratedContentUnavailableReason,
  HydratedSessionEvent,
  HydratedSessionEventContent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY } from "@ai-sidekicks/contracts";

import {
  isContentCiphertextDigestBoundUnderProvenance,
  openContentPayload,
} from "./pii-indirection.js";
import {
  SessionContentKeyUnavailableError,
  type ResolvedSessionContentKey,
  type SessionContentKeyReader,
} from "./session-content-key-store.js";

/**
 * One stored row, as the caller read it.
 *
 * `contentPayload` and `retentionClass` are typed `unknown` ON PURPOSE: they
 * arrive straight from SQLite, where the column types are BLOB-or-NULL and
 * TEXT-or-NULL and a caller's cast is exactly the assumption this module must
 * not inherit. A `contentPayload` that is neither `Uint8Array` nor NULL is
 * classified, not trusted and not skipped.
 */
export interface StoredEventContentRow {
  /** The event as already projected from the signed `payload` column. */
  readonly envelope: EventEnvelope;
  /** `session_events.content_payload`, verbatim. */
  readonly contentPayload: unknown;
  /** `session_events.retention_class`, verbatim. Non-NULL means compacted. */
  readonly retentionClass: unknown;
  /**
   * `session_events.received_from_node_id`, verbatim — NULL on a row this daemon
   * authored, the peer's node id on one carried in.
   *
   * REQUIRED, AND `unknown` LIKE ITS SIBLINGS. Required because it selects which
   * arm of the digest binding runs, and a caller that has not decided provenance
   * must say `null` rather than leave the field off and inherit an arm it never
   * chose. `unknown` because it arrives from SQLite like the two above it — and,
   * unlike them, from a column no migration in this package has created yet, so
   * every caller today passes `null` and means it.
   */
  readonly receivedFromNodeId: unknown;
}

/** Constructor dependencies for {@link SessionContentReader}. */
export interface SessionContentReaderDeps {
  readonly keyReader: SessionContentKeyReader;
}

function readSignedMember(envelope: EventEnvelope, key: string): unknown {
  const payload: unknown = envelope.payload;
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function unavailable(reason: HydratedContentUnavailableReason): HydratedSessionEventContent {
  return { status: "unavailable", reason };
}

/**
 * Maps a key-store failure onto the read projection's vocabulary.
 *
 * `wrapped_key_unopenable` lands on `decrypt_failed` rather than on a reason of
 * its own: from the reader's side a wrapped key whose envelope will not open and
 * a body whose AEAD tag fails are the same event — sealed material refused to
 * open — and the store's finer reason is a WRITE-path distinction. Reporting it
 * as `master_key_unavailable` would be worse still: it would name a cause the
 * store explicitly did not find.
 */
function keyFailureReason(
  error: SessionContentKeyUnavailableError,
): HydratedContentUnavailableReason {
  switch (error.reason) {
    case "master_key_unavailable":
      return "master_key_unavailable";
    case "wrapped_key_missing":
      return "wrapped_key_missing";
    case "wrapped_key_unopenable":
      return "decrypt_failed";
  }
}

/**
 * Hydrates stored rows into {@link HydratedSessionEvent}s.
 *
 * HOLDS NO KEY CACHE ACROSS CALLS. Keys are resolved once per distinct session
 * WITHIN one {@link SessionContentReader.hydrateAll} call and dropped when it
 * returns, which is the whole win — a 1,000-row range in one session unwraps
 * once instead of a thousand times — without a long-lived plaintext key map that
 * a session purge or a master-key rotation would then have to invalidate. A
 * cache whose invalidation is someone else's problem is how a rotated-away key
 * keeps opening bodies.
 */
export class SessionContentReader {
  readonly #keyReader: SessionContentKeyReader;

  constructor(deps: SessionContentReaderDeps) {
    this.#keyReader = deps.keyReader;
  }

  /** Hydrates one row. */
  async hydrate(row: StoredEventContentRow): Promise<HydratedSessionEvent> {
    return this.#hydrateWith(row, new Map<SessionId, Promise<ResolvedSessionContentKey>>());
  }

  /**
   * Hydrates a batch, resolving each distinct session's key at most once.
   *
   * SEQUENTIAL, not `Promise.all`: the key resolutions this shares are memoized
   * by the map, and the remaining work is synchronous AEAD over rows that are
   * already in memory. Fanning out would multiply peak plaintext-body residency
   * by the batch size for no throughput a single CPU-bound decrypt loop lacks.
   */
  async hydrateAll(
    rows: readonly StoredEventContentRow[],
  ): Promise<readonly HydratedSessionEvent[]> {
    const keys = new Map<SessionId, Promise<ResolvedSessionContentKey>>();
    const hydrated: HydratedSessionEvent[] = [];
    for (const row of rows) {
      hydrated.push(await this.#hydrateWith(row, keys));
    }
    return hydrated;
  }

  async #hydrateWith(
    row: StoredEventContentRow,
    keys: Map<SessionId, Promise<ResolvedSessionContentKey>>,
  ): Promise<HydratedSessionEvent> {
    return { event: row.envelope, content: await this.#classify(row, keys) };
  }

  /**
   * THE CLASSIFICATION ORDER, which is load-bearing top to bottom.
   *
   * 1. COMPACTED FIRST. A compacted row has a NULL column and a stub payload
   *    carrying no digest, so it is indistinguishable at steps 2 and 3 from a
   *    row that never had a body — and `absent` would then report a destroyed
   *    body as one that never existed. Compaction is a fact this daemon
   *    recorded; it gets named.
   *
   *    AND IT IS AUTHORITATIVE FOR THE ONE STATE WHERE IT AND STEP 2 DISAGREE:
   *    a compacted row whose column somehow still holds bytes. The stub payload
   *    carries no digest, so the binding check reads that row UNBOUND and would
   *    report tampering — sending an operator to hunt an attacker for what is a
   *    defect in the compactor. The disagreement is not a contradiction: step 2
   *    answers about BYTES and step 1 answers about an act this daemon
   *    RECORDED, and the recorded act is the better report.
   * 2. THE DIGEST BINDING, before any decrypt is attempted, and PROVENANCE-
   *    DISPATCHED. It is the only step that can distinguish TAMPERING from LOSS,
   *    and on an origin row it decides all four of its states — including the two
   *    a decrypt attempt would misreport: bytes with no signed digest (nothing
   *    vouches for them) would "open" fine under a key that opens anything
   *    sealed for this session, and a NULL column under a signed digest (cleared
   *    after signing) would report as `absent`. On a RECEIVED row the arm is the
   *    stricter one — the column must be absent, because a carried origin claim
   *    is exactly what a planted local ciphertext would be made to match. See
   *    the header for what that arm still owes.
   * 3. ABSENT. Reachable only with the digest check already green, which at a
   *    NULL column means the payload carries no digest either — the ordinary
   *    body-less row.
   * 4. OPEN IT. Key first (its failures are about this daemon), then the AEAD
   *    (its failure is about these bytes).
   */
  async #classify(
    row: StoredEventContentRow,
    keys: Map<SessionId, Promise<ResolvedSessionContentKey>>,
  ): Promise<HydratedSessionEventContent> {
    if (row.retentionClass != null) {
      return unavailable("compacted");
    }
    if (
      !isContentCiphertextDigestBoundUnderProvenance(
        row.contentPayload,
        row.envelope.payload,
        row.receivedFromNodeId,
      )
    ) {
      return unavailable("digest_unbound");
    }
    // Bound with a null column means no digest was signed either — see step 3.
    if (row.contentPayload == null) {
      return unavailable("absent");
    }
    // The digest check already refused every non-`Uint8Array` non-NULL shape.
    const sealed: Uint8Array = row.contentPayload as Uint8Array;

    const sessionId: SessionId = row.envelope.sessionId;
    let resolved: ResolvedSessionContentKey;
    try {
      let pending: Promise<ResolvedSessionContentKey> | undefined = keys.get(sessionId);
      if (pending === undefined) {
        pending = this.#keyReader.read(sessionId);
        // Memoized BEFORE the await so two rows of one session never race two
        // reads; a rejected promise is dropped below so a transient failure is
        // not cached for the life of the batch.
        keys.set(sessionId, pending);
      }
      resolved = await pending;
    } catch (error) {
      keys.delete(sessionId);
      return unavailable(
        error instanceof SessionContentKeyUnavailableError
          ? keyFailureReason(error)
          : "master_key_unavailable",
      );
    }

    let body: string;
    try {
      body = openContentPayload(sealed, resolved.key, sessionId, row.envelope.id);
    } catch {
      // Deliberately swallowed rather than re-raised or logged with its message:
      // the throw's text can name byte offsets and lengths of material that
      // failed to authenticate, and the caller's contract is the closed reason.
      return unavailable("decrypt_failed");
    }

    // Echoed from the SIGNED payload, never recomputed from `body`: a recomputed
    // `contentLength` would silently equal the truncated length and erase the
    // evidence that anything was cut.
    const signedLength: unknown = readSignedMember(row.envelope, CONTENT_LENGTH_PAYLOAD_KEY);
    const signedTruncated: unknown = readSignedMember(row.envelope, CONTENT_TRUNCATED_PAYLOAD_KEY);
    return {
      status: "available",
      body,
      ...(typeof signedLength === "number" ? { contentLength: signedLength } : {}),
      ...(signedTruncated === true ? { contentTruncated: true as const } : {}),
    };
  }
}
