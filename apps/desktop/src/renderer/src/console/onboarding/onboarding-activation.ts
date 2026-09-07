// The three ways this walkthrough opens, and the one seam every one of them uses.
//
// `Spec-026 §Provider Authentication (Group B)` fixes the set at exactly three and
// says there are no others: the _Set up providers_ entry point, a running flow
// reaching the step after the relay choice resolves, and an account-plane refusal
// that has already happened. This module is what those three have in common — a
// request naming which step to open at and, on the refusal arm alone, which account
// to scope the readiness read to.
//
// A SIGNAL RATHER THAN A PROP, because two of the three triggers are raised by code
// that cannot reach this family: the console's view families are siblings and none of
// them may import another, and the run-failure surface that meets an account-plane
// refusal is one of them. A module-scoped signal is the console's existing answer to
// that shape — the command registry is one — and it costs no polling and no state.
//
// AND NEVER A TIMER. Nothing here ticks, re-reads, or retries: an activation is one
// event raised by an act somebody performed.
//
// WHAT THIS IS NOT. It is not a gate. Readiness authorizes nothing, and neither does
// this: an activation OFFERS the step. A run refused on the account plane is already
// refused, and opening the step after the fact is the remedy being shown rather than
// a precondition being enforced — which is exactly the ordering `Spec-026 §Trigger`
// requires, since the step must never run ahead of a run that would have been
// admitted.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { readProviderAccountId } from "../bridge/index.js";
import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import { ONBOARDING_STEPS, type OnboardingStepId } from "./steps/step-model.js";

/**
 * The account-plane refusals that should open the provider step.
 *
 * A DELIBERATE SUBSET, and the rule that selects it is a conjunction: the code is
 * reachable when a provider RUN is refused at admission, AND the readiness projection
 * carries a remedy arm that closes it — `register`, `choose_default`, or `sign_in`,
 * which is the whole of `ProviderRemedy`. Both halves are needed, because a
 * walkthrough opened over a failure it has no remedy for is worse than no walkthrough
 * at all. Transcribed rather than derived, because no renderer module can read the
 * error table.
 *
 * The account plane registers twelve codes. The other seven are excluded on one
 * conjunct or the other, and naming which is what keeps this list checkable:
 *
 *   • `default_conflict`, `signin_unsupported`, `signin_in_flight`,
 *     `token_class_refused`, and `credential_seal_refused` refuse a registry mutation
 *     or a sign-in call, never a run — so the first conjunct fails and a run never
 *     meets them.
 *   • `permission_denied` and `provider_version_below_floor` ARE run-admission
 *     refusals, and they fail the second: the remedy for the first is node-operator
 *     authority and for the second a host binary upgrade, and the readiness
 *     projection has an arm for neither. Opening the step for either would show a
 *     person three remedies, none of which is theirs.
 */
export const ACCOUNT_PLANE_RUN_REFUSAL_CODES: readonly string[] = [
  "provideraccount.not_registered",
  "provideraccount.no_default",
  "provideraccount.unknown",
  "provideraccount.credential_home_unavailable",
  "provideraccount.not_authenticated",
];

/** One request to open the walkthrough, and where it opens. */
export interface OnboardingActivation {
  readonly openAtStep: OnboardingStepId;
  /**
   * Scopes the readiness read to one account rather than the provider's default.
   *
   * Present on the post-refusal arm and absent everywhere else, because it exists for
   * exactly one caller: a run bound to a per-run account override. Without it the
   * remedy would describe the provider's DEFAULT account — a different account from
   * the one that failed, whose home may be perfectly healthy.
   */
  readonly accountScope: ProviderAccountId | undefined;
}

/**
 * The signal itself.
 *
 * A class rather than a bare emitter so the two verbs read as what they are, and so
 * a caller cannot emit an activation shaped by hand.
 */
export class OnboardingActivationSignal {
  readonly #requests = new Emitter<OnboardingActivation>("onboarding activation");

  /** Ask the mounted walkthrough to open. Does nothing when none is mounted. */
  public request(activation: OnboardingActivation): void {
    this.#requests.emit(activation);
  }

  public subscribe(sink: (activation: OnboardingActivation) => void): Unsubscribe {
    return this.#requests.subscribe(sink);
  }
}

/** This window's signal. One per renderer, like the command registry beside it. */
export const onboardingActivation: OnboardingActivationSignal = new OnboardingActivationSignal();

/**
 * Whether an activation opens group A — the half the corpus makes non-dismissible.
 *
 * WHICH GROUP AN ACTIVATION IS FOR IS ALREADY ON IT, in the step it asks to open at,
 * and this reads that rather than adding a discriminator beside it: `step-model.ts`
 * assigns every step a group, so an activation naming a step names a group, and a
 * second field would be a fact with two homes that disagree the first time one of
 * them is edited.
 *
 * WHY IT IS ASKED AT ALL. `Spec-026 §Desktop Surface` makes the walkthrough
 * non-dismissible until the relay choice is made, and that rule is about the flow an
 * outbound invite triggers. Two of the three openings are group B's — the _Set up
 * providers_ command and the post-refusal activation, both of which name the provider
 * step — and `Spec-026 §Provider Authentication (Group B)` has those "offered and
 * never demanded", reached after a refusal that has already happened. Locking those
 * behind an unmade relay choice would turn a look at provider readiness into a setup
 * flow nobody asked for, with no way out of the dialog.
 */
export function activationRequiresRelayChoice(activation: OnboardingActivation): boolean {
  return ONBOARDING_STEPS[activation.openAtStep].group === "relay";
}

/**
 * The activation a refused run should raise, or `undefined` where it should raise none.
 *
 * FAIL-CLOSED IN THE DIRECTION THAT MATTERS: an unrecognised code answers `undefined`
 * and the run's own refusal stands alone, because a walkthrough opened over a failure
 * it has no remedy for is worse than no walkthrough at all.
 *
 * The account id is read off the refusal's own `data.fields` by the caller and passed
 * in as a raw string rather than dug for here: this console has one reader for a wire
 * envelope (`core/wire-rejection.ts`) and a second field-picking rule living beside a
 * predicate would be a second reading of the same value. It is PARSED here, which is
 * the one place it can be — the readiness read takes the contract's branded id, and a
 * scope that does not parse becomes an unscoped read rather than a refused activation:
 * the provider step is still worth opening, it just describes the default account.
 */
// Consumed by T-023p-1C-3 — the runs pane's run-failure routing.
export function activationForRunRefusal(
  refusal: ConsoleRefusal,
  accountId: string | undefined,
): OnboardingActivation | undefined {
  if (!ACCOUNT_PLANE_RUN_REFUSAL_CODES.includes(refusal.code)) {
    return undefined;
  }
  return {
    openAtStep: "providers",
    accountScope: accountId === undefined ? undefined : readProviderAccountId(accountId),
  };
}
