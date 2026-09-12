// The walkthrough's steps, and where a person is in them.
//
// The shape is fixed: a left-rail progress list with a right pane carrying copy and
// inputs and one explicit primary action per step. This module is the rail's model —
// which steps exist, in what order, which group each belongs to, and what "resolved"
// means for each — and it holds no wire.
//
// TWO GROUPS AND NOT ONE FLOW. Group A settles where this node relays and takes a
// separate explicit answer about telemetry; group B tells a person which providers
// this node can actually run. They are different questions with different terminals:
// group A must be answered before the invite that triggered the walkthrough can go
// out, and group B is offered and never demanded — onboarding completes with zero
// registered accounts. The rail shows both because a person reaching either one arrives
// through the same door.
//
// RESUME IS A FIRST-CLASS STATE, not a recovery path. A daemon restart mid-flow resumes
// at the step the person left, and partial state older than twenty-four hours reports as
// UNRESOLVED rather than as stale progress. The daemon owns that judgement and this
// console never re-derives it: the completed-step set arrives on the state read, and a
// step outside it is simply not done.
//
// THE STEP IDS ARE THIS CONSOLE'S. There is no normative step-id vocabulary — what is
// normative is the three RELAY method identifiers, which live next door in
// `relay-choice.ts`. These ids are what this walkthrough sends back on
// `onboardingStepAdvance`, so they are declared once here and the daemon's
// completed-step set is matched against them fail-closed: an id this build does not
// recognise is ignored rather than guessed at, and a step it does not mention is not
// done.
//
// AND ONLY GROUP A IS EVER SENT BACK. Group B persists nothing — no config key, no
// partial-state entry, no keystore entry, and no event — because the account registry
// already holds every fact it establishes. Leaving the provider step is therefore a
// LOCAL act — the walkthrough's **Not now** — and no verb of this family records it: a
// completed-step entry for group B would be exactly the second record that rule refuses,
// accurate about a moment and wrong about the node as soon as an account is signed out.

/**
 * Every step, in rail order. Closed; the rail renders exactly these.
 *
 * A tuple with the union derived from it, on `routing/routes.ts`' rule about its own
 * destinations: "exactly these" is a claim about a set, and a set nothing can walk at
 * runtime cannot be held to it.
 */
export const ONBOARDING_STEP_IDS = ["relay", "telemetry", "providers"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * The opening that means "wherever this node has got to" rather than a named step.
 *
 * A SENTINEL RATHER THAN A STEP CHOSEN AT PRESS TIME. The collaboration entry point
 * resumes, and where a resumed walkthrough opens is a reading of the daemon's
 * completed set — which the command that contributes it cannot have, because the
 * activation may be raised before any state read has answered. A press that picked a
 * step from an unanswered snapshot picked `relay` every time, whatever the node had
 * already settled. Carrying the INTENT instead lets the walkthrough resolve it from
 * the read it is already performing, under that read's own generation.
 */
export const RESUME_OPENING = "resume" as const;

/** Where an activation opens: one named step, or wherever this node has got to. */
export type OnboardingOpening = OnboardingStepId | typeof RESUME_OPENING;

/** Which of the walkthrough's two step groups a step belongs to. */
export type OnboardingStepGroup = "relay" | "providers";

/**
 * The group whose questions have to be answered, named once for every reader.
 *
 * The walkthrough splits in two and treats the halves differently: group A settles
 * where this node relays and takes a separate explicit telemetry answer, and group B is
 * offered and never demanded. Three rules key on that split — which activations may be
 * locked shut, which steps hold the completion action, and which are simply offered —
 * and a literal repeated at each of them would be the same claim written three times,
 * free to disagree the day a step changes group.
 */
export const MANDATORY_STEP_GROUP: OnboardingStepGroup = "relay";

export interface OnboardingStepDescriptor {
  readonly id: OnboardingStepId;
  readonly group: OnboardingStepGroup;
  /** The rail's label. Sentence case, names the question rather than the act. */
  readonly label: string;
  /** One line under the label, so the rail says what the step decides. */
  readonly summary: string;
  /**
   * Whether a person may leave this step without answering it.
   *
   * EXACTLY ONE STEP MAY BE LEFT UNANSWERED, and it is the provider step: it is offered
   * and never demanded, and onboarding completes with zero registered accounts. The
   * other two are not. The relay choice sits behind a modal that is non-dismissible
   * until a choice is made or the user explicitly cancels the outbound invite that
   * triggered it, and telemetry — which this field once called skippable — is the
   * strictest of the three: the flow must not proceed past telemetry opt-in without an
   * explicit choice, and there is no silent default. Default-OFF is what the answer
   * defaults to, not permission to leave without giving one.
   *
   * NAMED FOR LEAVING RATHER THAN FOR SKIPPING, because a skip is something the
   * daemon is told and this is not: the one step it admits is group B's, which
   * persists nothing (see the header). The word carried the write with it, and a
   * field called `isSkippable` is the field the next author wires to a skip verb.
   *
   * READ BY THE WALKTHROUGH AND BY NOTHING ELSE, which is what keeps it honest: the
   * local exit is offered from this field, so a step it holds shut has no way out
   * rather than a second rule somewhere saying it must not have one.
   */
  readonly mayBeLeftUnanswered: boolean;
  /**
   * The step that has to be resolved before this one may be opened, where there is
   * one at all.
   *
   * ONE STEP HAS A PREREQUISITE, and it is telemetry: that question is put after the
   * relay choice resolves, and asking it alongside the choice is a defect. A rail that
   * let a person open it first, and a control that put the question when they did, is
   * that defect reached the long way round — the answer would be recorded before the
   * choice it is supposed to follow.
   *
   * THE PROVIDER STEP HAS NONE, and that is a decision rather than an omission. Group
   * B is offered and never demanded, and is reached by its own entry point and by an
   * account-plane refusal, neither of which passes through the relay choice — so
   * ordering it behind group A would turn an independent workflow into a mandatory
   * setup flow.
   *
   * READ THROUGH `stepBlockedReason` AND NOWHERE ELSE, so the rail's disabled entry
   * and the step's own control answer one question once instead of two that agree
   * until one of them is edited.
   */
  readonly opensAfter: OnboardingStepId | undefined;
}

/**
 * The steps, as data.
 *
 * A TOTAL record keyed by the id union rather than an array beside it, so a fourth
 * step is a compile error here until its group, label, summary, skippability, and
 * prerequisite are decided — the shape `settings-page-registry.ts` uses for its
 * section labels, and for the same reason: a rail entry cannot silently default to
 * its id.
 */
export const ONBOARDING_STEPS: Readonly<Record<OnboardingStepId, OnboardingStepDescriptor>> = {
  relay: {
    id: "relay",
    group: "relay",
    label: "Where this node relays",
    summary: "Three ways this node's traffic can reach your other devices. One has to be chosen.",
    mayBeLeftUnanswered: false,
    opensAfter: undefined,
  },
  telemetry: {
    id: "telemetry",
    group: "relay",
    label: "Telemetry",
    summary: "Its own question, asked after the relay choice and answered explicitly.",
    mayBeLeftUnanswered: false,
    opensAfter: "relay",
  },
  providers: {
    id: "providers",
    group: "providers",
    label: "Providers",
    summary: "Which providers this node can run right now, and how to close the gaps.",
    mayBeLeftUnanswered: true,
    opensAfter: undefined,
  },
};

/** The steps in rail order, derived from the id tuple so the two cannot disagree. */
export const ONBOARDING_STEPS_IN_ORDER: readonly OnboardingStepDescriptor[] =
  ONBOARDING_STEP_IDS.map((id) => ONBOARDING_STEPS[id]);

/**
 * Where the completion act stands: settled already, held, or simply offered.
 *
 * ONE CLOSED VALUE RATHER THAN A REASON BESIDE A FLAG, because the three states are
 * mutually exclusive and a footer handed two independent inputs can render a
 * combination that means nothing — a control offered over a node the daemon has
 * already recorded as set up, which is exactly the state that let a finished
 * walkthrough re-dispatch `onboarding.complete`.
 */
export type OnboardingCompletionStanding =
  | { readonly kind: "settled" }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "offered" };

/**
 * The daemon's completed-step set, narrowed to the steps this build knows.
 *
 * FAIL-CLOSED, on the console's unknown-member rule: an id the daemon reports that this
 * build does not recognise is dropped rather than guessed into a neighbouring step, and
 * a step the daemon does not mention is simply not done. Neither direction invents
 * progress.
 */
export function completedStepsFrom(
  completedStepIds: readonly string[],
): ReadonlySet<OnboardingStepId> {
  const known = new Set<OnboardingStepId>();
  for (const candidate of completedStepIds) {
    const recognised = ONBOARDING_STEP_IDS.find((stepId) => stepId === candidate);
    if (recognised !== undefined) {
      known.add(recognised);
    }
  }
  return known;
}

/**
 * Where a resumed walkthrough opens: the first step nothing says is done.
 *
 * `undefined` where every step is done, which is the completion summary's cue. The
 * rail still renders every step — a person may go back to one they finished — so
 * this decides only where the right pane starts.
 */
export function firstUnresolvedStep(
  completed: ReadonlySet<OnboardingStepId>,
): OnboardingStepId | undefined {
  return ONBOARDING_STEP_IDS.find((stepId) => !completed.has(stepId));
}

/**
 * Why a step may not be opened yet, or `undefined` where nothing holds it.
 *
 * A SENTENCE RATHER THAN A BOOLEAN, because both readers need the reason and not
 * only the verdict: the rail renders it as the disabled entry's own text, and the
 * step renders it beside the control it has taken away. A boolean would have each of
 * them write that sentence itself, which is the same claim in two places.
 *
 * THE PREREQUISITE IS NAMED BY ITS OWN LABEL, so a step renamed above is renamed
 * here — a hand-written "the relay choice" would be a second name for a step that
 * already has one.
 *
 * WHAT "RESOLVED" MEANS IS THE DAEMON'S, read off the completed set the state read
 * carries. Nothing here re-derives progress, and a step the daemon does not mention
 * is simply not done — which is why a walkthrough whose read has not answered blocks
 * rather than opens: an unanswered read is not permission.
 */
export function stepBlockedReason(
  stepId: OnboardingStepId,
  completed: ReadonlySet<OnboardingStepId>,
): string | undefined {
  const prerequisite = ONBOARDING_STEPS[stepId].opensAfter;
  if (prerequisite === undefined || completed.has(prerequisite)) {
    return undefined;
  }
  return `Opens once “${ONBOARDING_STEPS[prerequisite].label}” is settled.`;
}

/**
 * Where the completion act stands, from the daemon's own reading and nothing else.
 *
 * THE SETTLED ARM IS THE READ'S AND NOT THE MUTATION'S. `onboarding.complete`
 * answering is the daemon accepting the act; this node being SET UP is what the state
 * read says afterwards, and only the second retires the control. A footer that
 * retired on the reply would go quiet over a completion the re-read then contradicted,
 * and one that retired on neither offered the same act again the moment its in-flight
 * flag cleared.
 *
 * GROUP A IS THE WHOLE OF THE HELD CONDITION, asked of the same field the dismissal
 * lock asks: a step's group. The relay choice sits behind a modal that stays shut until
 * it is made, telemetry may not be proceeded past without an explicit choice, and the
 * provider step is offered and never demanded, with onboarding completing at zero
 * registered accounts. So completion is held on group A and on nothing else — a footer
 * that dispatched `onboarding.complete` before those two answers would ask the daemon to
 * record a node as set up over questions nobody put, and the daemon accepting it is the
 * case that cannot be taken back.
 *
 * KEYED ON THE GROUP RATHER THAN ON `mayBeLeftUnanswered`, so the lock, the rail, and
 * this read one field. Leaving answers whether a person may walk away from a step;
 * this answers whether the walkthrough may be finished, and today the two coincide
 * only because the same split produced both.
 *
 * A SENTENCE NAMING THE OUTSTANDING STEPS, on `stepBlockedReason`'s rule: the footer
 * renders it beside the control it has taken away, and "finishing is unavailable" is
 * not something a person can act on. The steps are named by their own labels, so one
 * renamed above is renamed here.
 */
export function completionStanding(
  completed: ReadonlySet<OnboardingStepId>,
  isRecordedComplete: boolean,
): OnboardingCompletionStanding {
  if (isRecordedComplete) {
    return { kind: "settled" };
  }
  const outstanding = ONBOARDING_STEPS_IN_ORDER.filter(
    (step) => step.group === MANDATORY_STEP_GROUP && !completed.has(step.id),
  ).map((step) => `“${step.label}”`);
  if (outstanding.length === 0) {
    return { kind: "offered" };
  }
  return { kind: "held", reason: `Answer ${joinInRailOrder(outstanding)} to finish setting up.` };
}

/** The outstanding step names as one phrase, in the order the rail lists them. */
function joinInRailOrder(names: readonly string[]): string {
  const last = names.at(-1);
  if (last === undefined) {
    return "";
  }
  const leading = names.slice(0, -1);
  return leading.length === 0 ? last : `${leading.join(", ")} and ${last}`;
}
