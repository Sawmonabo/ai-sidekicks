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
// against the boards the composition hands this family rather than against a
// process-wide singleton. The two pane RENDERERS are here for the same reason and stop
// there — the pane REGISTRATION is declared in `repos/index.ts`, because
// `console/panes/index.ts` states that contract in its own words: a family claims its
// pane kinds "inside that function", the one it publishes from its own `index.ts`.

import { createElement, type ReactNode } from "react";

import {
  ArtifactPane,
  registerInlineArtifactCardBody,
  registerInlineAttachmentCardBody,
} from "./artifact-pane/index.js";
import { DiffPane, registerInlineDiffCardBody } from "./diff-pane/index.js";
import {
  paneBodyForKind,
  type ConsolePaneContext,
  type InlineCardSeatRegistry,
  type SidebarSectionRegistry,
} from "../seats/index.js";
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

/**
 * The diff pane, at an address the deck resolved to this kind.
 *
 * `paneBodyForKind` is the seat's own narrowing and the one answer to the arm that
 * cannot be served: it compares the kind, hands the body its own arm, and renders the
 * chrome's typed refusal otherwise. Six families writing that comparison themselves is
 * six answers to one question — which is what this family had, in a refusal it minted
 * and a card it drew — so the narrowing is consumed rather than restated.
 *
 * A MISMATCH IS STILL A RENDERED REFUSAL AND NEVER A THROW, for the reason it always
 * was: the deck looks a body up BY kind, so the arm is reachable only through a
 * restored layout row or a typed route, and one bad row must lose that row rather than
 * take the whole deck down with it.
 */
export const renderDiffPaneBody: (context: ConsolePaneContext) => ReactNode = paneBodyForKind(
  "diff",
  (context) => createElement(DiffPane, { context }),
);

/** The artifact pane, on the narrowing the diff body above explains. */
export const renderArtifactPaneBody: (context: ConsolePaneContext) => ReactNode = paneBodyForKind(
  "artifact",
  (context) => createElement(ArtifactPane, { context }),
);

/**
 * Fill the sidebar's two repos-family sections and the ledger row's three cards.
 *
 * Reached from `console/families.ts` through this family's door, at its own reserved
 * line, and handed the two boards it writes into.
 *
 * THE BOARDS ARE PARAMETERS RATHER THAN IMPORTS, which is the same rule
 * `registerReposPanes` already follows for the pane deck. A family that reached for a
 * module-scope singleton would write into a board no caller named, so an independent
 * composition — an auxiliary window selecting a subset, a suite composing one family
 * in isolation — would mutate the running console instead of its own registry, and
 * two compositions in one process would see each other's registrations. Passing the
 * board makes the write addressable: what a composition gets is what it asked for.
 * There is deliberately no singleton-reaching convenience form left to fall back to,
 * because a default that reintroduces the defect is the defect.
 *
 * TWO SECTIONS AND NOT ONE, because `seats/sidebar-sections.ts` names both as this
 * family's: "repos and artifacts are the repos family's". The second is the
 * attachment carrier — the ingest trio's one production entry point, and the only
 * surface in this console through which a participant hands the session a file.
 *
 * A CALL PER CARD RATHER THAN A DESCRIPTOR LIST, because that seat registry is filled
 * by a call each card module makes for itself: the body stays private to the module
 * that draws it and what leaves is the registration, which now carries the board
 * through. All three kinds `INLINE_CARD_KINDS` declares are this family's, so after
 * this function returns that board is full — and they are claimed HERE rather than at
 * each card module's own scope so that a family registers everything it owns through
 * one entry point, and a hot reload re-runs one module rather than four.
 */
export function registerRepos(
  sidebarSections: SidebarSectionRegistry,
  inlineCardSeats: InlineCardSeatRegistry,
): void {
  sidebarSections.register({
    id: "repos",
    owner: REPOS_FAMILY_OWNER,
    render: (context) => createElement(RepoSection, { context }),
  });
  sidebarSections.register({
    id: "artifacts",
    owner: REPOS_FAMILY_OWNER,
    render: (context) => createElement(AttachmentCarrierSection, { context }),
  });
  registerInlineDiffCardBody(inlineCardSeats);
  registerInlineArtifactCardBody(inlineCardSeats);
  registerInlineAttachmentCardBody(inlineCardSeats);
}
