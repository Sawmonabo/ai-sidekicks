// The searches whose later pages are still to be read, each held as its first page opened it, so a
// write between pages neither repeats nor drops a hit. A search holds a view of the index, which
// keeps the index version it opened on, its files and the totals it scores with, so holding is
// bounded: a search not paged for a while is let go, so is one held too long however often it is
// paged, and past a count the least recently paged goes first. A cursor of a search let go is
// refused, and the search starts again.

import type { HeldSearch } from "@ai-sidekicks/search-index";

import { mintUuidV7 } from "../../uuid-v7.js";
import type { ParsedSearchQuery } from "./query.js";

/**
 * One held search. `queryKey` is the parsed query it answers, so a cursor sent with another query
 * continues nothing. It keeps that query, its view of the index, and where the rowid floor log
 * stood for that view.
 */
export interface SearchSnapshot {
  readonly queryKey: string;
  readonly query: ParsedSearchQuery;
  readonly view: HeldSearch;
  readonly floorPosition: number;
}

/** The bounds on held searches. */
export interface SearchSnapshotLimits {
  /** The most searches held at once; past it the least recently paged is let go. */
  readonly maxHeld: number;
  /** How long a search may go unpaged before it is let go. */
  readonly idleMs: number;
  /** How long a search is held at most from its first page, however often it is paged. */
  readonly lifetimeMs: number;
}

/**
 * The daemon's bounds. Sixteen searches: a person typing opens one per keystroke and an agent pages
 * a few at once, while each view keeps an index version's files and totals alive. Five minutes
 * unpaged: a person reading one page and scrolling on still continues it, and a search left behind
 * gives its view back soon after. Thirty minutes in all: a search paged on and on still lets go of
 * its index version, so merged files are not kept on disk behind it.
 */
export const DEFAULT_SEARCH_SNAPSHOT_LIMITS: SearchSnapshotLimits = {
  maxHeld: 16,
  idleMs: 5 * 60_000,
  lifetimeMs: 30 * 60_000,
};

interface HeldSnapshot {
  readonly snapshot: SearchSnapshot;
  readonly heldAt: number;
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
    const now = this.#now();
    this.#held.set(snapshotId, { snapshot, heldAt: now, lastPagedAt: now });
    for (const [heldId, held] of this.#held) {
      if (this.#held.size <= this.#limits.maxHeld) {
        break;
      }
      this.#letGo(heldId, held);
    }
    this.#armExpiry();
    return snapshotId;
  }

  /** The held search with this id, marked as just paged; `undefined` once it is let go. */
  find(snapshotId: string): SearchSnapshot | undefined {
    this.#letGoExpired();
    const held = this.#held.get(snapshotId);
    if (held === undefined) {
      return undefined;
    }
    this.#held.delete(snapshotId);
    held.lastPagedAt = this.#now();
    this.#held.set(snapshotId, held);
    this.#armExpiry();
    return held.snapshot;
  }

  /**
   * The lowest place in the rowid floor log a held search still reads from; `undefined` while none
   * is held.
   */
  oldestFloorPosition(): number | undefined {
    let oldest: number | undefined;
    for (const { snapshot } of this.#held.values()) {
      oldest = Math.min(oldest ?? snapshot.floorPosition, snapshot.floorPosition);
    }
    return oldest;
  }

  /** Lets go of every held search, as the index closes. */
  letGoOfAll(): void {
    for (const [snapshotId, held] of this.#held) {
      this.#letGo(snapshotId, held);
    }
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #letGo(snapshotId: string, held: HeldSnapshot): void {
    this.#held.delete(snapshotId);
    held.snapshot.view.release();
  }

  #letGoExpired(): void {
    const now = this.#now();
    for (const [snapshotId, held] of this.#held) {
      if (now >= this.#expiryOf(held)) {
        this.#letGo(snapshotId, held);
      }
    }
  }

  #expiryOf(held: HeldSnapshot): number {
    return Math.min(held.lastPagedAt + this.#limits.idleMs, held.heldAt + this.#limits.lifetimeMs);
  }

  // One timer, for the search that expires first, so an idle daemon lets its searches go.
  #armExpiry(): void {
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    let firstExpiry = Number.POSITIVE_INFINITY;
    for (const held of this.#held.values()) {
      firstExpiry = Math.min(firstExpiry, this.#expiryOf(held));
    }
    if (firstExpiry === Number.POSITIVE_INFINITY) {
      return;
    }
    this.#expiryTimer = setTimeout(
      () => {
        this.#letGoExpired();
        this.#armExpiry();
      },
      Math.max(0, firstExpiry - this.#now()),
    );
    this.#expiryTimer.unref();
  }
}
