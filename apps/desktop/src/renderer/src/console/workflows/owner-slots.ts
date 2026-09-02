// The five bodies this family mounts and does not author.
//
// The workflows chrome is routes, headers, deck placement, and the absence and
// refusal shapes. The bodies inside it — the node graph, the run detail, the human
// form, the draft, and the chat start — are Plan-017's, and a body authored here
// would be this repository's console growing a second implementation of a surface
// another plan owns.
//
// So each hole is an `OwnerSlotProps` value: WHO authors the body, WHAT this family
// owes it when it arrives, WHERE the fixture shell dies. The seat's own rule is that
// nothing branches on those three members and no surface renders one — they name
// governance work, and this file is where a reader building the body meets them.
// `body` is `undefined` in every one of them today, which is not a placeholder but
// the literal fact: nobody has filled the slot, so the mount renders its own
// reserved-not-stubbed absence rather than a shape that reads as a broken feature.
//
// WHY ONE MODULE RATHER THAN A CONSTANT BESIDE EACH MOUNT. Two of the five are
// mounted by the run pane, two by the builder pane, and one by both — the human
// form opens from a parked phase in the run view and from the phase inspector in
// the builder. Spread across the mounts, the pair that is shared would be written
// twice and would drift the first time either half moved.

import type { OwnerSlotContract, OwnerSlotProps } from "../workspace/index.js";

/**
 * The body every slot here eventually holds: a rendered React subtree.
 *
 * One alias rather than five identical type arguments. The slots differ in WHAT
 * they hold and not in how it is handed over — every one of them is mounted into a
 * layout this family owns — so the generic parameter carries no information at any
 * of the five sites and repeating it five times invites a sixth that differs by
 * accident.
 */
type WorkflowOwnerSlot = OwnerSlotProps<React.ReactNode>;

/** Shared by all five, so the deletion obligation is stated once. */
const PLAN_017_BODY: Pick<OwnerSlotContract, "owningTask" | "deleteShellIn"> = {
  owningTask: "Plan-017 — the workflow engine's own renderer bodies",
  deleteShellIn: "the Plan-017 task that mounts the body, in the same PR as the mount",
};

/** The node-graph canvas the builder pane frames. */
export const WORKFLOW_GRAPH_SLOT: WorkflowOwnerSlot = {
  contract: {
    ...PLAN_017_BODY,
    mountObligation:
      "the builder pane supplies the pane context and the full pane body area, and reads back nothing; geometry stays client-local and never enters the hashed definition body",
  },
  body: undefined,
};

/** The run detail — phase sections, retries, outputs — inside the run pane. */
export const WORKFLOW_RUN_DETAIL_SLOT: WorkflowOwnerSlot = {
  contract: {
    ...PLAN_017_BODY,
    mountObligation:
      "the run pane supplies the run snapshot and the scroll chokepoint, and keeps the header and the park banner above it",
  },
  body: undefined,
};

/** The human phase's form, opened from a parked phase and from the inspector. */
export const WORKFLOW_HUMAN_FORM_SLOT: WorkflowOwnerSlot = {
  contract: {
    ...PLAN_017_BODY,
    mountObligation:
      "both panes supply the phase reference and render the daemon's typed refusal; neither derives whether the form may be submitted",
  },
  body: undefined,
};

/** The human phase's in-progress draft, which is renderer-local and never durable. */
export const WORKFLOW_DRAFT_SLOT: WorkflowOwnerSlot = {
  contract: {
    ...PLAN_017_BODY,
    mountObligation:
      "the mounting pane supplies the window-lifetime draft store and never the durable one; a draft that survived a restart would be participant content in a durable home",
  },
  body: undefined,
};

/**
 * Starting a run by talking to it, rather than from a definition row.
 *
 * Mounted TWICE, which is why the obligation below names what both mounts owe
 * rather than one of them: the definitions browser offers it beneath the scope
 * groups, where a person who has just read the list may start one by describing it,
 * and the run pane offers it on its no-run arm, where a pane opened from a
 * keybinding has nothing to show and starting one is the move. The two differ in
 * what they can supply — the browser holds a resolved definition and the empty run
 * pane holds only the session — so the obligation is stated as the floor both meet.
 */
export const WORKFLOW_CHAT_START_SLOT: WorkflowOwnerSlot = {
  contract: {
    ...PLAN_017_BODY,
    mountObligation:
      "every mount supplies the session context and, where it holds one, the resolved definition; each offers the control without deciding whether the caller may start a run",
  },
  body: undefined,
};
