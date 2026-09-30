// Sends one worktree removal. The settlement goes to a recorder (the confirmation that asked)
// rather than a published snapshot: it records one act, never goes stale, and no refresh would
// re-send it. A rejected call is not caught here: the in-flight guard is released and the
// rejection propagates to the caller.

import type { WorktreeId, WorktreeRetireResponse } from "@ai-sidekicks/contracts";

import type { RepoOperations } from "../../repo-operations.js";

/** The one call this controller makes. */
export type RootRemovalOperations = Pick<RepoOperations, "retireWorktree">;

/** Where one removal stands. */
export type RootRemovalReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "settled"; readonly state: WorktreeRetireResponse["state"] };

/** Where a settlement lands: the confirmation that asked for the removal. */
export interface RootRemovalRecorder {
  /** Record where this removal stands: the send and the settlement each reach it. */
  recordRemoval(reading: RootRemovalReading): void;
}

/** What one removal controller is scoped to, and who it reports to. */
export interface RootRemovalControllerOptions {
  readonly operations: RootRemovalOperations;
  /** The worktree's own id, sent verbatim. */
  readonly rootId: string;
  readonly recorder: RootRemovalRecorder;
}

/** Sends one root's removal and reports what came back. */
export class RootRemovalController {
  readonly #operations: RootRemovalOperations;
  readonly #rootId: string;
  readonly #recorder: RootRemovalRecorder;
  #inFlight = false;
  #disposed = false;

  public constructor(options: RootRemovalControllerOptions) {
    this.#operations = options.operations;
    this.#rootId = options.rootId;
    this.#recorder = options.recorder;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Terminal. A reply still on the wire is dropped, not reported to a torn-down confirmation. */
  public dispose(): void {
    this.#disposed = true;
  }

  /**
   * Send this root's removal. A second press while a call is on the wire is ignored, so one
   * intent never sends two removals.
   */
  public async send(): Promise<void> {
    if (this.#inFlight || this.#disposed) {
      return;
    }
    this.#inFlight = true;
    this.#recorder.recordRemoval({ status: "sending" });
    try {
      // The ordinary removal: this confirm offers no discard, so a tree that changed since its
      // risks were read is refused with the current ones rather than removed.
      const reply = await this.#operations.retireWorktree({
        worktreeId: this.#rootId as WorktreeId,
        discard: false,
      });
      if (this.#disposed) {
        return;
      }
      // The reply carries `state` and no cleanup instant; that lands on the status read later.
      this.#recorder.recordRemoval({ status: "settled", state: reply.state });
    } finally {
      // Released on every exit: a guard that survived a failed send would refuse every retry.
      this.#inFlight = false;
    }
  }
}
