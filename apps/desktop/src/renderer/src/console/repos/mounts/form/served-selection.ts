// One user choice, reconciled against the set a read is currently serving.
//
// THE CLASS THIS MODULE CLOSES. Both dialogs in this family computed sendability from
// FORM state alone while their pickers drew from SERVED state, and the two disagreed on
// four reachable states: a sole node the picker checked and the form never held, so the
// control stayed shut over a complete form; a chosen node a roster refresh removed, so
// the control stayed open and sent an id the session no longer has; a mode default
// applied once per mount and never again, so a reopened dialog offered no mode at all;
// and a chosen mode a capabilities refresh withdrew, so the picker drew it excluded
// while the button beside it still sent it. Every one of them is a control that says
// one thing and does another.
//
// ONE RESOLUTION, READ BY BOTH HALVES. A surface asks this module which choice is live
// and hands the answer to the picker's `checked` and to its own verdict. There is
// nothing left for the two to drift between, which is the whole of the fix: the split
// was never a bug in either half, it was two halves answering one question.
//
// THE DEFAULT IS AN INPUT AND NOT AN EFFECT. Writing a default into form state needs a
// memory of whether it has been written yet, and that memory is what a reopened dialog
// got wrong — it survived the form it was taken about. Derived per read, the default is
// re-applied whenever the form is empty and the served answer names one, and a
// user's own pick still wins because a pick is what `chosen` holds.
//
// FOUR ARMS BECAUSE THERE ARE FOUR SENTENCES. A silent refusal is forbidden, and
// "pick one", "the one you picked is gone", and
// "nothing has answered yet" are three different facts about a shut control. Collapsing
// them would put a false sentence under the button in two cases out of the three.

/**
 * Where one choice stands against the answer on screen.
 *
 * `resolved` is the only arm a form may send, which {@link selectedChoiceOf} states as
 * a value rather than leaving each caller to re-derive it.
 */
export type ServedSelection<TChoice> =
  /** Live: either the user's own pick, or the default the served answer names. */
  | { readonly status: "resolved"; readonly choice: TChoice }
  /** Picked, and the newest served answer does not offer it. Fail closed, and say so. */
  | { readonly status: "withdrawn"; readonly choice: TChoice }
  /** Picked, and nothing is being served to check it against. Also closed, differently. */
  | { readonly status: "unserved"; readonly choice: TChoice }
  /** Nothing picked, and no default to stand in for one. */
  | { readonly status: "unresolved" };

/** What one reconciliation reads: the pick, what is offered, and what stands in. */
export interface ServedSelectionInputs<TChoice> {
  /** What the user explicitly picked, if anything. Never a default. */
  readonly chosen: TChoice | undefined;
  /**
   * Every choice the newest served answer offers, or `undefined` where no answer is
   * being served at all.
   *
   * THE TWO ABSENCES ARE KEPT APART. An empty array is a read that answered and named
   * nothing — a session with no nodes, a mount that admits no mode — and `undefined` is
   * a read that has not answered. The first withdraws a pick; the second cannot know.
   */
  readonly servedChoices: readonly TChoice[] | undefined;
  /** The one choice the served answer leaves no decision about, where there is one. */
  readonly defaultChoice: TChoice | undefined;
}

/**
 * Reconcile one pick against one served answer.
 *
 * THE DEFAULT IS CHECKED AGAINST THE SERVED SET LIKE ANY OTHER CHOICE. A caller whose
 * reply disagrees with itself — naming a default outside its own offered set — then
 * resolves to nothing rather than to a choice the picker would draw as unavailable, and
 * the rule lives here once rather than at each caller's own default derivation.
 */
export function resolveServedSelection<TChoice>(
  inputs: ServedSelectionInputs<TChoice>,
): ServedSelection<TChoice> {
  const { chosen, servedChoices, defaultChoice } = inputs;
  if (servedChoices === undefined) {
    return chosen === undefined ? { status: "unresolved" } : { status: "unserved", choice: chosen };
  }
  if (chosen !== undefined) {
    return servedChoices.includes(chosen)
      ? { status: "resolved", choice: chosen }
      : { status: "withdrawn", choice: chosen };
  }
  return defaultChoice !== undefined && servedChoices.includes(defaultChoice)
    ? { status: "resolved", choice: defaultChoice }
    : { status: "unresolved" };
}

/**
 * The choice a picker draws as checked and a form may send, or none.
 *
 * ONE FUNCTION FOR BOTH READINGS, which is the property that keeps a picker and a
 * button from disagreeing: a surface that drew the withdrawn choice while refusing to
 * send it would be showing a selection nothing can act on.
 */
export function selectedChoiceOf<TChoice>(
  selection: ServedSelection<TChoice>,
): TChoice | undefined {
  return selection.status === "resolved" ? selection.choice : undefined;
}
