/**
 * The read projection for machine-authored prose: pairs a stored event with the body its
 * `session_events.content_payload` column holds, without altering the event.
 *
 * - The body is never merged into `payload`. It is excluded from the canonical bytes so a
 *   large tool result cannot push a row past `EVENT_CANONICAL_BYTES_MAX`, and a caller must
 *   be able to tell what the daemon stored from what a read added. The projection is a pair
 *   ({@link HydratedSessionEvent}), and this module returns a fresh object.
 * - A body that cannot be produced is reported on the `unavailable` arm by name, never as
 *   `{ status: "available", body: "" }`: an empty body claims the assistant said nothing,
 *   while "the key could not be read" is a claim about this daemon. The transcript fold
 *   relies on that distinction.
 * - `content_payload` is node-local, so a row carried in from a peer reads as `absent`.
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
 * One stored row, as the caller read it. `contentPayload` and `retentionClass` are `unknown`
 * because they arrive straight from SQLite (BLOB-or-NULL, TEXT-or-NULL) and a cast would be
 * an assumption; a `contentPayload` that is neither bytes nor NULL is classified, not trusted.
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
 * Maps a key-store failure onto the read projection's reasons. `wrapped_key_unopenable`
 * becomes `decrypt_failed`: from the reader's side, a wrapped key that will not open and a
 * body whose AEAD tag fails are the same event, and `master_key_unavailable` would name a
 * cause the store did not find.
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
 * Holds no key cache across calls: keys are resolved once per distinct session within one
 * {@link SessionContentReader.hydrateAll} call and dropped on return, so a purge or master-key
 * rotation never has a long-lived plaintext key map to invalidate. A key read that rejects is
 * retained for the rest of the batch, so every remaining row of that session settles on the
 * same classified reason instead of retrying the unseal.
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
   * Hydrates a batch, resolving each distinct session's key at most once. Rows are processed
   * sequentially: fanning out would multiply peak plaintext-body residency by the batch size
   * for no gain over a CPU-bound decrypt loop.
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
   * Classifies one row; the order matters.
   *
   * 1. Purged first: a purged row has a NULL column, so `absent` would report a deleted body as
   *    one that never existed.
   * 2. Absent: a NULL column is the ordinary body-less row.
   * 3. A column value that is not bytes cannot be opened and is `decrypt_failed`.
   * 4. Open it: key failures are about this daemon, an AEAD failure is about these bytes.
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
        // Memoized before the await so two rows of one session never race two reads.
        keys.set(sessionId, pending);
      }
      resolved = await pending;
    } catch (error) {
      // The rejection stays in the map for the rest of the batch, so a failed read is not
      // retried per row (200 rows would mean 200 unwrap attempts, or 200 prompts when the
      // master key sits behind a hardware ceremony). The retry unit is the caller: `hydrate`
      // and each `hydrateAll` call start with a fresh map. No rejection goes unhandled: this
      // `catch` is attached in the same synchronous run that stores the promise.
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
      // The reason is the closed contract; the throw's text can name byte offsets and lengths of
      // material that failed to authenticate, so it is not surfaced.
      return unavailable("decrypt_failed");
    }

    // Echoed from the stored payload, not recomputed from `body`: a recomputed length would
    // equal the truncated length and hide that anything was cut.
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
