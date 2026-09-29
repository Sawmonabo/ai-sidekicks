// What the repos section knows, who asked for it, and when it asks again.
//
// Every read here goes through the console's one `RefreshScheduler`, which coalesces a
// burst of reasons into one read and serializes reads so two never overlap. The refresh
// policy is fixed: reads happen on subscribe, on window focus, on reconnect, and on the
// terminal events this class names, and never on an interval. `subscribe` is this class's
// own `start`; the other three come from the shared `SessionRefreshTriggers`, which this
// class hands itself. This class owns the read and that one owns when.
//
// The roots come from their own read, and it is the only one that names a worktree. A
// workspace row carries no worktree id, so the session-scoped worktree status read is what
// says which roots a session is running in. It is one call for the whole session rather
// than one per mount.
//
// The read order is forced by the wire. There is no mount list call, so the session's
// mounts are learned from its workspaces: every workspace names its mount, so the roster
// names every mount this session has bound a workspace on. A mount attached and not yet
// bound is on no workspace, so it is not in the roster. Hence list, then one mount read per
// distinct mount, which is the only read carrying `health`.
//
// This state is not in the session store because a mount read is not an event projection.
// It is a probe whose `checkedAt` is the point of it, and the store's entity kinds have no
// repo mount.
//
// A call that rejects is not caught here: the scheduler re-throws it, so the reading stays
// where it was and the rejection reaches whoever runs the scheduler's callback.
//
// The mode switch is next door. Four reads on a scheduler and one mutation with a register
// of its own are two jobs: `execution-mode-selection.ts` holds the mutation,
// `repo-mounts-model.ts` the reading both of them publish, and `hooks/useRepoMounts.ts` the
// hook that mounts this class. This class hosts the switch, handing it the three things
// `ExecutionModeSelectionHost` names: the standing reading, the publish, and the refresh an
// accepted switch asks for.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
} from "@ai-sidekicks/contracts";
import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type ConsoleClock } from "@renderer/lib/clock.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { type ReadRound } from "@renderer/console/store/read/read-cancellation.js";
import { type ReadTriggerTarget } from "@renderer/console/store/read/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  ExecutionModeSelections,
  type ExecutionModeSelectionHost,
} from "./execution-mode-selection.js";
import { REPO_MOUNTS_NOT_READ, type RepoMountsReading } from "./repo-mounts-model.js";
import type { RepoOperations } from "../repo-operations.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../repo-lifecycle-events.js";

/** What one section reader collaborates with. */
export interface RepoMountsReaderOptions {
  /** The reads and the mode switch this section makes; nothing else reaches the daemon. */
  readonly operations: RepoOperations;
  /**
   * The session being read, and two of the three reasons to read again.
   *
   * The STORE rather than a bare session id: a `workspace.stale` frame and the repair
   * edge that stands for reconnect are both transitions of this object, and a reader
   * handed only an id could observe neither. The id is read off it, so the section and
   * the store can never name two sessions.
   */
  readonly sessionStore: SessionStore;
  /**
   * The clock this section's reading is stamped with. Supplied, never defaulted.
   *
   * REQUIRED, BECAUSE A DEFAULT WOULD BE THE WALL CLOCK. `consoleClockFor` is the one
   * answer to which clock a window runs on, and under the fixture that is the
   * scenario's frozen clock — so a reader that fell back to a `RealClock` of its own
   * stamped `readAtMilliseconds` on wall time while the deadline wake-up beside it ran
   * on the scenario's, and every card rendering an age against that stamp re-rendered
   * a different string every day. A reader without a clock is a construction error
   * rather than a reader on the machine's clock.
   */
  readonly clock: ConsoleClock;
}

/** Reads a session's mounts, workspaces and roots, and hosts the mode switch. */
export class RepoMountsReader implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this section a fresh read.
   *
   * DECLARED HERE rather than handed to the trigger wiring, because which events
   * change an answer is a property of the question: a kind list passed in at each call
   * site is how two readers of one answer come to watch different frames. The family's
   * census is `repo-lifecycle-events.ts`, which derives it from the contract's own
   * registry and is where the `SessionEventType` check lives.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #operations: RepoOperations;
  readonly #sessionStore: SessionStore;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
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
    // Bound once and shared with the scheduler, so the instant a reading is stamped
    // with and the instant a refresh is measured from are the same time base — under
    // the fixture that is the scenario's frozen clock and under the app it is the wall.
    this.#clock = options.clock;
    this.#scheduler = new RefreshScheduler({
      clock: this.#clock,
      perform: async (_reasons, round) => {
        await this.#performRead(round);
      },
    });
    // The three reasons to read again. They reach this reader through `requestRead`
    // and the scheduler behind it, and through nothing else.
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
    this.#selections = new ExecutionModeSelections({
      operations: options.operations,
      host: this.#selectionHost(),
    });
  }

  /** What the section renders right now. Stable identity between publishes. */
  public get snapshot(): RepoMountsReading {
    return this.#reading;
  }

  /**
   * Whether this reader is over, terminally.
   *
   * READ BY THE BINDING, because `dispose` is terminal and React's strict-mode
   * double-mount runs a cleanup and then the same effect's setup again: `start()` on a
   * disposed reader returns early, so the section would sit unread with nothing on
   * screen to say why. The binding asks and mints a replacement instead of this class
   * growing a second, revivable lifecycle.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether this reader's reads are taken against `sessionStore`.
   *
   * The seam holds a resource per `(subject, key)` and this reader has three
   * collaborators — the bridge, the calls it makes and the store it reads against — where
   * the seam has one subject slot and one string key. The bridge and the calls are the
   * subject and the session id is the key, so the axis they cannot carry is the store's
   * own identity: a projection replaced under the same id retires every read taken
   * against the old one, and this is how the binding notices.
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
   * Begin reading, and keep listening for the reasons to read again.
   *
   * Idempotent: a second call adds no listener and asks for no second read. React
   * mounts an effect twice in development strict mode, and a reader that armed twice
   * there would double every read in the one environment where the budget is watched.
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
   * Ask for a read. Coalescing, debouncing, and the call itself stay the scheduler's.
   *
   * The ONE way a reason reaches this reader, which is why the trigger wiring beside
   * it is given this object rather than the scheduler: a second entry point would be a
   * second place for a reason to be dropped, renamed, or double-counted, and the
   * `performCount` this class publishes would stop being the whole record of what ran.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Record one explicit mode switch. The act next door owns what that means. */
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
  #selectionHost(): ExecutionModeSelectionHost {
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
   * Whether this pass has stopped mattering, by either of the two ways it can.
   *
   * A METHOD RATHER THAN THE EXPRESSION AT EACH OF THE FOUR SITES, for two reasons.
   * The reading is a disjunction that must not drift between the awaits it guards,
   * and `AbortSignal.aborted` is a readonly property TypeScript narrows on first
   * inspection and keeps narrowed across an `await` — the very interval in which it
   * changes — so a repeated inline check reads as settled to the compiler while being
   * the opposite in fact.
   */
  #isAbandoned(round: ReadRound): boolean {
    return this.#disposed || round.signal.aborted;
  }

  /**
   * The section's whole reading: a workspace roster, one mount read per distinct
   * mount, the worktree roster, and one capability read per workspace.
   *
   * Serial, and so the most worth abandoning. The round's signal reaches each read, so a
   * pass abandoned because the section was left costs the door's pre-send check per
   * remaining call and nothing else.
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
      if (!mounts.some((held) => held.id === mount.id)) {
        mounts.push(mount);
      }
    }

    const roots = await this.#operations.readWorktreeStatus(this.#sessionId, round.signal);
    if (this.#isAbandoned(round)) {
      return;
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
      worktrees: roots.worktrees,
      readAtMilliseconds: this.#clock.now(),
      capabilitiesByWorkspaceId,
      // Spread forward, never rebuilt. A switch the daemon has not answered is still on the
      // wire while a read runs beside it, since the accepted switch asks for this read, so
      // a publish that reset the map would release the picker before the mutation it is
      // holding for had settled.
      pendingModeByWorkspaceId: this.#reading.pendingModeByWorkspaceId,
    });
  }

  #publish(reading: RepoMountsReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
