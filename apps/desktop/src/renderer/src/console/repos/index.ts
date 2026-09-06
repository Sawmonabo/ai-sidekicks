// The repos family's door.
//
// The family is `T-023p-1C-5` — repos and worktrees, the diff pane and its inline
// cards, the artifact pane, and attachments — and it occupies ONE directory tree,
// `repos/`, with a sub-module per subject: the sidebar section and its mount cards,
// the two pane bodies in `repos/diff-pane/` and `repos/artifact-pane/`, and the
// artifacts, attachments, proposals and restore modules beside them. The pane bodies
// live HERE and not under `console/panes/`, which holds composition files only: the
// deck's pane registry is keyed by pane kind while the sidebar's registry is keyed by
// section id, and a family that owned bodies in both key spaces would otherwise need
// two doors. This is the one door: everything the family registers is registered here.
//
// THE FAMILY'S SHEETS ARE IMPORTED HERE AND NOWHERE ELSE. One family, one door for
// its stylesheets — the rule every console family obeys — and the family's styling is
// spread over eight files: the root sheet and one per sub-module. This module is what
// both pane barrels are reached through, so every sheet is present whenever any of
// the sub-modules renders, and each lands in the graph once.
//
// WHAT IS HERE AND WHAT IS BELOW. This module imports the family's eight sheets,
// publishes the two registration entry points the console calls, and publishes the
// two cross-family seams at the bottom. The BODIES are all in `family-bodies.ts`,
// whose header says why a door that read the two pane barrels and the sidebar
// registry itself was a barrel chain rather than a consumer of any of them.

import "./repos.css";
// The five subject sheets, in the order their rules held inside `repos.css` before
// that file outgrew a reader. Imported after the root sheet and before the two pane
// sheets, which is the order the rules were in, so nothing about the cascade turns on
// the split. Each is imported HERE for the same reason the pane sheets are: a sheet
// imported from the directory it styles arrives only on the paths that reach that
// directory, and this family is reached through several.
import "./mounts/mounts.css";
import "./proposals/proposals.css";
import "./restore/restore.css";
import "./artifacts/artifacts.css";
import "./attachments/attachments.css";
// The two pane sub-modules' own sheets, imported HERE and not from their barrels, so
// this door stays the family's only stylesheet importer. A CSS `@import` from
// `repos.css` would have kept the file count the same and lost the rules: the
// browser tiers inject a sheet as a `<style>` element, and a relative `@import`
// inside one resolves against the document rather than against the sheet, so the
// rules silently do not arrive and the pane is screenshotted unstyled.
import "./diff-pane/diff.css";
import "./artifact-pane/artifact.css";

import type { ConsolePaneRegistry } from "../seats/index.js";
import {
  REPOS_FAMILY_OWNER,
  registerRepos,
  renderArtifactPaneBody,
  renderDiffPaneBody,
} from "./family-bodies.js";

// The sidebar and card seats, from the module that fills them. `console/families.ts`
// calls this at the family's own reserved line; `family-bodies.ts` says why the calls
// are made there rather than here.
export { registerRepos };

/**
 * Claim the two pane kinds this family builds bodies for.
 *
 * DECLARED HERE rather than re-exported, because `console/panes/index.ts` states the
 * contract in its own words — a family claims its pane kinds "inside that function",
 * the one it publishes from its own `index.ts` — and because that composition site is
 * itself an `index.ts`: a door line whose only production reader is another door has
 * no reader the census can see, and a declaration is not a door line.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for the
 * seat board's reason: a test composes the same bodies into a registry it owns, and
 * an auxiliary window composes a subset without a second code path.
 *
 * NEITHER KIND DECLARES A TEAR-OFF, because a descriptor cannot: whether a pane may
 * be torn off is a property of the KIND, answered once by `isDetachablePaneKind` off
 * the window model's own route set, and never a member a family fills in.
 * `Spec-023 §The surface set` names `timeline` and `agent-console` as the two panes
 * that get their own hardened window, so both of this family's kinds answer that
 * predicate `false` — and they answer it in the one place that decides it rather than
 * in six families' registrations.
 */
export function registerReposPanes(registry: ConsolePaneRegistry): void {
  registry.register({ kind: "diff", owner: REPOS_FAMILY_OWNER, render: renderDiffPaneBody });
  registry.register({
    kind: "artifact",
    owner: REPOS_FAMILY_OWNER,
    render: renderArtifactPaneBody,
  });
}

// The file half of a rewound run, published for the surface that mounts it.
//
// A READ SURFACE OVER A REGISTERED WIRE TYPE, and the door is the whole of what this
// family owes it. `FileRestoreDisclosure` renders `RollbackInterventionResult` — the
// reply the `run.intervene` rollback answers with — and its production entry point is
// the runs pane's intervention history, which is a SIBLING view family's body: a repos
// module may not import it and a runs module may not deep-import this one, so the seam
// between them is this export and the runs pane's own composition of it.
//
// NO DEAD-CODE EXEMPTION TAG, AND THE GATE IS WHY. That marker exempts an export
// NOTHING reaches; this one is reached — the door's own case reads it — so knip reports
// the symbol as used and `--treat-tag-hints-as-errors` fails a marker that suppresses
// nothing. The claim the marker would have carried is stated here instead, in the
// `// Consumed by` form `apps/desktop/AGENTS.md` gives the declaration side of it, and
// it is deleted by the cross-family pass that adds the import.
//
// Consumed by T-023p-1C-3, which builds the runs family and composes its intervention
// history. The consumer is named by TASK rather than by path: a pane body lives in its
// own family's `pane/` directory, and `panes/` is flat composition only, so a path
// written here ahead of that family would name a module `console-panes-hold-no-body`
// forbids and no file on the tree has.
export {
  // Consumed by T-023p-1C-3, the runs pane's intervention history, in the
  // cross-family task that composes it.
  FileRestoreDisclosure,
  // Consumed by T-023p-1C-3, with the component above.
  type FileRestoreDisclosureProps,
} from "./restore/FileRestoreDisclosure.js";

// The ingest trio, published as the binding that owns it rather than as the client.
//
// THE CARRIER AND NOT THE CLIENT, deliberately. `AttachmentIngestClient` is a stream
// with a lifecycle — constructed, subscribed, disposed — and a sibling family handed
// the raw class would own three of those and get one of them wrong; the composer's
// message-scoped attachments and this family's own artifacts section then hold two
// carriers over one session. `useAttachmentCarrier` is that seam done once: it
// constructs the client, publishes the entries with the instant they were published
// at, and gives the daemon back every open spool on unmount.
//
// Consumed by the composer family's attachment affordance, in the cross-family task
// that composes it. No dead-code exemption tag, on `FileRestoreDisclosure`'s reason
// above: the section this door registers already reaches the binding, so the symbol
// is used and a marker here would suppress nothing.
export {
  useAttachmentCarrier,
  // Consumed by T-023p-1C-3, the composer family's attachment affordance, in the
  // cross-family task that composes it.
  type AttachmentCarrierBinding,
  // Consumed by T-023p-1C-3, with the binding above.
  type AttachmentCarrierSnapshot,
} from "./attachments/attachment-carrier.js";
