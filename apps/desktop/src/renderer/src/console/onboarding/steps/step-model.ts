// The walkthrough's steps, and where a person is in them.
//
// `Spec-026 §Desktop Surface` fixes the shape: "a left-rail progress list with a
// right pane carrying copy and inputs and one explicit primary action per step".
// This module is the rail's model — which steps exist, in what order, which group
// each belongs to, and what "resolved" means for each — and it holds no wire.
//
// TWO GROUPS AND NOT ONE FLOW. Group A settles where this node relays and takes a
// separate explicit answer about telemetry; group B tells a person which providers
// this node can actually run. They are different questions with different terminals:
// group A must be answered before the invite that triggered the walkthrough can go
// out, and group B is offered and never demanded — "onboarding completes with zero
// registered accounts", `Spec-026 §Provider Authentication (Group B)`. The rail
// shows both because a person reaching either one arrives through the same door.
//
// RESUME IS A FIRST-CLASS STATE, not a recovery path. `Spec-026` has a daemon
// restart mid-flow resume at the step the person left, and partial state older than
// twenty-four hours report as UNRESOLVED rather than as stale progress. The daemon
// owns that judgement and this console never re-derives it: the completed-step set
// arrives on the state read, and a step outside it is simply not done.
//
// THE STEP IDS ARE THIS CONSOLE'S. `Spec-026` names no step-id vocabulary — what it
// names normatively is the three RELAY method identifiers, which live next door in
// `relay-choice.ts`. These ids are what this walkthrough sends back on
// `onboardingStepAdvance` / `onboardingStepSkip`, so they are declared once here and
// the daemon's completed-step set is matched against them fail-closed: an id this
// build does not recognise is ignored rather than guessed at, and a step it does not
// mention is not done.

/**
 * Every step, in rail order. Closed; the rail renders exactly these.
 *
 * A tuple with the union derived from it, on `routing/routes.ts`' rule about its own
 * destinations: "exactly these" is a claim about a set, and a set nothing can walk at
 * runtime cannot be held to it.
 */
export const ONBOARDING_STEP_IDS = ["relay", "telemetry", "providers"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Which of `Spec-026`'s two step groups a step belongs to. */
export type OnboardingStepGroup = "relay" | "providers";

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
   * EXACTLY ONE STEP IS SKIPPABLE, and it is the provider step: `Spec-026 §Provider
   * Authentication (Group B)` makes it "offered and never demanded", and onboarding
   * completes with zero registered accounts. The other two are not. `Spec-026
   * §Desktop Surface` puts the relay choice behind a modal that is "non-dismissible
   * until a choice is made or the user explicitly cancels the outbound invite that
   * triggered it", and telemetry — which this field once called skippable — is the
   * step that spec is most explicit about: "The flow must not proceed past telemetry
   * opt-in without an explicit choice; no silent default" (`Spec-026 §Telemetry
   * Opt-In`). Default-OFF is what the answer defaults to, not permission to leave
   * without giving one.
   *
   * READ BY THE WALKTHROUGH AND BY NOTHING ELSE, which is what keeps it honest: the
   * skip control is offered from this field, so a step marked unskippable has no way
   * to be skipped rather than a second rule somewhere saying it must not be.
   */
  readonly isSkippable: boolean;
  /**
   * The step that has to be resolved before this one may be opened, where there is
   * one at all.
   *
   * ONE STEP HAS A PREREQUISITE, and it is telemetry: `Spec-026 §Telemetry Opt-In`
   * puts that question "after the relay choice resolves", and `Spec-026 §Pitfalls To
   * Avoid` names asking it alongside the choice as a defect. A rail that let a person
   * open it first, and a control that put the question when they did, is that defect
   * reached the long way round — the answer would be recorded before the choice it is
   * supposed to follow.
   *
   * THE PROVIDER STEP HAS NONE, and that is a decision rather than an omission. Group
   * B is "offered and never demanded" (`Spec-026 §Provider Authentication (Group B)`)
   * and is reached by its own entry point and by an account-plane refusal, neither of
   * which passes through the relay choice — so ordering it behind group A would turn
   * an independent workflow into a mandatory setup flow.
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
    summary: "Three ways to reach other people. One has to be chosen before an invite goes out.",
    isSkippable: false,
    opensAfter: undefined,
  },
  telemetry: {
    id: "telemetry",
    group: "relay",
    label: "Telemetry",
    summary: "Its own question, asked after the relay choice and answered explicitly.",
    isSkippable: false,
    opensAfter: "relay",
  },
  providers: {
    id: "providers",
    group: "providers",
    label: "Providers",
    summary: "Which providers this node can run right now, and how to close the gaps.",
    isSkippable: true,
    opensAfter: undefined,
  },
};

/** The steps in rail order, derived from the id tuple so the two cannot disagree. */
export const ONBOARDING_STEPS_IN_ORDER: readonly OnboardingStepDescriptor[] =
  ONBOARDING_STEP_IDS.map((id) => ONBOARDING_STEPS[id]);

/**
 * The daemon's completed-step set, narrowed to the steps this build knows.
 *
 * FAIL-CLOSED, per `Spec-023 §Console Design (Meridian)`' unknown-member rule: an id
 * the daemon reports that this build does not recognise is dropped rather than
 * guessed into a neighbouring step, and a step the daemon does not mention is simply
 * not done. Neither direction invents progress.
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
