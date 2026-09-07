// Where this family's sidebar sections are filled, and nothing else.
//
// ONE BODY, NOT EIGHT. `seats/sidebar-sections.ts` carries all eight sections the
// spec names and splits them across three families: `channels`, `agents`, and
// `members` are the collaboration family's, `repos` and `artifacts` the repos
// family's, and `goal`, `runs`, and `approvals` this one's. Each registers its
// own through the same seat — which is the whole reason the seat exists, because
// eight bodies edited into one component would be seven merge conflicts.
//
// OF THIS FAMILY'S THREE, TWO HAVE BODIES HERE: `runs` and `goal`. The goal's own
// density rule puts one line in the session sidebar showing the goal clamped to a
// measure, with the editor opening in place on the surface that owns it — so the
// section is a READING and the approvals pane keeps the two mutations, which is
// what stops one session having two editors over a contract that admits one
// in-flight change. `approvals` still renders the sidebar's own "reserved, not
// stubbed" answer, exactly as an unlanded family's sections do: pending decisions
// are a whole surface a person navigates to rather than an independently loaded
// section, and seating it is a body this list grows rather than a contract anyone
// has to reopen.
//
// A CALL, NOT A MODULE SIDE EFFECT, for `shell/index.ts`'s reason: registering at
// module top level would fill an owner-scoped seat for anyone who imported this
// file for any reason, and a seat filled by accident is a seat its real owner
// then collides with.

import { createElement } from "react";

import {
  type SidebarSectionDescriptor,
  type SidebarSectionRegistry,
} from "../../../seats/index.js";
import { GoalSection } from "./GoalSection.js";
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
  {
    id: "goal",
    owner: "composer-family",
    render: (context) => createElement(GoalSection, context),
  },
];

/**
 * Fill this family's sidebar sections on the board a composition hands it.
 *
 * THE BOARD IS A PARAMETER, never the module-scope registry. `registerConsoleFamilies`
 * takes all five boards so a composition owns what it composes into; a family reaching
 * past that for the process-wide one writes into the running console whatever its
 * caller assembled, which is how two compositions leak registrations into each other
 * and how an auxiliary window loses the ability to compose a subset.
 */
export function registerComposerSidebarSections(registry: SidebarSectionRegistry): void {
  for (const descriptor of COMPOSER_SIDEBAR_SECTIONS) {
    registry.register(descriptor);
  }
}
