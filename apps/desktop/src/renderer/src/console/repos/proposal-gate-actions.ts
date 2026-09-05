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
// seven things an act needs from the half that read: the standing reading, the served
// context, the caller's own participant id, the publish, the two writes to the held
// proposal, and the refresh an accepted act asks for. Nothing else crosses — this class
// holds no scheduler, no trigger, and no arm of its own, so a read cannot be started
// from here and an act cannot invent a context.
//
// THE CAUSATION IS ASKED FOR THROUGH THE SAME SEAM AND NEVER READ HERE. The registered
// `GitActionExecuteRequest` carries an optional `causationParticipantId`, and which
// participant this window is comes from a read — so it is the reading half's to
// perform, exactly as the branch context is. This class awaits the answer and sends
// what it gets: an identity that could not be read omits the member rather than
// blocking the press, because the daemon resolves the principal an act runs under from
// the transport and takes this member as attribution.
//
// ONE ACT AT A TIME, AND THE SECOND PRESS IS REFUSED RATHER THAN QUEUED OR DROPPED.
// Two overlapping preparations can settle out of order and the older proposal then
// overwrites the newer one; two overlapping commits are two commits. Refused rather
// than ignored, because a press that produced nothing at all is the silent no-op
// rule 8 forbids.
//
// SETTLED BY REQUEST IDENTITY, NOT MERELY BY LIVENESS. Every continuation checks the id
// it was issued under before it writes: a reply for a request the register has moved
// past describes a proposal a later act superseded, and writing it puts that payload back.
//
// AND THE REGISTER SAYS NOTHING ABOUT THE READ. It answers "did a later act supersede
// this one", while the branch-context read runs on its own schedule and can replace or
// lose the served context inside an act's own await. So a git action re-checks, at the
// moment it would go on the wire, that the context it was admitted under is still the
// one the gate has read — by the pairing rule's three members, not by object identity —
// and refuses rather than mutating a root the participant is no longer looking at.
//
// THE TARGET BRANCH IS THE CONTEXT'S AND NEVER A SELECTION. `branch-context-model.ts`
// forbids inferring base or head from a pane, a tab, or a focused view; the
// preparation call's `targetBranch` is read off the served context's `baseBranch` and
// there is no parameter on this class through which a selection could reach it.
//
// AND A CALL THAT REJECTS IS AN ANSWER, WHICH IS WHY NO ACT HERE AWAITS THE PORT BARE.
// The live bridge crosses a process boundary, so an IPC disconnect makes a call THROW
// rather than answer a refusal, and a thrown act used to escape `request` entirely: the
// `finally` gave the register back, so every control re-enabled, while nothing was
// written beside the one that was pressed and the binding — which voids this promise —
// left the rejection unhandled. Both wires reject the same way. So the dispatch is
// wrapped, the rejection is read through the repos family's ONE normalizer, and it is
// recorded BEFORE the register is released. `request` settles and never rejects.

import type { ConsoleBridge } from "../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { BranchContextReading } from "./branch-context-model.js";
import { proposalContextKeysMatch, type PreparedProposal } from "./prepared-proposal.js";
import { gitActionExecuteRequest } from "./git-action-request.js";
import { repoCallRefusal } from "./repo-reads.js";
import {
  PROPOSAL_ACTION_HEAD_EFFECT,
  PROPOSAL_ACTION_PRESENTATION,
  reachesGitAction,
  type GitActionProposalAction,
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
  /**
   * Which participant this window is, or `undefined` where the read did not answer.
   *
   * A PROMISE RATHER THAN A SETTLED VALUE, because the identity read and the
   * branch-context read are issued together and neither waits on the other: an act
   * pressed the instant a context lands would otherwise send no causation for the
   * ordinary reason that one read finished first. The reading half performs it once and
   * every act awaits that same answer.
   */
  callerParticipantId(): Promise<string | undefined>;
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
  /**
   * The mount the git action names — the one part of the SUBJECT an act sends.
   *
   * The registered request takes a mount and no workspace: this call used to send
   * `workspaceId`, a member `GitActionExecuteRequest` does not have, so a
   * contract-valid daemon would have refused every act before running it. Which root
   * inside that mount is being acted on is said in `params`, off the served context —
   * `git-action-request.ts` owns that, and it is why the mount alone is enough here.
   */
  readonly repoMountId: string;
  readonly host: ProposalGateActionHost;
}

/** The three modelled acts, the register that holds one, and what each answer writes. */
export class ProposalGateActions {
  readonly #bridge: ConsoleBridge;
  readonly #repoMountId: string;
  readonly #host: ProposalGateActionHost;
  /** The act awaiting the bridge. One at a time, and the gate says which. */
  #inFlight: InFlightProposalAction | undefined;
  /** Monotonic, so a superseded continuation can never match the standing request. */
  #nextRequestId = 1;
  #disposed = false;

  public constructor(options: ProposalGateActionsOptions) {
    this.#bridge = options.bridge;
    this.#repoMountId = options.repoMountId;
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
      // Routed by the predicate rather than by naming the act, so a fourth act says
      // which of the two wires it reaches before it can be sent — and the guard
      // NARROWS, so the request builder is handed an act the git action can take.
      if (!reachesGitAction(action)) {
        await this.#prepareProposal(context, request);
        return;
      }
      await this.#executeGitAction(action, context, request);
    } catch (rejection) {
      // The identity check the settle paths make, for their reason: a rejection for a
      // request the register has moved past describes an act a later press superseded.
      if (this.#stillStandingFor(request)) {
        this.#recordActionRefusal(action, repoCallRefusal(proposalActionWire(action), rejection));
      }
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

  /**
   * Whether the context an act was admitted under is still the one the gate has read.
   *
   * The pairing rule's three members and not the object's identity: a re-read serves a
   * fresh value every time, so comparing references would refuse every act that
   * outlived a refresh which changed nothing.
   */
  #stillActingOn(context: BranchContextReading): boolean {
    const served = this.#host.servedContext();
    return served !== undefined && proposalContextKeysMatch(context, served);
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

  async #executeGitAction(
    action: GitActionProposalAction,
    context: BranchContextReading,
    request: InFlightProposalAction,
  ): Promise<void> {
    // Awaited before the act rather than alongside it: the causation travels ON the
    // request, so there is nothing to parallelise — and the answer is read once by the
    // half that reads, so this await resolves immediately for every act after the first.
    const causationParticipantId = await this.#host.callerParticipantId();
    if (!this.#stillStandingFor(request)) {
      return;
    }
    if (!this.#stillActingOn(context)) {
      // THE REGISTER IS NOT THE WHOLE ANSWER. Holding it says no LATER ACT superseded
      // this one; it says nothing about the READ, which runs on its own schedule and
      // can replace or lose the served context inside this await. A gate already
      // showing a different root — or none — would otherwise mutate the branch context
      // this press was admitted against, which is a remote act against something the
      // participant is no longer looking at.
      //
      // REFUSED AT THE SEND RATHER THAN CANCELLED ON THE REFRESH, because the refresh
      // belongs to the half that reads: `ProposalGateActionHost` gives it no operation
      // that reaches the register, and adding one would let the reader decide an act's
      // fate. The comparison is the pairing rule's own three members, so "still the
      // context I was pressed against" is one decision in this family rather than two.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "context-superseded" satisfies ProposalGateRefusalCode,
          `${PROPOSAL_ACTION_PRESENTATION[action].label} was pressed against a branch context this gate has since read again, so nothing was sent against it.`,
        ),
      );
      return;
    }
    const outcome = await this.#bridge.growth.gitActionExecute(
      gitActionExecuteRequest(action, context, {
        repoMountId: this.#repoMountId,
        causationParticipantId,
      }),
    );
    if (!this.#stillStandingFor(request)) {
      return;
    }
    if (outcome.status === "unavailable") {
      this.#recordActionRefusal(action, outcome);
      return;
    }
    if (!outcome.value.success) {
      // A served answer that did not take the act. Rendered rather than treated as a
      // success — and the reply's OWN `error` is what stands there when it carries one,
      // verbatim, because rule 9 forbids paraphrasing a refusal the console did not
      // author. The console's sentence is the fallback for a reply that failed and said
      // why nowhere, and it claims nothing about the reason.
      this.#recordActionRefusal(
        action,
        refuse(
          PROPOSAL_GATE_REFUSAL_ORIGIN,
          "action-not-accepted" satisfies ProposalGateRefusalCode,
          outcome.value.error ??
            `The daemon answered this action without taking it, and named no reason. Nothing was ${action === "commit" ? "recorded" : "sent"}.`,
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

/**
 * Which growth-port operation an act's press puts on the wire.
 *
 * Read off the SAME predicate the dispatch routes on rather than from a table of its
 * own, so the wire a refusal names and the wire the act was sent on are one decision:
 * a second routing could disagree with the first for a fourth act, and the sentence a
 * participant reads would then name a call the console never made.
 */
function proposalActionWire(action: ProposalAction): string {
  return reachesGitAction(action) ? "gitActionExecute" : "gitflowPrPrepare";
}
