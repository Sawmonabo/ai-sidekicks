// Prepares one workspace's execution root: the reuse check first, then the prepare. The check
// (`repo.worktreeReuseCheck`) tells the form whether the prepare is a create, needs consent, or
// cannot be sent, so the branch name is the prerequisite question: a different one abandons the
// answer in flight and an emptied field withdraws it. Only the check is refreshable; re-sending
// a prepare on a window focus would put a second root on disk for one press.

import type { ExecutionMode, RepoMountId, WorkspaceId } from "@ai-sidekicks/contracts/repo";
import type { ExecutionRootPrepareResponse, WorktreeId } from "@ai-sidekicks/contracts/worktree";

import type { Clock } from "@renderer/lib/clock.js";
import { ActControllerBase } from "../../acts/act-controller-base.js";
import { type ActReading } from "../../acts/act-reading.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import type { RepoOperations } from "../../repo-operations.js";
import { reuseVerdictFor, type ReuseVerdict } from "./prepare-form.js";

/** The two calls this controller makes. */
export type PrepareOperations = Pick<RepoOperations, "checkWorktreeReuse" | "prepareExecutionRoot">;

/** What a finished prepare carries: the root on disk, and the state it is in. */
export type PrepareSettlement = { readonly status: "prepared" } & Readonly<
  Pick<ExecutionRootPrepareResponse, "executionRoot" | "state">
>;

/** Both halves, published together so a form renders one consistent frame. */
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
  /** The window the reading is drawn in; its regaining focus re-asks. */
  readonly ownerWindow: Window;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: Clock;
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
      ownerWindow: options.ownerWindow,
      // The repos feature's census: a worktree appearing, being retired or changing state makes a
      // reuse verdict wrong.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
    });
    this.#operations = options.operations;
    this.#subject = options.subject;
  }

  /**
   * Arm the refresh triggers and take no first read: there is no branch until somebody names
   * one, so the first read arrives with the first `checkReuse`. Idempotent.
   */
  public start(): void {
    this.startTriggers();
  }

  /**
   * Ask whether this branch already has a live checkout on the mount. An empty branch asks
   * nothing and puts the reading back to unchecked, so a cleared field leaves no verdict
   * attached to a branch nobody named.
   */
  public checkReuse(branchName: string): void {
    if (branchName.trim().length === 0) {
      this.withdrawPrerequisite();
      return;
    }
    this.askPrerequisite(branchName, "user-request");
  }

  /**
   * Prepare a worktree root, reusing a named candidate where the verdict admits one. The
   * acknowledgement travels only with a candidate id: sent alone it would consent to nothing.
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
   * The reuse check for the branch the form holds. The round's signal goes to the call, so a
   * check superseded by further typing stops instead of folding into a stale verdict.
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

  #reusableCandidate(): string | undefined {
    const verdict = this.prerequisiteValue;
    return verdict !== undefined && verdict.kind !== "none" ? verdict.worktreeId : undefined;
  }
}
