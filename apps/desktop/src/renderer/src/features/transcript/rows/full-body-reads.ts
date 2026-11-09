// One session's reads of the large bodies a person opened. A body too large to travel with its row
// is first read when its control is pressed, never because its row was drawn, and lands on the
// row's own event in the store, so the row draws it as it draws any stored body and lets it go
// with the row. An opened body stays opened: when its row is drawn again carrying its size alone,
// as it is once the store let it go and read it back, the body is read again through the same
// client. A copy reads a body in full through the same client without opening it or keeping it.
// A body longer than one page comes in parts, each asked for at the offset the last one names, and
// is joined in order before it lands or is copied; a part that fails fails the whole read.
// Every read ends with the session's pane: one still out is abandoned, never parsed. A refused
// read is recorded in the window's diagnostics. A context, as the row toggles are, so a body's
// control reaches the reads without a prop through every card.

import { createContext, type Context } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TranscriptBodyReadResponse } from "@ai-sidekicks/contracts/transcript/operations";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import type { DaemonReply, DaemonReplyRefusalCode } from "#renderer/services/daemon/reply.js";
import type { TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { FullOutputReading } from "./bodies/FullOutputControl.js";

/** Reads and opens one session's large bodies, and tells a body's control where its read stands. */
export class FullBodyReads {
  readonly #sessionStore: SessionStore;
  readonly #readBody: TranscriptBodyRead;
  /** The rows a person opened, by id, for the session's life. */
  readonly #openedRowIds = new Set<string>();
  /** The rows whose read is out. */
  readonly #readingRowIds = new Set<string>();
  /** The opened rows whose last read was refused, offered again. */
  readonly #refusedRowIds = new Set<string>();
  readonly #listeners = new Set<() => void>();
  /** Aborted once the session's pane goes, which abandons every read still out. */
  readonly #lifetime = new AbortController();

  /** Hear a read go out or settle. Returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Where a large body's read stands: offered until it is opened, then read until it is drawn, and
   * refused when its last read was.
   */
  public readonly readingOf = (rowId: string): FullOutputReading =>
    this.#refusedRowIds.has(rowId) ? "refused" : this.#openedRowIds.has(rowId) ? "reading" : "rest";

  /** Open one row's large body: read it, or read it again after a refusal. */
  public readonly open = (rowId: string): void => {
    this.#openedRowIds.add(rowId);
    this.#refusedRowIds.delete(rowId);
    this.#read(rowId);
    this.#notify();
  };

  /**
   * Read an opened body again, called as its row is drawn with its size alone; a body never opened,
   * or one whose read is out or was refused, is left as it stands.
   */
  public readonly readOpenedBody = (rowId: string): void => {
    if (this.#openedRowIds.has(rowId) && !this.#refusedRowIds.has(rowId)) {
      this.#read(rowId);
    }
  };

  /**
   * Read one row's large body in full, every part joined in order, for a copy, which neither opens
   * it nor keeps it: the row still draws its control. Resolves the refusal in place of a body that
   * could not be read, a part's refusal when any part could not, a `reply-unreadable` refusal for
   * parts that do not follow one another within the body's stated length, and a `read-abandoned`
   * refusal once the pane went.
   */
  public readonly readFullBody = async (
    rowId: string,
  ): Promise<DaemonReply<TranscriptBodyReadResponse>> => {
    const sessionId = heldIdAsWireId<SessionId>(this.#sessionStore.sessionId);
    const options = { signal: this.#lifetime.signal };
    const firstReply = await this.#readBody({ sessionId, rowId }, options);
    if (firstReply.status === "refused" || firstReply.value.status === "unavailable") {
      return firstReply;
    }
    const first = firstReply.value;
    if (first.offset !== 0) {
      return PARTS_OUT_OF_ORDER;
    }
    const end = first.contentLength ?? Number.POSITIVE_INFINITY;
    const parts = [first];
    let part = first;
    while (part.nextOffset !== null) {
      const offset = part.nextOffset;
      // Each part starts past the last and short of the stated end, so the read ends.
      if (offset <= part.offset || offset >= end) {
        return PARTS_OUT_OF_ORDER;
      }
      const reply = await this.#readBody({ sessionId, rowId, offset }, options);
      if (reply.status === "refused" || reply.value.status === "unavailable") {
        return reply;
      }
      if (reply.value.offset !== offset) {
        return PARTS_OUT_OF_ORDER;
      }
      part = reply.value;
      parts.push(part);
    }
    return { status: "served", value: joinedBodyOf(first, parts) };
  };

  public constructor(sessionStore: SessionStore, readBody: TranscriptBodyRead) {
    this.#sessionStore = sessionStore;
    this.#readBody = readBody;
  }

  /** Whether the pane went, ending these reads. */
  public get isDisposed(): boolean {
    return this.#lifetime.signal.aborted;
  }

  /** Abandons every read still out, as the session's pane goes; terminal. */
  public dispose(): void {
    this.#lifetime.abort();
    this.#listeners.clear();
  }

  #read(rowId: string): void {
    if (this.#readingRowIds.has(rowId)) {
      return;
    }
    this.#readingRowIds.add(rowId);
    void this.readFullBody(rowId).then((reply) => {
      if (this.isDisposed) {
        return;
      }
      this.#readingRowIds.delete(rowId);
      if (reply.status === "served") {
        this.#sessionStore.admitFullBody(rowId, reply.value);
      } else {
        recordRejectedRequest(
          FULL_BODY_READS_SOURCE,
          "full-body-read-refused",
          new RefusalError(reply.refusal),
        );
        this.#refusedRowIds.add(rowId);
      }
      this.#notify();
    });
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** The session's body reads, or `undefined` in a composition that reads no bodies. */
export const FullBodyReadsContext: Context<FullBodyReads | undefined> = createContext<
  FullBodyReads | undefined
>(undefined);

/** Where a refused read is recorded from in the window's diagnostics. */
const FULL_BODY_READS_SOURCE = "features/transcript/full-body-reads";

/** One part of a body read, as the daemon serves it. */
type BodyPart = Extract<TranscriptBodyReadResponse, { status: "available" }>;

/**
 * The whole body from its parts in order: their text and block starts, which already count from
 * the body's start, end to end, with the first part's length and cut failure, which every part
 * repeats.
 */
function joinedBodyOf(first: BodyPart, parts: readonly BodyPart[]): BodyPart {
  const startParts = parts.flatMap((part) =>
    part.blockStarts === undefined ? [] : [part.blockStarts],
  );
  const blockStarts = new Uint8Array(
    startParts.reduce((total, starts) => total + starts.length, 0),
  );
  let written = 0;
  for (const starts of startParts) {
    blockStarts.set(starts, written);
    written += starts.length;
  }
  return {
    status: "available",
    body: parts.map((part) => part.body).join(""),
    offset: 0,
    nextOffset: null,
    ...(first.contentLength === undefined ? {} : { contentLength: first.contentLength }),
    ...(blockStarts.length === 0 ? {} : { blockStarts }),
    ...(first.blockCutFailure === undefined ? {} : { blockCutFailure: first.blockCutFailure }),
  };
}

/** The read of a body whose parts do not follow one another, which no reading can join. */
const PARTS_OUT_OF_ORDER: DaemonReply<never> = {
  status: "refused",
  refusal: refuse(
    FULL_BODY_READS_SOURCE,
    "reply-unreadable" satisfies DaemonReplyRefusalCode,
    "The background service sent this body's parts out of order.",
  ),
};
