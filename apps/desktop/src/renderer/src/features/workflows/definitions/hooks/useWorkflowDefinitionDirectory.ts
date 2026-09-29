// The definitions a context can see, as a surface can honestly know them.
//
// The paging hook for the definitions list, so a reader can tell a console that asked
// and found none from one that never asked. The call that enumerates is the caller's,
// and a rejected call reaches whoever supplied it.
//
// THE READ IS SESSION-SCOPED, AND THAT IS THE WIRE'S RULE RATHER THAN A CHOICE.
// The enumeration's request carries a required session id — resolution walks
// `session` then `project` then `shared` FROM somewhere, and the somewhere is a
// session. So a caller with no session has not got a narrower answer; it has no
// question to put, which is what `unasked` is. Rendering that as an empty list
// would be the console asserting that this context sees no definitions, which is a
// claim about the daemon nothing established.
//
// ONE READ PER MOUNT, AND NO POLLING, for `seats/session-directory.ts`'s reason:
// a directory that refreshed itself on a timer is a second source of truth running
// beside the event stream, and the cheapest way to hold two answers to one question
// is to keep asking it. A navigation back to the surface remounts and re-reads,
// which is the moment a person expects a fresh list.
//
// THE THREE STATES ARE THREE FACTS AND NO OTHERS — nobody could ask, a read is in
// flight, and an answer came back (possibly with no rows, which is a real answer).
// Collapsing any two is the conflation the five kinds of nothing exist to prevent.
//
// THE CURSOR IS KEPT, AND FOLLOWED ONLY WHEN A PERSON ASKS. The reply's
// `nextCursor` is the enumeration's own continuation token, and dropping it made
// every definition past the daemon's first-page limit unreachable — not slow to
// reach, unreachable, with nothing on screen saying so. Draining it on mount is the
// opposite mistake: an unbounded loop of reads for a list nobody has scrolled, on a
// wire whose page size no console controls. So the cursor is held and the hook
// hands its caller a control; the caller renders it while a cursor exists and not
// otherwise, which is the "absent, not disabled" rule.
//
// A CONTINUATION IS ITS OWN STATE, BESIDE THE PAGES AND NOT INSTEAD OF THEM. A
// second page that is in flight changes nothing about the rows already on screen:
// those were served and are still true. So the served arm carries a continuation with
// its own three facts — there is no more, there is more and you may ask, the asking is
// in flight — and the pages survive all three.

import { useCallback } from "react";

import type { WorkflowDefinitionSummary } from "@renderer/services/wire-shapes/workflow-projection.js";
import { subjectReadStart, type SubjectRead } from "../../subject-read-start.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";
import type { WorkflowDefinitionRow } from "../definition-rows.js";

/**
 * The call that enumerates the definitions visible from a session, a page at a time.
 *
 * Pass a stable function: a new identity re-reads.
 */
export type WorkflowDefinitionListCall = (request: {
  readonly sessionId: string;
  readonly cursor?: string;
}) => Promise<WorkflowDefinitionPage>;

/**
 * What lies beyond the pages held, and whether it can be asked for.
 *
 * Three facts and no others: the daemon said this was the last page, it said there is
 * more and here is the handle, or that handle is in flight. A boolean would conflate
 * the last two, and each of them is a different thing for a surface to draw — nothing,
 * a control, a wait.
 */
export type WorkflowDefinitionContinuation =
  | { readonly status: "exhausted" }
  | { readonly status: "available"; readonly cursor: string }
  | { readonly status: "reading"; readonly cursor: string };

/**
 * What the list knows about the definitions visible from here, at one moment.
 *
 * Three states and no others, and the two unsettled ones come from the shared shape in
 * `features/workflows/subject-read-start.ts` — the rule this hook established and the runs
 * directory and the run snapshot now hold to as well, written once so the three
 * cannot drift about which frame is allowed to claim nobody asked, or about which
 * frame is allowed to hold the previous call's answer.
 */
export type WorkflowDefinitionDirectoryState = SubjectRead<SettledDefinitionDirectory>;

/** The directory a caller renders, and the one thing it can ask for. */
export interface WorkflowDefinitionDirectory {
  readonly state: WorkflowDefinitionDirectoryState;
  /**
   * Ask the daemon for the page after the ones held.
   *
   * Does nothing at all unless a cursor is in hand and no continuation is already in
   * flight, so a caller may wire it to a control without also encoding the rule for
   * when the control exists — which would be the same decision made twice.
   */
  readonly continueReading: () => void;
}

/**
 * Read the definitions visible from one session, one page at a time.
 *
 * The effect is keyed on the call and the session id: the call is stable for the life
 * of a window, so a re-render never re-reads, while a different call and a move to a
 * different session both do.
 */
export function useWorkflowDefinitionDirectory(
  listDefinitions: WorkflowDefinitionListCall,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory {
  // The state is held against the CALL AND THE SESSION it is about, and the
  // disagreement is settled DURING the render that brings a new pair rather than in an
  // effect after the commit. An effect would commit one render of `unasked` under a
  // session the caller had already asked about, which paints as a served-looking empty
  // list and reads to assistive technology as an answer.
  //
  // THE PUBLISHER IS THE READ'S OWN GUARD, which is why this hook counts nothing and
  // why the continuation below can publish through the same handle: a page that comes
  // back after the session changed belongs to a list nobody is looking at, and
  // `publish` carries the addressing it was captured under, so exactly those answers
  // write nowhere.
  const { value: state, publish } = useSubjectRead<
    WorkflowDefinitionPage,
    WorkflowDefinitionDirectoryState
  >(
    listDefinitions,
    sessionId,
    (subject) => (subject === undefined ? undefined : listDefinitions({ sessionId: subject })),
    { unsettled: subjectReadStart, settled: firstPageState },
  );

  const continueReading = useCallback(() => {
    if (sessionId === undefined || state.status !== "served") {
      return;
    }
    const cursor = askableCursorOf(state.continuation);
    if (cursor === undefined) {
      return;
    }
    publish({ ...state, continuation: { status: "reading", cursor } });
    void listDefinitions({ sessionId, cursor }).then((page) => {
      // Folded over whatever is current rather than over the state this call closed
      // on, so a page cannot resurrect a list that has since been replaced.
      publish((current) => appendedPageState(current, cursor, page));
    });
  }, [listDefinitions, sessionId, publish, state]);

  return { state, continueReading };
}

/** One page of the enumeration, as the call answers it. */
interface WorkflowDefinitionPage {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly nextCursor?: string;
}

/** What this read looks like once its first page has an answer. */
interface SettledDefinitionDirectory {
  readonly status: "served";
  readonly definitions: readonly WorkflowDefinitionRow[];
  readonly continuation: WorkflowDefinitionContinuation;
}

/**
 * The cursor a continuation can be asked with, if any.
 *
 * Only `available` carries one to ask with. `reading` withholds it so a second request
 * is not put for a page already in flight, and `exhausted` has none.
 */
function askableCursorOf(continuation: WorkflowDefinitionContinuation): string | undefined {
  return continuation.status === "available" ? continuation.cursor : undefined;
}

/** What the daemon's `nextCursor` says about the pages after this one. */
function continuationFor(nextCursor: string | undefined): WorkflowDefinitionContinuation {
  return nextCursor === undefined
    ? { status: "exhausted" }
    : { status: "available", cursor: nextCursor };
}

/** The directory, given the first page. */
function firstPageState(page: WorkflowDefinitionPage): WorkflowDefinitionDirectoryState {
  return {
    status: "served",
    definitions: page.definitions,
    continuation: continuationFor(page.nextCursor),
  };
}

/**
 * The directory, given a continuation's settlement folded onto what is on screen.
 *
 * Pure, and total over a state that has moved on: a page whose request is no longer
 * the one in flight is dropped rather than appended, because the alternative is a
 * list holding two answers to one question.
 */
function appendedPageState(
  current: WorkflowDefinitionDirectoryState,
  cursor: string,
  page: WorkflowDefinitionPage,
): WorkflowDefinitionDirectoryState {
  if (
    current.status !== "served" ||
    current.continuation.status !== "reading" ||
    current.continuation.cursor !== cursor
  ) {
    return current;
  }
  return {
    status: "served",
    definitions: withUnseenDefinitions(current.definitions, page.definitions),
    continuation: continuationFor(page.nextCursor),
  };
}

/**
 * The held rows plus the arriving ones this list has not seen, in arrival order.
 *
 * Keyed on the definition id because the wire's paging guarantees no disjointness a
 * console may rely on — a definition authored between two page reads shifts the
 * window, and the same row arriving twice would render twice and give React two
 * children with one key. Dropping the duplicate rather than replacing it keeps the
 * first page's position stable under the reader's eye.
 */
function withUnseenDefinitions(
  held: readonly WorkflowDefinitionRow[],
  arriving: readonly WorkflowDefinitionRow[],
): readonly WorkflowDefinitionRow[] {
  const heldIds = new Set(held.map((definition) => definition.id));
  const unseen = arriving.filter((definition) => !heldIds.has(definition.id));
  return unseen.length === 0 ? held : [...held, ...unseen];
}
