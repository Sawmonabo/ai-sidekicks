// Reaches the rows before the window this console was given. A resumed stream replays from
// the last acknowledged position, so the window's head can sit mid-log, and only a backward
// `beforeCursor` page moves it. This holds a position and a verdict, not rows: pages go
// into the session store through `prependEarlierEvents`.

import {
  type EventCursor,
  type SessionId,
  type TimelineReadRequest,
  type TimelineReadResponse,
} from "@ai-sidekicks/contracts";

import { TRANSCRIPT_EARLIER_PAGE_ROWS } from "../frame/frame-caps.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { type DaemonReply } from "@renderer/services/daemon/daemon-reply.js";
import { readEarlierTimelinePage } from "@renderer/services/daemon/timeline-page.js";
import { isReadAbandoned, ReadScope } from "@renderer/lib/reads/read-scope.js";
import { type CurrentGenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/** What the transcript renders about the rows before this window. */
export interface EarlierHistoryState {
  /**
   * Whether a backward page can be asked for right now.
   *
   * False when the window opens at the beginning of the log, the producer says nothing
   * remains, or a page is in flight; the transcript does not tell them apart, and
   * {@link isReading} carries the last for progress.
   */
  readonly canLoadEarlier: boolean;
  /** A backward page is in flight. */
  readonly isReading: boolean;
  /** Why the last attempt did not land, until the next one is made. */
  readonly refusal: Refusal | undefined;
  /** Rows this walk has admitted at the head, across every page it has read. */
  readonly admittedRowCount: number;
}

/**
 * The read that fetches one backward page, parsed, or the refusal standing in its place.
 *
 * Resolves `served` or `refused` for every transport outcome and never rejects, so the walk
 * holds no `catch`.
 */
export type EarlierPageRead = (
  request: TimelineReadRequest,
  options: { readonly signal: AbortSignal },
) => Promise<DaemonReply<TimelineReadResponse>>;

/**
 * One session's backward walk.
 *
 * Single-flight: a press while a page is in flight is dropped, since two reads from one cursor
 * fetch the same rows twice. Whether earlier rows remain is the daemon's `hasMore`, never
 * inferred from page size; only a missing cursor is read locally. A page is discarded when
 * the store's window generation moved while it was in flight: merging it would put rows
 * before a head the store has left, and the store's strictly-earlier guard would then refuse
 * every later page.
 */
export class EarlierHistoryReader {
  /**
   * The store window this walk is based on, once observed. The store's own claim, re-taken
   * by any read that re-establishes its base state, whatever position that read used.
   */
  #baseWindowGeneration: CurrentGenerationClaim | undefined;
  /**
   * The line every backward page is read on. Owned here and opened after the single-flight
   * guard admits a press, so a double press cannot abort the page already in flight. The
   * walk's owner ends it through {@link abandonReads}, so a pane that leaves stops its
   * outstanding page.
   */
  readonly #readLine = new ReadScope();
  /** Where the next page starts. `undefined` means there is nowhere to ask from. */
  #nextBeforeCursor: string | undefined;
  #exhausted = true;
  #isReading = false;
  #refusal: Refusal | undefined;
  #admittedRowCount = 0;

  /** Whether this walk's read line is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#readLine.isAbandoned;
  }

  /**
   * Ends the read line: an outstanding page stops and no later one is live.
   *
   * The walk's fields stay as they are; a holder handed this reader back (React's
   * double-mount) sees `isAbandoned` and mints a fresh one.
   */
  public abandonReads(): void {
    this.#readLine.abandon();
  }

  /**
   * What the transcript should render, read against the store as it stands. The store is
   * passed in, not held, because the walk's base is the store's fact.
   */
  public state(sessionStore: SessionStore): EarlierHistoryState {
    this.#rebaseIfWindowMoved(sessionStore);
    return {
      canLoadEarlier: !this.#exhausted && !this.#isReading && this.#nextBeforeCursor !== undefined,
      isReading: this.#isReading,
      refusal: this.#refusal,
      admittedRowCount: this.#admittedRowCount,
    };
  }

  /**
   * Read one page of rows before this window's head and grow the log with it.
   *
   * Resolves when the page has landed or been refused; the caller re-reads
   * {@link state} either way. Never rejects, because {@link EarlierPageRead} never does.
   */
  public async loadEarlier(
    readEarlierPage: EarlierPageRead,
    sessionStore: SessionStore,
  ): Promise<void> {
    const baseWindowGeneration = this.#rebaseIfWindowMoved(sessionStore);
    const beforeCursor = this.#nextBeforeCursor;
    if (this.#isReading || this.#exhausted || beforeCursor === undefined) {
      return;
    }
    this.#isReading = true;
    this.#refusal = undefined;
    const round = this.#readLine.openRound();
    try {
      const reply = await readEarlierPage(
        {
          // `SessionId` and `EventCursor` are markers over wire strings that both came off the
          // wire; the casts stay local because a feature may import no other feature.
          sessionId: sessionStore.sessionId as SessionId,
          beforeCursor: beforeCursor as EventCursor,
          limit: TRANSCRIPT_EARLIER_PAGE_ROWS,
        },
        { signal: round.signal },
      );
      if (isReadAbandoned(round.signal)) {
        // Nothing is waiting, so nothing installs, neither the page nor the refusal
        // `callDaemon` composes for an abandoned read. The window generation says the window
        // moved; this says the pane offering the control is gone.
        return;
      }
      if (reply.status === "refused") {
        // Through the round too, so a refusal is not installed after the window moved.
        baseWindowGeneration.settle(() => {
          this.#refusal = reply.refusal;
        });
        return;
      }
      const page = readEarlierTimelinePage(reply.value);
      // The rows go to the store and the position stays here; the admitted count shows a page
      // the log already held as one that added nothing. Both install only while this page's
      // window is still the store's, or the walk would keep asking from a cursor naming the
      // old head.
      baseWindowGeneration.settle(() => {
        this.#admittedRowCount += sessionStore.prependEarlierEvents(page.events).admitted;
        this.#nextBeforeCursor = page.nextBeforeCursor;
        this.#exhausted = !page.hasEarlierRows || page.nextBeforeCursor === undefined;
      });
    } finally {
      this.#isReading = false;
    }
  }

  /**
   * Starts the walk over when the store's window is not the one it was based on, and
   * answers the window generation it is based on now.
   *
   * One comparison covers both ways a window moves: a different acknowledged head, and the
   * same head re-read after the old log (and any rows prepended to it) was thrown away. The
   * caller keeps the generation until its reply lands.
   */
  #rebaseIfWindowMoved(sessionStore: SessionStore): CurrentGenerationClaim {
    const baseWindowGeneration = this.#baseWindowGeneration;
    if (baseWindowGeneration?.isCurrent === true) {
      return baseWindowGeneration;
    }
    const windowGeneration = sessionStore.windowGeneration;
    const windowHeadCursor = sessionStore.snapshot().windowHeadCursor;
    this.#baseWindowGeneration = windowGeneration;
    this.#nextBeforeCursor = windowHeadCursor;
    // A window that opens at the beginning of the log has nothing before it: exhausted, not a
    // refusal.
    this.#exhausted = windowHeadCursor === undefined;
    this.#refusal = undefined;
    this.#admittedRowCount = 0;
    return windowGeneration;
  }
}
