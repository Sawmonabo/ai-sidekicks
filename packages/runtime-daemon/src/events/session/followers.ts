// Who receives a session's committed events, and in what order. A session's events go out in
// sequence order with no gap: a receipt that arrives ahead of an earlier one still unpublished is
// preceded by the missing events read back from the log, and a receipt at or below what was
// already published is dropped.
//
// - A new follower catches up from the log before it goes live, one bounded page at a time, and
//   reads its next page only on a later turn of the event loop and once its receiver has room, so
//   a receiver that reads nothing never makes the daemon read the whole log for it. An event
//   committed while it catches up is in the log before its receipt is published, so the follower
//   passes the receipt by and reads the event on its next page, holding nothing in memory; it goes
//   live in the same turn as the page that reports nothing more.
// - Followers never cost each other an event. A session follower that throws, or whose catch-up
//   page or missing events cannot be read, ends alone and hears why through `onFailure`. A follower
//   of every session that throws stays attached, and the failure goes to the service log; when a
//   session's missing events cannot be read, it hears of the gap through its `onGap`, so it can
//   rebuild what it holds for that session from the session's rows.
// - A session is tracked while it has followers or an append whose receipt is not yet published.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionStreamChange } from "@ai-sidekicks/contracts/session/methods";
import { encodeEventCursor, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { SessionEventReads } from "./read.js";

// One change a session follower receives: the committed event and the cursor that resumes after it.
type SessionEventChange = SessionStreamChange<EventEnvelope>;

/**
 * The receiving side of one session's follow. `isFull` and `onceDrained` pace its catch-up by the
 * receiver's room. Only `onChange` may throw: its throw ends the follow, through `onFailure` after
 * the first page.
 */
export interface SessionEventListener {
  /** One committed event and its cursor, in sequence order with none skipped or repeated. */
  onChange(change: SessionStreamChange<EventEnvelope>): void;
  /**
   * The follow ended on `error`: a catch-up page or the events before a receipt could not be read,
   * or `onChange` threw. Nothing more arrives.
   */
  onFailure(error: unknown): void;
  /** Whether the receiver has no room now; the catch-up reads its next page only once it has. */
  isFull(): boolean;
  /** Calls `listener` once the receiver has room again. Returns a detach. */
  onceDrained(listener: () => void): () => void;
}

interface SessionFollower {
  readonly listener: SessionEventListener;
  /** The sequence of the last event delivered, or the position the follower started after. */
  lastDelivered: number;
  /** Whether it still reads the log; published receipts pass it by until it goes live. */
  isCatchingUp: boolean;
  isDetached: boolean;
  /** Cancels the wait for the next catch-up page: the turn's yield or the receiver's drain. */
  cancelNextPage: (() => void) | undefined;
}

interface AllSessionsFollower {
  readonly onCommitted: (event: EventEnvelope) => void;
  readonly onGap: ((sessionId: SessionId) => void) | undefined;
}

interface SessionPublication {
  readonly key: SessionId;
  /** The highest sequence published for the session. */
  lastPublished: number;
  readonly followers: Set<SessionFollower>;
  /** Appends tracked whose receipt is not yet published and whose write has not failed. */
  appendsInFlight: number;
}

/** Publishes committed events to the followers of one session and to the followers of all. */
export class SessionEventFollowers {
  readonly #reads: SessionEventReads;
  readonly #pageSize: number;
  readonly #writeServiceLog: ServiceLogWriter;
  // Keyed by the canonical session id.
  readonly #sessions = new Map<SessionId, SessionPublication>();
  readonly #allSessionsFollowers = new Set<AllSessionsFollower>();

  /**
   * `pageSize` bounds each catch-up read; `writeServiceLog` takes the failures no follower hears.
   */
  constructor(reads: SessionEventReads, pageSize: number, writeServiceLog: ServiceLogWriter) {
    this.#reads = reads;
    this.#pageSize = pageSize;
    this.#writeServiceLog = writeServiceLog;
  }

  /**
   * Starts tracking `sessionId` before an append is queued, when anyone follows, so the first
   * receipt is ordered against the head the log had before it. Returns the settle, which the
   * append runs once its receipt is published or its write has failed.
   */
  trackAppend(sessionId: SessionId): () => void {
    if (this.#allSessionsFollowers.size === 0 && !this.#sessions.has(canonicalizeUuid(sessionId))) {
      return settleUntracked;
    }
    const publication = this.#publicationOf(sessionId);
    publication.appendsInFlight += 1;
    return () => {
      publication.appendsInFlight -= 1;
      this.#releaseIfIdle(publication);
    };
  }

  /** Publishes one committed event, filling any gap before it from the log first. */
  publish(event: EventEnvelope): void {
    const publication = this.#sessions.get(canonicalizeUuid(event.sessionId));
    if (publication === undefined || event.sequence <= publication.lastPublished) {
      return;
    }
    if (event.sequence > publication.lastPublished + 1) {
      this.#publishMissing(publication, event);
    }
    this.#publishInOrder(publication, event);
  }

  /**
   * Delivers the session's events after `afterPosition`, which the caller has checked against the
   * log, then follows new ones. The first page is delivered before this returns, and a read error
   * or an `onChange` throw on it is thrown here; a later one reaches `onFailure`. Returns the
   * detach, which stops delivery at once, from inside `onChange` too.
   */
  follow(sessionId: SessionId, afterPosition: number, listener: SessionEventListener): () => void {
    const publication = this.#publicationOf(sessionId);
    const follower: SessionFollower = {
      listener,
      lastDelivered: afterPosition,
      isCatchingUp: true,
      isDetached: false,
      cancelNextPage: undefined,
    };
    publication.followers.add(follower);
    try {
      this.#catchUp(sessionId, publication, follower);
    } catch (error) {
      this.#detach(publication, follower);
      throw error;
    }
    return () => {
      this.#detach(publication, follower);
    };
  }

  /**
   * Delivers every session's committed events from now on, each session in sequence order, and
   * calls `onGap` with a session whose events before a receipt could not be read, before that
   * receipt; a follower that keeps state built from events rebuilds that session's from its rows.
   */
  followAll(
    onCommitted: (event: EventEnvelope) => void,
    onGap?: (sessionId: SessionId) => void,
  ): () => void {
    // A fresh object, so one function attached twice detaches once per attach.
    const follower: AllSessionsFollower = { onCommitted, onGap };
    this.#allSessionsFollowers.add(follower);
    return () => {
      this.#allSessionsFollowers.delete(follower);
    };
  }

  // A new entry starts at the log's head: every event at or below it is already in the log, where
  // a catching-up follower reads it.
  #publicationOf(sessionId: SessionId): SessionPublication {
    const key = canonicalizeUuid(sessionId);
    let publication = this.#sessions.get(key);
    if (publication === undefined) {
      publication = {
        key,
        lastPublished: this.#reads.readHead(sessionId) ?? -1,
        followers: new Set(),
        appendsInFlight: 0,
      };
      this.#sessions.set(key, publication);
    }
    return publication;
  }

  #releaseIfIdle(publication: SessionPublication): void {
    if (
      publication.followers.size === 0 &&
      publication.appendsInFlight === 0 &&
      this.#sessions.get(publication.key) === publication
    ) {
      this.#sessions.delete(publication.key);
    }
  }

  #detach(publication: SessionPublication, follower: SessionFollower): void {
    if (follower.isDetached) {
      return;
    }
    follower.isDetached = true;
    follower.cancelNextPage?.();
    follower.cancelNextPage = undefined;
    publication.followers.delete(follower);
    this.#releaseIfIdle(publication);
  }

  #fail(publication: SessionPublication, follower: SessionFollower, error: unknown): void {
    if (follower.isDetached) {
      return;
    }
    this.#detach(publication, follower);
    follower.listener.onFailure(error);
  }

  // A live follower would miss the events the log cannot give back, so it ends; one catching up
  // reads them on its own page, and a follower of every session is told of the gap.
  #publishMissing(publication: SessionPublication, event: EventEnvelope): void {
    let missing: EventEnvelope[];
    try {
      missing = this.#reads.readWindow(
        event.sessionId,
        publication.lastPublished + 1,
        event.sequence - 1,
      );
    } catch (error) {
      for (const follower of publication.followers) {
        if (!follower.isCatchingUp) {
          this.#fail(publication, follower, error);
        }
      }
      this.#report(
        `reading session ${event.sessionId}'s events before sequence ${String(event.sequence)}`,
        error,
      );
      for (const allSessionsFollower of this.#allSessionsFollowers) {
        try {
          allSessionsFollower.onGap?.(event.sessionId);
        } catch (gapError) {
          this.#report(
            `a follower of every session repairing session ${event.sessionId}`,
            gapError,
          );
        }
      }
      return;
    }
    for (const missingEvent of missing) {
      this.#publishInOrder(publication, missingEvent);
    }
  }

  #publishInOrder(publication: SessionPublication, event: EventEnvelope): void {
    publication.lastPublished = event.sequence;
    const change = changeOf(event);
    for (const follower of publication.followers) {
      if (follower.isCatchingUp) {
        continue;
      }
      try {
        deliver(follower, change);
      } catch (error) {
        this.#fail(publication, follower, error);
      }
    }
    for (const allSessionsFollower of this.#allSessionsFollowers) {
      try {
        allSessionsFollower.onCommitted(event);
      } catch (error) {
        this.#report(
          `a follower of every session, on sequence ${String(event.sequence)} of session ` +
            event.sessionId,
          error,
        );
      }
    }
  }

  #report(what: string, error: unknown): void {
    this.#writeServiceLog(
      `event log: ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Reads one page and delivers it, then waits for the next page or goes live.
  #catchUp(sessionId: SessionId, publication: SessionPublication, follower: SessionFollower): void {
    // One row past the page shows whether more remain.
    const page = this.#reads.readAfter(sessionId, follower.lastDelivered, this.#pageSize + 1);
    const hasMore = page.length > this.#pageSize;
    for (const event of hasMore ? page.slice(0, this.#pageSize) : page) {
      deliver(follower, changeOf(event));
    }
    if (follower.isDetached) {
      return;
    }
    if (!hasMore) {
      follower.isCatchingUp = false;
      return;
    }
    const readNextPage = (): void => {
      follower.cancelNextPage = undefined;
      try {
        this.#catchUp(sessionId, publication, follower);
      } catch (error) {
        this.#fail(publication, follower, error);
      }
    };
    if (follower.listener.isFull()) {
      follower.cancelNextPage = follower.listener.onceDrained(readNextPage);
    } else {
      const nextTurn = setImmediate(readNextPage);
      follower.cancelNextPage = () => {
        clearImmediate(nextTurn);
      };
    }
  }
}

function settleUntracked(): void {}

function changeOf(event: EventEnvelope): SessionEventChange {
  return { cursor: encodeEventCursor(event.sequence), event };
}

// Delivers a change the follower has not had yet; anything at or below its last delivery is a
// copy it already read from the log.
function deliver(follower: SessionFollower, change: SessionEventChange): void {
  if (follower.isDetached || change.event.sequence <= follower.lastDelivered) {
    return;
  }
  follower.lastDelivered = change.event.sequence;
  follower.listener.onChange(change);
}
