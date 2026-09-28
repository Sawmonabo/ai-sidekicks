// The artifact pane's door: one directory, one barrel, and only the two inline-card
// registrations on it.
//
// The directory's other modules are not on it, because nothing outside the directory uses
// them. `repos/family-bodies.ts` imports this barrel statically.
//
// The sheet enters here because this directory owns it, so it is present whenever the
// family door is.
//
// The two inline cards ship as registrations rather than components, because the seat is
// filled by a call, and a barrel that exported the component would invite a sibling to
// mount it directly across view families.

import "./artifact.css";

export { registerInlineArtifactCardBody } from "./InlineArtifactCard.js";
export { registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";
