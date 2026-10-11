// Reads a session's mounts, workspaces and roots through the console's one `RefreshScheduler`,
// which coalesces a burst of reasons into one read and never overlaps two. Reads happen on
// subscribe, window focus, reconnect and the terminal events this class names, never on an
// interval. The order is forced by the wire: `repo.mountList` lists every folder the service can
// reach, not one session's, and carries no `health`, so a session's mounts are learned from its
// listed workspaces, then read once per distinct mount (the only read carrying `health`), then
// worktree status once per distinct project those mounts belong to; a chat's managed mount belongs
// to no project and has no worktrees. A rejected call ends the pass: its cause goes to the window's
// diagnostic capture, the reading returns to where it stood before the pass, and the session's
// failed dependent reads hold this reader until a pass succeeds, so the line under the session
// header says the window could not catch up. The state is not in the session store because a mount
// read is a probe, not an event projection.

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { WorktreeStatusRecord } from "@ai-sidekicks/contracts/worktree/lifecycle";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { type Clock } from "#renderer/lib/clock.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { SessionRefreshTriggers } from "#renderer/store/reads/session-refresh-triggers.js";
import { type ReadRound } from "#renderer/lib/reads/scope.js";
import { type ReadTriggerTarget } from "#renderer/store/reads/triggers.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { REPO_MOUNTS_NOT_READ, type RepoMountsReading } from "./reading.js";
import type { RepoOperations } from "../operations.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../lifecycle-events.js";

/** The subsystem a refused mount read names. */
const REPO_MOUNTS_READ_ORIGIN = "repo-mounts";

/** What one section reader collaborates with. */
export interface RepoMountsReaderOptions {
  /** The reads this section makes; nothing else reaches the daemon. */
  readonly operations: RepoOperations;
  /**
   * The session being read and two of the three reasons to read again. A store, not a bare id:
   * a `workspace.stale` frame and the repair edge that stands for reconnect are transitions of
   * this object, and the id is read off it so the two never name different sessions.
   */
  readonly sessionStore: SessionStore;
  /** The window the reading is drawn in; its regaining focus re-asks. */
  readonly ownerWindow: Window;
  /**
   * The clock this section's reading is stamped with, and the scheduler measures from. Required:
   * a wall-clock default would stamp `readAtMilliseconds` on a different time base than the
   * window's, and every age drawn against it would change string daily.
   */
  readonly clock: Clock;
}

/** Reads a session's mounts, workspaces and roots. */
export class RepoMountsReader implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this section a fresh read. Declared here so two readers of one
   * answer cannot watch different frames; `lifecycle-events.ts` derives the set.
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
      ownerWindow: options.ownerWindow,
    });
  }

  /** What the section renders right now. Stable identity between publishes. */
  public get snapshot(): RepoMountsReading {
    return this.#reading;
  }

  /**
   * Whether this reader is over, terminally. The binding asks so it can mint a replacement:
   * strict-mode's re-run setup would otherwise `start()` a disposed reader that returns early.
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

  /**
   * Terminal. No later event can re-arm a read behind a section that unmounted, and the window
   * no longer depends on this read, so a failure it recorded is forgotten.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#sessionStore.failedDependentReads.forget(this);
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
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
   * One pass, which never rejects: a refused call puts the reading back to the status it had
   * before the pass, so the section never says it is reading after the pass has ended, records
   * the cause in the window's diagnostic capture, and marks this read failed on the session.
   */
  async #performRead(round: ReadRound): Promise<void> {
    const statusBeforePass = this.#reading.status;
    this.#publish({ ...this.#reading, status: "reading" });
    try {
      await this.#readSection(round);
    } catch (rejection) {
      if (this.#disposed) {
        return;
      }
      const refusal = coerceToRefusal(rejection, REPO_MOUNTS_READ_ORIGIN);
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(this.#clock),
        severity: "warning",
        source: "features/repos",
        kind: "repo-mounts-read-refused",
        detail: `session ${this.#sessionId}: ${refusal.code}: ${refusal.detail}`,
      });
      this.#sessionStore.failedDependentReads.markFailed(this);
      this.#publish({ ...this.#reading, status: statusBeforePass });
    }
  }

  /**
   * The section's whole reading: the listed workspaces, one mount read per distinct mount and one
   * worktree read per distinct project. The round's signal reaches
   * each read, so an abandoned pass costs only the pre-send check per remaining call.
   */
  async #readSection(round: ReadRound): Promise<void> {
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
    const seenProjectIds = new Set<ProjectId>();
    for (const mount of mounts) {
      if (mount.origin.kind === "managed" || seenProjectIds.has(mount.origin.projectId)) {
        continue;
      }
      seenProjectIds.add(mount.origin.projectId);
      const roots = await this.#operations.readWorktreeStatus(mount.origin.projectId, round.signal);
      if (this.#isAbandoned(round)) {
        return;
      }
      worktrees.push(...roots.worktrees);
    }

    // Only this read's own success clears its failure.
    this.#sessionStore.failedDependentReads.forget(this);
    this.#publish({
      status: "read",
      mounts,
      workspaces,
      worktrees,
      readAtMilliseconds: this.#clock.now(),
    });
  }

  #publish(reading: RepoMountsReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
