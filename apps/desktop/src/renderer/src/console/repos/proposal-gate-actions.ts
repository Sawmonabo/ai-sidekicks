// The change-proposal gate's ACT half: one act on the wire at a time, and what each
// answer leaves standing on the arm the read published.
//
// Split from `proposal-gate-reader.ts` on the seam this family already uses three
// times — `proposal-gate-model.ts` beside the reader, `proposal-gate-binding.ts`
// beside the component, `prepared-proposal.ts` beside `ProposalGate.tsx`. The class
// next door owns the READ: which call, on which of the four reasons, and what it
// publishes when one does not answer. This one owns the ACTS: what a press sends,
// what a reply does to the held proposal, and what a refusal leaves beside the control
// that produced it. Two subjects, two collaborators — a scheduler and its triggers
// there, the growth port's two mutating operations here — and two teardowns. Kept
// together the file was doing both jobs at once, which `apps/desktop/AGENTS.md`
// rejects.
//
// THEY MEET AT ONE OBJECT, WHICH IS THE WHOLE SEAM. `ProposalGateActionHost` is the
// six things an act needs from the half that read: the standing reading, the served
// context, the publish, the two writes to the held proposal, and the refresh an
// accepted act asks for. Nothing else crosses — this class holds no scheduler, no
// trigger, and no arm of its own, so a read cannot be started from here and an act
// cannot invent a context.
//
// ONE ACT AT A TIME, AND THE SECOND PRESS IS REFUSED RATHER THAN QUEUED OR DROPPED.
// Two overlapping preparations can settle out of order and the older proposal then
// overwrites the newer one; two overlapping commits are two commits. Refused rather
// than ignored, because a press that produced nothing at all is the silent no-op
// rule 8 forbids.
//
// SETTLED BY REQUEST IDENTITY, NOT MERELY BY LIVENESS. Every continuation checks the
// id it was issued under before it writes: a reply for a request the register has
// moved past describes a proposal a later act has already superseded, and writing it
// would put the older payload back on the arm.
//
// THE TARGET BRANCH IS THE CONTEXT'S AND NEVER A SELECTION. `branch-context-model.ts`
// forbids inferring base or head from a pane, a tab, or a focused view; the
// preparation call's `targetBranch` is read off the served context's `baseBranch` and
// there is no parameter on this class through which a selection could reach it.

import type { ConsoleBridge } from "../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { BranchContextReading } from "./branch-context-model.js";
import type { PreparedProposal } from "./prepared-proposal.js";
import {
  PROPOSAL_ACTION_HEAD_EFFECT,
  PROPOSAL_ACTION_PRESENTATION,
  type ProposalAction,
} from "./proposal-actions.js";
import {
  GATE_SETTLEMENT_COPY,
  PROPOSAL_GATE_REFUSAL_ORIGIN,
  type ProposalGateReading,
  type ProposalGateRefusalCode,
} from "./proposal-gate-model.js";

/**
 * What an act needs from the half of the gate that reads.
 *
 * DECLARED ONCE AND IMPLEMENTED BY THE READER, so the two halves share a contract
 * rather than a field. Every member here writes or reads state the reader owns, which
 * is why they are named as the operations they are rather than exposed as the fields
 * they touch: `holdPreparedProposal` takes the context a proposal was prepared
 * AGAINST and the reader derives the pairing key from it, so an act cannot mint a key
 * of its own and cannot hold a proposal without saying what it was built for.
 */
export interface ProposalGateActionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): ProposalGateReading;
  /**
   * The context a served read is holding, or `undefined` where none has been served.
   *
   * Read through the host rather than off the arm, because only the `prepared` arm
   * carries one and an act must not have to narrow an arm to find the id it was given.
   */
  servedContext(): BranchContextReading | undefined;
  publish(reading: ProposalGateReading): void;
  /** Hold a prepared proposal, keyed by the context it was prepared against. */
  holdPreparedProposal(proposal: PreparedProposal, preparedFor: BranchContextReading): void;
  /** Drop the held proposal and the context it was prepared for, which are one fact. */
  discardProposal(): void;
  /** Ask for the read that follows an act the daemon accepted. */
  requestRefreshAfterAct(): void;
}

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

export interface ProposalGateActionsOptions {
  readonly bridge: ConsoleBridge;
  /** The workspace the git action names — the one part of the subject an act sends. */
  readonly workspaceId: string;
  readonly host: ProposalGateActionHost;
}

/** The three modelled acts, the register that holds one, and what each answer writes. */
export class ProposalGateActions {
  readonly #bridge: ConsoleBridge;
  readonly #workspaceId: string;
  readonly #host: ProposalGateActionHost;
  /** The act awaiting the bridge. One at a time, and the gate says which. */
  #inFlight: InFlightProposalAction | undefined;
  /** Monotonic, so a superseded continuation can never match the standing request. */
  #nextRequestId = 1;
  #disposed = false;

  public constructor(options: ProposalGateActionsOptions) {
    this.#bridge = options.bridge;
    this.#workspaceId = options.workspaceId;
    this.#host = options.host;
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
  public async request(action: ProposalAction): Promise<void> {
    const pending = this.#inFlight;
    if (pending !== undefined) {
      // The sentence names the act the gate is actually waiting on, not the one
      // pressed: a participant told "something is in flight" cannot tell what.
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
    // to stand beside its control for the life of the gate even after the same act
    // succeeded. One write here covers both accepted paths and leaves an in-flight
    // retry showing no stale failure; a refused retry re-records its own below. Every
    // OTHER act's entry survives — a failed commit is still a fact after a push worked.
    this.#clearActionRefusal(action);
    const context = this.#host.servedContext();
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
    const request: InFlightProposalAction = { action, requestId: this.#nextRequestId };
    this.#nextRequestId += 1;
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

  /** Terminal. A call still on the wire settles into nothing rather than onto a gate that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#inFlight = undefined;
  }

  /** Take the register for one act, and redraw so the gate holds its controls. */
  #holdFor(request: InFlightProposalAction): void {
    this.#inFlight = request;
    this.#host.publish({ ...this.#host.currentReading(), inFlightAction: request.action });
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
    this.#host.publish({ ...this.#host.currentReading(), inFlightAction: undefined });
  }

  /** Whether a settled call still speaks for the act the register is holding. */
  #stillStandingFor(request: InFlightProposalAction): boolean {
    return !this.#disposed && this.#inFlight?.requestId === request.requestId;
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
    if (!this.#stillStandingFor(request)) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal("prepare-proposal", outcome);
      return;
    }
    this.#host.holdPreparedProposal(
      {
        baseBranch: context.baseBranch,
        headBranch: context.headBranch,
        state: outcome.value.state,
        blob: outcome.value.proposalBlob,
      },
      context,
    );
    // Re-read rather than publish the proposal beside a context this call did not
    // re-establish: one read is the source of the arm, so the proposal joins the arm
    // the next read publishes and the console holds no second copy of the context.
    this.#host.requestRefreshAfterAct();
  }

  async #executeGitAction(action: ProposalAction, request: InFlightProposalAction): Promise<void> {
    const outcome = await this.#bridge.growth.gitActionExecute({
      workspaceId: this.#workspaceId,
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
      // CHECK IN THE READER CANNOT SEE IT. `proposalContextKeysMatch` compares the
      // context id and the two branch names, and a commit changes none of the three —
      // so the refresh this act queues would re-publish the pre-commit proposal and go
      // on offering the send for a payload that no longer describes the head. Discarded
      // HERE, before the refresh is asked for, so the new contents have to be prepared
      // and reviewed again.
      //
      // AND REDRAWN IN THE SAME ACT rather than left to the read. The scheduler
      // debounces, so a discard that only took effect when the answer came back would
      // leave the remote act offered against the stale proposal for the length of that
      // wait. The arm keeps the context it last read, which is still the context; what
      // it loses is the proposal.
      this.#host.discardProposal();
      this.#withdrawPublishedProposal();
    }
    this.#host.requestRefreshAfterAct();
  }

  /** Redraw the standing arm with the proposal gone, where it was carrying one. */
  #withdrawPublishedProposal(): void {
    const reading = this.#host.currentReading();
    const { state } = reading;
    if (state.kind !== "prepared" || state.proposal === undefined) {
      return;
    }
    const { proposal: _withdrawn, ...withoutProposal } = state;
    this.#host.publish({
      ...reading,
      state: withoutProposal,
      refusal: undefined,
      settlement: GATE_SETTLEMENT_COPY.prepared,
    });
  }

  /** Drop one act's standing failure. A publish only where there was one to drop. */
  #clearActionRefusal(action: ProposalAction): void {
    const reading = this.#host.currentReading();
    if (!reading.actionRefusals.has(action)) {
      return;
    }
    const actionRefusals = new Map(reading.actionRefusals);
    actionRefusals.delete(action);
    this.#host.publish({ ...reading, actionRefusals });
  }

  #recordActionRefusal(action: ProposalAction, refusal: ConsoleRefusal): void {
    const reading = this.#host.currentReading();
    const actionRefusals = new Map(reading.actionRefusals);
    actionRefusals.set(action, refusal);
    this.#host.publish({ ...reading, actionRefusals });
  }
}
