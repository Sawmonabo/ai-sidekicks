// Where this family's sidebar sections are filled, and nothing else.
//
// ONE BODY, NOT EIGHT. `seats/sidebar-sections.ts` carries all eight sections the
// spec names and splits them across three families: `channels`, `agents`, and
// `members` are the collaboration family's, `repos` and `artifacts` the repos
// family's, and `goal`, `runs`, and `approvals` this one's. Each registers its
// own through the same seat — which is the whole reason the seat exists, because
// eight bodies edited into one component would be seven merge conflicts.
//
// OF THIS FAMILY'S THREE, ONE HAS A BODY HERE: `runs`. A session's goal and its
// pending approvals are read on this branch through the approvals pane, which is
// a whole surface a person navigates to rather than an independently loaded
// section of the sidebar — the two are not substitutes, and the seat says so. So
// `goal` and `approvals` render the sidebar's own "reserved, not stubbed" answer,
// exactly as an unlanded family's sections do, and seating them is a body this
// list grows rather than a contract anyone has to reopen.
//
// A CALL, NOT A MODULE SIDE EFFECT, for `shell/index.ts`'s reason: registering at
// module top level would fill an owner-scoped seat for anyone who imported this
// file for any reason, and a seat filled by accident is a seat its real owner
// then collides with.

import { createElement } from "react";

import { registerSidebarSection, type SidebarSectionDescriptor } from "../../../seats/index.js";
import { RunsSection } from "./RunsSection.js";

/**
 * The descriptors this family contributes.
 *
 * Module-local: the registration below is the whole of what a caller wants, and
 * an exported descriptor list would be a second way to fill the same seat. The
 * owner string reads as the family rather than as a task id, because it appears
 * in a duplicate-claim refusal and the console's runtime strings carry no
 * governance ids.
 */
const COMPOSER_SIDEBAR_SECTIONS: readonly SidebarSectionDescriptor[] = [
  {
    id: "runs",
    owner: "composer-family",
    // `createElement` rather than JSX: this is a `.ts` module, and the naming
    // rule reserves `.tsx` for a single PascalCase component per file.
    render: (context) => createElement(RunsSection, context),
  },
];

/** Fill this family's sidebar sections in the process-wide registry. */
export function registerComposerSidebarSections(): void {
  for (const descriptor of COMPOSER_SIDEBAR_SECTIONS) {
    registerSidebarSection(descriptor);
  }
}
