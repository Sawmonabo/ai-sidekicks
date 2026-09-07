// The artifact pane's door.
//
// Same shape and same reason as `repos/diff-pane/index.ts`: one directory, one barrel,
// and only the two ledger-card registrations on it. `ArtifactPane` is off the door for
// the reason stated there — its one reader is this directory's own loader-backed body
// module, and a door line would put the pane back on the initial import graph.
//
// THE SHEET ENTERS HERE, and that is the same rule this directory's sibling keeps.
// `apps/desktop/AGENTS.md` keys it on the directory that OWNS a sheet rather than on
// depth, and a directory carrying a door owns itself. The fear that put `artifact.css`
// on the family door instead — that a surface composing the pane through that door
// alone would draw it unstyled — does not survive reading the graph: nothing composes
// this pane from `repos/index.ts`, which reaches the bodies through
// `repos/family-bodies.ts`, and that module imports this barrel statically.
//
// The two inline cards ship as their REGISTRATIONS rather than as components, for the
// diff card's reason: the seat is filled by a call, and a family barrel that exported
// the component would invite a sibling to mount it directly — which is the import
// across view families the seats exist to prevent.

import "./artifact.css";

export { registerInlineArtifactCardBody } from "./InlineArtifactCard.js";
export { registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";
