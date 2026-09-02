// The acts the change-proposal gate offers: which exist, what each one does, and what
// each says before it is confirmed.
//
// `Spec-023 §Console Design (Meridian)` §10.7 puts these on the gate; `Spec-011
// §Required Behavior` names them. `ProposalGate.tsx` renders them and decides nothing
// about them, and `proposal-gate-reader.ts` sends them without re-deciding either.
//
// NEVER, and each is a property of THIS file:
//   • No fourth action. `PROPOSAL_ACTIONS` is closed at the three `Spec-011 §Required
//     Behavior` names, so an action the console could send is an edit to that tuple.
//   • No parse of a git action's `output`. There is no function here that reads it; it
//     is diagnostic text the gate renders and the console never scrapes.

/**
 * The three `Spec-011 §Required Behavior` names, and no more.
 *
 * These are what the gate offers. The wire behind them is the growth port's
 * `gitActionExecute`, whose `action` member is an untyped string because the action
 * vocabulary is unregistered — `bridge/growth-slate.ts` carries it as the
 * `gitflow-actions` row, owned by `Spec-011`. So this tuple is the console's half of
 * that seam: three offers, each of which the port refuses by name today.
 */
export const PROPOSAL_ACTIONS = ["commit", "push", "prepare-proposal"] as const;

/** One modelled action. Derived, so the vocabulary is declared exactly once. */
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

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
  push: {
    label: "Push",
    consequence: "Sends the head branch to the detected host.",
  },
  "prepare-proposal": {
    label: "Prepare proposal",
    consequence:
      "Builds the proposal locally so it can be reviewed here first. Nothing is created on the host.",
  },
};
