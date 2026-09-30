/**
 * THE READ PROJECTION FOR MACHINE-AUTHORED PROSE — pairs a stored event with
 * the body its `session_events.content_payload` column holds, WITHOUT ever
 * altering the event.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROHIBITION THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 *
 * The body is NEVER merged into `payload`, not "just for the projection". Two
 * things break if it is:
 *
 *   1. The body is EXCLUDED from the canonical bytes by construction, precisely
 *      so a 256 KiB tool result cannot push a row past
 *      `EVENT_CANONICAL_BYTES_MAX`. Splicing it back in re-imports the ceiling
 *      problem the partition was built to avoid.
 *   2. A caller handed a payload-with-body cannot tell which members the daemon
 *      stored and which a read path added.
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
 * `content_payload` is node-local: it never crosses a machine boundary, so a
 * row carried in from a peer holds no body here and reads as `absent`.
 */

import type {
  EventEnvelope,
  HydratedContentUnavailableReason,
  HydratedSessionEvent,
  HydratedSessionEventContent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY } from "@ai-sidekicks/contracts";

import { openContentPayload } from "./pii-indirection.js";
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
  /** The event as already projected from the `payload` column. */
  readonly envelope: EventEnvelope;
  /** `session_events.content_payload`, verbatim. */
  readonly contentPayload: unknown;
  /** `session_events.retention_class`, verbatim. Non-NULL means purged. */
  readonly retentionClass: unknown;
}

/** Constructor dependencies for {@link SessionContentReader}. */
export interface SessionContentReaderDeps {
  readonly keyReader: SessionContentKeyReader;
}

function readPayloadMember(envelope: EventEnvelope, key: string): unknown {
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
 *
 * ONCE PER SESSION COVERS FAILED RESOLUTIONS TOO. A read that rejects is
 * retained for the rest of the batch and every remaining row of that session
 * settles on its classified reason, rather than each row re-attempting the unseal
 * — see the note at the retention in `#classify`.
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
   * 1. PURGED FIRST. A purged row has a NULL column, so it is
   *    indistinguishable at step 2 from a row that never had a body — and
   *    `absent` would then report a deleted body as one that never existed.
   *    The purge is a fact this daemon recorded; it gets named, even for a
   *    purged row whose column somehow still holds bytes.
   * 2. ABSENT. A NULL column: the ordinary body-less row.
   * 3. A column value that is not bytes cannot be opened, and is reported as
   *    `decrypt_failed` rather than trusted or skipped.
   * 4. OPEN IT. Key first (its failures are about this daemon), then the AEAD
   *    (its failure is about these bytes).
   */
  async #classify(
    row: StoredEventContentRow,
    keys: Map<SessionId, Promise<ResolvedSessionContentKey>>,
  ): Promise<HydratedSessionEventContent> {
    if (row.retentionClass != null) {
      return unavailable("purged");
    }
    if (row.contentPayload == null) {
      return unavailable("absent");
    }
    if (!(row.contentPayload instanceof Uint8Array)) {
      return unavailable("decrypt_failed");
    }
    const sealed: Uint8Array = row.contentPayload;

    const sessionId: SessionId = row.envelope.sessionId;
    let resolved: ResolvedSessionContentKey;
    try {
      let pending: Promise<ResolvedSessionContentKey> | undefined = keys.get(sessionId);
      if (pending === undefined) {
        pending = this.#keyReader.read(sessionId);
        // Memoized BEFORE the await so two rows of one session never race two
        // reads.
        keys.set(sessionId, pending);
      }
      resolved = await pending;
    } catch (error) {
      // THE REJECTION IS RETAINED FOR THE LIFETIME OF THIS MAP — deliberately,
      // and reversing what an earlier draft did here. That draft deleted the
      // entry so "a transient failure is not cached for the life of the batch",
      // which sounds prudent and is the wrong trade at this seam: it made a
      // failed read RETRY on every subsequent row of the same session. A batch
      // of 200 rows from one session whose key cannot be unsealed then performed
      // 200 unwrap attempts — or, when the master key sits behind a hardware
      // ceremony, prompted the operator 200 times — while `hydrateAll` documents
      // "resolving each distinct session's key at most once". Retention is what
      // makes that sentence true rather than aspirational.
      //
      // Retrying is not lost, it is RE-SCOPED to the caller: `hydrate` builds a
      // fresh map per row and `hydrateAll` a fresh map per call, so the next
      // invocation re-reads. The batch is the correct retention unit — inside
      // one batch nothing about the daemon's key state can have changed that a
      // second attempt would discover, and every row lands on the same
      // classified reason instead of a mix that depends on read ordering.
      //
      // NO UNHANDLED REJECTION IS POSSIBLE, by construction rather than by
      // reasoning about timing: the only writer of this map is the block above,
      // which attaches this very `catch` to the promise in the same synchronous
      // run as it creates and stores it. A retained rejected promise has
      // therefore already been handled once before any later row can observe it,
      // and each later row awaits it inside its own copy of this `try`.
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

    // Echoed from the stored payload, never recomputed from `body`: a
    // recomputed `contentLength` would silently equal the truncated length and
    // erase the evidence that anything was cut.
    const storedLength: unknown = readPayloadMember(row.envelope, CONTENT_LENGTH_PAYLOAD_KEY);
    const storedTruncated: unknown = readPayloadMember(row.envelope, CONTENT_TRUNCATED_PAYLOAD_KEY);
    return {
      status: "available",
      body,
      ...(typeof storedLength === "number" ? { contentLength: storedLength } : {}),
      ...(storedTruncated === true ? { contentTruncated: true as const } : {}),
    };
  }
}
