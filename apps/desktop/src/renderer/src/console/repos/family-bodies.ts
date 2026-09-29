// Everything this family hands the console, from the module that reads the doors.
//
// A door reading another door is not a reader: composing these registrations inside
// `repos/index.ts` would make the family's own barrel the only production reader of
// the sub-module barrels' lines, which is a barrel chain. Named here they have a real
// reader and the door stays a registration function and a list of names.
//
// The pane registration is declared in `repos/index.ts`, because `console/panes/index.ts`
// states that a family claims its pane kinds inside the function it publishes from its
// own `index.ts`. What this module composes is what a session paints without opening
// anything: the three inline ledger cards.

import { registerInlineArtifactCardBody } from "./artifact-pane/index.js";
import { registerInlineDiffCardBody } from "./diff-pane/index.js";
import { type InlineCardSeatRegistry } from "../seats/index.js";

/**
 * Who owns every body this family registers.
 *
 * One binding rather than several literals, and it is load-bearing: the registries carry
 * a `duplicatePolicy` of `"owner-scoped"`, so the owner string decides whether a second
 * registration replaces the first (a hot reload re-running a module) or raises (a
 * different family claiming a taken key). Literals that drifted apart would turn a hot
 * reload into a conflict.
 */
export const REPOS_FAMILY_OWNER = "repos";

/**
 * Fill the ledger row's three inline cards.
 *
 * The board is a parameter rather than an import, so an independent composition (an
 * auxiliary window selecting a subset, a suite composing one family in isolation)
 * writes into its own registry and never mutates the running console's. All three kinds
 * `INLINE_CARD_KINDS` declares are this family's, and they are claimed here rather than
 * at each card module's own scope so a hot reload re-runs one module rather than three.
 */
export function registerRepos(inlineCardSeats: InlineCardSeatRegistry): void {
  registerInlineDiffCardBody(inlineCardSeats);
  registerInlineArtifactCardBody(inlineCardSeats);
}
