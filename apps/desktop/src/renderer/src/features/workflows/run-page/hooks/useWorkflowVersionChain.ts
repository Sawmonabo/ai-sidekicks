// The versions a parked run may be re-pinned onto, read through `workflow.versionChainRead`
// by the pinned version id alone. Every unserved state settles to the same empty chain, so the
// picker is absent and the resume carries no re-pin; a chain synthesized from the id in hand
// would name a target nobody read. One read per pin, never a poll.

import type { WorkflowVersionChainEntry } from "@ai-sidekicks/contracts";
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
 * A module constant so the identity is stable across renders.
 */
const NO_VERSION_CHAIN: readonly WorkflowVersionChoice[] = [];

/**
 * Read the chain one run's pinned version belongs to, for as long as the caller holds it.
 *
 * Keyed on the call and the pinned version id: a re-render with the same call never re-reads,
 * while a run whose pin moved does. `undefined` where the pane holds no pin, so nothing is asked.
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
      // Both unsettled states are the same empty reading: neither "nobody asked" nor "still
      // coming" offers a chain. What they mean for the run is the run read's to report.
      unsettled: () => NO_VERSION_CHAIN,
      settled: (chain) => choicesFrom(chain.versions, pinnedWorkflowVersionId),
    },
  ).value;
}

/**
 * The picker's options, in the order the read answered them.
 *
 * Nothing is sorted or filtered: the order is the daemon's. The current pin is marked by
 * comparing with the id the read was asked with, not by a wire flag.
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
