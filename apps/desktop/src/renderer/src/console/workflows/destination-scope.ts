// Which session the workflows destination reads from, as one value with three arms.
//
// WHY THIS IS NOT A NULLABLE ID. The destination has two independent facts — a
// session a person picked here, and the session this window last opened — and the
// obvious fold of them (`chosen ?? retained`) collapses a THIRD state that neither
// carries: the person has asked to choose again and has not chosen yet. Under that
// fold, "choose a different session" could only be spelled as "forget the choice",
// which lands back on the retained id the moment there is one — so a person who had
// opened a session pressed the control and the surface did not move, because the
// answer to "which session" was the same before and after.
//
// So the three arms are three facts and no others: FOLLOW the window's retention,
// ASK which session, and READ this one. The retained id is not copied into the state
// when the destination mounts — it is read through it, on the arm that says so, which
// is what keeps the window's own retention a single source of truth: a copy taken at
// mount would go stale the moment another surface opened a session.
//
// The state is held for the mount and never persisted, for the reason
// `WorkflowsDestination.tsx`'s header gives about the choice itself.

/** What the destination is doing about its scope, right now. */
export type WorkflowsScopeState =
  /** Following whatever session this window last opened, including none. */
  | { readonly kind: "retained" }
  /** A person asked to choose, so the picker stands regardless of retention. */
  | { readonly kind: "choosing" }
  /** This person picked this session here, and it overrides retention. */
  | { readonly kind: "chosen"; readonly sessionId: string };

/** Where the destination starts: following the window, having been asked nothing. */
export const FOLLOWING_WINDOW_RETENTION: WorkflowsScopeState = { kind: "retained" };

/** What pressing "choose a different session" moves the scope to. */
export const AWAITING_SESSION_CHOICE: WorkflowsScopeState = { kind: "choosing" };

/** What a person's pick moves the scope to. */
export function chosenScope(sessionId: string): WorkflowsScopeState {
  return { kind: "chosen", sessionId };
}

/**
 * The session the destination reads from, or nothing while it has none to read.
 *
 * Total over the three arms, which is the point: `choosing` answers `undefined` even
 * when a retained id stands, so the picker is what a person who asked for it gets.
 */
export function scopeSessionIdFor(
  state: WorkflowsScopeState,
  retainedSessionId: string | undefined,
): string | undefined {
  switch (state.kind) {
    case "retained":
      return retainedSessionId;
    case "choosing":
      return undefined;
    case "chosen":
      return state.sessionId;
  }
}
