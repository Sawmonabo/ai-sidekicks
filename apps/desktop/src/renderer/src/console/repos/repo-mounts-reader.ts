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
// `repo-refresh-triggers.ts` beside this file, whose terminal event is a
// `workspace.stale` frame. This class owns the read and that one owns when.
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
// took the mutation and `repo-mounts-model.ts` took the reading both of them publish —
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
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ConsoleBridge } from "../bridge/index.js";
import {
  Emitter,
  RealClock,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import { RefreshScheduler, type SessionStore } from "../store/index.js";
import {
  ExecutionModeSelections,
  type ExecutionModeSelectionHost,
} from "./execution-mode-selection.js";
import { NOTHING_READ_YET, type RepoMountsReading } from "./repo-mounts-model.js";
import {
  readExecutionModeCapabilities,
  readRepoMount,
  readSessionWorkspaces,
  readWorktreeStatus,
  refusalFromRejection,
  type RepoCallOutcome,
} from "./repo-reads.js";
import { RepoRefreshTriggers } from "./repo-refresh-triggers.js";

/**
 * Re-exported from the module that declares it, because every importer names it here.
 *
 * The declaration sits in `repo-mounts-model.ts` so the reader and the selections can
 * both publish one without importing each other; this line is what keeps that move
 * invisible to the cards, which read the section's value through the class that
 * produces it. `proposal-gate-reader.ts` re-exports `ProposalGateReading` for the same
 * reason and in the same words.
 */
export type { RepoMountsReading, RepoWorkspaceRow } from "./repo-mounts-model.js";

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
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class RepoMountsReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: RepoRefreshTriggers;
  readonly #selections: ExecutionModeSelections;
  readonly #changes = new Emitter<RepoMountsReading>("repo mounts reading");

  #reading: RepoMountsReading = NOTHING_READ_YET;
  #started = false;
  #disposed = false;

  public constructor(options: RepoMountsReaderOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionStore.sessionId;
    // Bound once and shared with the scheduler, so the instant a reading is stamped
    // with and the instant a refresh is measured from are the same time base — under
    // the fixture that is the scenario's frozen clock and under the app it is the wall.
    this.#clock = options.clock ?? new RealClock();
    this.#scheduler = new RefreshScheduler({
      clock: this.#clock,
      perform: async () => {
        await this.#performRead();
      },
      // Swallowing is not an option and re-throwing into a timer callback reaches
      // nobody, so a read that threw past its own refusal handling lands in the
      // reading as one — the surface then renders it instead of showing stale rows.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          status: "read",
          refusal: refusalFromRejection("repo.workspaceList", error),
        });
      },
    });
    // The three reasons to read again. They reach this reader only through the scheduler.
    this.#triggers = new RepoRefreshTriggers({
      scheduler: this.#scheduler,
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
    this.#scheduler.request("subscribe");
    this.#triggers.start();
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
        this.#scheduler.request("terminal-event");
      },
    };
  }

  async #performRead(): Promise<void> {
    this.#publish({ ...this.#reading, status: "reading" });

    const workspaceOutcome = await readSessionWorkspaces(this.#bridge, this.#sessionId);
    if (this.#disposed) {
      return;
    }
    if (workspaceOutcome.status === "refused") {
      this.#publish({
        ...NOTHING_READ_YET,
        status: "read",
        refusal: workspaceOutcome.refusal,
        // Carried across the reset for the reason above: a refused roster read says
        // nothing about a switch still on the wire, and dropping the entry would offer
        // the picker again while its own mutation was unanswered.
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
      const mountOutcome = await readRepoMount(this.#bridge, workspace.repoMountId);
      if (this.#disposed) {
        return;
      }
      firstRefusal = recordFirstRefusal(firstRefusal, mountOutcome);
      if (
        mountOutcome.status === "read" &&
        !mounts.some((held) => held.id === mountOutcome.value.id)
      ) {
        mounts.push(mountOutcome.value);
      }
    }

    const worktreeOutcome = await readWorktreeStatus(this.#bridge, this.#sessionId);
    if (this.#disposed) {
      return;
    }

    const capabilitiesByWorkspaceId: Record<
      string,
      WorkspaceExecutionModeCapabilitiesReadResponse
    > = {};
    const refusalByWorkspaceId: Record<string, ConsoleRefusal> = {};
    for (const workspace of workspaces) {
      const capabilitiesOutcome = await readExecutionModeCapabilities(this.#bridge, workspace.id);
      if (this.#disposed) {
        return;
      }
      if (capabilitiesOutcome.status === "read") {
        capabilitiesByWorkspaceId[workspace.id] = capabilitiesOutcome.value;
      } else {
        refusalByWorkspaceId[workspace.id] = capabilitiesOutcome.refusal;
      }
    }

    this.#publish({
      status: "read",
      mounts,
      workspaces,
      worktrees: worktreeOutcome.status === "read" ? worktreeOutcome.value.worktrees : [],
      // Both arrays off the one reply, so a refused root read empties both together
      // and a served one carries whatever each array held — including an empty
      // `ephemeralClones`, which the contract requires present and which is a lawful
      // answer rather than a gap.
      ephemeralClones:
        worktreeOutcome.status === "read" ? worktreeOutcome.value.ephemeralClones : [],
      readAtMilliseconds: this.#clock.now(),
      capabilitiesByWorkspaceId,
      refusal: firstRefusal,
      worktreeRefusal: worktreeOutcome.status === "refused" ? worktreeOutcome.refusal : undefined,
      // The read ran on this path whatever it answered, which is exactly the fact a
      // served-and-empty clone list needs to tell itself apart from an unasked one.
      worktreeReadPosition: "made",
      refusalByWorkspaceId,
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
  outcome: RepoCallOutcome<unknown>,
): ConsoleRefusal | undefined {
  if (held !== undefined || outcome.status === "read") {
    return held;
  }
  return outcome.refusal;
}

/** What the hook hands a surface: the reading, and the one mutation the picker sends. */
export interface RepoMountsBinding {
  readonly reading: RepoMountsReading;
  readonly requestModeSelection: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
}

/**
 * Bind one section to its reader.
 *
 * The reader is constructed in a hook and never in a render body, subscribed through
 * `useSyncExternalStore` so a publish is a single transition, and disposed on
 * unmount — the three properties `apps/desktop/AGENTS.md` requires of anything that
 * holds state beside a component.
 */
export function useRepoMounts(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): RepoMountsBinding {
  const reader = useMemo(
    () => new RepoMountsReader({ bridge, sessionStore }),
    [bridge, sessionStore],
  );
  useEffect(() => {
    reader.start();
    return () => {
      reader.dispose();
    };
  }, [reader]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
  const requestModeSelection = useCallback(
    (workspaceId: WorkspaceId, executionMode: ExecutionMode) => {
      void reader.requestModeSelection(workspaceId, executionMode);
    },
    [reader],
  );
  return { reading, requestModeSelection };
}
