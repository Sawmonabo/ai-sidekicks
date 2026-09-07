// Preparing one workspace's execution root: the reuse check first, then the prepare.
//
// TWO CALLS IN ORDER, AND THE ORDER IS THE WHOLE POINT. `repo.worktreeReuseCheck`
// answers whether a live checkout of the named branch already exists and whether it is
// clean and compatible; only then does the surface know whether the prepare it is
// about to send needs a consent, cannot be sent at all, or is an ordinary create. A
// surface that sent the prepare first would learn the same three facts as REFUSALS,
// after the fact, and would have no way to ask for the consent the dirty case needs.
//
// THE CHECK IS KEYED ON WHAT WAS TYPED AND IS RE-RUN WHEN IT CHANGES, which is why the
// branch name is the prerequisite QUESTION `store/act-controller.ts` is scoped to: it
// does not exist until someone types one, a different one abandons the answer in
// flight, and an emptied field withdraws it rather than leaving a verdict on screen
// attached to a branch nobody named.
//
// THE CLONE PREPARE IS HERE TOO, AND NOT IN A THIRD CLASS. It is the same act — put an
// execution root on disk for this workspace — reached by a different call because the
// execution mode is different, and its settlement is the same three arms. What it does
// not have is a reuse check, because a clone is minted per run and nothing is reused.
//
// NOTHING IS RE-READ AFTER A SETTLEMENT BY THIS CLASS. The section owns its own
// reading and re-reads on the participant's act; a controller that also re-read would
// put two reads on the wire for one prepare.
//
// AND THE PREPARE ITSELF IS NOT REFRESHABLE, which is why only the check half is
// scheduled. A prepare is an act a person took once; re-sending it on a window focus
// would put a second execution root on disk for one press.

import type {
  EphemeralClonePrepareResponse,
  ExecutionMode,
  ExecutionRootPrepareResponse,
  RepoMountId,
  WorkspaceId,
  WorktreeId,
} from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleClock } from "../../../core/index.js";
import {
  ActSurfaceController,
  type ActOutcome,
  type ActPrerequisiteReading,
  type ActReading,
  type ActSettlementReading,
  type SessionStore,
} from "../../../store/index.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import {
  checkWorktreeReuse,
  prepareEphemeralClone,
  prepareExecutionRoot,
  REPO_READS_REFUSAL_ORIGIN,
} from "../../repo-reads.js";
import { reuseVerdictFor, type ReuseVerdict } from "./root-act-model.js";

/** What a finished prepare carries: the root on disk, and the state it is in. */
export interface PrepareSettlement {
  readonly status: "prepared";
  readonly executionRoot: string;
  readonly state: string;
}

/** Where the reuse check stands, for the branch name currently in the form. */
export type ReuseCheckReading = ActPrerequisiteReading<ReuseVerdict>;

/** Where the prepare stands. Its served arm carries the root the daemon put on disk. */
export type PrepareActReading = ActSettlementReading<PrepareSettlement>;

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
  readonly bridge: ConsoleBridge;
  readonly subject: PrepareSubject;
  /** The session whose reconnect edge and repo frames re-ask the reuse question. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/** Checks reuse and sends prepares for one workspace. */
export class ExecutionRootPrepareController extends ActSurfaceController<
  ReuseVerdict,
  PrepareSettlement
> {
  readonly #bridge: ConsoleBridge;
  readonly #subject: PrepareSubject;

  public constructor(options: PrepareControllerOptions) {
    super({
      label: "execution root prepare reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      // THE FAMILY'S CENSUS AND NOT A LIST OF ITS OWN, on `repo-mounts-reader.ts`'s
      // rule: a worktree appearing, being retired, or changing state is exactly what
      // makes a reuse verdict wrong, and two readers of one answer must not disagree
      // about when that answer goes stale.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
      refusalOrigin: REPO_READS_REFUSAL_ORIGIN,
    });
    this.#bridge = options.bridge;
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
   * sending a request the contract would refuse: a participant who cleared the field
   * has withdrawn the question, and leaving the last verdict on screen would attach it
   * to a branch nobody named.
   */
  public checkReuse(branchName: string): void {
    if (branchName.trim().length === 0) {
      this.withdrawPrerequisite();
      return;
    }
    this.askPrerequisite(branchName, "participant-request");
  }

  /**
   * Prepare a worktree root, reusing a named candidate where the verdict admits one.
   *
   * THE CONSENT AND THE CANDIDATE TRAVEL TOGETHER OR NOT AT ALL. `Spec-010`'s pair is
   * two members because naming a candidate and consenting to its uncommitted work are
   * two decisions, and sending the acknowledgement without the id would consent to
   * nothing — which is why the reuse id is what decides whether either is sent.
   */
  public async prepare(branchName: string, acknowledgeDirtyCandidate: boolean): Promise<void> {
    const reuseWorktreeId = this.#reusableCandidate();
    await this.sendAct(
      async () =>
        await prepareExecutionRoot(this.#bridge, {
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
   * Prepare an ephemeral clone for this workspace.
   *
   * NO CLEANUP POLICY IS SENT, and the omission is the contract's own default rather
   * than a value withheld: omitting it means `on_run_complete`, applied daemon-side and
   * echoed back, so the effective policy a card renders is the one that was applied.
   * A console that sent a policy here would be choosing a disposal deadline nobody
   * asked it to choose.
   */
  public async prepareClone(branchName: string): Promise<void> {
    await this.sendAct(
      async () =>
        await prepareEphemeralClone(this.#bridge, {
          workspaceId: this.#subject.workspaceId as WorkspaceId,
          branchName,
        }),
      (value: EphemeralClonePrepareResponse) => ({
        status: "prepared" as const,
        executionRoot: value.cloneRoot,
        state: value.state,
      }),
    );
  }

  /** The reuse check, asked for whatever branch name the form currently holds. */
  protected override async readPrerequisite(branchName: string): Promise<ActOutcome<ReuseVerdict>> {
    const reply = await checkWorktreeReuse(
      this.#bridge,
      this.#subject.repoMountId as RepoMountId,
      branchName,
    );
    return reply.status === "refused"
      ? reply
      : { status: "served", value: reuseVerdictFor(reply.value) };
  }

  /** The worktree the newest verdict names, where the verdict names one at all. */
  #reusableCandidate(): string | undefined {
    const verdict = this.prerequisiteValue;
    return verdict !== undefined && verdict.kind !== "none" ? verdict.worktreeId : undefined;
  }
}
