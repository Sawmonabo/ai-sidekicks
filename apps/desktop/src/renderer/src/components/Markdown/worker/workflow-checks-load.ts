// How far the page's workflow checks have loaded. Their module is compiled only once something on
// the page first needs them, by the markdown worker, and handed to the contracts' checks, which
// answer once it runs; a module that was not compiled, or did not start, is asked for again.

import {
  isWorkflowCheckModuleProvided,
  provideWorkflowCheckModule,
  subscribeToWorkflowCheckModule,
} from "@ai-sidekicks/contracts/workflow/definition/check";

import type { CompiledPageModule } from "./messages.js";

/** Where the checks stand: never asked for, being compiled, answering, or not started. */
export type WorkflowChecksState = "unasked" | "loading" | "ready" | "failed";

/** The page's workflow checks as the markdown worker's connection loads them. */
export class WorkflowChecksLoad {
  readonly #listeners = new Set<() => void>();
  #state: Exclude<WorkflowChecksState, "ready"> = "unasked";

  /** Calls `listener` each time the state moves; the returned function stops it. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    const stopReady = subscribeToWorkflowCheckModule(listener);
    return () => {
      this.#listeners.delete(listener);
      stopReady();
    };
  };

  /** Where the checks stand now; `ready` once the contracts' checks hold their module. */
  public get state(): WorkflowChecksState {
    return isWorkflowCheckModuleProvided() ? "ready" : this.#state;
  }

  /** Whether a worker should compile the module: it was asked for and is not in hand. */
  public get isModuleWanted(): boolean {
    return this.state === "loading";
  }

  /**
   * Asks for the module where it is neither in hand nor on its way, a failed load included, and
   * answers whether a worker must now be asked to compile it.
   */
  public want(): boolean {
    const state = this.state;
    if (state === "ready" || state === "loading") {
      return false;
    }
    this.#move("loading");
    return true;
  }

  /**
   * Takes what a worker compiled. A module that was not compiled, or does not start, is recorded
   * through `onFailure` and leaves the checks failed until they are asked for again.
   */
  public provide(compiled: CompiledPageModule, onFailure: (failure: unknown) => void): void {
    if (this.state !== "loading") {
      return;
    }
    if (compiled.status === "absent") {
      onFailure(new Error(compiled.reason));
      this.#move("failed");
      return;
    }
    try {
      provideWorkflowCheckModule(compiled.module);
    } catch (error: unknown) {
      onFailure(error);
      this.#move("failed");
    }
  }

  /** The worker that was to compile the module is gone, so a load on its way has failed. */
  public dropLoad(): void {
    if (this.state === "loading") {
      this.#move("failed");
    }
  }

  #move(state: Exclude<WorkflowChecksState, "ready">): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** The app's workflow checks, which the markdown worker's connection loads. */
export const appWorkflowChecks: WorkflowChecksLoad = new WorkflowChecksLoad();
