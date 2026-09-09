// The sign-in card's chunk root: the one module an `import()` names.
//
// WHY IT EXISTS. Nothing on the flagship first paint is a sign-in card.
// `Spec-023 §WebAuthn Credential Flow` gives the ceremony a start and no screen and
// `Spec-026 §Trigger` deliberately does not gate first launch, so the console opens
// signed out and this card is drawn only once somebody runs the command — which is
// exactly the question `apps/desktop/AGENTS.md` §Module shape says a registration
// answers: painted before a person acts, or reached through a loader.
//
// It rode the initial import graph anyway, because `SignInOverlay.tsx` named the card
// by static import — and a symbol reachable both statically and dynamically is assigned
// to the STATIC chunk, so the overlay's one line put the card, the device-grant card,
// and the whole copy table on the document every session downloads. The overlay now
// reaches them through `sign-in-card-mount.ts`, and this module is the split point:
// everything only it reaches is emitted as its own chunk and fetched the first time the
// card opens.
//
// WHAT STAYS EAGER, AND WHY IT IS NOT ARBITRARY. The overlay itself does — it registers
// the command, holds the open state, and publishes the window's modal lifetime, none of
// which a person can wait for. So does the FLOW: it lives outside `Dialog.Portal`, so
// it survives a close where the card does not, and moving it here would have reset a
// ceremony's state every time the card was dismissed and reopened. The stylesheet stays
// on the family door for the same class of reason — it dresses the backdrop and popup
// the eager shell renders, so landing it with this chunk would flash them undressed.

export { SignInCard as Body } from "./SignInCard.js";
