// Reads the session's history past the edges of the window its store holds: backward before the
// head, forward after a tail that was let go or never read. A stretch is a height, not a row count:
// pages are read until the whole held transcript is estimated that much taller than when the read
// began, or the daemon has no more, each page's limit sized from the height still owed. This holds
// no rows and no position: pages go into the store, and every read is asked from the store's own
// edge.

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
import type { TranscriptWindowEdge } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { TRANSCRIPT_STRETCH_SCREEN_HEIGHTS } from "../viewport/caps.js";
import { type WindowSide } from "../viewport/window-cap.js";
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

/** The history past both edges: `earlier` before the head, `later` after the tail. */
export interface TranscriptHistoryState {
  readonly earlier: HistoryEdgeState;
  readonly later: HistoryEdgeState;
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
  /** The clock a failure the reader could not settle is stamped with. */
  readonly #clock: Clock;
  /**
   * The line every read goes out on, ended by {@link abandonReads} when the transcript holding
   * this reader leaves.
   */
  readonly #readLine = new ReadScope();
  readonly #changes = new Emitter<void>("transcript history state");
  #readingSide: WindowSide | undefined;
  /** The read that failed past each edge, which asking for that edge again sends unchanged. */
  readonly #failedReadBySide = new Map<WindowSide, PendingRead>();
  readonly #failureCountBySide = new Map<WindowSide, number>();
  /** The viewport the transcript is laid out in, while one is. */
  #measure: TranscriptStretchMeasure | undefined;
  /** The state last read; it stands while the reader and each edge's `hasMore` stay put. */
  #state: TranscriptHistoryState | undefined;

  public constructor(sessionStore: SessionStore, clock: Clock) {
    this.#sessionStore = sessionStore;
    this.#clock = clock;
  }

  /** Whether this reader's read line is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#readLine.isAbandoned;
  }

  /** Ends the read line: the read in flight stops and nothing it brings lands. */
  public abandonReads(): void {
    this.#readLine.abandon();
  }

  /**
   * The history as it stands, read against the store's edges. The same value until the reader
   * moves or an edge's `hasMore` changes, the one edge fact it reports, so it can serve as an
   * external store's snapshot even while every streamed row moves the live tail.
   */
  public state(): TranscriptHistoryState {
    const { transcriptHead, transcriptTail } = this.#sessionStore.snapshot();
    if (
      this.#state !== undefined &&
      this.#state.earlier.hasMore === transcriptHead.hasMore &&
      this.#state.later.hasMore === transcriptTail.hasMore
    ) {
      return this.#state;
    }
    this.#state = {
      earlier: this.#edgeState("head", transcriptHead),
      later: this.#edgeState("tail", transcriptTail),
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
   * flight, or no viewport to measure the stretch in, leaves this one unasked.
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
    this.#walk(pending, read, measure).catch((error: unknown) => {
      this.#failWalk(pending, error);
    });
    return true;
  }

  /**
   * Reads one page after another past an edge, starting with `pending`, until the stretch is
   * paid, the edge has no more, the edge moved or a read failed. The stretch is paid once the held
   * transcript, derived whole, is estimated `pending.owedHeightPx` taller than at the start.
   */
  async #walk(
    pending: PendingRead,
    read: TranscriptPageRead,
    measure: TranscriptStretchMeasure,
  ): Promise<void> {
    const { side } = pending;
    this.#readingSide = side;
    this.#failedReadBySide.delete(side);
    this.#announceChange();
    try {
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
          this.#recordFailedRead(next);
          return;
        }
        if (this.#edgeOf(side).cursor !== cursorOf(side, request)) {
          return;
        }
        const page = readTranscriptPage(reply.value);
        if (side === "head") {
          this.#sessionStore.prependEarlierEvents(page.events, page.edge);
        } else {
          this.#sessionStore.appendLaterEvents(page.events, page.edge);
        }
        const owedHeightPx = targetHeightPx - this.#heldHeightPx(measure);
        const edge = this.#edgeOf(side);
        if (owedHeightPx <= 0 || !edge.hasMore || edge.cursor === undefined) {
          return;
        }
        next = this.#pendingRead(side, edge.cursor, owedHeightPx, measure);
      }
    } finally {
      this.#readingSide = undefined;
      this.#announceChange();
    }
  }

  /**
   * A walk that threw rather than settling: the edge reads as failed, and `Try again` sends its
   * first read again, or a fresh one when a page landed before the throw. The cause goes to the
   * window's diagnostic capture.
   */
  #failWalk(pending: PendingRead, error: unknown): void {
    this.#recordFailedRead(pending);
    this.#announceChange();
    windowDiagnosticCapture.record({
      at: diagnosticStampAt(this.#clock),
      severity: "error",
      source: "features/transcript/history",
      kind: "history-read-failed",
      detail: `session ${this.#sessionStore.sessionId}: ${describeFailure(error)}`,
    });
  }

  #recordFailedRead(failed: PendingRead): void {
    this.#failedReadBySide.set(failed.side, failed);
    this.#failureCountBySide.set(failed.side, (this.#failureCountBySide.get(failed.side) ?? 0) + 1);
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

  /** The estimated height of the whole transcript the store holds, drawn as the feed draws it. */
  #heldHeightPx(measure: TranscriptStretchMeasure): number {
    return measure.heldHeightPx(this.#sessionStore.snapshot().transcript);
  }

  #edgeOf(side: WindowSide): TranscriptWindowEdge {
    const state = this.#sessionStore.snapshot();
    return side === "head" ? state.transcriptHead : state.transcriptTail;
  }

  #edgeState(side: WindowSide, edge: TranscriptWindowEdge): HistoryEdgeState {
    return {
      hasMore: edge.hasMore,
      isReading: this.#readingSide === side,
      hasFailed: this.#failedReadBySide.has(side),
      failureCount: this.#failureCountBySide.get(side) ?? 0,
    };
  }

  #announceChange(): void {
    this.#state = undefined;
    this.#changes.emit(undefined);
  }
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
