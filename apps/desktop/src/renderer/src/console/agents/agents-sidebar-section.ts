// This family's one sidebar section, and the call that seats it.
//
// A CALL AND NOT A MODULE SIDE EFFECT, for the reason every registrar in this console
// gives: registering at module top level would fill an owner-scoped seat for anyone who
// imported this file for any reason, and a seat filled by accident is a seat its real
// owner then collides with.
//
// THE BOARD IS A PARAMETER, never the module-scope registry beside the contract. A
// family reaching for the process-wide board writes into the running console whatever
// its caller assembled, so an independent composition would mutate it, two compositions
// would leak sections into each other, and an auxiliary window could not compose a
// subset however it asked.
//
// NO `attention` READER, and the absence is a claim rather than an omission. The
// descriptor's reader is a PULL performed while the section is COLLAPSED, over state
// the family already holds — and this family holds nothing then: the roster lives in
// the section's own reader, which exists only while the section is mounted. Answering
// from a read that has not happened would be the badge the sidebar refuses to
// synthesise, and performing one from a rollup reader would put a wire call inside the
// sidebar's render. So the section reports nothing until a person opens it.

import { createElement } from "react";

import { type SidebarSectionRegistry } from "../seats/index.js";
import { AgentsSection } from "./AgentsSection.js";

/** The owner string a duplicate-claim refusal names. It reads as the family, never as a task id. */
const AGENTS_SECTION_OWNER = "agents-family";

/** Fill the sidebar's `agents` section on the board a composition hands this family. */
export function registerAgentsSidebarSection(sections: SidebarSectionRegistry): void {
  sections.register({
    id: "agents",
    owner: AGENTS_SECTION_OWNER,
    render: (context) => createElement(AgentsSection, { context }),
  });
}
