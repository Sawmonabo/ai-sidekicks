// The artifact pane's door.
//
// Same shape and same reason as `panes/diff/index.ts`: one directory, one barrel, the
// bodies reached only through it, and no stylesheet — the family's single sheet is
// imported from `repos/index.ts`, the module that composes both panes.
//
// The two inline cards ship as their REGISTRATIONS rather than as components, for the
// diff card's reason: the seat is filled by a call, and a family barrel that exported
// the component would invite a sibling to mount it directly — which is the import
// across view families the seats exist to prevent.

export { ArtifactPane } from "./ArtifactPane.js";

export { registerInlineArtifactCardBody } from "./InlineArtifactCard.js";
export { registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";
