// The invite confirmation's chunk root: the one module an `import()` names, and the
// whole of the deep-link card reached through it.
//
// WHY IT EXISTS. Nothing on any first paint is this card. `InviteLifecycleOverlay.tsx`
// states the rule it follows — an arrival draws a NOTICE and never opens the card, and
// the confirmation opens on a press, one gesture later and never a moment the person did
// not choose. That is exactly the question `apps/desktop/AGENTS.md` §Module shape makes a
// registration answer: painted before a person acts, or reached through a loader.
//
// It rode the initial import graph anyway, because the overlay named the card by static
// import — and a symbol reachable both statically and dynamically is assigned to the
// STATIC chunk, so that one line put the card, the invitation reading, the outcome report
// and its five readings, the refusal words, and the footnote copy table on the document
// every session downloads, whether or not a deep link ever arrived. The overlay now
// reaches them through `invite-confirmation-mount.ts`, and this module is the bundler's
// split point: everything only it reaches is emitted as its own chunk.
//
// WHAT STAYS EAGER, AND WHY IT IS NOT ARBITRARY. The lifecycle itself does — it owns two
// live subscriptions and the single-use reference queue, so a window whose chunk had not
// been asked for would receive nothing, which is the one thing a deep link cannot be
// allowed to do. The notice does, and `invite-queue-copy.ts` with it, because the notice
// is what a person sees without acting. `invite-refusal-copy.ts` does too, for a reason
// this file does not get to decide: `CreateInvite.tsx` reads it on a surface that is
// painted with its section, so it is a static symbol already and moving it here would put
// it in both chunks and change nothing.
//
// AND THE STYLESHEET STAYS ON THE FAMILY DOOR. `invites.css` dresses the notice, the
// ledger, and the mint form as well as this card — all of them eager — so landing it with
// this chunk would flash three surfaces undressed to defer one.

export { InviteConfirmation as Body } from "./InviteConfirmation.js";
