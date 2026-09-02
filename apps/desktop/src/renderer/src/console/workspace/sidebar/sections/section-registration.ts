// Where this family's sidebar sections are filled, and nothing else.
//
// ONE SECTION, NOT SIX. The sidebar renders six sections and this family owns
// exactly one of them: `runs`. `channels`, `agents`, and `members` are the
// collaboration family's and `repos` and `artifacts` are the repos family's, and
// each registers its own through the same seat — which is the whole reason the
// seat exists, because six bodies edited into one component would be five merge
// conflicts. A section this file does not fill renders the sidebar's own
// "reserved, not stubbed" answer until its owner lands.
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
