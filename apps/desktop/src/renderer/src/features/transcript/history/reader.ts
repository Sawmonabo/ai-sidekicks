// Reads the session's history past the edges of the window its store holds: backward before the
// head, forward after a tail that was let go or never read, and the page at either end of the log,
// which takes the place of the whole window, so Home and End reach the session's own ends without
// walking the history between, and a page inside a stretch the store let go between two events it
// holds, which a long run's window opening onto calls it left out reads back. A stretch is a
// height, not a row count:
// pages are read until the whole held transcript is estimated that much taller than when the read
// began, or the daemon has no more, each page's limit sized from the height still owed. This holds
// no rows and no position: pages go into the store, and every read is asked from the store's own
// edge. A failed read toward the tail or inside the window stands on the session's catch-up line,
// whose `Try again` sends it again.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptReadRequest } from "@ai-sidekicks/contracts/transcript/operations";

import type { Unsubscribe } from "#shared/preload-api.js";
import { describeFailure } from "#shared/failure-message.js";
import { type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { isReadAbandoned, ReadScope } from "#renderer/lib/reads/scope.js";
import {
  readTranscriptPage,
  type TranscriptPageRead,
} from "#renderer/services/daemon/transcript/page.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type DependentRead } from "#renderer/store/session/failed-dependent-reads.js";
import {
  heldRowCursor,
  type ReleasedEventStretch,
  type TranscriptWindowEdge,
} from "#renderer/store/session/state.js";
import { type ReleasedStretchReadDirection } from "#renderer/store/session/transcript-window.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { TRANSCRIPT_STRETCH_SCREEN_HEIGHTS } from "../viewport/caps.js";
import { type WindowSide } from "#renderer/lib/scroll/window-side.js";
import { pageLimitFor } from "./page-limit.js";

/** What the transcript shows about the history past one edge of the store's window. */
export interface HistoryEdgeState {
  /** Whether the daemon holds rows past this edge that the store does not. */
  readonly hasMore: boolean;
  /** Whether a stretch past this edge is being read. */
  readonly isReading: boolean;
  /** Whether the last read past this edge failed; it stands until that read is sent again. */
  readonly hasFailed: boolean;
  /** How many reads past this edge have failed, so a retry that fails again is a new failure. */
  readonly failureCount: number;
}

/**
 * The history past both edges, `earlier` before the head and `later` after the tail, and inside
 * the window, in the stretches the store let go between two events it holds.
 */
export interface TranscriptHistoryState {
  readonly earlier: HistoryEdgeState;
  readonly later: HistoryEdgeState;
  readonly inside: HistoryEdgeState;
}

/** How a stretch is sized and counted, read from the viewport the transcript is laid out in. */
export interface TranscriptStretchMeasure {
  /** The viewport's height in pixels, the unit a stretch is sized in. */
  readonly screenHeightPx: () => number;
  /** The least height a row is estimated at, which sizes a page's row limit. */
  readonly smallestRowHeightPx: () => number;
  /**
   * The estimated height, in pixels, of the rows the store's whole transcript would draw. Derived
   * through the session's own window derivation, so it is handed the store's transcript alone.
   */
  readonly heldHeightPx: (transcript: readonly ProjectedSessionEvent[]) => number;
}

/**
 * One session's reads past the edges of its store's window.
 *
 * Single-flight across both edges: two reads from one edge would fetch the same rows twice, and
 * the reader is never far enough from both edges at once to need them together. A stretch is
 * counted over the whole held transcript, never page by page: a finished run split across pages
 * draws folded once its last row is held, while a page judged alone would count it live and
 * unfolded. A failed read keeps its request, and asking for that edge again sends the same
 * request. A page lands only while the store's edge is still the one it was asked from: a let-go
 * or a fresh opening read moves the edge, and a page from the old one would leave a hole in the
 * log.
 */
export class TranscriptHistoryReader {
  readonly #sessionStore: SessionStore;
  /** The clock a walk waits a frame on between pages, and stamps a failure it could not settle. */
  readonly #clock: Clock;
  /** Runs a task of its own behind the work the thread already has, as a stretch's first read. */
  readonly #queueTask: (task: () => void) => void;
  /**
   * The line every read goes out on, ended by {@link abandonReads} when the transcript holding
   * this reader leaves.
   */
  readonly #readLine = new ReadScope();
  readonly #changes = new Emitter<void>("transcript history state");
  #readingSide: HistoryReadPlace | undefined;
  /** Bumped by each walk and each jump, so only the newest clears the side it reads past. */
  #readCount = 0;
  /** The read that failed past each edge, which asking for that edge again sends unchanged. */
  readonly #failedReadBySide = new Map<WindowSide, PendingRead>();
  readonly #failureCountBySide = new Map<HistoryReadPlace, number>();
  /** Whether the last read inside the window failed; it stands until a read inside is sent. */
  #hasInsideReadFailed = false;
  /**
   * The failed reads the session's catch-up line offers again, by where they read: each sends its
   * read again, answering whether there was still one to send.
   */
  readonly #catchUpRetries = new Map<CatchUpReadPlace, () => boolean>();
  /** This reader on the session's catch-up line while a read it offers again stands failed. */
  readonly #catchUpRead: DependentRead = {
    requestRead: () => {
      this.#retryForCatchUp();
    },
  };
  /** The viewport the transcript is laid out in, while one is. */
  #measure: TranscriptStretchMeasure | undefined;
  /** The state last read; it stands while the reader and each edge's `hasMore` stay put. */
  #state: TranscriptHistoryState | undefined;

  public constructor(
    sessionStore: SessionStore,
    clock: Clock,
    queueTask: (task: () => void) => void,
  ) {
    this.#sessionStore = sessionStore;
    this.#clock = clock;
    this.#queueTask = queueTask;
  }

  /** Whether this reader's read line is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#readLine.isAbandoned;
  }

  /** Ends the read line: the read in flight stops and nothing it brings lands. */
  public abandonReads(): void {
    this.#readLine.abandon();
    this.#catchUpRetries.clear();
    this.#sessionStore.failedDependentReads.forget(this.#catchUpRead);
  }

  /**
   * The history as it stands, read against the store's edges. The same value until the reader
   * moves or an edge's `hasMore` changes, the one edge fact it reports, so it can serve as an
   * external store's snapshot even while every streamed row moves the live tail.
   */
  public state(): TranscriptHistoryState {
    const { transcriptHead, transcriptTail, releasedStretches } = this.#sessionStore.snapshot();
    const hasInsideMore = releasedStretches.length > 0;
    if (
      this.#state !== undefined &&
      this.#state.earlier.hasMore === transcriptHead.hasMore &&
      this.#state.later.hasMore === transcriptTail.hasMore &&
      this.#state.inside.hasMore === hasInsideMore
    ) {
      return this.#state;
    }
    this.#state = {
      earlier: this.#edgeState("head", transcriptHead.hasMore),
      later: this.#edgeState("tail", transcriptTail.hasMore),
      inside: this.#edgeState("inside", hasInsideMore),
    };
    return this.#state;
  }

  /** Takes the measure of the viewport the transcript is laid out in, or lets it go. */
  public measureWith(measure: TranscriptStretchMeasure | undefined): void {
    this.#measure = measure;
  }

  /** Hears every change the reader itself makes; a move of a store edge is the store's to tell. */
  public subscribe(onChange: () => void): Unsubscribe {
    return this.#changes.subscribe(() => {
      onChange();
    });
  }

  /**
   * Reads past one edge until about `owedHeightPx` of rows have landed, a stretch when it is not
   * given, or the daemon has no more. Answers whether that edge has more to read, so a caller can
   * tell a stretch asked for (or already under way) from an edge with nothing past it. A failed
   * read past an edge that has not moved is sent again unchanged; a read past the other edge in
   * flight, or no viewport to measure the stretch in, leaves this one unasked. The read is marked
   * under way at once and sent in a task of its own, so a scroll event that asks for it does not
   * carry the page request.
   */
  public readStretch(side: WindowSide, read: TranscriptPageRead, owedHeightPx?: number): boolean {
    const edge = this.#edgeOf(side);
    const measure = this.#measure;
    if (!edge.hasMore || edge.cursor === undefined || measure === undefined) {
      return false;
    }
    if (this.#readingSide !== undefined) {
      return this.#readingSide === side;
    }
    const retry = (): boolean => this.readStretch(side, read, owedHeightPx);
    // A failed read is sent again only from the edge it was asked from: one that moved since,
    // by a release or a fresh opening, is asked anew from where it stands.
    const failedRead = this.#failedReadBySide.get(side);
    const pending =
      failedRead !== undefined && cursorOf(side, failedRead.request) === edge.cursor
        ? failedRead
        : this.#pendingRead(
            side,
            edge.cursor,
            owedHeightPx ?? TRANSCRIPT_STRETCH_SCREEN_HEIGHTS * measure.screenHeightPx(),
            measure,
          );
    const readNumber = this.#startRead(side);
    this.#queueTask(() => {
      this.#walk(pending, read, measure, readNumber, retry).catch((error: unknown) => {
        this.#failWalk(pending, error, retry);
      });
    });
    return true;
  }

  /**
   * Reads one page inside the released stretch `stretch`, `direction` from the event that bounds
   * it: `backward` toward the head from the event after it, `forward` from the event before it.
   * The page holds about a stretch's rows, which the window that asked for it opens onto. Answers
   * whether the read started: not while another read is under way, with no viewport to size the
   * page, or once the store no longer holds that stretch. Single-flight with the edges' reads.
   */
  public readReleasedStretch(
    stretch: ReleasedEventStretch,
    direction: ReleasedStretchReadDirection,
    read: TranscriptPageRead,
  ): boolean {
    const measure = this.#measure;
    const request =
      measure === undefined ? undefined : this.#releasedStretchRequest(stretch, direction, measure);
    if (request === undefined || this.#readingSide !== undefined) {
      return false;
    }
    const retry = (): boolean => this.readReleasedStretch(stretch, direction, read);
    const readNumber = this.#startRead("inside");
    this.#queueTask(() => {
      this.#readReleasedPage(stretch, direction, request, read, readNumber, retry).catch(
        (error: unknown) => {
          this.#failInsideRead(retry, describeFailure(error));
        },
      );
    });
    return true;
  }

  /**
   * Starts reading the page at one end of the session's log, its first page for `head` or its
   * newest for `tail`, to put it in place of the store's whole window; answers whether it started,
   * not when the store holds that end already or no viewport measures the page. `beforePageLands`
   * runs just before the page takes the window's place, so the viewport is told before any render
   * of it; a read abandoned, overtaken by a newer read, refused or failed lands nothing, and a
   * refused or failed one reads as a failed read past that edge. A walk under way gives way to
   * it: the walk's next page finds its edge moved.
   */
  public jumpTo(side: WindowSide, read: TranscriptPageRead, beforePageLands: () => void): boolean {
    const newestCursor = this.#sessionStore.snapshot().streamAfterCursor;
    const measure = this.#measure;
    if (
      !this.#edgeOf(side).hasMore ||
      measure === undefined ||
      (side === "tail" && newestCursor === undefined)
    ) {
      return false;
    }
    const owedHeightPx = TRANSCRIPT_STRETCH_SCREEN_HEIGHTS * measure.screenHeightPx();
    const pending: PendingRead = {
      side,
      request: {
        sessionId: heldIdAsWireId(this.#sessionStore.sessionId),
        // No cursor reads forward from the log's start; the stream's newest position, backward.
        ...(side === "tail" ? { beforeCursor: newestCursor } : {}),
        limit: pageLimitFor(owedHeightPx, measure.smallestRowHeightPx()),
      },
      owedHeightPx,
    };
    this.#readLogEnd(pending, read, beforePageLands).catch((error: unknown) => {
      this.#failWalk(pending, error, undefined);
    });
    return true;
  }

  /** Reads `pending`'s page at an end of the log and puts it in place of the store's window. */
  async #readLogEnd(
    pending: PendingRead,
    read: TranscriptPageRead,
    beforePageLands: () => void,
  ): Promise<void> {
    const readNumber = this.#startRead(pending.side);
    try {
      const round = this.#readLine.openRound();
      const reply = await read(pending.request, { signal: round.signal });
      if (isReadAbandoned(round.signal) || this.#readCount !== readNumber) {
        return;
      }
      if (reply.status === "refused") {
        this.#recordFailedRead(pending, undefined);
        this.#recordCause("history-read-refused", refusalDetail(reply.refusal));
        return;
      }
      const page = readTranscriptPage(reply.value);
      beforePageLands();
      this.#sessionStore.replaceWithLogEndPage(pending.side === "head" ? "start" : "end", page);
    } finally {
      this.#endRead(readNumber);
    }
  }

  /**
   * Reads one page after another past an edge, starting with `pending`, until the stretch is
   * paid, the edge has no more, the edge moved or a read failed. The stretch is paid once the held
   * transcript, derived whole, is estimated `pending.owedHeightPx` taller than at the start. Each
   * page after the first is asked a frame after the last landed, so however fast pages answer, no
   * one task merges and derives a whole stretch. `readNumber` is the read `#startRead` marked, and
   * `retry` asks the stretch again from the catch-up line should a read fail.
   */
  async #walk(
    pending: PendingRead,
    read: TranscriptPageRead,
    measure: TranscriptStretchMeasure,
    readNumber: number,
    retry: () => boolean,
  ): Promise<void> {
    const { side } = pending;
    try {
      // A jump to an end of the log, asked while this read waited for its task, has taken over.
      if (this.#readCount !== readNumber) {
        return;
      }
      const targetHeightPx = this.#heldHeightPx(measure) + pending.owedHeightPx;
      let next = pending;
      for (;;) {
        const { request } = next;
        const round = this.#readLine.openRound();
        const reply = await read(request, { signal: round.signal });
        if (isReadAbandoned(round.signal)) {
          return;
        }
        if (reply.status === "refused") {
          this.#recordFailedRead(next, retry);
          this.#recordCause("history-read-refused", refusalDetail(reply.refusal));
          return;
        }
        if (this.#edgeOf(side).cursor !== cursorOf(side, request)) {
          return;
        }
        const page = readTranscriptPage(reply.value);
        if (side === "head") {
          this.#sessionStore.prependEarlierEvents(page);
        } else {
          this.#sessionStore.appendLaterEvents(page);
          this.#settleCatchUp("tail");
        }
        const owedHeightPx = targetHeightPx - this.#heldHeightPx(measure);
        const edge = this.#edgeOf(side);
        if (owedHeightPx <= 0 || !edge.hasMore || edge.cursor === undefined) {
          return;
        }
        next = this.#pendingRead(side, edge.cursor, owedHeightPx, measure);
        await this.#nextFrame();
        if (
          this.#readLine.isAbandoned ||
          this.#edgeOf(side).cursor !== cursorOf(side, next.request)
        ) {
          return;
        }
      }
    } finally {
      this.#endRead(readNumber);
    }
  }

  /**
   * Reads the page `request` asks inside `stretch` and adds it to the store, unless the store let
   * the stretch's bounds go meanwhile. `readNumber` is the read `#startRead` marked.
   */
  async #readReleasedPage(
    stretch: ReleasedEventStretch,
    direction: ReleasedStretchReadDirection,
    request: TranscriptReadRequest,
    read: TranscriptPageRead,
    readNumber: number,
    retry: () => boolean,
  ): Promise<void> {
    try {
      if (this.#readCount !== readNumber) {
        return;
      }
      const round = this.#readLine.openRound();
      const reply = await read(request, { signal: round.signal });
      if (isReadAbandoned(round.signal)) {
        return;
      }
      if (reply.status === "refused") {
        this.#failInsideRead(retry, refusalDetail(reply.refusal));
        return;
      }
      this.#sessionStore.readReleasedStretch(stretch, direction, readTranscriptPage(reply.value));
      this.#settleCatchUp("inside");
    } finally {
      this.#endRead(readNumber);
    }
  }

  /**
   * The page read `direction` inside `stretch`, sized to a stretch of the viewport, or `undefined`
   * once the store no longer holds the stretch.
   */
  #releasedStretchRequest(
    stretch: ReleasedEventStretch,
    direction: ReleasedStretchReadDirection,
    measure: TranscriptStretchMeasure,
  ): TranscriptReadRequest | undefined {
    const { transcript, releasedStretches } = this.#sessionStore.snapshot();
    const isHeld = releasedStretches.some(
      (held) =>
        held.lastHeldSequenceBefore === stretch.lastHeldSequenceBefore &&
        held.firstHeldCursorAfter === stretch.firstHeldCursorAfter,
    );
    const before = transcript.find((event) => event.sequence === stretch.lastHeldSequenceBefore);
    if (!isHeld || before === undefined) {
      return undefined;
    }
    const owedHeightPx = TRANSCRIPT_STRETCH_SCREEN_HEIGHTS * measure.screenHeightPx();
    return {
      sessionId: heldIdAsWireId(this.#sessionStore.sessionId),
      // A backward read answers the rows at or before its cursor, a forward one those after it.
      ...(direction === "backward"
        ? { beforeCursor: stretch.firstHeldCursorAfter }
        : { afterCursor: heldRowCursor(before) }),
      limit: pageLimitFor(owedHeightPx, measure.smallestRowHeightPx()),
    };
  }

  /** Marks a read under way, clearing the last failure where it reads; answers its number. */
  #startRead(place: HistoryReadPlace): number {
    this.#readCount += 1;
    this.#readingSide = place;
    if (place === "inside") {
      this.#hasInsideReadFailed = false;
    } else {
      this.#failedReadBySide.delete(place);
    }
    this.#announceChange();
    return this.#readCount;
  }

  /** Ends the read numbered `readNumber`; the side it read past stays marked for a newer one. */
  #endRead(readNumber: number): void {
    if (this.#readCount === readNumber) {
      this.#readingSide = undefined;
    }
    this.#announceChange();
  }

  /**
   * A walk that threw rather than settling: the edge reads as failed, and `Try again` sends its
   * first read again, or a fresh one when a page landed before the throw. The cause goes to the
   * window's diagnostic capture. `retry` offers a read toward the tail on the catch-up line.
   */
  #failWalk(pending: PendingRead, error: unknown, retry: (() => boolean) | undefined): void {
    this.#recordFailedRead(pending, retry);
    this.#announceChange();
    this.#recordCause("history-read-failed", describeFailure(error));
  }

  /**
   * Marks the read past `failed.side` failed, and a read toward the tail failed on the catch-up
   * line too, which `retry` sends again: no line past the tail offers it.
   */
  #recordFailedRead(failed: PendingRead, retry: (() => boolean) | undefined): void {
    this.#failedReadBySide.set(failed.side, failed);
    this.#countFailure(failed.side);
    if (failed.side === "tail" && retry !== undefined) {
      this.#offerOnCatchUpLine("tail", retry);
    }
  }

  /** A read inside the window that failed: it stands on the catch-up line, which `retry` sends. */
  #failInsideRead(retry: () => boolean, cause: string): void {
    this.#hasInsideReadFailed = true;
    this.#countFailure("inside");
    this.#offerOnCatchUpLine("inside", retry);
    this.#announceChange();
    this.#recordCause("history-read-failed", cause);
  }

  #countFailure(place: HistoryReadPlace): void {
    this.#failureCountBySide.set(place, (this.#failureCountBySide.get(place) ?? 0) + 1);
  }

  /** Records why a read failed in the window's diagnostic capture; the screen names no cause. */
  #recordCause(kind: string, cause: string): void {
    windowDiagnosticCapture.record({
      at: diagnosticStampAt(this.#clock),
      severity: "error",
      source: "features/transcript/history",
      kind,
      detail: `session ${this.#sessionStore.sessionId}: ${cause}`,
    });
  }

  #offerOnCatchUpLine(place: CatchUpReadPlace, retry: () => boolean): void {
    this.#catchUpRetries.set(place, retry);
    this.#sessionStore.failedDependentReads.markFailed(this.#catchUpRead);
  }

  /** A page landed where a failed read stood, so the catch-up line no longer offers that one. */
  #settleCatchUp(place: CatchUpReadPlace): void {
    if (this.#catchUpRetries.delete(place) && this.#catchUpRetries.size === 0) {
      this.#sessionStore.failedDependentReads.forget(this.#catchUpRead);
    }
  }

  /**
   * The catch-up line's `Try again`: the first failed read that still has one to send is sent
   * again, as reads go one at a time; a read with nothing left to send is no longer offered, and
   * another failed read stays offered for the next press.
   */
  #retryForCatchUp(): void {
    for (const [place, retry] of this.#catchUpRetries) {
      if (retry()) {
        return;
      }
      this.#settleCatchUp(place);
    }
  }

  /** The read past `cursor` that owes `owedHeightPx`, its limit sized from that height. */
  #pendingRead(
    side: WindowSide,
    cursor: EventCursor,
    owedHeightPx: number,
    measure: TranscriptStretchMeasure,
  ): PendingRead {
    return {
      side,
      request: {
        sessionId: heldIdAsWireId(this.#sessionStore.sessionId),
        ...(side === "head" ? { beforeCursor: cursor } : { afterCursor: cursor }),
        limit: pageLimitFor(owedHeightPx, measure.smallestRowHeightPx()),
      },
      owedHeightPx,
    };
  }

  #nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.#clock.scheduleFrame(resolve);
    });
  }

  /** The estimated height of the whole transcript the store holds, drawn as the feed draws it. */
  #heldHeightPx(measure: TranscriptStretchMeasure): number {
    return measure.heldHeightPx(this.#sessionStore.snapshot().transcript);
  }

  #edgeOf(side: WindowSide): TranscriptWindowEdge {
    const state = this.#sessionStore.snapshot();
    return side === "head" ? state.transcriptHead : state.transcriptTail;
  }

  #edgeState(place: HistoryReadPlace, hasMore: boolean): HistoryEdgeState {
    return {
      hasMore,
      isReading: this.#readingSide === place,
      hasFailed: place === "inside" ? this.#hasInsideReadFailed : this.#failedReadBySide.has(place),
      failureCount: this.#failureCountBySide.get(place) ?? 0,
    };
  }

  #announceChange(): void {
    this.#state = undefined;
    this.#changes.emit(undefined);
  }
}

/** Where a read reaches: past one edge of the store's window, or inside it. */
type HistoryReadPlace = WindowSide | "inside";

/** The reads the catch-up line offers again: toward the tail, and inside the window. */
type CatchUpReadPlace = Exclude<HistoryReadPlace, "head">;

/** What a refused read says of why, for the diagnostic capture. */
function refusalDetail(refusal: { readonly code: string; readonly detail: string }): string {
  return `${refusal.code}: ${refusal.detail}`;
}

/** A read past one edge and the height its stretch still owes: the next to send, or one failed. */
interface PendingRead {
  readonly side: WindowSide;
  readonly request: TranscriptReadRequest;
  readonly owedHeightPx: number;
}

/** The edge cursor a request was asked from. */
function cursorOf(side: WindowSide, request: TranscriptReadRequest): EventCursor | undefined {
  return side === "head" ? request.beforeCursor : request.afterCursor;
}
