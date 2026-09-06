// The collaboration subtree's door.
//
// Channels, the roster, invites, and members — the sidebar sections this subtree
// fills — plus the four stylesheets they render through, imported here and nowhere
// else so a section can never reach a screen without them and the bundler sees one
// edge into each sheet. Each sub-family carries its own sheet; `collaboration.css`
// holds what two of them share and the live line the family draws itself.
//
// WHAT IS NOT HERE
//
// The family's composition. Three sibling view families carry this family's other
// subtrees, and naming them is what `console/collaboration-family.ts` is for: a view
// family may import no other view family, and the console's composition sites are
// the files the layering gate subtracts from that rule. This door names only its own
// subtree, which is what makes it a door rather than a second composition site.

import "./collaboration.css";
import "./channels/channels.css";
import "./channels/create-channel.css";
import "./invites/invites.css";
import "./members/members.css";

export { registerCollaborationSections } from "./sections.js";
export { registerCollaborationProjectors } from "./members/membership-projector.js";
