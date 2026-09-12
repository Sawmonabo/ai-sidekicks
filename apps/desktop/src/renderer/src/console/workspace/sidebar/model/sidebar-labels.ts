// What each section is called, and the attribute a header carries so an act can find it.
//
// Here rather than in either component: the header writes the attribute and the
// sidebar's focus act queries for it, and a second spelling is a focus act that finds
// nothing. The labels sit beside it because the announcement sentence and the
// disclosure both read them, and two tables would be two names for one section.

import { type SidebarSectionId } from "../../../seats/index.js";

/**
 * The DOM attribute a section header carries, so the focus act needs no class name.
 *
 * A `data-` attribute rather than a class: a class is a styling hook a stylesheet may
 * rename, and an act that queried for one would break on a rename no test reads.
 */
export const SECTION_HEADER_ATTRIBUTE = "data-sidebar-section";

/**
 * The label a person reads on each section header.
 *
 * Total over the union by construction, so a section added to the seat's tuple fails
 * to compile here rather than rendering as its own identifier. The order is the
 * seat's and not this table's: the sidebar walks `SIDEBAR_SECTION_IDS`, and a record
 * is unordered.
 */
export const SIDEBAR_SECTION_LABELS: Readonly<Record<SidebarSectionId, string>> = {
  goal: "Goal",
  channels: "Channels",
  runs: "Runs",
  agents: "Agents",
  repos: "Repos and worktrees",
  approvals: "Approvals",
  artifacts: "Artifacts",
};
