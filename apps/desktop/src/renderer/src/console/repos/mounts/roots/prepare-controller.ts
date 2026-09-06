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
import type { ConsoleClock, Unsubscribe } from "../../../core/index.js";
import {
  ActController,
  type ActPrerequisiteReading,
  type ActReading,
  type ActSettlementReading,
  type ReadTriggerTarget,
  type RefreshReason,
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
export class ExecutionRootPrepareController implements ReadTriggerTarget {
  /**
   * The frames that owe the reuse check a fresh answer.
   *
   * THE FAMILY'S CENSUS AND NOT A LIST OF ITS OWN, on `repo-mounts-reader.ts`'s rule:
   * a worktree appearing, being retired, or changing state is exactly what makes a
   * reuse verdict wrong, and two readers of one answer must not disagree about when
   * that answer goes stale.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #bridge: ConsoleBridge;
  readonly #subject: PrepareSubject;
  readonly #acts: ActController<ReuseVerdict, PrepareSettlement>;

  public constructor(options: PrepareControllerOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#acts = new ActController({
      label: "execution root prepare reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      triggeringEventKinds: this.triggeringEventKinds,
      refusalOrigin: REPO_READS_REFUSAL_ORIGIN,
      readPrerequisite: async (branchName: string) => {
        const reply = await checkWorktreeReuse(
          this.#bridge,
          this.#subject.repoMountId as RepoMountId,
          branchName,
        );
        return reply.status === "refused"
          ? reply
          : { status: "served", value: reuseVerdictFor(reply.value) };
      },
    });
  }

  public get snapshot(): PrepareReading {
    return this.#acts.snapshot;
  }

  public get isDisposed(): boolean {
    return this.#acts.isDisposed;
  }

  public subscribe(sink: (reading: PrepareReading) => void): Unsubscribe {
    return this.#acts.subscribe(sink);
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
    this.#acts.start();
  }

  /**
   * Re-ask the reuse question, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING WITH NO BRANCH NAMED, which is the whole of what makes this reading
   * unusual: a window focus over a form nobody has typed into has no question to
   * re-ask, and requesting anyway would put `repo.worktreeReuseCheck` on the wire with
   * an empty branch on every focus for the life of the card.
   */
  public requestRead(reason: RefreshReason): void {
    this.#acts.requestRead(reason);
  }

  public dispose(): void {
    this.#acts.dispose();
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
      this.#acts.withdraw();
      return;
    }
    this.#acts.ask(branchName, "participant-request");
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
    await this.#acts.act(
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
    await this.#acts.act(
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

  /** Put the act half back to idle, so a second prepare is not read against the first. */
  public clearAct(): void {
    this.#acts.clearAct();
  }

  /** The worktree the newest verdict names, where the verdict names one at all. */
  #reusableCandidate(): string | undefined {
    const { prerequisite } = this.#acts.snapshot;
    return prerequisite.status === "read" && prerequisite.value.kind !== "none"
      ? prerequisite.value.worktreeId
      : undefined;
  }
}
