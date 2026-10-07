// Who receives a session's committed events, and in what order. A session's events go out in
// sequence order with no gap: a receipt that arrives ahead of an earlier one still unpublished is
// preceded by the missing events read back from the log, and a receipt at or below what was
// already published is dropped.
//
// A new follower catches up from the log before it goes live. It registers first, so every event
// published from then on lands in its buffer while it reads pages; once a page reports nothing
// more, the buffer drains, dropping every sequence it already delivered from the log. Pages are
// bounded and the follower yields to the event loop between them.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionStreamChange } from "@ai-sidekicks/contracts/session/methods";
import { encodeEventCursor, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { SessionEventReads } from "./read.js";

/** One change a session follower receives: the committed event and the cursor that resumes after it. */
export type SessionEventChange = SessionStreamChange<EventEnvelope>;

interface SessionFollower {
  readonly onChange: (change: SessionEventChange) => void;
  /** The sequence of the last event delivered, or the position the follower started after. */
  lastDelivered: number;
  /** Changes published while the follower is catching up; `undefined` once it is live. */
  buffer: SessionEventChange[] | undefined;
  isDetached: boolean;
  pendingPage: ReturnType<typeof setImmediate> | undefined;
}

interface SessionPublication {
  /** The highest sequence published for the session. */
  lastPublished: number;
  readonly followers: Set<SessionFollower>;
}

/** Publishes committed events to the followers of one session and to the followers of all. */
export class SessionEventFollowers {
  readonly #reads: SessionEventReads;
  readonly #pageSize: number;
  // Keyed by the canonical session id. A session has an entry while it has followers, and, while
  // any all-sessions follower is attached, from its first append onward.
  readonly #sessions = new Map<SessionId, SessionPublication>();
  readonly #allSessionsFollowers = new Set<(event: EventEnvelope) => void>();

  /** `pageSize` bounds each catch-up read. */
  constructor(reads: SessionEventReads, pageSize: number) {
    this.#reads = reads;
    this.#pageSize = pageSize;
  }

  /**
   * Starts tracking `sessionId` before an append is queued, when anyone follows, so the first
   * receipt is ordered against the head the log had before it.
   */
  trackAppend(sessionId: SessionId): void {
    if (this.#allSessionsFollowers.size > 0) {
      this.#publicationOf(sessionId);
    }
  }

  /** Publishes one committed event, filling any gap before it from the log first. */
  publish(event: EventEnvelope): void {
    const publication = this.#sessions.get(canonicalizeUuid(event.sessionId));
    if (publication === undefined || event.sequence <= publication.lastPublished) {
      return;
    }
    if (event.sequence > publication.lastPublished + 1) {
      const missing = this.#reads.readWindow(
        event.sessionId,
        publication.lastPublished + 1,
        event.sequence - 1,
      );
      for (const missingEvent of missing) {
        this.#publishInOrder(publication, missingEvent);
      }
    }
    this.#publishInOrder(publication, event);
  }

  /**
   * Delivers the session's events after `afterPosition`, which the caller has checked against the
   * log, then follows new ones. The first page is delivered before this returns; a read error on it
   * is thrown here. Returns the detach, which stops delivery at once, from inside `onChange` too.
   */
  follow(
    sessionId: SessionId,
    afterPosition: number,
    onChange: (change: SessionEventChange) => void,
  ): () => void {
    const publication = this.#publicationOf(sessionId);
    const follower: SessionFollower = {
      onChange,
      lastDelivered: afterPosition,
      buffer: [],
      isDetached: false,
      pendingPage: undefined,
    };
    publication.followers.add(follower);
    const detach = (): void => {
      if (follower.isDetached) {
        return;
      }
      follower.isDetached = true;
      follower.buffer = undefined;
      if (follower.pendingPage !== undefined) {
        clearImmediate(follower.pendingPage);
        follower.pendingPage = undefined;
      }
      publication.followers.delete(follower);
      this.#releaseIfUnfollowed(sessionId, publication);
    };
    try {
      this.#catchUp(sessionId, follower);
    } catch (error) {
      detach();
      throw error;
    }
    return detach;
  }

  /** Delivers every session's committed events from now on, each session in sequence order. */
  followAll(onCommitted: (event: EventEnvelope) => void): () => void {
    // A wrapper, so one function attached twice detaches once per attach.
    const follower = (event: EventEnvelope): void => {
      onCommitted(event);
    };
    this.#allSessionsFollowers.add(follower);
    return () => {
      if (!this.#allSessionsFollowers.delete(follower) || this.#allSessionsFollowers.size > 0) {
        return;
      }
      for (const [sessionId, publication] of this.#sessions) {
        if (publication.followers.size === 0) {
          this.#sessions.delete(sessionId);
        }
      }
    };
  }

  // A new entry starts at the log's head: every event at or below it is already in the log, where
  // a catching-up follower reads it.
  #publicationOf(sessionId: SessionId): SessionPublication {
    const key = canonicalizeUuid(sessionId);
    let publication = this.#sessions.get(key);
    if (publication === undefined) {
      publication = {
        lastPublished: this.#reads.readHead(sessionId) ?? -1,
        followers: new Set(),
      };
      this.#sessions.set(key, publication);
    }
    return publication;
  }

  #releaseIfUnfollowed(sessionId: SessionId, publication: SessionPublication): void {
    const key = canonicalizeUuid(sessionId);
    if (
      publication.followers.size === 0 &&
      this.#allSessionsFollowers.size === 0 &&
      this.#sessions.get(key) === publication
    ) {
      this.#sessions.delete(key);
    }
  }

  #publishInOrder(publication: SessionPublication, event: EventEnvelope): void {
    publication.lastPublished = event.sequence;
    const change = changeOf(event);
    for (const follower of publication.followers) {
      if (follower.buffer === undefined) {
        deliver(follower, change);
      } else {
        follower.buffer.push(change);
      }
    }
    for (const allSessionsFollower of this.#allSessionsFollowers) {
      allSessionsFollower(event);
    }
  }

  // Reads one page, delivers it, then either schedules the next page or drains the buffer and
  // goes live.
  #catchUp(sessionId: SessionId, follower: SessionFollower): void {
    // One row past the page shows whether more remain.
    const page = this.#reads.readAfter(sessionId, follower.lastDelivered, this.#pageSize + 1);
    const hasMore = page.length > this.#pageSize;
    for (const event of hasMore ? page.slice(0, this.#pageSize) : page) {
      deliver(follower, changeOf(event));
    }
    if (follower.isDetached) {
      return;
    }
    if (hasMore) {
      follower.pendingPage = setImmediate(() => {
        follower.pendingPage = undefined;
        this.#catchUp(sessionId, follower);
      });
      return;
    }
    // Delivering can detach the follower, which clears the buffer, so it is read on each turn.
    for (let index = 0; follower.buffer !== undefined && index < follower.buffer.length; index++) {
      deliver(follower, follower.buffer[index]!);
    }
    follower.buffer = undefined;
  }
}

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
  follower.onChange(change);
}
