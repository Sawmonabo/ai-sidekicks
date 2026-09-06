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
// SETTLED BY ITS ROUND, NOT MERELY BY LIVENESS. Every continuation asks whether the
// round it was issued on is still the live one before it writes: a reply for a round
// the register has moved past describes a proposal a later act superseded, and writing
// it puts that payload back.
//
// AND THE REGISTER IS THE CONSOLE'S, NOT A COUNTER OF THIS FILE'S OWN. The three
// questions this class asks — may I dispatch, is this settlement still mine, give the
// key back — are exactly `store/generation-latch.ts`'s, and the place copies of a guard
// drift is the predicate. It takes ONE key, because the rule is one act at a time
// across every control: `claim` refuses the second press rather than superseding it,
// `isCurrent` answers supersession and disposal in one question because `dispose`
// supersedes every key, and `release` is guarded by the round's own serial, so a
// continuation that no longer holds the key cannot free its successor's.
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
// left the rejection unhandled. Both wires reject the same way.
//
// SO BOTH GO THROUGH THE PORT'S OWN REFUSAL BUILDER. `request` used to wrap the
// dispatch and read the rejection through `repoCallRefusal` — the family's DAEMON-read
// normalizer — so a rejected `gitActionExecute` was published under the `repos` origin
// while the same operation's ANSWERED refusal rendered `growth-port`: one act, two
// failure paths, two subsystem names, and a code from a vocabulary the growth port
// never declared. `readGrowthAnswer` (`repos/growth-call.ts`) is the one reading of a
// growth answer in this family and hands every rejected call to
// `growthUnavailableFromRejection`, which stamps the port's origin and its own
// `call-rejected` — the member that says a call was MADE and threw, where the answered
// `wire-unregistered` says this build carries no such wire. The `catch` below stays as
// the backstop for everything else `request` awaits and calls that same builder
// directly, so the two paths cannot disagree about what a rejection is. `request`
// settles and never rejects.

import { growthUnavailableFromRejection, type ConsoleBridge } from "../../bridge/index.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
  type GenerationClaim,
} from "../../store/index.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";
import { isProposalState, proposalContextKeysMatch } from "./prepared-proposal.js";
import { gitActionExecuteRequest } from "./git-action-request.js";
import { readGrowthAnswer } from "../growth-call.js";
import {
  PROPOSAL_ACTION_HEAD_EFFECT,
  proposalActionWire,
  reachesGitAction,
  type GitActionProposalAction,
  type ProposalAction,
} from "./proposal-actions.js";
import {
  actionInFlightRefusal,
  actionNotAcceptedRefusal,
  clearActionRefusal,
  contextSupersededRefusal,
  noServedContextRefusal,
  preparedStateUnreadableRefusal,
  recordActionRefusal,
} from "./proposal-gate-refusals.js";
import { GATE_SETTLEMENT_COPY } from "./proposal-gate-model.js";
import type { ProposalGateActionHost } from "./proposal-gate-action-host.js";

/**
 * The one key an act takes.
 *
 * A CONSTANT AND NOT THE ACT, because the rule is one act at a time across every
 * control: keying by act would admit a commit while a preparation was unanswered, and
 * the payload the commit runs against is the one that preparation is about to replace.
 */
const PROPOSAL_ACTION_KEY = "proposal-action";

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
  readonly #acts = new GenerationLatch();

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
    const round = this.#acts.claim(this, PROPOSAL_ACTION_KEY);
    if (round === undefined) {
      // The sentence names the act the gate is actually waiting on, not the one
      // pressed: a participant told "something is in flight" cannot tell what. The
      // gate's own arm carries it — `#holdFor` publishes it in the tick the key is
      // taken — so there is no second copy to disagree with what the gate is showing.
      const pending = this.#host.currentReading().inFlightAction ?? action;
      recordActionRefusal(this.#host, action, actionInFlightRefusal(pending));
      return;
    }
    // WHAT THE LAST PRESS PRODUCED IS CLEARED WHEN THE NEXT ONE IS ISSUED, not when it
    // settles: every later publish spreads `actionRefusals` forward, so a refusal used
    // to stand beside its control for the life of the gate even after the same act
    // succeeded. One write here covers both accepted paths and leaves an in-flight
    // retry showing no stale failure; a refused retry re-records its own below. Every
    // OTHER act's entry survives — a failed commit is still a fact after a push worked.
    clearActionRefusal(this.#host, action);
    const context = this.#host.servedContext();
    if (context === undefined) {
      // Structurally unreachable from the gate, which offers acts only on the
      // `prepared` arm — and recorded rather than dropped, for the same reason. The
      // key is given back bare: nothing was published against it, so there is no
      // control to hand back with it.
      round.release();
      recordActionRefusal(this.#host, action, noServedContextRefusal());
      return;
    }
    this.#holdFor(action);
    try {
      // Routed by the predicate rather than by naming the act, so a fourth act says
      // which of the two wires it reaches before it can be sent — and the guard
      // NARROWS, so the request builder is handed an act the git action can take.
      if (!reachesGitAction(action)) {
        await this.#prepareProposal(context, round);
        return;
      }
      await this.#executeGitAction(action, context, round);
    } catch (rejection) {
      // The check the settle paths make, for their reason: a rejection on a round the
      // register has moved past describes an act a later press superseded.
      if (round.isCurrent) {
        recordActionRefusal(
          this.#host,
          action,
          growthUnavailableFromRejection(proposalActionWire(action), rejection),
        );
      }
    } finally {
      this.#releaseHeld(round);
    }
  }

  /** Terminal. A call still on the wire settles into nothing rather than onto a gate that unmounted. */
  public dispose(): void {
    this.#acts.supersedeAll();
  }

  /** Take the key for one act, and redraw so the gate holds its controls. */
  #holdFor(action: ProposalAction): void {
    this.#host.publish({ ...this.#host.currentReading(), inFlightAction: action });
  }

  /**
   * Give the key back, but only where it is still this round's to give.
   *
   * `release` is guarded by the round's own serial, so a disposal or a successor
   * leaves it a no-op. The publish is asked separately and skipped on that arm,
   * because offering the controls back on behalf of a round the gate has moved past
   * would offer them while its successor's call is still on the wire.
   */
  #releaseHeld(round: GenerationClaim): void {
    const heldByThisRound = round.isCurrent;
    round.release();
    if (!heldByThisRound) {
      return;
    }
    this.#host.publish({ ...this.#host.currentReading(), inFlightAction: undefined });
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
    round: CurrentGenerationClaim,
  ): Promise<void> {
    const preparationWire = proposalActionWire("prepare-proposal");
    const answer = await readGrowthAnswer(preparationWire, preparationWire, () =>
      this.#bridge.growth.gitflowPrPrepare({
        branchContextId: context.branchContextId,
        // The context's own base branch, never a selection: there is no parameter on
        // this class through which one could arrive.
        targetBranch: context.baseBranch,
      }),
    );
    if (!round.isCurrent) {
      return;
    }
    if (answer.status === "refused") {
      recordActionRefusal(this.#host, "prepare-proposal", answer.refusal);
      return;
    }
    // THE REPLY IS TYPED AND THE PORT IS A PROCESS BOUNDARY. The signature table says
    // this member is one of the wire's two words; what arrives is whatever was sent,
    // and a third word held here would reach the summary line as a missing key and the
    // remote act's `=== "ready"` as a silent `false` — the act withheld, no sentence
    // saying why, and nothing failing. Refused at the boundary instead, which is what
    // makes the state vocabulary one home rather than one home and an assumption.
    const servedState: unknown = answer.value.state;
    if (!isProposalState(servedState)) {
      recordActionRefusal(
        this.#host,
        "prepare-proposal",
        preparedStateUnreadableRefusal(servedState),
      );
      return;
    }
    this.#host.holdPreparedProposal(
      {
        baseBranch: context.baseBranch,
        headBranch: context.headBranch,
        state: servedState,
        blob: answer.value.proposalBlob,
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
    round: CurrentGenerationClaim,
  ): Promise<void> {
    // Awaited before the act rather than alongside it: the causation travels ON the
    // request, so there is nothing to parallelise — and the answer is read once by the
    // half that reads, so this await resolves immediately for every act after the first.
    const causationParticipantId = await this.#host.callerParticipantId();
    if (!round.isCurrent) {
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
      recordActionRefusal(this.#host, action, contextSupersededRefusal(action));
      return;
    }
    const gitActionWire = proposalActionWire(action);
    const answer = await readGrowthAnswer(gitActionWire, gitActionWire, () =>
      this.#bridge.growth.gitActionExecute(
        gitActionExecuteRequest(action, context, {
          repoMountId: this.#repoMountId,
          causationParticipantId,
        }),
      ),
    );
    if (!round.isCurrent) {
      return;
    }
    if (answer.status === "refused") {
      recordActionRefusal(this.#host, action, answer.refusal);
      return;
    }
    if (!answer.value.success) {
      // A served answer that did not take the act. Rendered rather than treated as a
      // success — and the reply's OWN `error` is what stands there when it carries one,
      // verbatim, because rule 9 forbids paraphrasing a refusal the console did not
      // author. The console's sentence is the fallback for a reply that failed and said
      // why nowhere, and it claims nothing about the reason.
      recordActionRefusal(this.#host, action, actionNotAcceptedRefusal(action, answer.value.error));
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
}
