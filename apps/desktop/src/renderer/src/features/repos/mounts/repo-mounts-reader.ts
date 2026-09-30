// Reads a session's mounts, workspaces and roots through the console's one `RefreshScheduler`,
// which coalesces a burst of reasons into one read and never overlaps two. Reads happen on
// subscribe, window focus, reconnect and the terminal events this class names, never on an
// interval. The order is forced by the wire: there is no mount list call, so mounts are learned
// from the workspace roster, then read once per distinct mount (the only read carrying
// `health`), then worktree status once per mount. A rejected call is not caught here: the
// scheduler re-throws it and the reading stays where it was. The state is not in the session
// store because a mount read is a probe, not an event projection.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
  WorktreeStatusRecord,
} from "@ai-sidekicks/contracts";
import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { type ReadRound } from "@renderer/lib/reads/read-scope.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  ExecutionModeSelections,
  type RepoMountsReadingPublisher,
} from "./execution-mode-selection.js";
import { REPO_MOUNTS_NOT_READ, type RepoMountsReading } from "./repo-mounts-model.js";
import type { RepoOperations } from "../repo-operations.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../repo-lifecycle-events.js";

/** What one section reader collaborates with. */
export interface RepoMountsReaderOptions {
  /** The reads and the mode switch this section makes; nothing else reaches the daemon. */
  readonly operations: RepoOperations;
  /**
  /**
   * The session being read and two of the three reasons to read again. A store, not a bare id:
   * a `workspace.stale` frame and the repair edge that stands for reconnect are transitions of
   * this object, and the id is read off it so the two never name different sessions.
   */
  readonly sessionStore: SessionStore;
  /**
   * The clock this section's reading is stamped with, and the scheduler measures from. Required:
   * a wall-clock default would stamp `readAtMilliseconds` on a different time base than the
   * window's, and every age drawn against it would change string daily.
   */
  readonly clock: Clock;
}

/** Reads a session's mounts, workspaces and roots, and owns the mode switch. */
export class RepoMountsReader implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this section a fresh read. Declared here so two readers of one
   * answer cannot watch different frames; `repo-lifecycle-events.ts` derives the set.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #operations: RepoOperations;
  readonly #sessionStore: SessionStore;
  readonly #sessionId: string;
  readonly #clock: Clock;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #selections: ExecutionModeSelections;
  readonly #changes = new Emitter<RepoMountsReading>("repo mounts reading");

  #reading: RepoMountsReading = REPO_MOUNTS_NOT_READ;
  #started = false;
  #disposed = false;

  public constructor(options: RepoMountsReaderOptions) {
    this.#operations = options.operations;
    this.#sessionStore = options.sessionStore;
    this.#sessionId = options.sessionStore.sessionId;
    // Shared with the scheduler, so the reading's stamp and the refresh deadline share a time base.
    this.#clock = options.clock;
    this.#scheduler = new RefreshScheduler({
      clock: this.#clock,
      perform: async (_reasons, round) => {
        await this.#performRead(round);
      },
    });
    // The three reasons to read again reach this reader through `requestRead` only.
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
    this.#selections = new ExecutionModeSelections({
      operations: options.operations,
      publisher: this.#readingPublisher(),
    });
  }

  /** What the section renders right now. Stable identity between publishes. */
  public get snapshot(): RepoMountsReading {
    return this.#reading;
  }

  /**
   * Whether this reader is over, terminally. The binding asks so it can mint a replacement:
   * strict-mode's replayed setup would otherwise `start()` a disposed reader that returns early.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether this reader's reads are taken against `sessionStore`. The resource seam keys on the
   * bridge, the calls and the session id, so a projection replaced under the same id is
   * noticed only through this.
   */
  public isReadingFor(sessionStore: SessionStore): boolean {
    return this.#sessionStore === sessionStore;
  }

  /** How many workspaces hold a mode switch right now. The act half's own bound. */
  public get inFlightSelectionCount(): number {
    return this.#selections.inFlightCount;
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  public subscribe(sink: (reading: RepoMountsReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Begin reading and keep listening for the reasons to read again. Idempotent, so strict mode's
   * double effect adds no second listener or read.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.requestRead("subscribe");
    this.#triggers.start();
  }

  /**
   * Ask for a read; coalescing, debouncing and the call itself stay the scheduler's. The one
   * way a reason reaches this reader, so `performCount` is the whole record of what ran.
   */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /** Record one explicit mode switch. `ExecutionModeSelections` owns what that means. */
  public async requestModeSelection(
    workspaceId: WorkspaceId,
    executionMode: ExecutionMode,
  ): Promise<void> {
    await this.#selections.request(workspaceId, executionMode);
  }

  /** Terminal. No later event can re-arm a read behind a section that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#selections.dispose();
    this.#changes.clear();
  }

  /** The three operations a mode switch needs from the half that reads, and no more. */
  #readingPublisher(): RepoMountsReadingPublisher {
    return {
      currentReading: () => this.#reading,
      publish: (reading: RepoMountsReading) => {
        this.#publish(reading);
      },
      requestRefreshAfterSelect: () => {
        this.requestRead("terminal-event");
      },
    };
  }

  /**
   * Whether this pass has stopped mattering (disposed or aborted). A method because
   * `AbortSignal.aborted` stays narrowed across an `await` in TypeScript, so a repeated inline
   * check would read as settled while the value changes.
   */
  #isAbandoned(round: ReadRound): boolean {
    return this.#disposed || round.signal.aborted;
  }

  /**
   * The section's whole reading: the workspace roster, one mount read per distinct mount, one
   * worktree read per mount and one capability read per workspace. The round's signal reaches
   * each read, so an abandoned pass costs only the pre-send check per remaining call.
   */
  async #performRead(round: ReadRound): Promise<void> {
    this.#publish({ ...this.#reading, status: "reading" });

    const { workspaces } = await this.#operations.listWorkspaces(this.#sessionId, round.signal);
    if (this.#isAbandoned(round)) {
      return;
    }

    const mounts: RepoMountReadResponse[] = [];
    const seenMountIds = new Set<string>();
    for (const workspace of workspaces) {
      if (seenMountIds.has(workspace.repoMountId)) {
        continue;
      }
      seenMountIds.add(workspace.repoMountId);
      const mount = await this.#operations.readMount(workspace.repoMountId, round.signal);
      if (this.#isAbandoned(round)) {
        return;
      }
      mounts.push(mount);
    }

    const worktrees: WorktreeStatusRecord[] = [];
    for (const mount of mounts) {
      const roots = await this.#operations.readWorktreeStatus(mount.id, round.signal);
      if (this.#isAbandoned(round)) {
        return;
      }
      worktrees.push(...roots.worktrees);
    }

    const capabilitiesByWorkspaceId: Record<
      string,
      WorkspaceExecutionModeCapabilitiesReadResponse
    > = {};
    for (const workspace of workspaces) {
      capabilitiesByWorkspaceId[workspace.id] = await this.#operations.readWorkspaceExecutionModes(
        workspace.id,
        round.signal,
      );
      if (this.#isAbandoned(round)) {
        return;
      }
    }

    this.#publish({
      status: "read",
      mounts,
      workspaces,
      worktrees,
      readAtMilliseconds: this.#clock.now(),
      capabilitiesByWorkspaceId,
      // Spread forward, never rebuilt: a switch still on the wire while a read runs beside it
      // must keep holding the picker.
      pendingModeByWorkspaceId: this.#reading.pendingModeByWorkspaceId,
    });
  }

  #publish(reading: RepoMountsReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
