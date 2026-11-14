// How far a WebAssembly module the markdown worker compiles for the page has loaded: the fuzzy
// matcher's, asked for by every worker until it is in hand, and the workflow checks', asked for
// only once something on the page first needs them. Each is handed to its holder the same way; a
// module that was not compiled, or did not start, is asked for again on the next ask, and a load
// whose worker ended before it answered is tried once more before it reads as failed.

import type { FuzzyMatcher } from "@ai-sidekicks/search-ranking";
import {
  isWorkflowCheckModuleProvided,
  provideWorkflowCheckModule,
  subscribeToWorkflowCheckModule,
} from "@ai-sidekicks/contracts/workflow/definition/check";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { appFuzzyMatcher } from "#renderer/lib/fuzzy-matcher.js";
import type { CompiledPageModule } from "./messages.js";

/** Where a module stands: never asked for, being compiled, running, or not started. */
export type PageModuleState = "unasked" | "loading" | "ready" | "failed";

/** What a compiled module is handed to: whether it holds one, the hand-over, and its arrival. */
export interface PageModuleHolder {
  readonly isProvided: () => boolean;
  /** Starts `module`; throws when it does not start. */
  readonly provide: (module: WebAssembly.Module) => void;
  /** Calls `listener` once the holder starts a module; the returned function stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** One page module as the markdown worker's connection loads it. */
export class PageModuleLoad {
  readonly #holder: PageModuleHolder;
  /** The diagnostic kind a module that did not start is recorded under. */
  readonly #failureKind: string;
  readonly #listeners = new Set<() => void>();
  #state: Exclude<PageModuleState, "ready"> = "unasked";
  /** Whether this load already outlived one worker, so the next worker's end fails it. */
  #isTriedAgain = false;

  /** Calls `listener` each time the state moves; the returned function stops it. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    const stopReady = this.#holder.subscribe(listener);
    return () => {
      this.#listeners.delete(listener);
      stopReady();
    };
  };

  public constructor(holder: PageModuleHolder, failureKind: string) {
    this.#holder = holder;
    this.#failureKind = failureKind;
  }

  /** Where the module stands now; `ready` once its holder runs it. */
  public get state(): PageModuleState {
    return this.#holder.isProvided() ? "ready" : this.#state;
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
    this.#isTriedAgain = false;
    this.#move("loading");
    return true;
  }

  /**
   * Takes what a worker compiled. A module that was not compiled, or does not start, is recorded
   * and leaves the load failed until it is asked for again.
   */
  public provide(compiled: CompiledPageModule): void {
    if (this.state !== "loading") {
      return;
    }
    if (compiled.status === "absent") {
      this.fail(new Error(compiled.reason));
      return;
    }
    try {
      this.#holder.provide(compiled.module);
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  /** Records why the load on its way failed, and leaves it failed until it is asked for again. */
  public fail(failure: unknown): void {
    recordRejectedRequest("components/Markdown/worker", this.#failureKind, failure);
    this.#move("failed");
  }

  /**
   * The worker that was to compile the module is gone. A load on its way stays wanted for the next
   * worker the first time, since a worker ends for causes that pass, and fails the second.
   */
  public dropLoad(): void {
    if (this.state !== "loading") {
      return;
    }
    if (this.#isTriedAgain) {
      this.#move("failed");
      return;
    }
    this.#isTriedAgain = true;
  }

  #move(state: Exclude<PageModuleState, "ready">): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** `matcher` as the holder of its module. */
export function fuzzyMatcherHolder(matcher: FuzzyMatcher): PageModuleHolder {
  return {
    isProvided: () => matcher.isReady,
    provide: (module) => {
      matcher.provide(module);
    },
    subscribe: matcher.subscribe,
  };
}

/** The holder of the page's workflow checks, the contracts' own module slot. */
export const WORKFLOW_CHECKS_HOLDER: PageModuleHolder = {
  isProvided: isWorkflowCheckModuleProvided,
  provide: provideWorkflowCheckModule,
  subscribe: subscribeToWorkflowCheckModule,
};

/** The app's workflow checks, which the markdown worker's connection loads on first need. */
export const appWorkflowChecks: PageModuleLoad = new PageModuleLoad(
  WORKFLOW_CHECKS_HOLDER,
  "workflow-checks-not-started",
);

/** The app's fuzzy matcher's module, which the markdown worker's connection loads at its start. */
export const appFuzzyMatcherLoad: PageModuleLoad = new PageModuleLoad(
  fuzzyMatcherHolder(appFuzzyMatcher),
  "fuzzy-matcher-not-started",
);
