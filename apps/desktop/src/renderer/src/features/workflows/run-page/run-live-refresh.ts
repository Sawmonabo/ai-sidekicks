// Counts the moves of the run a pane shows, as a refresh count the pane's snapshot read is keyed
// on.
// Event-driven, no timer: `SessionRefreshTriggers` watches the session store's own transitions
// (no second subscription) and `RefreshScheduler` coalesces them. A new key supersedes the read
// itself, so nothing here supersedes an in-flight answer. Frames are scoped to one run.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/** What one live-refresh reading is opened against. */
export interface WorkflowRunLiveRefreshOptions {
  /** The window's clock, which the coalescing window is measured on. */
  readonly clock: Clock;
  /** Absent on a pane with no session (opened before one is chosen); observes nothing. */
  readonly sessionStore: SessionStore | undefined;
  /** Absent on a pane that names no run: every frame naming a run then names a different one. */
  readonly workflowRunId: string | undefined;
}

/** How many times the run under this pane has been reported as moved; each advance is a new key. */
export class WorkflowRunLiveRefresh implements ReadTriggerTarget {
  /**
   * Every `workflow.*` type: a run read projects status, phases, parks and the pin, so any of them
   * can move what the pane draws. The run is the other half of the question, see
   * {@link admitsTriggeringEvent}.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = WORKFLOW_EVENT_TYPES;

  readonly #scheduler: RefreshScheduler;
  /** Absent with no session: there is nothing to observe and nothing to detach. */
  readonly #triggers: SessionRefreshTriggers | undefined;
  readonly #sessionStore: SessionStore | undefined;
  readonly #workflowRunId: string | undefined;
  readonly #changes = new Emitter<number>("workflow run live refresh");

  #refreshCount = 0;
  #started = false;
  #disposed = false;

  public constructor(options: WorkflowRunLiveRefreshOptions) {
    this.#sessionStore = options.sessionStore;
    this.#workflowRunId = options.workflowRunId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      // A burst of frames (a fan-out completing four phases) collapses into one advance. The
      // performer's `ReadRound` goes unused: nothing goes on the wire, and the read this refresh
      // drives is superseded by its own subject key. No `onError`: a rejection can only be a
      // subscriber throwing, a renderer defect that must surface.
      perform: () => {
        this.#advance();
        return Promise.resolve();
      },
    });
    this.#triggers =
      options.sessionStore === undefined
        ? undefined
        : new SessionRefreshTriggers({ target: this, sessionStore: options.sessionStore });
  }

  /** The refresh the caller keys its read on. Starts at zero and only ever rises. */
  public get snapshot(): number {
    return this.#refreshCount;
  }

  /** Whether this reading has ended. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether this reading watches `sessionStore`. A store rebuilt for the same session across a
   * reconnect keeps its key but is a different object; without this check the refresh would stop
   * advancing silently.
   */
  public isReadingFor(sessionStore: SessionStore | undefined): boolean {
    return this.#sessionStore === sessionStore;
  }

  /**
   * Whether this frame is about this run: admitted unless it names a different run. A frame with
   * no run id is admitted because some census types have no registered payload, so demanding one
   * would leave the pane stale. With no run addressed, every named frame is refused.
   */
  public admitsTriggeringEvent(event: ProjectedSessionEvent): boolean {
    const namedRunId = workflowRunIdOfEventPayload(event.payload);
    return namedRunId === undefined || namedRunId === this.#workflowRunId;
  }

  /** Begin observing. Idempotent: React strict mode mounts an effect twice in development. */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers?.start();
  }

  public subscribe(sink: (refresh: number) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Ask for the refresh to advance. The scheduler decides what a burst costs. */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /** Terminal: no later frame or focus advances a refresh, and no timer outlives the pane. */
  public dispose(): void {
    this.#disposed = true;
    this.#triggers?.dispose();
    this.#scheduler.dispose();
  }

  #advance(): void {
    if (this.#disposed) {
      return;
    }
    this.#refreshCount += 1;
    this.#changes.emit(this.#refreshCount);
  }
}

const WORKFLOW_EVENT_TYPES: ReadonlySet<string> = new Set(
  [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter((type) => type.startsWith("workflow.")),
);

function workflowRunIdOfEventPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const named = payload?.["workflowRunId"];
  return typeof named === "string" ? named : undefined;
}
