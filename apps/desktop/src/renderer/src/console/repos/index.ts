// The repos family's door.
//
// The family is `T-023p-1C-5` — repos and worktrees, the diff pane and its inline
// cards, the artifact pane, and attachments — and it occupies THREE directories:
// `repos/` for the sidebar section and its mount cards, `panes/diff/`, and
// `panes/artifact/`. They are one family and not three, because the deck's pane
// registry is keyed by pane kind while the sidebar's registry is keyed by section
// id, and a family that owned bodies in both key spaces would otherwise need two
// doors. This is the one door: everything the family registers is registered here.
//
// THE FAMILY'S SHEET IS IMPORTED HERE AND NOWHERE ELSE. One family, one stylesheet,
// imported from that family's barrel — the rule every console family obeys. This
// module is what both pane barrels are reached through, so the sheet is present
// whenever any of the three directories renders, and it lands in the graph once.
//
// WHY `registerRepos` TAKES NO REGISTRY WHERE THE OTHER SEATS DO. The seat board in
// `console/families.ts` describes a family as `register<Family>(registry:
// ConsoleSurfaceRegistry)`, because most families claim a SURFACE — the thing a
// route mounts. This one claims none: `CONSOLE_SURFACE_SLOTS` is closed at five and
// none of them is a repos destination, because the repos family reaches the screen
// through the session sidebar and the deck rather than through a route of its own.
// A parameter it never reads would be a claim that it might, and the eslint
// suppression that parameter needs would outlive the reason for it.

import "./repos.css";
// The diff surfaces' own sheet, imported HERE and not from `panes/diff/index.ts`,
// so this barrel stays the family's only stylesheet importer. A CSS `@import` from
// `repos.css` would have kept the file count the same and lost the rules: the
// browser tiers inject a sheet as a `<style>` element, and a relative `@import`
// inside one resolves against the document rather than against the sheet, so the
// rules silently do not arrive and the pane is screenshotted unstyled.
import "../panes/diff/diff.css";

import { createElement } from "react";

import {
  ArtifactPane,
  registerInlineArtifactCardBody,
  registerInlineAttachmentCardBody,
} from "../panes/artifact/index.js";
import { DiffPane, registerInlineDiffCardBody } from "../panes/diff/index.js";
import { registerSidebarSection, type ConsolePaneRegistry } from "../workspace/index.js";
import { RepoSection } from "./RepoSection.js";

/**
 * Who owns every body this family registers.
 *
 * One binding rather than three literals, and it is load-bearing rather than tidy:
 * both registries carry a `duplicatePolicy` of `"owner-scoped"`, so the owner
 * string is what decides whether a second registration REPLACES the first (a hot
 * reload re-running this module) or RAISES (a different family claiming a taken
 * key). Three literals that drifted apart would turn a hot reload into a conflict
 * on whichever body was spelled differently.
 */
const REPOS_FAMILY_OWNER = "repos";

/**
 * Fill the sidebar's repos section.
 *
 * Reached from `console/families.ts`, at this family's own reserved line.
 */
export function registerRepos(): void {
  registerSidebarSection({
    id: "repos",
    owner: REPOS_FAMILY_OWNER,
    render: (context) => createElement(RepoSection, { context }),
  });
  // The ledger row's three card bodies. They are registered HERE rather than at
  // each card module's own scope for the reason this whole file exists: a family
  // registers everything it owns through one door, so a reader can see the
  // family's entire contact surface with the rest of the console in one place,
  // and so a hot reload re-runs one module rather than several. All three kinds
  // `INLINE_CARD_KINDS` declares are this family's, so after this call the seat
  // registry is full.
  registerInlineDiffCardBody();
  registerInlineArtifactCardBody();
  registerInlineAttachmentCardBody();
}

/**
 * Claim the two pane kinds this family builds bodies for.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for the
 * seat board's reason: a test composes the same bodies into a registry it owns, and
 * an auxiliary window composes a subset without a second code path.
 *
 * BOTH KINDS ANSWER `openInWindow: true`, and they answer it for the same reason
 * the two kinds that cannot are the ones that hold something a window move would
 * break. A diff and an artifact are read from the renderer's own state — no
 * main-process view, no process lease — so a tear-off carries nothing with it.
 * THAT IS THIS FAMILY'S OWN DECLARATION, and no committed document states it:
 * `Spec-023 §The surface set` names `timeline` and `agent-console` as the two panes
 * that get their own hardened window, so the flag here says only that neither of
 * these bodies would break if the seat board moved one.
 */
export function registerReposPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "diff",
    owner: REPOS_FAMILY_OWNER,
    openInWindow: true,
    render: (context) => createElement(DiffPane, { context }),
  });
  registry.register({
    kind: "artifact",
    owner: REPOS_FAMILY_OWNER,
    openInWindow: true,
    render: (context) => createElement(ArtifactPane, { context }),
  });
}
