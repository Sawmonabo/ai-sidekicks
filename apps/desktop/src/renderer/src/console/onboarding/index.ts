// The onboarding family's door.
//
// THE OVERLAY, because that is what the renderer root composes, and the ACTIVATION
// SEAM, because one of the three openings is raised from outside this family
// entirely: the surface that meets an account-plane refusal on a run start is a
// sibling view family, and siblings reach each other through nothing. A module-scoped
// signal published here is how a console family offers an entry point without
// inverting the DAG.
//
// The flow, the readiness model, the steps, and the rail are deliberately
// unpublished. Every one of them is an interior of the walkthrough, and a door line
// for any of them would invite a second composition of a surface that must have
// exactly one.
//
// The stylesheet enters here because this directory owns it.

import "./onboarding.css";

// The two tagged lines below name the TASK that will import them, which is the form
// `apps/desktop/AGENTS.md` §Module shape fixes for the dead-code gate's one exemption
// — the prose these carried was a description of a consumer and not a task id, so
// nothing retired them. The consumer is the runs pane's run-failure routing: a run
// refused on the account plane reads the code, and these two turn it into an
// activation. Both lines are deleted in the PR that writes that import.
export {
  /** @consumedBy T-023p-1C-3 */
  activationForRunRefusal,
  onboardingActivation,
  /** @consumedBy T-023p-1C-3 */
  type OnboardingActivation,
} from "./onboarding-activation.js";

export { OnboardingOverlay } from "./OnboardingOverlay.js";
