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
import { refuse, type ConsoleRefusal } from "../core/index.js";
import { RefusalCard } from "../primitives/index.js";
import { registerSidebarSection, type ConsolePaneRegistry, type PaneKind } from "../seats/index.js";
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
 * NEITHER KIND DECLARES A TEAR-OFF, because a descriptor cannot: whether a pane
 * may be torn off is a property of the KIND, answered once by
 * `isDetachablePaneKind` off the window model's own route set, and never a member
 * a family fills in. `Spec-023 §The surface set` names `timeline` and
 * `agent-console` as the two panes that get their own hardened window, so both of
 * this family's kinds answer that predicate `false` — and they answer it in the
 * one place that decides it rather than in six families' registrations.
 */
export function registerReposPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "diff",
    owner: REPOS_FAMILY_OWNER,
    // The comparison narrows the address union to this kind's arm, which is what
    // gives the body a required `entity` of the kinds a diff is opened over. It is a
    // literal rather than a captured variable deliberately: a generic helper shared
    // by both registrations would need a cast to narrow, and the cast is the thing
    // the union was minted to remove.
    render: (context) =>
      context.kind === "diff"
        ? createElement(DiffPane, { context })
        : createElement(RefusalCard, misaddressedPaneRefusal("diff", context.kind)),
  });
  registry.register({
    kind: "artifact",
    owner: REPOS_FAMILY_OWNER,
    render: (context) =>
      context.kind === "artifact"
        ? createElement(ArtifactPane, { context })
        : createElement(RefusalCard, misaddressedPaneRefusal("artifact", context.kind)),
  });
}

/**
 * The file half of a rewound run, published for the surface that mounts it.
 *
 * A READ SURFACE OVER A REGISTERED WIRE TYPE, and the door is the whole of what this
 * family owes it. `FileRestoreDisclosure` renders `RollbackInterventionResult` — the
 * reply the `run.intervene` rollback answers with — and its production entry point is
 * the runs pane's intervention history, which is a SIBLING view family's body: a repos
 * module may not import it and a runs module may not deep-import this one, so the seam
 * between them is this export and the runs pane's own composition of it.
 *
 * The `@consumedBy` tag rides the specifier because that is the export the dead-code
 * gate reports, and it names the cross-family task that mounts it. The tag and this
 * comment are deleted together by the PR that imports the symbol — the gate's
 * `--treat-tag-hints-as-errors` run fails on a marker that outlived its consumer.
 */
export {
  /** @consumedBy T-023p-1C-8 — mounted by `panes/runs/InterventionHistory.tsx`. */
  FileRestoreDisclosure,
  /** @consumedBy T-023p-1C-8 — mounted by `panes/runs/InterventionHistory.tsx`. */
  type FileRestoreDisclosureProps,
} from "./FileRestoreDisclosure.js";
