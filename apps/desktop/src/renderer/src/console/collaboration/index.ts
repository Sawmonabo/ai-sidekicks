// The collaboration subtree's door.
//
// Channels, the roster, invites, and members — the sidebar sections this subtree
// fills — plus the stylesheet they render through, imported here and nowhere else so
// a section can never reach a screen without it and the bundler sees one edge into
// the sheet.
//
// WHAT IS NOT HERE
//
// The family's composition. Three sibling view families carry this family's other
// subtrees, and naming them is what `console/collaboration-family.ts` is for: a view
// family may import no other view family, and the console's composition sites are
// the files the layering gate subtracts from that rule. This door names only its own
// subtree, which is what makes it a door rather than a second composition site.

import "./collaboration.css";

export { registerCollaborationSections } from "./sections.js";
