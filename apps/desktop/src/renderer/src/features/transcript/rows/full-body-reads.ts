// One session's reads of the large bodies a person opened. A body too large to travel with its row
// is first read when its control is pressed, never because its row was drawn, and lands on the
// row's own event in the store, so the row draws it as it draws any stored body and lets it go
// with the row. An opened body stays opened: when its row is drawn again carrying its size alone,
// as it is once the store let it go and read it back, the body is read again through the same
// client. A copy reads a body in full through the same client without opening it or keeping it. A
// context, as the row toggles are, so a body's control reaches the reads without a prop through
// every card.

import { createContext, type Context } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TranscriptBodyReadResponse } from "@ai-sidekicks/contracts/transcript/content";

import { type DaemonReply } from "#renderer/services/daemon/reply.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type FullOutputReading } from "./bodies/FullOutputControl.js";

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
   * Read one row's large body in full for a copy, which neither opens it nor keeps it: the row
   * still draws its control. Resolves the refusal in place of a body that could not be read.
   */
  public readonly readFullBody = (
    rowId: string,
  ): Promise<DaemonReply<TranscriptBodyReadResponse>> =>
    this.#readBody({ sessionId: heldIdAsWireId<SessionId>(this.#sessionStore.sessionId), rowId });

  public constructor(sessionStore: SessionStore, readBody: TranscriptBodyRead) {
    this.#sessionStore = sessionStore;
    this.#readBody = readBody;
  }

  #read(rowId: string): void {
    if (this.#readingRowIds.has(rowId)) {
      return;
    }
    this.#readingRowIds.add(rowId);
    void this.readFullBody(rowId).then((reply) => {
      this.#readingRowIds.delete(rowId);
      if (reply.status === "served") {
        this.#sessionStore.admitFullBody(rowId, reply.value);
      } else {
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
