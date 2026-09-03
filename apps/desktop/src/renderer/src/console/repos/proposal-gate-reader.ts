// What one worktree's change-proposal gate knows, who asked for it, and when it asks
// again.
//
// `ProposalGate.tsx` renders and does not read; this is the half that reads, and
// `proposal-gate-binding.ts` is the half that holds one of these beside a component.
// One reader holds one worktree's gate state, so the two roots of a two-agent session
// carry two independent gates and neither can publish the other's refusal.
//
// EVERY READ GOES THROUGH THE CONSOLE'S ONE SCHEDULER, AND EVERY REASON THROUGH ONE
// TRIGGER CLASS. `Spec-023 §Rules every console surface obeys` fixes the policy —
// "Reads happen on subscribe, on window focus, on reconnect, and on the terminal events
// the owning spec names", under "No interval polling" — so this class arms no timer of
// its own and owns no listener of
// its own either: it builds a `RepoRefreshTriggers` over its own scheduler exactly as
// `repo-mounts-reader.ts` beside it does, which is what makes all four reasons reach
// a gate rather than only window focus. A daemon that reconnected, or a `workspace.stale`
// frame arriving in an already-focused window, used to leave the branch context and
// the prepared proposal standing with `push` still offered against them.
//
// The reader supplies one terminal event of its own beside the section's `workspace.stale`
// one: an act the daemon accepted, which it requests directly because it is the only
// observer of that act.
//
// NOT EVERY ROOT CAN BE ASKED ABOUT, AND THE ONES THAT CANNOT SAY SO. A gate is built
// for any of the three writable execution roots, and only one of them has a key the
// registered request takes: `proposal-gate-model.ts` resolves that once per reader as a
// read plan, an `unaddressable` plan publishes `not-checked` carrying its own reason,
// and no call is made and no refresh trigger is armed for it. The alternative was the
// one this file already refuses everywhere else — asking under a key the read does not
// take, and rendering whatever came back as a reading.
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
// THE TARGET BRANCH IS THE CONTEXT'S AND NEVER A SELECTION. `branch-context-model.ts`
// forbids inferring base or head from a pane, a tab, or a focused view; the preparation call's
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
  SUBJECT_NOT_ADDRESSABLE,
  branchContextReadPlanFor,
  branchContextReadingFrom,
  type BranchContextReadPlan,
  type ProposalGateRefusalCode,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";
import {
  proposalContextKeyOf,
  proposalContextKeysMatch,
  type PreparedProposal,
  type ProposalContextKey,
} from "./prepared-proposal.js";
import {
  PROPOSAL_ACTION_HEAD_EFFECT,
  PROPOSAL_ACTION_PRESENTATION,
  type ProposalAction,
} from "./proposal-actions.js";
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
   * The act this gate is waiting on the bridge for, or `undefined` where none is.
   *
   * ONE AT A TIME IS A PROPERTY OF THE READER, not of the surface that draws it. Two
   * preparations settling out of order let the older proposal overwrite the newer one,
   * and two commits confirmed against one payload are two commits. The surface renders
   * this member by holding its controls; the rule is enforced here, where a second
   * request is refused whatever pressed it.
   */
  readonly inFlightAction: ProposalAction | undefined;
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
  inFlightAction: undefined,
  settlement: undefined,
};

/**
 * One act awaiting the bridge, and the identity that tells it from its successor.
 *
 * The id is what makes a settlement attributable. `#inFlight` alone answers "is one
 * pending"; a continuation coming back from its await also has to answer "is the
 * pending one MINE", because a response for a request the register has moved past
 * must be dropped rather than written over the newer answer.
 */
interface InFlightProposalAction {
  readonly action: ProposalAction;
  readonly requestId: number;
}

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
  /** Resolved once: whether this root can be asked about, and with what. */
  readonly #readPlan: BranchContextReadPlan;
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
  /** The act awaiting the bridge. One at a time, and the gate says which. */
  #inFlight: InFlightProposalAction | undefined;
  /** Monotonic, so a superseded continuation can never match the standing request. */
  #nextActionRequestId = 1;
  #started = false;
  #disposed = false;

  public constructor(options: ProposalGateReaderOptions) {
    this.#bridge = options.bridge;
    this.#subject = options.subject;
    this.#readPlan = branchContextReadPlanFor(options.subject);
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
    if (this.#readPlan.kind === "unaddressable") {
      // NOTHING TO SCHEDULE AND NOTHING TO RE-READ. There is no arm of the registered
      // request this root can fill, so a focus, a reconnect, and a `workspace.stale`
      // frame would all produce the same answer — and producing it costs a read burst
      // each time. The arm is published once, here, and this reader arms no timer and
      // no listener at all.
      this.#publishUnaddressable(this.#readPlan.reason);
      return;
    }
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
    const pending = this.#inFlight;
    if (pending !== undefined) {
      // ONE ACT AT A TIME, AND THE SECOND PRESS IS REFUSED RATHER THAN QUEUED OR
      // DROPPED. Two overlapping preparations can settle out of order and the older
      // proposal then overwrites the newer one; two overlapping commits are two
      // commits. Refused rather than ignored, because a press that produced nothing
      // at all is the silent no-op rule 8 forbids — the sentence names the act the
      // gate is actually waiting on.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "action-in-flight" satisfies ProposalGateRefusalCode,
          `${PROPOSAL_ACTION_PRESENTATION[pending.action].label} has been sent and the daemon has not answered yet. Nothing else is sent until it settles.`,
        ),
      );
      return;
    }
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
      // `prepared` arm — and recorded rather than dropped, for the same reason.
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
    const request: InFlightProposalAction = { action, requestId: this.#nextActionRequestId };
    this.#nextActionRequestId += 1;
    this.#holdFor(request);
    try {
      if (action === "prepare-proposal") {
        await this.#prepareProposal(context, request);
        return;
      }
      await this.#executeGitAction(action, request);
    } finally {
      this.#release(request);
    }
  }

  /** Take the register for one act, and redraw so the gate holds its controls. */
  #holdFor(request: InFlightProposalAction): void {
    this.#inFlight = request;
    this.#publish({ ...this.#reading, inFlightAction: request.action });
  }

  /**
   * Give the register back, but only where it is still this request's to give.
   *
   * A disposal clears the register out from under a continuation, and a request that
   * no longer holds it must not clear a successor's — which is the same identity check
   * the settle paths make before they write.
   */
  #release(request: InFlightProposalAction): void {
    if (this.#inFlight?.requestId !== request.requestId) {
      return;
    }
    this.#inFlight = undefined;
    this.#publish({ ...this.#reading, inFlightAction: undefined });
  }

  /** Whether a settled call still speaks for the act the register is holding. */
  #stillStandingFor(request: InFlightProposalAction): boolean {
    return !this.#disposed && this.#inFlight?.requestId === request.requestId;
  }

  /** Terminal. No later event can re-arm a read behind a gate that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    // Cleared so a call still in flight settles into nothing rather than into a
    // register whose surface has gone.
    this.#inFlight = undefined;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  async #prepareProposal(
    context: BranchContextReading,
    request: InFlightProposalAction,
  ): Promise<void> {
    const outcome = await this.#bridge.growth.gitflowPrPrepare({
      branchContextId: context.branchContextId,
      // The context's own base branch, never a selection: there is no parameter on
      // this class through which one could arrive.
      targetBranch: context.baseBranch,
    });
    // SETTLED BY REQUEST IDENTITY, not merely by liveness. A reply for a request the
    // register has moved past describes a proposal a later act has already superseded,
    // and writing it would put the older payload back on the arm.
    if (!this.#stillStandingFor(request)) {
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

  async #executeGitAction(action: ProposalAction, request: InFlightProposalAction): Promise<void> {
    const outcome = await this.#bridge.growth.gitActionExecute({
      workspaceId: this.#subject.workspaceId,
      action,
    });
    if (!this.#stillStandingFor(request)) {
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
    if (PROPOSAL_ACTION_HEAD_EFFECT[action] === "moves-head") {
      // AN ACCEPTED COMMIT MOVES THE HEAD THE PROPOSAL WAS BUILT FROM, AND THE PAIRING
      // CHECK BELOW CANNOT SEE IT. `proposalContextKeysMatch` compares the context id
      // and the two branch names, and a commit changes none of the three — so the
      // refresh this act queues would re-publish the pre-commit proposal and go on
      // offering the send for a payload that no longer describes the head. Discarded
      // HERE, before the refresh is asked for, so the new contents have to be prepared
      // and reviewed again.
      //
      // AND REDRAWN IN THE SAME ACT rather than left to the read. The scheduler
      // debounces, so a discard that only took effect when the answer came back would
      // leave the remote act offered against the stale proposal for the length of that
      // wait. The arm keeps the context it last read, which is still the context; what
      // it loses is the proposal.
      this.#discardProposal();
      this.#withdrawPublishedProposal();
    }
    this.#scheduler.request("terminal-event");
  }

  /** Redraw the standing arm with the proposal gone, where it was carrying one. */
  #withdrawPublishedProposal(): void {
    const { state } = this.#reading;
    if (state.kind !== "prepared" || state.proposal === undefined) {
      return;
    }
    const { proposal: _withdrawn, ...withoutProposal } = state;
    this.#publish({
      ...this.#reading,
      state: withoutProposal,
      refusal: undefined,
      settlement: GATE_SETTLEMENT_COPY.prepared,
    });
  }

  async #performRead(): Promise<void> {
    const plan = this.#readPlan;
    if (plan.kind === "unaddressable") {
      // `start` short-circuits before scheduling one of these, so this is reached only
      // if some other path asks for a read. It publishes the same honest arm rather
      // than returning silently, which would leave a gate showing whatever it showed.
      this.#publishUnaddressable(plan.reason);
      return;
    }
    if (!this.#hasEnteredPreparing) {
      this.#hasEnteredPreparing = true;
      this.#publish({ ...this.#reading, state: { kind: "preparing" }, refusal: undefined });
    }

    const outcome = await this.#bridge.growth.gitflowBranchContextRead(plan.request);
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

  /**
   * Say that this root cannot be asked about, and why.
   *
   * `not-checked` and never `no-context`: the question was not PUT, which is a
   * different fact from a workspace that has none — and the arm carries no message of
   * its own, so the reason travels beside it as the refusal the surface renders. The
   * refusal is the reader's own, because nothing refused it: no call was made.
   */
  #publishUnaddressable(reason: string): void {
    this.#context = undefined;
    this.#discardProposal();
    this.#publish({
      ...this.#reading,
      state: { kind: "not-checked" },
      refusal: refuse(PROPOSAL_GATE_REFUSAL_ORIGIN, SUBJECT_NOT_ADDRESSABLE, reason),
      settlement: reason,
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
