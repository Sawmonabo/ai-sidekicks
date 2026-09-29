// The versions a parked run may be re-pinned onto, as the pane can honestly know them.
//
// WHY A SECOND READ AND NOT A MEMBER OF THE FIRST. `workflow.runRead` answers one
// `workflowVersionId` — the pin the run is on — and stops there. No registered read
// takes that id anywhere: `workflow.versionRead` addresses a version by
// `(definitionId, versionNumber)`, which a caller holding one opaque id holds neither
// half of, and the definition enumeration carries only each definition's LATEST. So
// the re-pin picker has no target it could NAME without this read.
//
// AN EMPTY CHAIN IS STILL "NO CHAIN WAS READ", ON EVERY ARM THAT IS NOT SERVED. The
// read is unasked before a snapshot names a pin and in flight after that. Both settle
// to the SAME empty reading, and that is the honest one rather than a collapse: the
// control's contract is that an empty chain means no target can be named, so the
// picker is absent rather than empty and the resume travels with no re-pin.
// Synthesizing a chain from the one id in hand would offer the operator a target
// nobody read, which is the "no server-resolved latest" rule with the server swapped
// out for the renderer.
//
// ONE READ PER PIN, AND NO POLLING. The subject is the version id itself, so the read
// is put once for as long as the run stays on the pin it was read for and again when a
// served resume moves it — which is the run read's own re-arm reaching this one
// through the value it answers with, and not a cadence this module arms.

import type { WorkflowVersionChainEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";
import type { WorkflowVersionChoice } from "../run-controls.js";

/**
 * The call that reads the chain one pinned version belongs to. Pass a stable function: a
 * new identity re-reads.
 */
export type WorkflowVersionChainReadCall = (request: {
  readonly workflowVersionId: string;
}) => Promise<{ readonly versions: readonly WorkflowVersionChainEntry[] }>;

/**
 * The reading every unserved state settles to.
 *
 * A module constant rather than a fresh literal per state, so the identity a caller
 * holds is stable across renders — the picker's absence must not be a new array every
 * frame.
 */
const NO_VERSION_CHAIN: readonly WorkflowVersionChoice[] = [];

/**
 * Read the chain one run's pinned version belongs to, for as long as the caller holds
 * that pin.
 *
 * Keyed on the call and the pinned version id, exactly as the run read is keyed on its
 * call and the run: a re-render with the same call never re-reads, while a run whose pin
 * moved does.
 *
 * `undefined` where the pane holds no pin: the request carries a required version id,
 * so a pane whose snapshot has not been served has nothing to ask.
 */
export function useWorkflowVersionChain(
  readChain: WorkflowVersionChainReadCall,
  pinnedWorkflowVersionId: string | undefined,
): readonly WorkflowVersionChoice[] {
  return useSubjectRead<
    { readonly versions: readonly WorkflowVersionChainEntry[] },
    readonly WorkflowVersionChoice[]
  >(
    readChain,
    pinnedWorkflowVersionId,
    () =>
      pinnedWorkflowVersionId === undefined
        ? undefined
        : readChain({ workflowVersionId: pinnedWorkflowVersionId }),
    {
      // Both unsettled states are the same empty reading, and they are not a
      // conflation: this hook's product is the chain a picker may offer, and neither
      // "nobody asked" nor "the answer is still coming" offers one. What those two
      // states mean for the RUN is the run read's to report.
      unsettled: () => NO_VERSION_CHAIN,
      settled: (chain) => choicesFrom(chain.versions, pinnedWorkflowVersionId),
    },
  ).value;
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
 * what the chokepoint rule in `apps/desktop/AGENTS.md` means by formatting a wire
 * value in one place.
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
