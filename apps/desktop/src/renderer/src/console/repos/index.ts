// The repos family's door.
//
// The family is repos and worktrees, the diff pane and its inline cards, the artifacts
// list and attachments, in one directory tree with a sub-module per subject. The diff
// pane body lives here and not under `console/panes/`, which holds composition files
// only. Everything the family registers is registered from this module.
//
// THE SHEETS THIS DIRECTORY OWNS ARE IMPORTED HERE. `apps/desktop/AGENTS.md` keys that
// rule on the directory that owns a sheet: a sub-directory without a barrel of its own
// is owned by this one however deep it sits, and a sub-directory with a door owns
// itself. `diff.css` and `artifact.css` enter through their sub-modules' barrels.
//
// The bodies are in `family-bodies.ts`, so this module reads no pane barrel and no
// sidebar registry itself.

import "@renderer/features/repos/repos.css";
// The subject sheets, in the order their rules held inside `repos.css` before that
// file outgrew a reader. Imported after the root sheet, which is the order the rules
// were in, so nothing about the cascade turns on the split. Each is imported HERE
// because none of these directories carries a barrel: they are owned by this one, and
// a sheet enters through its owner's door. `restore/` used to be one of them and is
// not any more: its sheet moved down to `console/primitives/restore/` with the
// component it dresses, for the reason the seam note at the bottom of this file gives.
//
// The pane sheets are NOT here. `repos/diff-pane/` and `repos/artifact-pane/` each
// carry a door, so each owns its own sheet and imports it there. A CSS `@import` from
// `repos.css` is no alternative: the browser tiers inject a sheet as a `<style>` element
// and a relative `@import` inside one resolves against the document, so the rules never
// arrive.
import "@renderer/features/repos/mounts/components/mounts.css";
// The two surfaces that left `mounts.css` on the seam between their subjects and its
// own, directly after it and ahead of the act sheets, so the four below keep their order.
// Siblings rather than residents of `bind/` and `roots/` because ownership follows the
// components: all four of the ones they dress live in `mounts/` itself. Each header
// says so, and says why the cascade cannot turn on the move.
import "@renderer/features/repos/mounts/components/execution-mode-picker.css";
import "@renderer/features/repos/mounts/components/execution-root-cards.css";
// The mount surfaces' own four sheets, after the sheet they were split out of and in
// the order their rules held inside it — the shape the act surfaces share, then the
// three sub-directories that override it. `mounts/mount-acts.css` says why a shape
// spanning three sibling directories is owned by the parent they share rather than by
// whichever of them declared it first, and each sub-sheet's header says what only that
// surface wears. The cascade is the split's whole risk and this order is the whole
// answer to it: an excluded mode's `cursor` still lands after the row shape it
// overrides.
import "@renderer/features/repos/mounts/mount-controls.css";
import "@renderer/features/repos/mounts/attach/attach.css";
import "@renderer/features/repos/mounts/execution-roots/execution-roots.css";
import "@renderer/features/repos/mounts/bind/bind.css";
import "@renderer/features/inspector/artifacts/components/artifacts.css";
import "@renderer/features/composer/attachments/components/attachments.css";

import type { ConsolePaneRegistry } from "../seats/index.js";
import {
  REPOS_FAMILY_OWNER,
  registerRepos,
} from "@renderer/features/repos/contributions/inline-cards.js";

// The sidebar and card seats, from the module that fills them. `console/families.ts`
// calls this at the family's own reserved line; `family-bodies.ts` says why the calls
// are made there rather than here.
export { registerRepos };

/**
 * Claim the pane kind this family builds a body for.
 *
 * Takes the registry rather than reaching for the module-scope singleton, so a test
 * composes the same body into a registry it owns and an auxiliary window composes a
 * subset without a second code path.
 *
 * The kind declares no tear-off: whether a pane may be torn off is a property of the
 * kind, answered once by `isDetachablePaneKind`, and never a member a family fills in.
 */
export function registerReposPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "diff",
    owner: REPOS_FAMILY_OWNER,
    // Loader-backed: the pane is not on the first paint, and it reaches the diff
    // parser and the virtualized row renderer, the largest block this family would put
    // on the initial import graph.
    body: () => import("@renderer/features/repos/contributions/diff-pane-body.js"),
  });
}

// The attachment carrier, published as the binding that owns it rather than as the client.
//
// THE CARRIER AND NOT THE CLIENT, deliberately. `AttachmentIngestClient` is a stream
// with a lifecycle — constructed, subscribed, disposed — and the composer handed the
// raw class would own three of those and get one of them wrong. `useAttachmentCarrier`
// is that seam done once: it constructs the client, publishes the entries with the
// instant they were published at, and gives the daemon back every open spool on
// unmount.
//
// Consumed by the composer's attachment affordance.
export {
  useAttachmentCarrier,
  type AttachmentCarrierBinding,
} from "./attachments/attachment-carrier.js";

// WHAT THE COMPOSER'S AFFORDANCE TAKES BESIDE THE BINDING, and why each of these and
// nothing more. The composer renders attachment CHIPS — one line each, at the density
// the send bar has room for — where this family renders cards, so the COMPONENT is not
// shared and every one of these is a READING or a SENTENCE the two surfaces must not
// answer differently: which name an entry goes by and whose it is, which media-type
// readings it has, what cancelling actually does, what each refusal disposition
// recommends, where a carrier stands against the count bound, whether one file is past
// the byte bound, and whether an upload has gone quiet.
export {
  attachmentCarrierFill,
  exceedsAttachmentByteAllowance,
} from "@renderer/features/composer/attachments/attachment-bounds.js";
export {
  INGEST_ABANDON_COPY,
  INGEST_DISPOSITION_COPY,
} from "@renderer/features/composer/attachments/attachment-policy.js";
export { isIngestStalled } from "@renderer/features/composer/attachments/attachment-presentation.js";
export {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  attachmentMediaTypeReadings,
  attachmentNameReading,
} from "@renderer/features/composer/attachments/attachment-provenance.js";
export type { AttachmentIngestEntry } from "@renderer/features/composer/attachments/attachment-shapes.js";
