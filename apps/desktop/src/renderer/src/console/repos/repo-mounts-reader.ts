// What the repos section knows, who asked for it, and when it asks again.
//
// `Spec-023 §Console Design (Meridian)` §10.1 fixes the refresh policy in one
// sentence — "on panel focus, on reconnect, and on a `workspace.stale` frame. No
// interval polling" — so every read this family performs is routed through the
// console's one `RefreshScheduler` (`console/store/scheduling.ts`). Nothing here
// arms a timer of its own; the scheduler coalesces a burst of reasons into one read
// and serializes reads so two never overlap.
//
// THE ROOTS COME FROM THEIR OWN READ, and it is the only one that names a worktree.
// A workspace row carries no worktree id, so `repo.worktreeStatusRead` — session
// scoped, both root kinds in one answer — is what lets the section draw the roots a
// session is running in and lets the change-proposal gate be asked per worktree. It
// is one call for the whole session rather than one per mount, because the request's
// mount filter exists for a caller with one mount in view and this section has a list.
//
// THE READ ORDER IS FORCED BY THE WIRE, not chosen. There is no `repo.mountList`
// method anywhere in the corpus, so the session's mounts are learned from its
// WORKSPACES: `workspaces.repo_mount_id` is NOT NULL under the mount-first funnel
// (`Spec-009`, D-009-4) and attach always mints a default `read-only` workspace
// (`Spec-009 §Default Behavior`), so the workspace roster names every mount. Hence
// list, then one `repo.mountRead` per distinct mount — which is also the only read
// that carries `health`, and the reason a mount card cannot be drawn from the list
// alone.
//
// WHY THIS IS NOT IN THE SESSION STORE. `console/store/entities.ts` partitions by a
// closed entity-kind set that has `workspace` and `worktree` and no repo mount, and
// a store rule this substrate states is that a projection never denormalises what
// another owns. A mount read is not an event projection at all — it is a synchronous
// probe result whose `checkedAt` is the point of it — so holding it beside the store
// duplicates nothing. When a `repo-mount` entity kind exists, this class becomes its
// reader and the state moves; the shape it publishes does not.
//
// EVERY FAILURE IS A REFUSAL, NEVER AN EMPTY LIST. A refused list read publishes the
// refusal with no mounts; a refused mount read publishes the mounts that did answer
// beside the refusal that explains the gap; a refused capabilities read is scoped to
// the one workspace it was about. `Spec-023 §Console Design (Meridian)` rule 8 is
// what forbids collapsing any of those into "there are none".

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
  WorkspaceListResponse,
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
import { RefreshScheduler } from "../store/index.js";
import {
  readExecutionModeCapabilities,
  readRepoMount,
  readSessionWorkspaces,
  readWorktreeStatus,
  refusalFromRejection,
  selectExecutionMode,
  type RepoCallOutcome,
} from "./repo-reads.js";
import type { EphemeralCloneStatusRecord, WorktreeStatusRecord } from "./worktree-model.js";

/** One workspace row, exactly as `WorkspaceListResponse` spells it. */
export type RepoWorkspaceRow = WorkspaceListResponse["workspaces"][number];

/**
 * Everything the section renders from, in one immutable value.
 *
 * `status` is the read's own position and is deliberately three-valued, matching the
 * three absences rule 8 separates: `not-checked` before the first read,
 * `computing` while one is in flight, and the answer afterwards. A fourth "failed"
 * member would collapse the refusal into the status; the refusal is its own field so
 * a partial answer — some mounts read, one refused — is representable.
 */
export interface RepoMountsReading {
  readonly status: "not-read" | "reading" | "read";
  readonly mounts: readonly RepoMountReadResponse[];
  readonly workspaces: readonly RepoWorkspaceRow[];
  /** Every worktree this session holds, in the order the status read returned them. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /**
   * Every ephemeral clone this session holds, in the order the same read returned
   * them.
   *
   * ITS OWN FIELD, never folded into `worktrees`. `repo.worktreeStatusRead` answers
   * with two arrays because the two record kinds are two shapes — one mount-anchored
   * over ten columns, the other workspace-anchored over nine, with no `updatedAt` —
   * and `Spec-023 §Console Design (Meridian)` §10.3 draws them as two lists with
   * different columns. Keeping only `worktrees` would report a session running in the
   * `ephemeral clone` execution mode as holding no execution root at all, which is
   * the daemon's answer discarded rather than rendered.
   */
  readonly ephemeralClones: readonly EphemeralCloneStatusRecord[];
  /**
   * The instant this reading was taken, on the reader's own clock.
   *
   * Carried on the reading rather than read from the wall clock by the cards that
   * render an age, because `Spec-023 §Console Design (Meridian)` §10.3 forbids polling
   * on that surface: an age has to move when the surface RE-READS and at no other
   * time, and a card reading `Date.now()` in its render body would move it on any
   * unrelated re-render. Zero before the first read, which no card renders against —
   * every one of them is behind the `read` status.
   */
  readonly readAtMilliseconds: number;
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /** The read's own failure, when the section as a whole could not be answered. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * The root read's own failure, scoped to it.
   *
   * Its own field rather than folded into `refusal`, on the same rule the per-workspace
   * map follows: a session whose mounts and workspaces answered and whose roots did not
   * is a PARTIAL answer, and collapsing the two would either hide the gap or report the
   * whole section as unread when most of it is on screen.
   */
  readonly worktreeRefusal: ConsoleRefusal | undefined;
  /** Per workspace: the daemon's answer to a capabilities read or a mode switch. */
  readonly refusalByWorkspaceId: Readonly<Record<string, ConsoleRefusal>>;
}

const NOTHING_READ_YET: RepoMountsReading = {
  status: "not-read",
  mounts: [],
  workspaces: [],
  worktrees: [],
  ephemeralClones: [],
  readAtMilliseconds: 0,
  capabilitiesByWorkspaceId: {},
  refusal: undefined,
  worktreeRefusal: undefined,
  refusalByWorkspaceId: {},
};

export interface RepoMountsReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class RepoMountsReader {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<RepoMountsReading>("repo mounts reading");

  #reading: RepoMountsReading = NOTHING_READ_YET;
  #started = false;
  #disposed = false;
  #detachWindowFocus: (() => void) | undefined;

  public constructor(options: RepoMountsReaderOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
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
   * Idempotent: a second call adds no second listener and requests no second read,
   * because React mounts an effect twice in development strict mode and a reader
   * that armed twice there would double every read in exactly the environment where
   * the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#scheduler.request("subscribe");
    if (typeof window === "undefined") {
      return;
    }
    const onWindowFocus = (): void => {
      this.#scheduler.request("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    this.#detachWindowFocus = () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }

  /**
   * Record one explicit mode switch, then re-read.
   *
   * A REFUSED switch does not re-read and does not re-pick: `Spec-010 §Required
   * Behavior` forbids silent substitution, and the renderer's half of that is
   * showing the refusal and leaving the choice with the participant. An ACCEPTED
   * switch re-reads, because the workspace transitions `ready -> provisioning ->
   * ready` on its existing id and the row has to follow it.
   */
  public async requestModeSelection(
    workspaceId: WorkspaceId,
    executionMode: ExecutionMode,
  ): Promise<void> {
    const outcome = await selectExecutionMode(this.#bridge, workspaceId, executionMode);
    if (this.#disposed) {
      return;
    }
    if (outcome.status === "refused") {
      this.#publish({
        ...this.#reading,
        refusalByWorkspaceId: {
          ...this.#reading.refusalByWorkspaceId,
          [workspaceId]: outcome.refusal,
        },
      });
      return;
    }
    this.#scheduler.request("terminal-event");
  }

  /** Terminal. No later event can re-arm a read behind a section that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#detachWindowFocus?.();
    this.#detachWindowFocus = undefined;
    this.#changes.clear();
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
      refusalByWorkspaceId,
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
export function useRepoMounts(bridge: ConsoleBridge, sessionId: string): RepoMountsBinding {
  const reader = useMemo(() => new RepoMountsReader({ bridge, sessionId }), [bridge, sessionId]);
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
