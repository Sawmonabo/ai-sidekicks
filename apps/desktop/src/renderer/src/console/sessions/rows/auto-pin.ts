// Whether a first send pins the session it was sent into.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: auto-pin on first send is
// a setting, default on, and it fires only when ALL FIVE of these hold — the setting
// is on, the session is still a draft placeholder, the session did not arrive by
// import, the session was not opened on behalf of a peer invocation or a child run,
// and the session was not started by a workflow.
//
// EACH EXCLUSION IS A FACT ABOUT THE SESSION'S ORIGIN, AND FACTS CAN BE ABSENT. Where
// the wire carries no marker for one of them, the conjunct FAILS CLOSED and no pin
// happens. That is the whole difficulty: an origin marker this console cannot read is
// not evidence that the session has an ordinary origin, and treating it as such would
// pin every workflow-started and peer-invoked session on the front tier — the one
// place a person put the work they chose.
//
// So the evidence is three-valued rather than boolean. `true` means the marker says
// yes, `false` means it says no, and `undefined` means nothing said — and only
// `false` clears an exclusion. Written as a boolean with a `?? false` default, the
// absent case would read as "not a workflow session" and the rule would be exactly
// backwards on the case it exists for.
//
// WHAT THIS MODULE IS NOT. It is not the trigger: the send that would fire it belongs
// to the composer, and the act that would perform it is the pin store's. This is the
// PREDICATE, so the rule has one home and the surfaces that consult it cannot each
// carry four of its five conjuncts.

/**
 * What is known about how a session came to exist, as the wire reports it.
 *
 * Every member is optional and every one of them means the same thing when it is
 * missing: nobody said. A caller that has the marker supplies it; a caller reading a
 * projection that carries none leaves it out and the pin does not happen.
 */
export interface SessionOriginEvidence {
  /** The session is still the placeholder a start press created and nothing has claimed. */
  readonly isDraftPlaceholder?: boolean;
  /** The session was seeded from a provider session somebody imported. */
  readonly arrivedByImport?: boolean;
  /** The session was opened on behalf of a peer invocation or a child run. */
  readonly openedForChildWork?: boolean;
  /** The session was started by a workflow rather than by a person. */
  readonly startedByWorkflow?: boolean;
}

/**
 * Why a first send did not pin, in the order the conjuncts are stated.
 *
 * A named reason rather than a bare `false`, because the two failing modes are
 * genuinely different to a person: a switch they turned off is a decision they made,
 * and an origin nobody reported is this console declining to guess. The reason is
 * what the auto-pin setting composes its own explanatory sentence from, so the rule
 * and the sentence a person reads cannot drift apart.
 */
export type AutoPinRefusalReason =
  | "setting-off"
  | "not-a-draft-placeholder"
  | "arrived-by-import"
  | "opened-for-child-work"
  | "started-by-workflow"
  | "origin-unreported";

/** The decision, and what decided it. */
export type AutoPinDecision =
  | { readonly pins: true }
  | { readonly pins: false; readonly because: AutoPinRefusalReason };

/**
 * The five conjuncts, in the order the design states them.
 *
 * An exclusion whose marker is absent answers `origin-unreported` rather than its own
 * name, because "we were not told whether this arrived by import" and "this arrived by
 * import" are two different states and only one of them is a fact about the session.
 */
export function autoPinDecision(options: {
  readonly isSettingEnabled: boolean;
  readonly origin: SessionOriginEvidence;
}): AutoPinDecision {
  if (!options.isSettingEnabled) {
    return { pins: false, because: "setting-off" };
  }
  const { arrivedByImport, isDraftPlaceholder, openedForChildWork, startedByWorkflow } =
    options.origin;
  if (isDraftPlaceholder === undefined) {
    return { pins: false, because: "origin-unreported" };
  }
  if (!isDraftPlaceholder) {
    return { pins: false, because: "not-a-draft-placeholder" };
  }
  for (const [exclusion, reason] of [
    [arrivedByImport, "arrived-by-import"],
    [openedForChildWork, "opened-for-child-work"],
    [startedByWorkflow, "started-by-workflow"],
  ] as const) {
    if (exclusion === undefined) {
      return { pins: false, because: "origin-unreported" };
    }
    if (exclusion) {
      return { pins: false, because: reason };
    }
  }
  return { pins: true };
}
