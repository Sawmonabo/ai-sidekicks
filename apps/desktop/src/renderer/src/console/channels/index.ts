// The channels subtree's door.
//
// Channels — the sidebar section this subtree fills — plus the two stylesheets it
// renders through, imported here and nowhere else so a section can never reach a
// screen without them and the bundler sees one edge into each sheet. The channels
// sub-family carries its own sheets; `sections.css` holds the shell the section
// takes and the live line the family draws itself.
//
// WHAT IS NOT HERE
//
// The family's composition. Three sibling view families carry this family's other
// subtrees, and naming them is what `console/session-surfaces-family.ts` is for: a view
// family may import no other view family, and the console's composition sites are
// the files the layering gate subtracts from that rule. This door names only its own
// subtree, which is what makes it a door rather than a second composition site.

import "./sections.css";
import "./channels.css";
import "./create-channel.css";

export { registerChannelsSections } from "./sections.js";
