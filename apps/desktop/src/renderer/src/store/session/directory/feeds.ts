// The service's session list, one feed per window however many views read it. The feed opens with
// the first reader and closes with the last; each list it delivers replaces what is held once its
// last page lands, so no view reads part of a list as all of it, and each change after it moves
// one entry. Nothing polls: a settled act that implies the list moved asks for it again with
// `reread`, which opens the feed afresh.

import type {
  SessionListChange,
  SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";

import type { Unsubscribe } from "#shared/preload-api.js";

import type {
  SessionDirectoryFeed,
  SessionDirectoryFrame,
  SessionDirectoryState,
} from "./state.js";

/** What is held before the feed delivers its list. */
const READING: SessionDirectoryState = { status: "reading" };

/**
 * Every feed being read, each folded into one state its readers share. Keyed by the feed, which
 * the composition holds stable per window, so a superseded feed takes its state with it.
 */
export class SessionDirectoryFeeds {
  readonly #heldByFeed = new WeakMap<SessionDirectoryFeed, HeldSessionDirectory>();

  /** Read `feed` until the handle releases it, waking `onChange` each time its state moves. */
  public watch(feed: SessionDirectoryFeed, onChange: () => void): Unsubscribe {
    return this.#heldFor(feed).watch(onChange);
  }

  /** What `feed`'s readers see now: `reading` until it delivers its list. */
  public stateOf(feed: SessionDirectoryFeed): SessionDirectoryState {
    return this.#heldByFeed.get(feed)?.state ?? READING;
  }

  /**
   * Open `feed` afresh while anyone reads it, so it delivers the list as it now stands. For a
   * settled act whose answer already implies the list changed.
   */
  public reread(feed: SessionDirectoryFeed): void {
    this.#heldByFeed.get(feed)?.reopen();
  }

  #heldFor(feed: SessionDirectoryFeed): HeldSessionDirectory {
    const known = this.#heldByFeed.get(feed);
    if (known !== undefined) {
      return known;
    }
    const held = new HeldSessionDirectory(feed);
    this.#heldByFeed.set(feed, held);
    return held;
  }
}

/** The app's session lists, one per window's feed. */
export const sessionDirectoryFeeds: SessionDirectoryFeeds = new SessionDirectoryFeeds();

/** A list arriving in pages: the entries so far and the chat count the latest page carried. */
interface IncomingSessionList {
  readonly sessions: SessionListEntry[];
  chatCount: number;
}

/** One feed's state and its readers, with the feed open while any reader is. */
class HeldSessionDirectory {
  readonly #feed: SessionDirectoryFeed;
  readonly #readers = new Set<() => void>();
  #state: SessionDirectoryState = READING;
  // The list being delivered, page by page, until its last page makes it the state.
  #incoming: IncomingSessionList | undefined;
  #release: Unsubscribe | undefined;

  public constructor(feed: SessionDirectoryFeed) {
    this.#feed = feed;
  }

  public get state(): SessionDirectoryState {
    return this.#state;
  }

  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#open();
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        this.#close();
        // A later reader opens the feed afresh, so it reads no list from before.
        this.#state = READING;
      }
    };
  }

  public reopen(): void {
    if (this.#release === undefined) {
      return;
    }
    // The list on screen stays until the fresh one replaces it.
    this.#close();
    this.#open();
  }

  #open(): void {
    this.#release = this.#feed((frame) => {
      this.#apply(frame);
    });
  }

  #close(): void {
    const release = this.#release;
    this.#release = undefined;
    // A closed stream finishes no list it was delivering.
    this.#incoming = undefined;
    release?.();
  }

  #apply(frame: SessionDirectoryFrame): void {
    const next = this.#stateAfter(frame);
    if (next === this.#state) {
      return;
    }
    this.#state = next;
    for (const onChange of [...this.#readers]) {
      onChange();
    }
  }

  // Until a list's last page lands, the state stays what it was: reading, or on a reread the
  // list it replaces.
  #stateAfter(frame: SessionDirectoryFrame): SessionDirectoryState {
    switch (frame.kind) {
      case "list":
        return this.#receive(
          { sessions: [...frame.sessions], chatCount: frame.chatCount },
          frame.isComplete,
        );
      case "lost":
        this.#incoming = undefined;
        return { status: "failed" };
      case "change": {
        const { change } = frame;
        if (change.kind !== "page") {
          return changedState(this.#state, change);
        }
        const incoming = this.#incoming;
        // A page with no list before it, like a change, moves nothing: the next list restates it.
        if (incoming === undefined) {
          return this.#state;
        }
        incoming.sessions.push(...change.sessions);
        incoming.chatCount = change.chatCount;
        return this.#receive(incoming, change.isComplete);
      }
    }
  }

  // Holds the list being delivered, or serves it once its last page has landed.
  #receive(incoming: IncomingSessionList, isComplete: boolean): SessionDirectoryState {
    if (!isComplete) {
      this.#incoming = incoming;
      return this.#state;
    }
    this.#incoming = undefined;
    return { status: "served", sessions: incoming.sessions, chatCount: incoming.chatCount };
  }
}

/**
 * The state after one entry's change. A change before the list arrives moves nothing: the list it
 * follows restates every session, that one included.
 */
function changedState(
  state: SessionDirectoryState,
  change: Exclude<SessionListChange, { kind: "page" }>,
): SessionDirectoryState {
  if (state.status !== "served") {
    return state;
  }
  return {
    status: "served",
    sessions:
      change.kind === "upsert"
        ? upsertInPlace(state.sessions, change.entry)
        : state.sessions.filter((session) => session.sessionId !== change.sessionId),
    chatCount: change.chatCount,
  };
}

/** The list with `entry` where its session stood, or at the end for a session new to it. */
function upsertInPlace(
  sessions: readonly SessionListEntry[],
  entry: SessionListEntry,
): readonly SessionListEntry[] {
  const at = sessions.findIndex((session) => session.sessionId === entry.sessionId);
  return at < 0 ? [...sessions, entry] : sessions.with(at, entry);
}
