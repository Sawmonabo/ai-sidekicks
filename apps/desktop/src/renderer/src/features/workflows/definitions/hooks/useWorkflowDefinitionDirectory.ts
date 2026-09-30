// The definitions visible from one session, paged, so a reader can tell a console that asked and
// found none from one that never asked. The list call is the caller's, and a rejected call reaches
// whoever supplied it. With no session there is no question to put (`unasked`, never an empty
// list). One read per mount, no polling: a timer would be a second source of truth.

import { useCallback } from "react";

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts";
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
 * What lies beyond the pages held: the daemon said this was the last page, said there is more
 * and gave a handle, or that handle is in flight. The cursor is followed only when a person
 * asks, since draining it on mount would be an unbounded read loop over a page size no console
 * controls. Pages already served survive every state.
 */
export type WorkflowDefinitionContinuation =
  | { readonly status: "exhausted" }
  | { readonly status: "available"; readonly cursor: string }
  | { readonly status: "reading"; readonly cursor: string };

/**
 * What the list knows about the definitions visible from here, at one moment. The two unsettled
 * states come from `features/workflows/subject-read-start.ts`, shared with the runs directory
 * and the run snapshot so they cannot drift.
 */
export type WorkflowDefinitionDirectoryState = SubjectRead<SettledDefinitionDirectory>;

/** The directory a caller renders, and the one thing it can ask for. */
export interface WorkflowDefinitionDirectory {
  readonly state: WorkflowDefinitionDirectoryState;
  /**
   * Ask the daemon for the page after the ones held. Does nothing unless a cursor is in hand
   * and no continuation is in flight, so a caller can wire it to a control without encoding
   * that rule.
   */
  readonly continueReading: () => void;
}

/**
 * Read the definitions visible from one session, one page at a time. It re-reads when the
 * call or the session changes; the call is stable for a window's life, so a re-render never
 * re-reads.
 */
export function useWorkflowDefinitionDirectory(
  listDefinitions: WorkflowDefinitionListCall,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory {
  // Settled during the render that brings a new call or session, not in an effect, which would
  // commit an `unasked` frame under a session already asked about. `publish` drops stale answers.
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
      // Folded over the current state, not the closed-over one, so a page cannot resurrect a
      // replaced list.
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
 * The cursor a continuation can be asked with, if any. `reading` withholds it so no second
 * request is put for a page in flight.
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
 * The directory with a continuation's settlement folded onto what is on screen. A page whose
 * request is not the one in flight is dropped, so the list never holds two answers to one
 * question.
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
 * Keyed on id because paging guarantees no disjointness: a definition authored between page
 * reads shifts the window, and a repeated row would give React two children with one key. The
 * duplicate is dropped so the first page's position stays stable.
 */
function withUnseenDefinitions(
  held: readonly WorkflowDefinitionRow[],
  arriving: readonly WorkflowDefinitionRow[],
): readonly WorkflowDefinitionRow[] {
  const heldIds = new Set(held.map((definition) => definition.id));
  const unseen = arriving.filter((definition) => !heldIds.has(definition.id));
  return unseen.length === 0 ? held : [...held, ...unseen];
}
