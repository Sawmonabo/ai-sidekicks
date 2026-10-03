// One user choice, reconciled against the set a read is currently serving. A form that computes
// sendability from form state while its picker draws from served state disagrees on reachable
// states (a default applied once per mount, a chosen mode a refresh withdrew), so both halves
// read this one resolution. The default is an input re-derived per read, not written into form
// state, and the four arms exist because each shut control needs its own true sentence.

/** Where one choice stands against the answer on screen; only `resolved` may be sent. */
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
   * Every choice the newest served answer offers, or `undefined` where none is served. An empty
   * array is a read that answered and named nothing, which withdraws a pick; `undefined` has
   * not answered, so it cannot know.
   */
  readonly servedChoices: readonly TChoice[] | undefined;
  /** The one choice the served answer leaves no decision about, where there is one. */
  readonly defaultChoice: TChoice | undefined;
}

/**
 * Reconcile one pick against one served answer. The default is checked against the served set
 * like any other choice, so a self-contradicting reply resolves to nothing.
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

/** The choice a picker draws as checked and a form may send, or none. */
export function selectedChoiceOf<TChoice>(
  selection: ServedSelection<TChoice>,
): TChoice | undefined {
  return selection.status === "resolved" ? selection.choice : undefined;
}
