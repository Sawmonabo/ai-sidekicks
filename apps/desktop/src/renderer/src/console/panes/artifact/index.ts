// The artifact pane's door.
//
// Same shape and same reason as `panes/diff/index.ts`: one directory, one barrel, the
// bodies reached only through it. The rows, the pane chrome, and the bounds disclosure
// keep drawing from `repos/repos.css`, which `repos/index.ts` imports; the one sheet
// imported here holds what belongs to this pane and to no panel rendered inside it,
// and it is imported from the barrel rather than from the component, which is where a
// family's CSS is admitted.
//
// The two inline cards ship as their REGISTRATIONS rather than as components, for the
// diff card's reason: the seat is filled by a call, and a family barrel that exported
// the component would invite a sibling to mount it directly — which is the import
// across view families the seats exist to prevent.

import "./artifact.css";

export { ArtifactPane } from "./ArtifactPane.js";

export { registerInlineArtifactCardBody } from "./InlineArtifactCard.js";
export { registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";
