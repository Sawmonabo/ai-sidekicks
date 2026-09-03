// The acts the change-proposal gate offers: which exist, how far each one reaches, what
// each says before it is confirmed, and which of them a given gate arm may offer at all.
//
// `ProposalGate.tsx` is the surface that offers these; `Spec-011
// §Required Behavior` names them. `ProposalGate.tsx` renders what `offeredProposalActions`
// returns and decides nothing about it, and `proposal-gate-reader.ts` sends them without
// re-deciding either.
//
// THE PREPARATION GATE IS A RULE HERE AND A LAYOUT THERE. `Spec-011 §Interfaces And
// Contracts` requires that `PRPrepare` "generate a reviewable proposal before any remote
// mutation", which is a claim about WHICH ACTS EXIST WHEN and not only about which order
// they are drawn in. So the offered set is a pure function of the arm below, the tuple's
// order is the pipeline's own — record locally, prepare locally, then send — and a
// component cannot offer a remote act the rule withholds, because it is handed a list
// rather than the vocabulary.
//
// WITHHOLDING THE REMOTE ACT IS NOT AN ELIGIBILITY DERIVATION, and the distinction is the
// same one `ProposalGate.tsx` draws for its blocking choice: the console is not
// recomputing what the daemon would allow — every such reason stays the daemon's and
// arrives as the refusal beside the act. It is reading a fact this surface itself
// established, namely whether it has a reviewed proposal to send.
//
// NEVER, and each is a property of THIS file:
//   • No fourth action. `PROPOSAL_ACTIONS` is closed at the three `Spec-011 §Required
//     Behavior` names, so an action the console could send is an edit to that tuple.
//   • No parse of a git action's `output`. There is no function here that reads it, and
//     no surface draws it: it is the act's own diagnostic text and this console never
//     scrapes it. What a REFUSED act says for itself is the reply's `error`, rendered
//     verbatim beside the control that was pressed.

import type { ProposalGateState } from "./proposal-gate-state.js";

/**
 * The three `Spec-011 §Required Behavior` names, and no more — in the gate's own order.
 *
 * These are what the gate offers. The wire behind them is the growth port's
 * `gitActionExecute`, whose `action` member is an untyped string because the action
 * vocabulary is unregistered — `bridge/growth-slate.ts` carries it as the
 * `gitflow-actions` row, owned by `Spec-011`. So this tuple is the console's half of
 * that seam: three offers, each of which the port refuses by name today.
 *
 * THE ORDER IS THE PIPELINE'S, NOT THE VOCABULARY'S. `commit` records on the head
 * branch, `prepare-proposal` builds the payload where it can be read, and only then does
 * `push` send anything — so a participant who works down the list has reviewed what
 * leaves the machine before it leaves. A tuple that put the remote act first would draw
 * a confirmable send above the thing it would send.
 */
export const PROPOSAL_ACTIONS = ["commit", "prepare-proposal", "push"] as const;

/** One modelled action. Derived, so the vocabulary is declared exactly once. */
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** How far an act's effect travels. The one axis the preparation gate turns on. */
export const PROPOSAL_ACTION_REACHES = ["local", "remote"] as const;

/** One reach. Derived, so the vocabulary is declared exactly once. */
export type ProposalActionReach = (typeof PROPOSAL_ACTION_REACHES)[number];

/**
 * Total over `ProposalAction` by construction.
 *
 * Each answer is the act's own consequence sentence restated as data, so the rule below
 * asks the table rather than naming `push`: an act added to the tuple has to say how far
 * it reaches before it can be offered anywhere.
 */
export const PROPOSAL_ACTION_REACH: Readonly<Record<ProposalAction, ProposalActionReach>> = {
  commit: "local",
  "prepare-proposal": "local",
  push: "remote",
};

/**
 * What an accepted act leaves of a proposal prepared before it.
 *
 * A SECOND AXIS RATHER THAN A SECOND READING OF THE FIRST, because reach does not
 * answer this: `commit` and `prepare-proposal` are both local and only one of them
 * moves the head a proposal was built from. The holder asks this table rather than
 * naming `commit`, so an act added to the tuple has to say what it does to a standing
 * proposal before it can be sent from anywhere.
 */
export const PROPOSAL_ACTION_HEAD_EFFECTS = ["moves-head", "leaves-head"] as const;

/** One head effect. Derived, so the vocabulary is declared exactly once. */
export type ProposalActionHeadEffect = (typeof PROPOSAL_ACTION_HEAD_EFFECTS)[number];

/**
 * Total over `ProposalAction` by construction.
 *
 * `commit` records new contents on the head branch, so every proposal prepared
 * against the old contents describes something that is no longer there — and it does
 * that WITHOUT moving `branchContextId`, `baseBranch`, or `headBranch`, which is
 * exactly why the holder cannot detect it by comparing contexts across a re-read.
 * `push` sends the head branch and changes nothing about what was prepared, so the
 * summary of what left the machine stays on screen.
 */
export const PROPOSAL_ACTION_HEAD_EFFECT: Readonly<
  Record<ProposalAction, ProposalActionHeadEffect>
> = {
  commit: "moves-head",
  "prepare-proposal": "leaves-head",
  push: "leaves-head",
};

/**
 * The acts that reach `gitflow.gitActionExecute`, as opposed to the preparation call.
 *
 * A SET HERE RATHER THAN A LITERAL IN THE SENDER. `proposal-gate-actions.ts` routed by
 * comparing the action against the string `"prepare-proposal"`, so the one act that
 * does not reach the git action was named in the class that sends rather than in the
 * module that owns which acts exist — and that class then held the whole action union
 * where the registered request takes only the acts this wire can serve.
 *
 * A SUBSET RATHER THAN A SECOND TOTAL TABLE, because the honest answer for
 * `prepare-proposal` is that it is not on this wire at all — not an empty parameter
 * list, which would read as "it sends nothing" rather than "it does not send". The
 * complement is asserted against `PROPOSAL_ACTIONS` in this module's tests, so the two
 * sets are held against each other rather than trusted to agree.
 */
export const GIT_ACTION_PROPOSAL_ACTIONS = ["commit", "push"] as const;

/**
 * One act the git action can take. Derived, so the set is declared exactly once.
 *
 * Assignable to `ProposalAction` by the guard below — a type predicate's type must be
 * assignable to the parameter it narrows, so a member misspelled in the tuple above
 * fails to compile here rather than becoming a fourth action nobody declared.
 */
export type GitActionProposalAction = (typeof GIT_ACTION_PROPOSAL_ACTIONS)[number];

/**
 * Whether one act reaches the git action, narrowing it where it does.
 *
 * A GUARD RATHER THAN A COMPARISON AT THE CALL SITE, because the caller needs the
 * NARROWING and not only the answer: the request builder takes the derived type, so a
 * sender that merely tested membership would still be holding the whole action union
 * and would have to assert its way into the call.
 */
export function reachesGitAction(action: ProposalAction): action is GitActionProposalAction {
  const gitActions: readonly ProposalAction[] = GIT_ACTION_PROPOSAL_ACTIONS;
  return gitActions.includes(action);
}

/** What each action is called on screen and what pressing it does. */
export interface ProposalActionPresentation {
  readonly label: string;
  /** What the act does, in one sentence. Shown before the act, never after it. */
  readonly consequence: string;
}

/**
 * Total over `ProposalAction` by construction.
 *
 * `prepare-proposal` states the gate's whole reason for existing: preparation happens
 * BEFORE any remote mutation, so its sentence is what a participant reads to know that
 * pressing it sends nothing.
 */
export const PROPOSAL_ACTION_PRESENTATION: Readonly<
  Record<ProposalAction, ProposalActionPresentation>
> = {
  commit: {
    label: "Commit",
    consequence:
      "Records the working tree's changes on the head branch. Nothing leaves this machine.",
  },
  "prepare-proposal": {
    label: "Prepare proposal",
    consequence:
      "Builds the proposal locally so it can be reviewed here first. Nothing is created on the host.",
  },
  push: {
    label: "Push",
    consequence: "Sends the head branch to the detected host.",
  },
};

/**
 * Whether an arm can offer acts at all, before the proposal question is put to it.
 *
 * A union rather than a tuple, which is the shape the rest of this file uses: nothing
 * iterates these two words, so a runtime tuple would exist only to be read back as a
 * type. The set is still declared exactly once, and the table below derives from it.
 */
type GateArmActionAvailability = "no-acts" | "acts-offered";

/**
 * Total over `ProposalGateState["kind"]` by construction — a sixth arm does not
 * compile until it says whether anything can be acted on from there.
 *
 * Four arms answer `no-acts` and each for its own reason: `not-checked` and `preparing`
 * have no branch context to act against, `refused` reports an act that did not happen —
 * and is where a workspace with no context lands, since the registered read refuses
 * rather than serving an absence — and `hosting-unavailable` is the arm whose whole
 * content is what to do BY HAND because the host is out of reach, so offering a send
 * there would offer a send to a host the same arm says is unreachable.
 */
const GATE_ARM_ACTION_AVAILABILITY: Readonly<
  Record<ProposalGateState["kind"], GateArmActionAvailability>
> = {
  "not-checked": "no-acts",
  preparing: "no-acts",
  prepared: "acts-offered",
  "hosting-unavailable": "no-acts",
  refused: "no-acts",
};

/**
 * Which acts this arm offers, in the gate's order.
 *
 * THE REMOTE ACT IS WITHHELD UNTIL THERE IS SOMETHING REVIEWED TO SEND, which is
 * `Spec-011 §Interfaces And Contracts`' rule that `PRPrepare` must generate a reviewable
 * proposal before any remote mutation, applied to the offer rather than to the layout: a
 * `prepared` arm carrying no proposal offers the local acts and no more, so the send
 * cannot be confirmed against a payload that has never been on screen. Preparing again
 * on an arm that already holds one is offered, because a proposal is cumulative over a
 * run lineage and re-preparing it is still a local act.
 */
export function offeredProposalActions(state: ProposalGateState): readonly ProposalAction[] {
  if (GATE_ARM_ACTION_AVAILABILITY[state.kind] === "no-acts") {
    return [];
  }
  // PRESENCE IS NOT REVIEWABILITY, AND THE WIRE'S OWN VOCABULARY IS WHY. The
  // preparation reply answers `draft | ready`, and `draft` is a proposal still being
  // assembled — so a rule that read presence alone admitted a remote mutation against
  // a payload the daemon had not finished putting together. `ready` is the one state
  // that says a person may send this, and it is the one state that offers the send.
  const hasSendableProposal = state.kind === "prepared" && state.proposal?.state === "ready";
  return PROPOSAL_ACTIONS.filter(
    (action) => PROPOSAL_ACTION_REACH[action] === "local" || hasSendableProposal,
  );
}

/**
 * What a proposal that is on screen and cannot be sent says for itself.
 *
 * A SENTENCE RATHER THAN A DISABLED CONTROL, on this file's own division of labour:
 * `ProposalGate.tsx` is handed a list rather than the vocabulary, so it cannot draw a
 * greyed `Push` without naming the remote act — which is the structural property that
 * keeps the preparation gate a rule stated once. What it CAN do is say why the row it
 * is not drawing is absent, which is the console's ordinary treatment of an absence.
 *
 * Only the draft case has a sentence. An arm with no proposal at all already renders
 * one — the empty state above the acts — and printing a second sentence under it would
 * word one absence twice.
 */
export function withheldRemoteActionCopy(state: ProposalGateState): string | undefined {
  if (GATE_ARM_ACTION_AVAILABILITY[state.kind] === "no-acts" || state.kind !== "prepared") {
    return undefined;
  }
  if (state.proposal === undefined || state.proposal.state === "ready") {
    return undefined;
  }
  return PROPOSAL_NOT_SENDABLE_COPY;
}

/**
 * The one sentence the withheld send owes a participant.
 *
 * Stated on the condition the rule turns on — being `ready` — rather than on the state
 * the proposal happens to be in, so a third preparation state added to the wire reads
 * correctly here without a second sentence being written for it.
 */
export const PROPOSAL_NOT_SENDABLE_COPY =
  "This proposal is not ready to send yet, so the act that reaches the host is not offered. Preparing it again is what moves it on.";
