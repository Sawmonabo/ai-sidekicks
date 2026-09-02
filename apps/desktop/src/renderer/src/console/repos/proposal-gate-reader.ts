// What one worktree's change-proposal gate knows, who asked for it, and when it asks
// again.
//
// `ProposalGate.tsx` renders and does not read; this is the half that reads, and
// `proposal-gate-binding.ts` is the half that holds one of these beside a component.
// One reader holds one worktree's gate state, so the two roots of a two-agent session
// carry two independent gates and neither can publish the other's refusal.
//
// EVERY READ GOES THROUGH THE CONSOLE'S ONE SCHEDULER, AND EVERY REASON THROUGH ONE
// TRIGGER CLASS. `Spec-023 §Console Design (Meridian)` §10.1 fixes the policy in a
// sentence — on panel focus, on reconnect, and on a `workspace.stale` frame, with no
// interval polling — so this class arms no timer of its own and owns no listener of
// its own either: it builds a `RepoRefreshTriggers` over its own scheduler exactly as
// `repo-mounts-reader.ts` beside it does, which is what makes all three reasons reach
// a gate rather than only the first. A daemon that reconnected, or a `workspace.stale`
// frame arriving in an already-focused window, used to leave the branch context and
// the prepared proposal standing with `push` still offered against them.
//
// The reader adds one reason of its own on top of the three: the terminal event of an
// act the daemon accepted, which it requests directly because it is the only observer
// of that act.
//
// ALL THREE OPERATIONS ARE GROWTH-PORT OPERATIONS, AND ALL THREE ARE UNREGISTERED.
// `bridge/growth-signatures.ts` carries the branch-context read, the preparation
// call, and the git action under one `gitflow-actions` slate row that `Spec-011`
// owns, and the live bridge refuses each of them by name. So the ordinary arm on a
// release build is `not-checked` carrying the port's own sentence — never an empty
// gate, and never a gate that looks prepared because nothing came back.
//
// WHAT THIS READER DELIBERATELY CANNOT PUBLISH, AND WHY IT IS A WIRE FACT
//
//   • `hosting-unavailable`, for the reason `proposal-gate-state.ts` records on the arm
//     itself: no registered reply names a bundle or an outage, so there is no honest
//     route to it, and it stays drawable for a caller that CAN state it.
//   • A `status` reading. The three trichotomies are facts about a proposal that
//     exists ON A HOST, and nothing in this console has talked to one — the
//     preparation call is explicitly the step before any remote mutation.
//   • `detectedHost`, `title`, `body`, `trailers`, `changedPaths`. Each is optional on
//     the shape it belongs to for the reason recorded there, and this reader supplies
//     exactly the ones a reply named.
//
// THE TARGET BRANCH IS THE CONTEXT'S AND NEVER A SELECTION. §10.7 forbids inferring
// base or head from a pane, a tab, or a focused view; the preparation call's
// `targetBranch` is therefore read off the served context's `baseBranch` and there is
// no parameter on this class through which a selection could reach it — the same
// prohibition `ProposalGate.tsx` makes structural on its own side.

import type { ConsoleBridge } from "../bridge/index.js";
import {
  Emitter,
  RealClock,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import { RefreshScheduler, type SessionStore } from "../store/index.js";
import type { BranchContextReading } from "./branch-context-model.js";
import {
  GATE_SETTLEMENT_COPY,
  PROPOSAL_GATE_REFUSAL_ORIGIN,
  branchContextReadingFrom,
  type ProposalGateRefusalCode,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";
import {
  proposalContextKeyOf,
  proposalContextKeysMatch,
  type PreparedProposal,
  type ProposalContextKey,
} from "./prepared-proposal.js";
import type { ProposalAction } from "./proposal-actions.js";
import type { ProposalGateState } from "./proposal-gate-state.js";
import { RepoRefreshTriggers } from "./repo-refresh-triggers.js";

/**
 * Everything one worktree's gate renders from, in one immutable value.
 *
 * `refusal` is a FIELD rather than a seventh arm because two of the six arms carry no
 * message of their own: `not-checked` is the arm a wire-unregistered refusal produces
 * and it says nothing about which wire, so the refusal travels beside it and the
 * surface renders it through the same `RefusalCard` the repos section uses for a
 * refused mount list. An arm that DOES carry its message — `refused` — leaves this
 * field undefined, so the same sentence is never printed twice.
 */
export interface ProposalGateReading {
  readonly state: ProposalGateState;
  /** The read's own failure, where the published arm admits no message. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * What the last press of each act produced. Rendered beside the control pressed.
   *
   * An act's entry is dropped the moment that act is issued again, so what stands here
   * is always a failure of the most recent press and never one a later success outran.
   */
  readonly actionRefusals: ReadonlyMap<ProposalAction, ConsoleRefusal>;
  /**
   * One sentence naming what this gate settled on, or `undefined` before it has.
   *
   * Composed here rather than in the component so the announcement and the arm cannot
   * disagree: the sentence is a function of the same publish that moved the arm, and a
   * surface that announced from its own render body would speak once per render.
   */
  readonly settlement: string | undefined;
}

const NOTHING_ASKED: ProposalGateReading = {
  state: { kind: "not-checked" },
  refusal: undefined,
  actionRefusals: new Map(),
  settlement: undefined,
};

export interface ProposalGateReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly subject: ProposalGateSubject;
  /** The session whose repair edge and whose frames are two of the three reasons to re-read. */
  readonly sessionStore: SessionStore;
  /** Injected so a test drives every read on frozen time with no real timers. */
  readonly clock?: ConsoleClock;
}

export class ProposalGateReader {
  readonly #bridge: ConsoleBridge;
  readonly #subject: ProposalGateSubject;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: RepoRefreshTriggers;
  readonly #changes = new Emitter<ProposalGateReading>("proposal gate reading");

  #reading: ProposalGateReading = NOTHING_ASKED;
  /**
   * The served context, held so an act can name the id and the branch it targets.
   *
   * Held beside the reading rather than read back out of it, because only the
   * `prepared` arm carries one and an act must not have to narrow an arm to find the
   * id it was given.
   */
  #context: BranchContextReading | undefined;
  #proposal: PreparedProposal | undefined;
  /** The context the held proposal was prepared AGAINST. `prepared-proposal.ts` says why. */
  #proposalPreparedFor: ProposalContextKey | undefined;
  /** `preparing` is entered once. A refresh redraws the answer, never the wait. */
  #hasEnteredPreparing = false;
  #started = false;
  #disposed = false;

  public constructor(options: ProposalGateReaderOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock ?? new RealClock(),
      perform: async () => {
        await this.#performRead();
      },
      // A read that threw past its own refusal handling lands in the reading as the
      // `refused` arm. Re-throwing into a timer callback reaches nobody, and
      // swallowing would leave a gate showing the wait it never came out of.
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          state: { kind: "refused", message: rejectionText(error) },
          refusal: undefined,
          settlement: GATE_SETTLEMENT_COPY.refused,
        });
      },
    });
    // The three reasons to read again. They reach this reader only through the scheduler.
    this.#triggers = new RepoRefreshTriggers({
      scheduler: this.#scheduler,
      sessionStore: options.sessionStore,
    });
  }

  /** What this gate renders right now. Stable identity between publishes. */
  public get snapshot(): ProposalGateReading {
    return this.#reading;
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  public subscribe(sink: (reading: ProposalGateReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Begin reading, and keep listening for the reasons to read again.
   *
   * Idempotent for `repo-mounts-reader.ts`'s reason: React mounts an effect twice in
   * development strict mode, and a gate that armed twice would double every read in
   * exactly the environment where the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#scheduler.request("subscribe");
    this.#triggers.start();
  }

  /**
   * Send one of the three modelled acts.
   *
   * `prepare-proposal` goes to the preparation call, which mutates nothing remote;
   * the other two go to the git action the port already carries. A refused act
   * publishes beside the control that was pressed and changes no arm — the act did
   * not happen, so the gate still reports what it last read. An accepted act
   * re-reads, because what the act changed is what the next read will say.
   */
  public async requestAction(action: ProposalAction): Promise<void> {
    // WHAT THE LAST PRESS PRODUCED IS CLEARED WHEN THE NEXT ONE IS ISSUED, not when it
    // settles: every later publish spreads `actionRefusals` forward, so a refusal used
    // to stand beside its control for the life of the reader even after the same act
    // succeeded. One write here covers both accepted paths and leaves an in-flight
    // retry showing no stale failure; a refused retry re-records its own below. Every
    // OTHER act's entry survives — a failed commit is still a fact after a push worked.
    this.#clearActionRefusal(action);
    const context = this.#context;
    if (context === undefined) {
      // Structurally unreachable from the gate, which offers acts only on the
      // `prepared` arm — and recorded rather than dropped, because a press that
      // produced nothing at all is the silent no-op rule 8 forbids.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "no-served-context" satisfies ProposalGateRefusalCode,
          "This gate has read no branch context, so there is nothing to act on.",
        ),
      );
      return;
    }
    if (action === "prepare-proposal") {
      await this.#prepareProposal(context);
      return;
    }
    await this.#executeGitAction(action);
  }

  /** Terminal. No later event can re-arm a read behind a gate that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  async #prepareProposal(context: BranchContextReading): Promise<void> {
    const outcome = await this.#bridge.growth.gitflowPrPrepare({
      branchContextId: context.branchContextId,
      // The context's own base branch, never a selection: there is no parameter on
      // this class through which one could arrive.
      targetBranch: context.baseBranch,
    });
    if (this.#disposed) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal("prepare-proposal", outcome);
      return;
    }
    this.#proposal = {
      baseBranch: context.baseBranch,
      headBranch: context.headBranch,
      state: outcome.value.state,
      blob: outcome.value.proposalBlob,
    };
    this.#proposalPreparedFor = proposalContextKeyOf(context);
    // Re-read rather than publish the proposal beside a context this call did not
    // re-establish: one read is the source of the arm, so the proposal joins the arm
    // the next read publishes and the console holds no second copy of the context.
    this.#scheduler.request("terminal-event");
  }

  async #executeGitAction(action: ProposalAction): Promise<void> {
    const outcome = await this.#bridge.growth.gitActionExecute({
      workspaceId: this.#subject.workspaceId,
      action,
    });
    if (this.#disposed) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal(action, outcome);
      return;
    }
    if (!outcome.value.accepted) {
      // A served answer that did not take the act. Rendered rather than treated as a
      // success: the wire said `accepted: false`, and the sentence says exactly that
      // rather than guessing at a reason the reply does not carry.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "action-not-accepted" satisfies ProposalGateRefusalCode,
          `The daemon answered this action without accepting it. Nothing was ${action === "commit" ? "recorded" : "sent"}.`,
        ),
      );
      return;
    }
    this.#scheduler.request("terminal-event");
  }

  async #performRead(): Promise<void> {
    if (!this.#hasEnteredPreparing) {
      this.#hasEnteredPreparing = true;
      this.#publish({ ...this.#reading, state: { kind: "preparing" }, refusal: undefined });
    }

    const outcome = await this.#bridge.growth.gitflowBranchContextRead({
      workspaceId: this.#subject.workspaceId,
      worktreeId: this.#subject.worktreeId,
    });
    if (this.#disposed) {
      return;
    }

    if (outcome.status === "unavailable") {
      this.#context = undefined;
      this.#discardProposal();
      // The port's two refusal classes are two different facts and get two different
      // arms. `wire-unregistered` means the question could not be put at all, which
      // is `not-checked` — and that arm carries no message, so the refusal travels
      // beside it. A scripted reply that never arrived means the question WAS put and
      // the answer did not come, which is a failure the `refused` arm states.
      if (outcome.code === "wire-unregistered") {
        this.#publish({
          ...this.#reading,
          state: { kind: "not-checked" },
          refusal: outcome,
          settlement: outcome.detail,
        });
        return;
      }
      this.#publish({
        ...this.#reading,
        state: { kind: "refused", message: outcome.detail },
        refusal: undefined,
        settlement: GATE_SETTLEMENT_COPY.refused,
      });
      return;
    }

    const branchContext = outcome.value.branchContext;
    if (branchContext === undefined) {
      this.#context = undefined;
      this.#discardProposal();
      this.#publish({
        ...this.#reading,
        state: { kind: "no-context", executionMode: this.#subject.executionMode },
        refusal: undefined,
        settlement: GATE_SETTLEMENT_COPY["no-context"],
      });
      return;
    }

    const context = branchContextReadingFrom(branchContext, this.#subject.executionMode);
    this.#context = context;
    // A REFRESHED CONTEXT NEVER CARRIES A PROPOSAL PREPARED FOR A DIFFERENT ONE. An
    // external checkout or a repair can move the base or the head between reads, and a
    // proposal on this arm is exactly what offers the remote act — so a mismatch
    // discards it rather than publishing it beside a context it was not built against.
    if (
      this.#proposalPreparedFor !== undefined &&
      !proposalContextKeysMatch(this.#proposalPreparedFor, context)
    ) {
      this.#discardProposal();
    }
    const proposal = this.#proposal;
    this.#publish({
      ...this.#reading,
      state: {
        kind: "prepared",
        context,
        ...(proposal === undefined ? {} : { proposal }),
      },
      refusal: undefined,
      settlement:
        proposal === undefined
          ? GATE_SETTLEMENT_COPY.prepared
          : GATE_SETTLEMENT_COPY["prepared-with-proposal"],
    });
  }

  /** Drop the held proposal and the context it was prepared for, which are one fact. */
  #discardProposal(): void {
    this.#proposal = undefined;
    this.#proposalPreparedFor = undefined;
  }

  /** Drop one act's standing failure. A publish only where there was one to drop. */
  #clearActionRefusal(action: ProposalAction): void {
    if (!this.#reading.actionRefusals.has(action)) {
      return;
    }
    const actionRefusals = new Map(this.#reading.actionRefusals);
    actionRefusals.delete(action);
    this.#publish({ ...this.#reading, actionRefusals });
  }

  #recordActionRefusal(action: ProposalAction, refusal: ConsoleRefusal): void {
    const actionRefusals = new Map(this.#reading.actionRefusals);
    actionRefusals.set(action, refusal);
    this.#publish({ ...this.#reading, actionRefusals });
  }

  #publish(reading: ProposalGateReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/** What a thrown read says, without asserting a shape the throw may not have. */
function rejectionText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
