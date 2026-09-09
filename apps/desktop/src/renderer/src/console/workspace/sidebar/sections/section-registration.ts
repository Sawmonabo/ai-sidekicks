// Where this family's sidebar sections are filled, and nothing else.
//
// ONE BODY, NOT EIGHT. `seats/slots/sidebar-sections.ts` carries all eight sections the
// spec names and splits them across three families: `channels`, `agents`, and
// `members` are the collaboration family's, `repos` and `artifacts` the repos
// family's, and `goal`, `runs`, and `approvals` this one's. Each registers its
// own through the same seat — which is the whole reason the seat exists, because
// eight bodies edited into one component would be seven merge conflicts.
//
// ALL THREE HAVE A BODY HERE. `runs` and `approvals` are the sidebar's own
// independently loaded reads — the seat's own header states why the approvals PANE was
// never a substitute for the section, the pane being a whole surface a person navigates
// to and the section being what this session is waiting on — and `goal` is a READING
// under its own density rule: one line showing the goal clamped to a measure, with the
// editor opening in place on the surface that owns it, which is what stops one session
// having two editors over a contract that admits one in-flight change.
//
// `goal` carries neither a rollup nor an attention claim, and that is a third
// disposition rather than an omission: one line has nothing to fold and reports no
// urgency of its own. The two that do carry a rollup carry only that, because the seat
// takes an explicit `attention` as a section's own claim and the fold over its `rollup`
// as the fallback, so a descriptor carrying both would answer one question twice.
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
import { ApprovalsSection, approvalsSectionRollup } from "./ApprovalsSection.js";
import { GoalSection } from "./GoalSection.js";
import { RunsSection, runsSectionRollup } from "./RunsSection.js";

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
    // The rollup the sidebar reads while this section is COLLAPSED, which is when
    // the rule that opens it has to decide. Seated here beside the body rather than
    // reached for from the sidebar, so one registration carries both halves of what
    // this family owns about its section.
    //
    // THE TREE AND NOT ALSO AN `attention` CLAIM. The seat takes an explicit level as
    // the section's own answer and the fold as its fallback, so a section that supplied
    // both would be answering one question twice — and the two would disagree the first
    // time either was edited alone. The fold over these nodes reaches the same level,
    // and the tree carries the grouped counts a single level cannot.
    rollup: runsSectionRollup,
  },
  {
    id: "approvals",
    owner: "composer-family",
    render: (context) => createElement(ApprovalsSection, context),
    // Its rollup, seated beside its body for the reason the runs row gives: one
    // registration carries both halves of what this family owns about its section,
    // the sidebar reads it while the section is COLLAPSED, which is when the rule that
    // opens it has to decide, and it is the tree rather than also an explicit level.
    rollup: approvalsSectionRollup,
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
