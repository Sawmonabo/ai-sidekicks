// The artifact pane's door.
//
// Same shape and same reason as `panes/diff/index.ts`: one directory, one barrel, the
// bodies reached only through it.
//
// NO STYLESHEET IS IMPORTED HERE, and that is the same rule this directory's sibling
// keeps. This directory and `panes/diff/` are two of the three directories the repos
// family occupies, and a family's CSS is imported from that family's DOOR — which is
// `repos/index.ts`, not this sub-module barrel. It imports `repos/repos.css`,
// `panes/diff/diff.css`, and this directory's own `artifact.css`, so all three arrive
// together whenever any of the three directories renders. Imported from here instead,
// the sheet arrived only on the paths that reach THIS barrel, so a surface composing
// the pane through the family door alone would draw it unstyled.
//
// The two inline cards ship as their REGISTRATIONS rather than as components, for the
// diff card's reason: the seat is filled by a call, and a family barrel that exported
// the component would invite a sibling to mount it directly — which is the import
// across view families the seats exist to prevent.

export { ArtifactPane } from "./ArtifactPane.js";

export { registerInlineArtifactCardBody } from "./InlineArtifactCard.js";
export { registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";
