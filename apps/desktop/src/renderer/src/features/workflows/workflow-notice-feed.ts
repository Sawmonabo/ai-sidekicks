// The one subscription the workflows screens hold on the machine's workflow stream, never one
// per row or per read. It keeps the start hold the stream opens with and every later hold frame,
// and turns each run, step and removal frame into a signal naming the run it moved, so the runs
// list, the attention list and an open run's page each read again on the frames that concern
// them. A schedule frame moves none of them, so it is not signaled.
//
// A subscription that cannot open is the feed's failed state, rendered where the hold switch
// stands; the reads beside it still answer, they only stop refreshing. So is a stream that ended
// and could not open again, until a re-open works: the hold it opens with sets the feed open.
//
// The feed lives as long as the screen and its reads: the stream is closed while nothing on
// screen draws from it and opened again when something does, and each opening after the first
// signals every run, since anything may have moved while it was closed.

import type { WorkflowRunsPauseState } from "@ai-sidekicks/contracts/workflow/run/records";

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import type { WorkflowNoticeFrame } from "#renderer/services/daemon/workflow-notices.js";

/** Where the feed stands: opening, open with the hold as last told, or refused while it is down. */
export type WorkflowNoticeFeedState =
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly pause: WorkflowRunsPauseState | undefined }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/**
 * Which runs a frame moved: one run by id, or every run (a removal of several, a definition's
 * new name, a frame that could not be read, a stream opened again after it ended). The frame of a
 * step a person has just answered, wherever they answered it, says so.
 */
export type WorkflowRunSignal =
  | { readonly scope: "run"; readonly workflowRunId: string; readonly isAnswered?: boolean }
  | { readonly scope: "all" };

/**
 * Opens the stream and hands each frame on; the caller's release closes it. It never throws: a
 * stream that cannot open arrives as a `reopenRefused` frame.
 */
export type SubscribeWorkflowNotices = (
  onFrame: (frame: WorkflowNoticeFrame) => void,
) => Unsubscribe;

/** The workflow stream as the workflows screens hear it: the hold, and which runs moved. */
export class WorkflowNoticeFeed {
  readonly #subscribe: SubscribeWorkflowNotices;
  readonly #changes = new Emitter<void>("workflow notice feed");
  readonly #runSignals = new Emitter<WorkflowRunSignal>("workflow run signal");
  #state: WorkflowNoticeFeedState = { kind: "opening" };
  #release: Unsubscribe | undefined;
  #hasOpened = false;
  #disposed = false;

  public constructor(subscribe: SubscribeWorkflowNotices) {
    this.#subscribe = subscribe;
  }

  /** The current state; a stable reference between changes, for `useSyncExternalStore`. */
  public get state(): WorkflowNoticeFeedState {
    return this.#state;
  }

  /** Whether {@link dispose} has run, so a holder re-mounting this feed opens a fresh one. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Be told when the state changes. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Be told which runs each frame moved. */
  public onRunSignal(listener: (signal: WorkflowRunSignal) => void): Unsubscribe {
    return this.#runSignals.subscribe(listener);
  }

  /**
   * Open the stream, signaling every run when it opens again after a close. Idempotent while it
   * is open; a no-op once disposed.
   */
  public start(): void {
    if (this.#disposed || this.#release !== undefined) {
      return;
    }
    const release = this.#subscribe((frame) => {
      this.#receive(frame);
    });
    if (this.#disposed) {
      release();
      return;
    }
    this.#release = release;
    // A first open refused while it was being made has already settled the feed as failed.
    if (this.#state.kind === "opening") {
      this.#settle({ kind: "open", pause: undefined });
    }
    if (this.#hasOpened) {
      this.#runSignals.emit({ scope: "all" });
    }
    this.#hasOpened = true;
  }

  /** Close the stream and go back to `opening`, keeping every listener for the next start. */
  public stop(): void {
    const release = this.#release;
    if (release === undefined) {
      return;
    }
    this.#release = undefined;
    release();
    this.#settle({ kind: "opening" });
  }

  /** Close the stream and drop every listener. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const release = this.#release;
    this.#release = undefined;
    release?.();
    this.#changes.clear();
    this.#runSignals.clear();
  }

  #receive(frame: WorkflowNoticeFrame): void {
    if (this.#disposed) {
      return;
    }
    if (frame.kind === "reopenRefused") {
      this.#settle({ kind: "failed", refusal: frame.refusal });
      return;
    }
    // A frame that could not be read, or a stream opened again after a gap: any run may have
    // moved unheard, so every read reads again.
    if (frame.kind === "unreadable" || frame.kind === "reopened") {
      this.#runSignals.emit({ scope: "all" });
      return;
    }
    const { notice } = frame;
    switch (notice.kind) {
      case "runsPause":
        this.#settle({
          kind: "open",
          pause: { paused: notice.paused, waitingStartCount: notice.waitingStartCount },
        });
        return;
      case "run":
        this.#runSignals.emit({ scope: "run", workflowRunId: notice.run.workflowRunId });
        return;
      case "step":
        this.#runSignals.emit({
          scope: "run",
          workflowRunId: notice.workflowRunId,
          isAnswered: notice.step.resolution !== undefined,
        });
        return;
      case "runsRemoved":
        for (const workflowRunId of notice.workflowRunIds) {
          this.#runSignals.emit({ scope: "run", workflowRunId });
        }
        return;
      case "definition":
      case "definitionRemoved":
        this.#runSignals.emit({ scope: "all" });
        return;
      case "schedule":
        return;
    }
  }

  #settle(next: WorkflowNoticeFeedState): void {
    this.#state = next;
    this.#changes.emit();
  }
}
