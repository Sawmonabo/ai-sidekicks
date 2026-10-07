// The searches whose later pages are still to be read, each held as its first page read it, so a
// write between pages neither repeats nor drops a hit. Holding is bounded: the searches together
// keep at most a byte budget, the least recently paged let go first, and one not paged for a while
// is let go on its own. A cursor of a search let go is refused, and the search starts again.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionSearchHit } from "@ai-sidekicks/contracts/session/methods";

import { mintUuidV7 } from "../../uuid-v7.js";

import type { TextRanking } from "./ranking.js";
import type { HeldRowCheck } from "./rowid-floors.js";

/** The sessions of a search with words, in the order its pages show them. */
export interface SessionOrder {
  /** The session at `index`, `undefined` past the last, read past the rows `isHeldRow` refuses. */
  sessionAt(index: number, isHeldRow: HeldRowCheck): SessionId | undefined;
  /** Roughly how many bytes the order holds so far. */
  readonly byteLength: number;
}

/** A session a search by tag alone found, with the tags that matched as its hits. */
export interface ListedSession {
  readonly sessionId: SessionId;
  readonly name: string | null;
  readonly hits: readonly SessionSearchHit[];
}

/**
 * One held search. `queryKey` is the parsed query it answers, so a cursor sent with another query
 * continues nothing. A search with words keeps its ranking, where the rowid floor log stood when
 * the ranking was read, and its session order; a search by tag alone keeps its whole answer.
 */
export type SearchSnapshot =
  | {
      readonly order: "ranked";
      readonly queryKey: string;
      readonly matchExpression: string;
      readonly ranking: TextRanking;
      readonly floorPosition: number;
      readonly sessionOrder: SessionOrder;
    }
  | {
      readonly order: "listed";
      readonly queryKey: string;
      readonly sessions: readonly ListedSession[];
      readonly byteLength: number;
    };

/** The bounds on held searches. */
export interface SearchSnapshotLimits {
  /** The most bytes the held searches keep together; one search alone may exceed it. */
  readonly maxBytes: number;
  /** How long a search may go unpaged before it is let go. */
  readonly idleMs: number;
}

/** The daemon's bounds: a search matching most of a million messages holds over a quarter. */
export const DEFAULT_SEARCH_SNAPSHOT_LIMITS: SearchSnapshotLimits = {
  maxBytes: 64 * 1024 * 1024,
  idleMs: 10 * 60_000,
};

// What a listed hit costs beyond its line's code units.
const LISTED_HIT_OVERHEAD_BYTES = 96;

interface HeldSnapshot {
  readonly snapshot: SearchSnapshot;
  lastPagedAt: number;
}

/** Holds searches between their pages, inside {@link SearchSnapshotLimits}. */
export class SearchSnapshots {
  readonly #limits: SearchSnapshotLimits;
  readonly #now: () => number;
  // Map order is paging order, least recently paged first.
  readonly #held = new Map<string, HeldSnapshot>();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(limits: SearchSnapshotLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  /** Holds a search and answers the id its cursors name. */
  hold(snapshot: SearchSnapshot): string {
    const snapshotId = mintUuidV7();
    this.#held.set(snapshotId, { snapshot, lastPagedAt: this.#now() });
    this.#letGoOverBudget();
    this.#armExpiry();
    return snapshotId;
  }

  /** The held search with this id, marked as just paged; `undefined` once it is let go. */
  find(snapshotId: string): SearchSnapshot | undefined {
    this.#letGoIdle();
    const held = this.#held.get(snapshotId);
    if (held === undefined) {
      return undefined;
    }
    this.#held.delete(snapshotId);
    held.lastPagedAt = this.#now();
    this.#held.set(snapshotId, held);
    this.#letGoOverBudget();
    this.#armExpiry();
    return held.snapshot;
  }

  // A search with words grows its order as it is paged, so the budget is checked on every page.
  #letGoOverBudget(): void {
    let total = 0;
    for (const held of this.#held.values()) {
      total += byteLengthOf(held.snapshot);
    }
    for (const [snapshotId, held] of this.#held) {
      if (total <= this.#limits.maxBytes || this.#held.size === 1) {
        return;
      }
      total -= byteLengthOf(held.snapshot);
      this.#held.delete(snapshotId);
    }
  }

  #letGoIdle(): void {
    const idleSince = this.#now() - this.#limits.idleMs;
    for (const [snapshotId, held] of this.#held) {
      if (held.lastPagedAt > idleSince) {
        return;
      }
      this.#held.delete(snapshotId);
    }
  }

  // One timer, for the least recently paged search, so an idle daemon lets its searches go.
  #armExpiry(): void {
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    const [oldest] = this.#held.values();
    if (oldest === undefined) {
      return;
    }
    const delay = Math.max(0, oldest.lastPagedAt + this.#limits.idleMs - this.#now());
    this.#expiryTimer = setTimeout(() => {
      this.#letGoIdle();
      this.#armExpiry();
    }, delay);
    this.#expiryTimer.unref();
  }
}

function byteLengthOf(snapshot: SearchSnapshot): number {
  return snapshot.order === "ranked"
    ? snapshot.ranking.byteLength + snapshot.sessionOrder.byteLength
    : snapshot.byteLength;
}

/** Roughly how many bytes a search by tag alone holds. */
export function listedByteLength(sessions: readonly ListedSession[]): number {
  let total = 0;
  for (const session of sessions) {
    for (const hit of session.hits) {
      total += hit.line.length * 2 + LISTED_HIT_OVERHEAD_BYTES;
    }
  }
  return total;
}
