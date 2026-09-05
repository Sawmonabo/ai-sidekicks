// Everything this family hands the console, from the module that reads the doors.
//
// A DOOR IS NOT A PLACE WHERE THINGS HAPPEN, and a door reading another door is not
// a reader. These bodies were composed inside `repos/index.ts`, which made the
// family's own barrel the only production reader of five door lines —
// `repos/artifact-pane/index.ts`'s three and `repos/diff-pane/index.ts`'s two — and a
// barrel importing a barrel is a barrel CHAIN rather than a consumer, which is what the
// census beside those doors reports. Named here the same imports are a real reader,
// and the door goes back to two registration functions and a list of names.
//
// WHAT IS HERE AND WHAT IS IN THE DOOR. The sidebar and card registrations run here,
// because `registerSidebarSection` is a seats-door line and the census asks the same
// question of it: read only from this family's barrel it has no production reader at
// all. The two pane RENDERERS are here for the same reason and stop there — the pane
// REGISTRATION is declared in `repos/index.ts`, because `console/panes/index.ts`
// states that contract in its own words: a family claims its pane kinds "inside that
// function", the one it publishes from its own `index.ts`.

import { createElement, type ReactNode } from "react";

import {
  ArtifactPane,
  registerInlineArtifactCardBody,
  registerInlineAttachmentCardBody,
} from "./artifact-pane/index.js";
import { DiffPane, registerInlineDiffCardBody } from "./diff-pane/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import { RefusalCard } from "../primitives/index.js";
import { registerSidebarSection, type ConsolePaneContext, type PaneKind } from "../seats/index.js";
import { AttachmentCarrierSection } from "./attachments/AttachmentCarrierSection.js";
import { RepoSection } from "./mounts/RepoSection.js";

/**
 * Who owns every body this family registers.
 *
 * One binding rather than five literals, and it is load-bearing rather than tidy:
 * both registries carry a `duplicatePolicy` of `"owner-scoped"`, so the owner
 * string is what decides whether a second registration REPLACES the first (a hot
 * reload re-running a module) or RAISES (a different family claiming a taken key).
 * Literals that drifted apart would turn a hot reload into a conflict on whichever
 * body was spelled differently.
 */
export const REPOS_FAMILY_OWNER = "repos";

/** The subsystem a misaddressed-pane refusal names as its author. */
const REPOS_PANES_ORIGIN = "repos-panes";

/**
 * What a pane body renders when the deck opens it at another kind's address.
 *
 * A REFUSAL RATHER THAN A THROW, on `core/refusal.ts`'s terms and for the deck's
 * sake: one misrouted pane in a restored layout takes this card and every other pane
 * in the deck still mounts, where an exception raised inside a render would take the
 * whole surface down with it.
 *
 * Reachable only through a defect above this family — the registry resolves a
 * descriptor BY kind and hands it the context it resolved on — which is exactly why
 * it is a rendered sentence rather than a comment: `ConsolePaneAddress` narrows the
 * entity with the kind, so a body cannot be typed on its own arm without the compiler
 * asking what the other arms do here, and answering "nothing" would put a blank
 * region on screen for a state a person cannot otherwise explain.
 */
function misaddressedPaneRefusal(expected: PaneKind, received: PaneKind): ConsoleRefusal {
  return refuse(
    REPOS_PANES_ORIGIN,
    "pane-kind-mismatch",
    `this body renders the ${expected} pane and the deck opened it at a ${received} address, so it has nothing to be a view of`,
  );
}

/**
 * The diff pane, at an address the deck resolved to this kind.
 *
 * The comparison narrows the address union to this kind's arm, which is what gives
 * the body a required `entity` of the kinds a diff is opened over. It is a literal
 * rather than a captured variable deliberately: a generic renderer shared by both
 * kinds would need a cast to narrow, and the cast is the thing the union was minted
 * to remove.
 */
export function renderDiffPaneBody(context: ConsolePaneContext): ReactNode {
  return context.kind === "diff"
    ? createElement(DiffPane, { context })
    : createElement(RefusalCard, misaddressedPaneRefusal("diff", context.kind));
}

/** The artifact pane, on the narrowing the diff body above explains. */
export function renderArtifactPaneBody(context: ConsolePaneContext): ReactNode {
  return context.kind === "artifact"
    ? createElement(ArtifactPane, { context })
    : createElement(RefusalCard, misaddressedPaneRefusal("artifact", context.kind));
}

/**
 * Fill the sidebar's two repos-family sections and the ledger row's three cards.
 *
 * Reached from `console/families.ts` through this family's door, at its own reserved
 * line.
 *
 * TWO SECTIONS AND NOT ONE, because `seats/sidebar-sections.ts` names both as this
 * family's: "repos and artifacts are the repos family's". The second is the
 * attachment carrier — the ingest trio's one production entry point, and the only
 * surface in this console through which a participant hands the session a file.
 *
 * A CALL PER CARD RATHER THAN A DESCRIPTOR LIST, because that seat registry is filled
 * by a call each card module makes for itself: the body stays private to the module
 * that draws it and what leaves is the registration. All three kinds
 * `INLINE_CARD_KINDS` declares are this family's, so after this function returns that
 * registry is full — and they are claimed HERE rather than at each card module's own
 * scope so that a family registers everything it owns through one entry point, and a
 * hot reload re-runs one module rather than four.
 */
export function registerRepos(): void {
  registerSidebarSection({
    id: "repos",
    owner: REPOS_FAMILY_OWNER,
    render: (context) => createElement(RepoSection, { context }),
  });
  registerSidebarSection({
    id: "artifacts",
    owner: REPOS_FAMILY_OWNER,
    render: (context) => createElement(AttachmentCarrierSection, { context }),
  });
  registerInlineDiffCardBody();
  registerInlineArtifactCardBody();
  registerInlineAttachmentCardBody();
}
