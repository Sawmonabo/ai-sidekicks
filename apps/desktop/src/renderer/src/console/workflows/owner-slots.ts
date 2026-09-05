// The five bodies this family mounts and does not author.
//
// The workflows chrome is routes, headers, deck placement, and the absence and
// refusal shapes. The bodies inside it — the node graph, the run detail, the human
// form, the draft, and the chat start — are Plan-017's, and a body authored here
// would be this repository's console growing a second implementation of a surface
// another plan owns.
//
// So each hole is an `OwnerSlotContract`: WHO authors the body, WHAT this family owes
// it when it arrives, WHERE the fixture shell dies. The seat's own rule is that
// nothing branches on those three members and no surface renders one — they name
// governance work, and this file is where a reader building the body meets them.
//
// A SEAT CARRIES NO BODY, and the absence is the repair of a real defect rather than a
// tidying. Each of these five used to publish `body: undefined` beside its contract,
// and NO MOUNT EVER READ IT: every wrapper composed its own body from its own optional
// prop, so the day somebody filled a seat's `body` the surface would have gone on
// rendering the reserved absence unchanged. A seat with two activation routes, one of
// which does nothing, is worse than a seat with one.
//
// A BODY IS A COMPONENT, NEVER A CALL — the one rule every slot wrapper shares, and
// the reason it is written here rather than five times. React attributes a hook to
// whichever component is RENDERING when the hook runs, so a wrapper that invokes
// `body(mount)` inside its own render puts the body's hooks into the wrapper's hook
// list. Every one of these mounts is conditional — no phase, no run, no session, no
// body — so that list would grow on the render where the branch is first taken, which
// is React's hook-order error and a crash the day a body uses a hook at all. So each
// wrapper CONSTRUCTS an element and lets the mount render it: the body gets its own
// boundary, and a body that is `undefined` is an absence rather than a call skipped.
// The reciprocal obligation is the caller's: the body must be a stable reference,
// because a component composed inline on each render is a new type each time and
// React remounts it, losing whatever state it held.
//
// WHY ONE MODULE RATHER THAN A CONSTANT BESIDE EACH MOUNT. Two of the five are
// mounted by the run pane, two by the builder pane, and one by both — the human
// form opens from a parked phase in the run view and from the phase inspector in
// the builder. Spread across the mounts, the pair that is shared would be written
// twice and would drift the first time either half moved.

import type { OwnerSlotContract } from "../seats/index.js";

/** Shared by all five, so the deletion obligation is stated once. */
const PLAN_017_BODY: Pick<OwnerSlotContract, "owningTask" | "deleteShellIn"> = {
  owningTask: "Plan-017 — the workflow engine's own renderer bodies",
  deleteShellIn: "the Plan-017 task that mounts the body, in the same PR as the mount",
};

/** The node-graph canvas the builder pane frames. */
export const WORKFLOW_GRAPH_SLOT: OwnerSlotContract = {
  ...PLAN_017_BODY,
  mountObligation:
    "the builder pane supplies the pane context and the full pane body area, and reads back nothing; geometry stays client-local and never enters the hashed definition body",
};

/** The run detail — phase sections, retries, outputs — inside the run pane. */
export const WORKFLOW_RUN_DETAIL_SLOT: OwnerSlotContract = {
  ...PLAN_017_BODY,
  mountObligation:
    "the run pane supplies the run snapshot and the scroll chokepoint, and keeps the header and the park banner above it",
};

/** The human phase's form, opened from a parked phase and from the inspector. */
export const WORKFLOW_HUMAN_FORM_SLOT: OwnerSlotContract = {
  ...PLAN_017_BODY,
  mountObligation:
    "both panes supply the phase reference and render the daemon's typed refusal; neither derives whether the form may be submitted",
};

/** The human phase's in-progress draft, which is renderer-local and never durable. */
export const WORKFLOW_DRAFT_SLOT: OwnerSlotContract = {
  ...PLAN_017_BODY,
  mountObligation:
    "the mounting pane supplies the window-lifetime draft store and never the durable one; a draft that survived a restart would be participant content in a durable home",
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
export const WORKFLOW_CHAT_START_SLOT: OwnerSlotContract = {
  ...PLAN_017_BODY,
  mountObligation:
    "every mount supplies the session context and, where it holds one, the resolved definition; each offers the control without deciding whether the caller may start a run",
};
