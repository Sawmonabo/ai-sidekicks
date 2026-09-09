// The walkthrough's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. `Spec-026 §Trigger` forbids this flow on install, first launch, health
// check, or first session creation and names its three openings instead — two commands
// a person runs and an activation raised after a run has already been refused. So no
// step of it is ever drawn before somebody acts, which is precisely the question
// `apps/desktop/AGENTS.md` §Module shape makes a registration answer.
//
// It rode the initial import graph anyway, because `OnboardingOverlay.tsx` named the
// walkthrough by static import — and a symbol reachable both statically and dynamically
// is assigned to the STATIC chunk, so one line put the rail, all four steps, the
// completion summary, the provider rows and their copy table on the document every
// session downloads, for a dialog most sessions never open. The overlay now reaches it
// through `onboarding-walkthrough-mount.ts`, and this module is the split point.
//
// WHAT STAYS EAGER, AND WHY IT IS NOT ARBITRARY. The overlay does: it registers the two
// commands, subscribes to the activation seam, holds the lock reading that decides
// whether the dialog may be closed, and publishes the window's modal lifetime — none of
// which a person can wait for, and the first two of which have to be live before
// anybody presses anything. So do the two MODELS and `steps/step-model.ts`: the flow's
// reading composes the close control's label, the activation seam and the flow both
// name the step vocabulary, and the pair is held outside `Dialog.Portal` so it survives
// a close where every step inside does not. The stylesheet stays on the family door on
// the same reasoning — it dresses the backdrop, popup, heading, and close control the
// eager shell renders, so landing it with this chunk would flash them undressed.

export { OnboardingWalkthrough as Body } from "./OnboardingWalkthrough.js";
