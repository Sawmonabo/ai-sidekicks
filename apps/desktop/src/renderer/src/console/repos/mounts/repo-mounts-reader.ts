// What the repos section knows, who asked for it, and when it asks again.
//
// `Spec-023 §Rules every console surface obeys` fixes the refresh policy — "Reads
// happen on subscribe, on window focus, on reconnect, and on the terminal events the
// owning spec names", under "No interval polling" — so every read this family performs
// is routed through the
// console's one `RefreshScheduler` (`console/store/scheduling.ts`). Nothing here
// arms a timer of its own; the scheduler coalesces a burst of reasons into one read
// and serializes reads so two never overlap. All FOUR of that rule's reasons are wired:
// `subscribe` by this class's own `start`, and the other three by
// the shared `SessionRefreshTriggers`, which this class hands ITSELF — the kind set it
// declares from `repo-lifecycle-events.ts` and the `requestRead` behind which the
// scheduler sits are the two members that wiring reads. This class owns the read and
// that one owns when.
//
// THE ROOTS COME FROM THEIR OWN READ, and it is the only one that names a worktree.
// A workspace row carries no worktree id, so `repo.worktreeStatusRead` — session
// scoped, both root kinds in one answer — is what lets the section draw the roots a
// session is running in and lets the change-proposal gate be asked per worktree. It
// is one call for the whole session rather than one per mount, because the request's
// mount filter exists for a caller with one mount in view and this section has a list.
//
// THE READ ORDER IS FORCED BY THE WIRE, not chosen. There is no `repo.mountList` in the
// corpus, so the session's mounts are learned from its WORKSPACES:
// `workspaces.repo_mount_id` is NOT NULL under the mount-first funnel (`Spec-009`,
// D-009-4) and attach always mints a default `read-only` workspace (`Spec-009 §Default
// Behavior`), so the roster names every mount. Hence list, then one `repo.mountRead`
// per distinct mount — the only read carrying `health`, and the reason a mount card
// cannot be drawn from the list alone.
//
// WHY THIS STATE IS NOT IN THE SESSION STORE, though the store is now OBSERVED for two
// of the three refresh reasons. `console/store/entities.ts` partitions by a closed
// entity-kind set with no repo mount, and a mount read is not an event projection at
// all — it is a synchronous probe whose `checkedAt` is the point of it — so holding it
// beside the store denormalises nothing. When a `repo-mount` entity kind exists, this
// class becomes its reader and the state moves; the shape it publishes does not.
//
// EVERY FAILURE IS A REFUSAL, NEVER AN EMPTY LIST. A refused list read publishes the
// refusal with no mounts; a refused mount read publishes the mounts that did answer
// beside the refusal explaining the gap; a refused capabilities read is scoped to the
// one workspace it was about. Rule 8 forbids collapsing any into "there are none".
//
// THE ACT IS NEXT DOOR AND THE SHAPE IS BESIDE BOTH. This file had reached the size
// `apps/desktop/AGENTS.md` calls two jobs, and the two were legible: four reads on a
// scheduler, and one mutation with a register of its own. `execution-mode-selection.ts`
// took the mutation, `repo-mounts-model.ts` took the reading both of them publish, and
// `repo-mounts-binding.ts` took the hook that mounts this class —
// the split `proposal-gate-reader.ts` / `proposal-gate-actions.ts` /
// `proposal-gate-model.ts` already makes in this family, on the same seam and for the
// same reason. This class is the act's host, handed the three operations
// `ExecutionModeSelectionHost` names and nothing else: the standing reading, the
// publish, and the refresh an accepted switch asks for. So a switch cannot start a read
// and this class cannot decide what a switch sends.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
} from "@ai-sidekicks/contracts";
import type { ConsoleBridge, DaemonReply } from "../../bridge/index.js";
import {
  Emitter,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import {
  RefreshScheduler,
  SessionRefreshTriggers,
  type ReadRound,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../../store/index.js";
import {
  ExecutionModeSelections,
  type ExecutionModeSelectionHost,
} from "./execution-mode-selection.js";
import { NOTHING_READ_YET, retainForRoster, type RepoMountsReading } from "./repo-mounts-model.js";
import {
  readExecutionModeCapabilities,
  readRepoMount,
  readSessionWorkspaces,
  readWorktreeStatus,
  repoCallRefusal,
} from "../repo-reads.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../repo-lifecycle-events.js";

export interface RepoMountsReaderOptions {
  readonly bridge: ConsoleBridge;
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

export class RepoMountsReader implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this section a fresh read.
   *
   * DECLARED HERE rather than handed to the trigger wiring, because which events
   * change an answer is a property of the question: the gate next door reads the same
   * rows, and a kind list passed in at each call site is how two readers of one answer
   * come to watch different frames. The family's census is
   * `repo-lifecycle-events.ts`, which derives it from the contract's own registry and
   * is where the `SessionEventType` check lives.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #bridge: ConsoleBridge;
  readonly #sessionStore: SessionStore;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #selections: ExecutionModeSelections;
  readonly #changes = new Emitter<RepoMountsReading>("repo mounts reading");

  #reading: RepoMountsReading = NOTHING_READ_YET;
  #started = false;
  #disposed = false;

  public constructor(options: RepoMountsReaderOptions) {
    this.#bridge = options.bridge;
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
      // Swallowing is not an option and re-throwing into a timer callback reaches
      // nobody, so a read that threw past its own refusal handling lands in the
      // reading as one — the surface then renders it instead of showing stale rows.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          status: "read",
          refusal: repoCallRefusal("repo.workspaceList", error),
        });
      },
    });
    // The three reasons to read again. They reach this reader through `requestRead`
    // and the scheduler behind it, and through nothing else.
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
    this.#selections = new ExecutionModeSelections({
      bridge: options.bridge,
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
   * The seam holds a resource per `(subject, key)` and this reader has TWO
   * collaborators — the bridge it calls through and the store it reads against — where
   * the seam has one subject slot and one string key. The bridge is the subject and the
   * session id is the key, so the axis a key cannot carry is the store's own identity:
   * a projection replaced under the same id retires every read taken against the old
   * one, and this is how the binding notices.
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
   * SERIAL AND THEREFORE THE MOST WORTH ABANDONING. Every await is a round trip whose
   * reply is parsed against a registered schema before this method sees it, and a
   * section left before the pass finishes used to run all of them and discard the
   * fold. The round's signal reaches each read, so an abandoned pass costs the door's
   * pre-send check per remaining call and nothing else.
   */
  async #performRead(round: ReadRound): Promise<void> {
    this.#publish({ ...this.#reading, status: "reading" });

    const workspaceOutcome = await readSessionWorkspaces(
      this.#bridge,
      this.#sessionId,
      round.signal,
    );
    if (this.#isAbandoned(round)) {
      return;
    }
    if (workspaceOutcome.status === "refused") {
      this.#publish({
        ...NOTHING_READ_YET,
        status: "read",
        refusal: workspaceOutcome.refusal,
        // Both halves carried across the reset for the same reason: a refused roster
        // read says nothing about a switch still on the wire, and nothing about one the
        // daemon already refused. Dropping the pending entry would offer the picker
        // again while its own mutation was unanswered; dropping the selection refusal
        // would take away the only sentence saying why the last press did nothing.
        workspaceRefusals: {
          byCapabilitiesRead: {},
          bySelection: this.#reading.workspaceRefusals.bySelection,
        },
        pendingModeByWorkspaceId: this.#reading.pendingModeByWorkspaceId,
      });
      return;
    }

    const workspaces = workspaceOutcome.value.workspaces;
    const mounts: RepoMountReadResponse[] = [];
    const seenMountIds = new Set<string>();
    let firstRefusal: ConsoleRefusal | undefined;

    for (const workspace of workspaces) {
      if (seenMountIds.has(workspace.repoMountId)) {
        continue;
      }
      seenMountIds.add(workspace.repoMountId);
      const mountOutcome = await readRepoMount(this.#bridge, workspace.repoMountId, round.signal);
      if (this.#isAbandoned(round)) {
        return;
      }
      firstRefusal = recordFirstRefusal(firstRefusal, mountOutcome);
      if (
        mountOutcome.status === "served" &&
        !mounts.some((held) => held.id === mountOutcome.value.id)
      ) {
        mounts.push(mountOutcome.value);
      }
    }

    const worktreeOutcome = await readWorktreeStatus(this.#bridge, this.#sessionId, round.signal);
    if (this.#isAbandoned(round)) {
      return;
    }

    const capabilitiesByWorkspaceId: Record<
      string,
      WorkspaceExecutionModeCapabilitiesReadResponse
    > = {};
    const byCapabilitiesRead: Record<string, ConsoleRefusal> = {};
    for (const workspace of workspaces) {
      const capabilitiesOutcome = await readExecutionModeCapabilities(
        this.#bridge,
        workspace.id,
        round.signal,
      );
      if (this.#isAbandoned(round)) {
        return;
      }
      if (capabilitiesOutcome.status === "served") {
        capabilitiesByWorkspaceId[workspace.id] = capabilitiesOutcome.value;
      } else {
        byCapabilitiesRead[workspace.id] = capabilitiesOutcome.refusal;
      }
    }

    this.#publish({
      status: "read",
      mounts,
      workspaces,
      worktrees: worktreeOutcome.status === "served" ? worktreeOutcome.value.worktrees : [],
      // Both arrays off the one reply, so a refused root read empties both together
      // and a served one carries whatever each array held — including an empty
      // `ephemeralClones`, which the contract requires present and which is a lawful
      // answer rather than a gap.
      ephemeralClones:
        worktreeOutcome.status === "served" ? worktreeOutcome.value.ephemeralClones : [],
      readAtMilliseconds: this.#clock.now(),
      capabilitiesByWorkspaceId,
      refusal: firstRefusal,
      worktreeRefusal: worktreeOutcome.status === "refused" ? worktreeOutcome.refusal : undefined,
      // The read ran on this path whatever it answered, which is exactly the fact a
      // served-and-empty clone list needs to tell itself apart from an unasked one.
      worktreeReadPosition: "made",
      // ONE HALF REBUILT, THE OTHER CARRIED, AND THAT IS THE WHOLE POINT OF THE SPLIT.
      // `byCapabilitiesRead` is this read's own answer and is replaced whole. The act
      // half is not this read's to answer: a mode switch the daemon refused stays
      // refused whether or not a lifecycle event happened to trigger a read a moment
      // later, and rebuilding one map for both erased exactly that — the participant's
      // failed press silently disappearing from the picker on the next repo event.
      workspaceRefusals: {
        byCapabilitiesRead,
        bySelection: retainForRoster(this.#reading.workspaceRefusals.bySelection, workspaces),
      },
      // SPREAD FORWARD, NEVER REBUILT. A switch the daemon has not answered is still on
      // the wire while a read runs beside it — the accepted switch ASKS for this read —
      // so a publish that reset the map would release the picker before the mutation it
      // is holding for had settled.
      pendingModeByWorkspaceId: this.#reading.pendingModeByWorkspaceId,
    });
  }

  #publish(reading: RepoMountsReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

function recordFirstRefusal(
  held: ConsoleRefusal | undefined,
  reply: DaemonReply<unknown>,
): ConsoleRefusal | undefined {
  if (held !== undefined || reply.status === "served") {
    return held;
  }
  return reply.refusal;
}
