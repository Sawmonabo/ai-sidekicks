// After the viewport's window lets rows go, the store lets go of the events no held row is drawn
// from, the calls each long run's window leaves out among them, so the window's memory stays flat
// however long the session runs. A return reads them again through the history reader, as any
// stretch past an edge of the store's window or inside it. The release runs in a task of its own
// after the commit that let the rows go: the feed it re-renders is drawn after the task the
// window's pass ran in, not inside it.

import { useEffect, useRef } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type ViewportRow, type ViewportSnapshot } from "../../viewport/snapshot.js";
import { type PruneOutcome } from "../../viewport/window-cap.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { keptEventCursors, type KeptEventSources } from "../kept-events.js";
import { queueTaskIn } from "#renderer/lib/queued-task.js";
import { type TranscriptHistory } from "./useTranscriptHistory.js";

/** The store whose events go, the window that let rows go, and what its rows are drawn from. */
export interface ReleaseOutsideWindowInputs {
  /** The reader a return reads the events again through; with none, nothing is let go. */
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  readonly snapshot: ViewportSnapshot;
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the viewport draws: folded by run group, holding only rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
  /** The rows held out of that window until they draw whole, whose events wait to be drawn. */
  readonly preparingRows: readonly ViewportRow[];
  /**
   * An open run group's window as the feed last cut it, reaching on over the calls read ahead past
   * an edge line in the drawn band, or `undefined` for a folded group.
   */
  readonly callWindowOf: KeptEventSources["callWindowOf"];
}

/**
 * Lets the store go of the events outside the window after the passes that let rows go, in a task
 * of its own, read against the window as the last commit before it drew it.
 */
export function useReleaseOutsideWindow(inputs: ReleaseOutsideWindowInputs): void {
  const { sessionStore } = inputs;
  const ownerWindow = useOwnerWindow();
  const release = useRef<OutsideWindowRelease | undefined>(undefined);
  useEffect(() => {
    const mounted = new OutsideWindowRelease(sessionStore, (task) => {
      queueTaskIn(ownerWindow, task);
    });
    release.current = mounted;
    return () => {
      mounted.dispose();
      release.current = undefined;
    };
  }, [sessionStore, ownerWindow]);
  // After every commit, since the queued release reads the window as the last one drew it.
  useEffect(() => {
    if (inputs.history === undefined) {
      return;
    }
    const { lastPrune, rows } = inputs.snapshot;
    release.current?.noteCommit(lastPrune, {
      rows,
      preparingRows: inputs.preparingRows,
      unfurledWindow: inputs.unfurledWindow,
      transcriptWindow: inputs.transcriptWindow,
      log: sessionStore.snapshot().transcript,
      callWindowOf: inputs.callWindowOf,
    });
  });
}

/** The window as one commit drew it: its rows, the rows waiting to join it, and their sources. */
interface CommittedWindow extends KeptEventSources {
  readonly rows: readonly ViewportRow[];
  readonly preparingRows: readonly ViewportRow[];
}

/** The release the window's passes owe the store, queued once and run after their commits. */
class OutsideWindowRelease {
  readonly #sessionStore: SessionStore;
  readonly #queueTask: (task: () => void) => void;
  /** Every row key the passes let go since the last release, which the next one moves past. */
  #letGoRowKeys: string[] = [];
  /** The last pass outcome taken in, so a commit that publishes it again adds nothing. */
  #lastPrune: PruneOutcome | undefined;
  #committed: CommittedWindow | undefined;
  #isQueued = false;
  #isDisposed = false;

  public constructor(sessionStore: SessionStore, queueTask: (task: () => void) => void) {
    this.#sessionStore = sessionStore;
    this.#queueTask = queueTask;
  }

  /** Takes in one commit's window and its last pass, queueing the release a cut owes. */
  public noteCommit(lastPrune: PruneOutcome | undefined, committed: CommittedWindow): void {
    if (lastPrune !== undefined && lastPrune !== this.#lastPrune) {
      this.#lastPrune = lastPrune;
      if (lastPrune.applied) {
        this.#letGoRowKeys.push(...lastPrune.prunedKeys);
      }
    }
    this.#committed = committed;
    if (this.#letGoRowKeys.length === 0 || this.#isQueued) {
      return;
    }
    this.#isQueued = true;
    this.#queueTask(() => {
      this.#isQueued = false;
      this.#release();
    });
  }

  /** Drops what is owed: a mount that is gone holds no rows to keep. */
  public dispose(): void {
    this.#isDisposed = true;
  }

  #release(): void {
    const committed = this.#committed;
    if (this.#isDisposed || committed === undefined || this.#letGoRowKeys.length === 0) {
      return;
    }
    // The store moved after that commit, so its rows may not be drawn yet: the commit that draws
    // them takes them in and queues this again.
    if (this.#sessionStore.snapshot().transcript !== committed.log) {
      return;
    }
    const letGoRowKeys = this.#letGoRowKeys;
    this.#letGoRowKeys = [];
    // A held row is about to be drawn, so its events stay however far the window's edges moved.
    const heldRows = [...committed.rows, ...committed.preparingRows];
    const kept = keptEventCursors(letGoRowKeys, heldRows, committed);
    if (kept !== undefined) {
      this.#sessionStore.releaseOutside(
        kept.firstKeptCursor,
        kept.lastKeptCursor,
        kept.releasedBetween,
      );
    }
  }
}
