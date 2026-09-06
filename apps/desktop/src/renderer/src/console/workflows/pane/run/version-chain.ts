// The versions a parked run may be re-pinned onto, as the pane can honestly know them.
//
// WHY A SECOND READ AND NOT A MEMBER OF THE FIRST. `workflow.runRead` answers one
// `workflowVersionId` — the pin the run is on — and stops there. No registered read
// takes that id anywhere: `workflow.versionRead` addresses a version by
// `(definitionId, versionNumber)`, which a caller holding one opaque id holds neither
// half of, and the definition enumeration carries only each definition's LATEST. So
// the re-pin picker had no target it could NAME, and the pane supplied an empty chain
// with a comment saying why. This hook is that comment turned into a question: the
// chain read is registered on the growth slate, the pane asks it, and what comes back
// is what the picker offers.
//
// AN EMPTY CHAIN IS STILL "NO CHAIN WAS READ", ON EVERY ARM THAT IS NOT SERVED. The
// read is unasked before a snapshot names a pin, in flight after that, and may refuse
// — the port's own refusal under a live bridge whose wire is unregistered, a daemon's
// verbatim refusal under a scripted one, or a rejection at the seam. All four settle
// to the SAME empty reading, and that is the honest one rather than a collapse: the
// control's contract is that an empty chain means no target can be named, so the
// picker is absent rather than empty and the resume travels with no re-pin.
// Synthesising a chain from the one id in hand would offer the operator a target
// nobody read, which is the "no server-resolved latest" rule with the server swapped
// out for the renderer.
//
// AND NOTHING IS ANNOUNCED, WHICH IS THIS PANE'S CONVENTION RATHER THAN AN OMISSION.
// The run read beside it — this pane's whole subject — announces nothing either, and
// the family's announcer is bound at the two destination surfaces whose lists settle
// under a cursor that is somewhere else. Announcing the refusal in particular would
// speak on every pane a release build opens, about a wire the slate already records as
// absent, while the sighted operator beside them is shown nothing at all.
//
// ONE READ PER PIN, AND NO POLLING. The subject is the version id itself, so the read
// is put once for as long as the run stays on the pin it was read for and again when a
// served resume moves it — which is the run read's own re-arm reaching this one
// through the value it answers with, and not a cadence this module arms.

import {
  useSettledGrowthRead,
  type GrowthPort,
  type WorkflowVersionChainEntry,
} from "../../../bridge/index.js";
import { formatCount } from "../../../primitives/index.js";
import type { WorkflowVersionChoice } from "./run-controls.js";

/**
 * The reading every arm but the served one settles to.
 *
 * A module constant rather than a fresh literal per arm, so the identity a caller
 * holds is stable across renders — the picker's absence must not be a new array every
 * frame — and so the four unserved arms are visibly one answer.
 */
const NO_VERSION_CHAIN: readonly WorkflowVersionChoice[] = [];

/**
 * Read the chain one run's pinned version belongs to, for as long as the caller holds
 * that pin.
 *
 * Keyed on the port and the pinned version id, exactly as the run read is keyed on the
 * port and the run: the port is minted once per bridge, so a re-render never re-reads,
 * while a bridge swapped underneath — the fixture's scenario switch — and a run whose
 * pin moved both do.
 *
 * `undefined` where the pane holds no pin: the request carries a required version id,
 * so a pane whose snapshot has not been served has nothing to ask, and the seed rule
 * answers `unasked` rather than putting a read against a fabricated id.
 */
export function useWorkflowVersionChain(
  growth: GrowthPort,
  pinnedWorkflowVersionId: string | undefined,
): readonly WorkflowVersionChoice[] {
  return useSettledGrowthRead<
    Awaited<ReturnType<GrowthPort["workflowVersionChainRead"]>>,
    readonly WorkflowVersionChoice[]
  >(growth, pinnedWorkflowVersionId, () => readChain(growth, pinnedWorkflowVersionId), {
    // Both unsettled states are the same empty reading, and they are not a
    // conflation: this hook's product is the chain a picker may offer, and neither
    // "nobody asked" nor "the answer is still coming" offers one. What those two
    // states mean for the RUN is the run read's to report, and it does.
    unsettled: () => NO_VERSION_CHAIN,
    // A refusal — the port's own under a live bridge, a daemon's under a scripted
    // one, or a rejection at the seam — settles to the same empty reading and is
    // deliberately not rendered: the picker's absence is the whole of what this
    // surface says about it, and a mount that drew a banner would be reporting a
    // wire's absence beside a control the operator can still press.
    settled: (settlement) =>
      settlement.status === "served"
        ? choicesFrom(settlement.value.versions, pinnedWorkflowVersionId)
        : NO_VERSION_CHAIN,
  }).value;
}

/**
 * The chain read, or no question at all.
 *
 * The absence is answered here, where the request is built, on the run read's own
 * rule: this wire's request carries a required version id, so a caller holding none
 * has nothing to ask and says so at the one place that knows the request's shape.
 */
function readChain(
  growth: GrowthPort,
  pinnedWorkflowVersionId: string | undefined,
): ReturnType<GrowthPort["workflowVersionChainRead"]> | undefined {
  return pinnedWorkflowVersionId === undefined
    ? undefined
    : growth.workflowVersionChainRead({ workflowVersionId: pinnedWorkflowVersionId });
}

/**
 * The picker's options, in the order the read answered them.
 *
 * NOTHING IS SORTED AND NOTHING IS FILTERED. The chain's order is the daemon's, and a
 * console that re-ranked it would be deciding which version an operator sees first on
 * evidence the wire did not send. The current pin is marked by COMPARISON rather than
 * read off a member: the caller asked by that very id, so a wire flag would be the
 * reply restating the request.
 *
 * The label is composed here because `WorkflowVersionChoice.label` is the caller's —
 * the version's own ordinal, through the console's one quantity formatter, which is
 * what `apps/desktop/AGENTS.md` §Chokepoints means by formatting a wire value in one
 * place.
 */
function choicesFrom(
  versions: readonly WorkflowVersionChainEntry[],
  pinnedWorkflowVersionId: string | undefined,
): readonly WorkflowVersionChoice[] {
  return versions.map((version) => ({
    workflowVersionId: version.workflowVersionId,
    label: `Version ${formatCount(version.versionNumber)}`,
    isCurrentPin: version.workflowVersionId === pinnedWorkflowVersionId,
  }));
}
