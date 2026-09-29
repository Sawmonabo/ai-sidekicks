// The runs a session holds, as the runs section can honestly know them.
//
// `RunList` renders snapshots and reads none, so the rows reach it from a caller. This
// hook is that caller's read: the call that enumerates the runs is its argument, and a
// rejected call is not caught here.
//
// THE READ IS SESSION-SCOPED, for `useWorkflowDefinitionDirectory.ts`'s reason and one of its
// own: a run belongs to a session, so a caller with no session in scope has no
// question to put rather than a narrower one. That is `unasked`, and rendering it as
// an empty list would assert that this context holds no runs — a claim about the
// daemon nothing established.
//
// ONE READ PER MOUNT, AND NO POLLING. A directory refreshing itself on a timer is a
// second source of truth beside the event stream, and the cheapest way to hold two
// answers to one question is to keep asking it. Navigating back remounts and
// re-reads, which is the moment a person expects a fresh list.
//
// THE THREE STATES ARE THREE FACTS AND NO OTHERS — nobody could ask, a read is in
// flight, and an answer came back (possibly with no runs, which is a real answer).
// Collapsing any two is the conflation the five kinds of nothing exist to prevent.

// The ENTRY the call answers with, which is the bridge's declaration rather than the
// list projection's. A hook that retyped the answer would be asserting a shape the
// wire never promised, and the projection accepts what the bridge sends because it is
// the reader, not the source. `WorkflowRunListEntry` and not the run READ's snapshot:
// the enumeration carries each run's definition name and that definition's newest
// version id, which is what lets a row read as more than an id and lets the frozen
// pin be an inequality rather than a guess.
import type { WorkflowRunListEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import { subjectReadStart, type SubjectRead } from "../../subject-read-start.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";

/**
 * What the runs section knows about a session's runs at one moment.
 *
 * Three states and no others, and the two unsettled ones come from the shared shape in
 * `features/workflows/subject-read-start.ts` rather than being spelled a third time here — so
 * this hook, the definitions directory and the run snapshot cannot drift about which
 * frame is allowed to claim nobody asked, or about which frame is allowed to hold the
 * previous call's answer.
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
 * Read the runs one session holds, once, for as long as the caller is mounted.
 *
 * Keyed on the call and the session id: a re-render with the same call never re-reads,
 * while a different call and a move to a different session both start the read over.
 *
 * THE STATE IS HELD AGAINST THE CALL AND THE SESSION IT IS ABOUT, so either change is
 * settled during the render that brings it rather than in the effect after the commit.
 * No committed frame shows `unasked` for a session already asked about, or the previous
 * call's or session's rows under the new one.
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
