// Preparing one workspace's execution root: the reuse check first, then the prepare.
//
// TWO CALLS IN ORDER, AND THE ORDER IS THE WHOLE POINT. `repo.worktreeReuseCheck`
// answers whether a live checkout of the named branch already exists and whether it is
// clean and compatible; only then does the surface know whether the prepare it is
// about to send needs a consent, cannot be sent at all, or is an ordinary create. A
// surface that sent the prepare first would learn the same three facts as REFUSALS,
// after the fact, and would have no way to ask for the consent the dirty case needs.
//
// THE CHECK IS KEYED ON WHAT WAS TYPED AND IS RE-RUN WHEN IT CHANGES, which is why it
// is a call a control makes rather than a read this class arms on construction: the
// branch name is the question, and it does not exist until someone types one.
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
// THE CHECK IS A WIRE READING, SO IT GOES THROUGH THE CONSOLE'S ONE SCHEDULER. Whether
// a branch already has a live checkout is a fact about the mount that another
// participant's retire, or another run's prepare, changes while this form sits open —
// so `Spec-023 §Rules every console surface obeys` applies to it exactly as it applies
// to the section's own read: no timer, four admitted reasons, one scheduler. What is
// unusual is only that the QUESTION arrives late. There is nothing to ask until a
// branch is named, so a refresh reason arriving with no named branch asks nothing
// rather than sending a request the contract would refuse unread.
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
import {
  Emitter,
  normalizeWireRejection,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../../core/index.js";
import {
  RefreshScheduler,
  SessionRefreshTriggers,
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

/** Where the reuse check stands, for the branch name currently in the form. */
export type ReuseCheckReading =
  | { readonly status: "not-checked" }
  | { readonly status: "checking" }
  | { readonly status: "checked"; readonly verdict: ReuseVerdict }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Where the prepare stands. Its served arm carries the root the daemon put on disk. */
export type PrepareActReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "prepared"; readonly executionRoot: string; readonly state: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Both halves, published together so a surface renders one consistent frame. */
export interface PrepareReading {
  readonly reuse: ReuseCheckReading;
  readonly act: PrepareActReading;
}

/** Nothing checked and nothing sent. */
export const PREPARE_NOT_STARTED: PrepareReading = {
  reuse: { status: "not-checked" },
  act: { status: "idle" },
};

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
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes = new Emitter<PrepareReading>("execution root prepare reading");
  #reading: PrepareReading = PREPARE_NOT_STARTED;
  #started = false;
  #disposed = false;
  /**
   * The branch the newest check was issued for.
   *
   * THE GUARD AGAINST A LATE ANSWER OVERWRITING A NEWER QUESTION. Two checks in flight
   * settle in whatever order the wire returns them, and without this the verdict on
   * screen could be the one for a branch name the participant has already edited away
   * from — which is the one state that would let a consent be given for the wrong tree.
   */
  #checkedBranch: string | undefined;

  public constructor(options: PrepareControllerOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performReuseCheck();
      },
      // A check that threw past its own refusal handling reaches nobody from inside a
      // scheduler callback, so it lands in the reuse half as a refusal instead — the
      // form renders it rather than holding the verdict it was showing before.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          reuse: {
            status: "refused",
            refusal: normalizeWireRejection(REPO_READS_REFUSAL_ORIGIN, error),
          },
        });
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
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
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers.start();
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
    if (this.#disposed || this.#checkedBranch === undefined) {
      return;
    }
    this.#scheduler.request(reason);
  }

  public get snapshot(): PrepareReading {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: PrepareReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
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
    if (this.#disposed) {
      return;
    }
    if (branchName.trim().length === 0) {
      this.#checkedBranch = undefined;
      this.#publish({ ...this.#reading, reuse: { status: "not-checked" } });
      return;
    }
    this.#checkedBranch = branchName;
    this.#publish({ ...this.#reading, reuse: { status: "checking" } });
    this.requestRead("participant-request");
  }

  /**
   * Ask the daemon about the branch the newest check named.
   *
   * READS THE BRANCH AT PERFORM TIME rather than taking one at request time, because
   * the scheduler coalesces: two edits inside one debounce window are one call, and it
   * has to be the call for what is in the field NOW.
   */
  async #performReuseCheck(): Promise<void> {
    const branchName = this.#checkedBranch;
    if (branchName === undefined) {
      return;
    }
    const reply = await checkWorktreeReuse(
      this.#bridge,
      this.#subject.repoMountId as RepoMountId,
      branchName,
    );
    if (this.#disposed || this.#checkedBranch !== branchName) {
      return;
    }
    this.#publish({
      ...this.#reading,
      reuse:
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : { status: "checked", verdict: reuseVerdictFor(reply.value) },
    });
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
    if (this.#reading.act.status === "sending" || this.#disposed) {
      return;
    }
    const reuse = this.#reading.reuse;
    const reuseWorktreeId =
      reuse.status === "checked" && reuse.verdict.kind !== "none"
        ? reuse.verdict.worktreeId
        : undefined;
    this.#publish({ ...this.#reading, act: { status: "sending" } });
    const reply = await prepareExecutionRoot(this.#bridge, {
      workspaceId: this.#subject.workspaceId as WorkspaceId,
      branchName,
      ...(reuseWorktreeId === undefined
        ? {}
        : { reuseWorktreeId: reuseWorktreeId as WorktreeId, acknowledgeDirtyCandidate }),
    });
    this.#settle(reply, (value: ExecutionRootPrepareResponse) => ({
      status: "prepared" as const,
      executionRoot: value.executionRoot,
      state: value.state,
    }));
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
    if (this.#reading.act.status === "sending" || this.#disposed) {
      return;
    }
    this.#publish({ ...this.#reading, act: { status: "sending" } });
    const reply = await prepareEphemeralClone(this.#bridge, {
      workspaceId: this.#subject.workspaceId as WorkspaceId,
      branchName,
    });
    this.#settle(reply, (value: EphemeralClonePrepareResponse) => ({
      status: "prepared" as const,
      executionRoot: value.cloneRoot,
      state: value.state,
    }));
  }

  /** Put the act half back to idle, so a second prepare is not read against the first. */
  public clearAct(): void {
    if (this.#reading.act.status === "idle") {
      return;
    }
    this.#publish({ ...this.#reading, act: { status: "idle" } });
  }

  /**
   * Publish one prepare's settlement, whichever call produced it.
   *
   * THE TWO CALLS ANSWER DIFFERENT SHAPES AND SETTLE THE SAME WAY, which is what this
   * takes a reader for: the worktree arm names its root `executionRoot` and the clone
   * arm names its root `cloneRoot`, and a surface that had to know which call it had
   * made in order to read the answer would carry the branch twice.
   */
  #settle<TValue>(
    reply:
      | { readonly status: "served"; readonly value: TValue }
      | { readonly status: "refused"; readonly refusal: ConsoleRefusal },
    read: (value: TValue) => PrepareActReading,
  ): void {
    if (this.#disposed) {
      return;
    }
    this.#publish({
      ...this.#reading,
      act:
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : read(reply.value),
    });
  }

  #publish(reading: PrepareReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
