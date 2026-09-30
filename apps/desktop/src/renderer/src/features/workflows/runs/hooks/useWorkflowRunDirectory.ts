// The runs a session holds, as the runs section can honestly know them. Session-scoped: with no
// session in scope the state is `unasked`, never an empty list, which would claim the daemon holds
// no runs. One read per mount, no polling: a timer would be a second source of truth beside the
// event stream, and navigating back remounts and re-reads. A rejected call is not caught here.

// The entry type is the bridge's declaration, not the projection's: it carries each run's
// definition name and the definition's newest version id, which the row and frozen pin need.
import type { WorkflowRunListEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import { subjectReadStart, type SubjectRead } from "../../subject-read-start.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";

/**
 * What the runs section knows about a session's runs at one moment: nobody asked, a read is in
 * flight, or an answer came back. The unsettled two come from `subject-read-start.ts`, shared with
 * the definitions directory and the run snapshot.
 */
export type WorkflowRunDirectoryState = SubjectRead<{
  readonly status: "served";
  readonly runs: readonly WorkflowRunListEntry[];
}>;

/**
 * The call that enumerates the runs a session holds. Pass a stable function: a new
 * identity re-reads.
 */
export type WorkflowRunListCall = (request: {
  readonly sessionId: string;
}) => Promise<{ readonly runs: readonly WorkflowRunListEntry[] }>;

/**
 * Read the runs one session holds, once, for as long as the caller is mounted. Keyed on the call
 * and the session id: a new call or session starts over, settled during the render that brings
 * it, so no committed frame shows the previous call's or session's rows.
 */
export function useWorkflowRunDirectory(
  listRuns: WorkflowRunListCall,
  sessionId: string | undefined,
): WorkflowRunDirectoryState {
  return useSubjectRead<
    { readonly runs: readonly WorkflowRunListEntry[] },
    WorkflowRunDirectoryState
  >(
    listRuns,
    sessionId,
    (subject) => (subject === undefined ? undefined : listRuns({ sessionId: subject })),
    {
      unsettled: subjectReadStart,
      settled: ({ runs }) => ({ status: "served", runs }),
    },
  ).value;
}
