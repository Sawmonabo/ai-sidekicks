// Preparing one workspace's execution root: the reuse check first, then the prepare.
//
// Two calls in order, and the order is the point. `repo.worktreeReuseCheck` answers whether
// a live checkout of the named branch already exists and whether it is clean and
// compatible; only then does the surface know whether the prepare it is about to send needs
// a consent, cannot be sent at all, or is an ordinary create.
//
// The check is keyed on what was typed and is re-run when it changes, which is why the
// branch name is the prerequisite question the store's act controller is scoped to: it does
// not exist until someone types one, a different one abandons the answer in flight, and an
// emptied field withdraws it rather than leaving a verdict on screen attached to a branch
// nobody named.
//
// Nothing is re-read after a settlement by this class. The section owns its own reading and
// re-reads on the user's act.
//
// The prepare itself is not refreshable, which is why only the check half is scheduled. A
// prepare is an act a person took once; re-sending it on a window focus would put a second
// execution root on disk for one press.

import type {
  ExecutionMode,
  ExecutionRootPrepareResponse,
  RepoMountId,
  WorkspaceId,
  WorktreeId,
} from "@ai-sidekicks/contracts";

import type { ConsoleClock } from "@renderer/lib/clock.js";
import { ActControllerBase } from "../../acts/act-controller-base.js";
import { type ActReading } from "../../acts/act-reading.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import type { RepoOperations } from "../../repo-operations.js";
import { reuseVerdictFor, type ReuseVerdict } from "./prepare-form.js";

/** The two calls this controller makes. */
export type PrepareOperations = Pick<RepoOperations, "checkWorktreeReuse" | "prepareExecutionRoot">;

/** What a finished prepare carries: the root on disk, and the state it is in. */
export interface PrepareSettlement {
  readonly status: "prepared";
  readonly executionRoot: string;
  readonly state: string;
}

/** Both halves, published together so a surface renders one consistent frame. */
export type PrepareReading = ActReading<ReuseVerdict, PrepareSettlement>;

/** What one prepare controller is scoped to: a workspace, on a mount, in one mode. */
export interface PrepareSubject {
  readonly workspaceId: string;
  readonly repoMountId: string;
  readonly executionMode: ExecutionMode;
}

/** What one prepare controller collaborates with, beside the subject it is scoped to. */
export interface PrepareControllerOptions {
  readonly operations: PrepareOperations;
  readonly subject: PrepareSubject;
  /** The session whose reconnect edge and repo frames re-ask the reuse question. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/** Checks reuse and sends prepares for one workspace. */
export class ExecutionRootPrepareController extends ActControllerBase<
  ReuseVerdict,
  PrepareSettlement
> {
  readonly #operations: PrepareOperations;
  readonly #subject: PrepareSubject;

  public constructor(options: PrepareControllerOptions) {
    super({
      label: "execution root prepare reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      // The family's census and not a list of its own: a worktree appearing, being retired,
      // or changing state is what makes a reuse verdict wrong, and two readers of one
      // answer must not disagree about when it goes stale.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
    });
    this.#operations = options.operations;
    this.#subject = options.subject;
  }

  /**
   * Arm the refresh triggers. Idempotent, and takes NO first read.
   *
   * The reader beside this one reads on `subscribe` because its question exists the
   * moment it is constructed. This one's does not — there is no branch until somebody
   * names one — so arming is the whole of what this does, and the first read arrives
   * with the first `checkReuse`.
   */
  public start(): void {
    this.startTriggers();
  }

  /**
   * Ask whether this branch already has a live checkout on the mount.
   *
   * AN EMPTY BRANCH ASKS NOTHING and puts the reading back to unchecked rather than
   * sending a request the contract would refuse: a user who cleared the field
   * has withdrawn the question, and leaving the last verdict on screen would attach it
   * to a branch nobody named.
   */
  public checkReuse(branchName: string): void {
    if (branchName.trim().length === 0) {
      this.withdrawPrerequisite();
      return;
    }
    this.askPrerequisite(branchName, "user-request");
  }

  /**
   * Prepare a worktree root, reusing a named candidate where the verdict admits one.
   *
   * The consent and the candidate travel together or not at all. Naming a candidate and
   * consenting to its uncommitted work are two decisions, and sending the acknowledgement
   * without the id would consent to nothing, so the reuse id decides whether either is sent.
   */
  public async prepare(branchName: string, acknowledgeDirtyCandidate: boolean): Promise<void> {
    const reuseWorktreeId = this.#reusableCandidate();
    await this.sendAct(
      async () =>
        await this.#operations.prepareExecutionRoot({
          workspaceId: this.#subject.workspaceId as WorkspaceId,
          branchName,
          ...(reuseWorktreeId === undefined
            ? {}
            : { reuseWorktreeId: reuseWorktreeId as WorktreeId, acknowledgeDirtyCandidate }),
        }),
      (value: ExecutionRootPrepareResponse) => ({
        status: "prepared" as const,
        executionRoot: value.executionRoot,
        state: value.state,
      }),
    );
  }

  /**
   * The reuse check, asked for whatever branch name the form currently holds.
   *
   * The round's signal goes straight to the call, which matters most on exactly this
   * read: a user typing a branch name supersedes their own check every few keystrokes,
   * and each superseded one stops instead of being folded into a verdict for a branch
   * that has already been edited away from.
   */
  protected override async readPrerequisite(
    branchName: string,
    signal: AbortSignal,
  ): Promise<ReuseVerdict> {
    const reply = await this.#operations.checkWorktreeReuse(
      this.#subject.repoMountId as RepoMountId,
      branchName,
      signal,
    );
    return reuseVerdictFor(reply);
  }

  /** The worktree the newest verdict names, where the verdict names one at all. */
  #reusableCandidate(): string | undefined {
    const verdict = this.prerequisiteValue;
    return verdict !== undefined && verdict.kind !== "none" ? verdict.worktreeId : undefined;
  }
}
