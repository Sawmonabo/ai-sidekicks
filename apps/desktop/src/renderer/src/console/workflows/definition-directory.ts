// The definitions a context can see, as a surface can honestly know them.
//
// The definitions browser is the workflows destination's whole subject, and until
// this hook the surface had no way to ask for one: the enumeration is a growth
// operation, the growth port is reached from the bridge, and every caller of the
// browser was passing rows it had built itself. So the browser rendered its own
// empty state in every build, including the fixture one, and a reader could not
// tell a console that had asked and found none from a console that had never asked.
//
// THE READ IS SESSION-SCOPED, AND THAT IS THE WIRE'S RULE RATHER THAN A CHOICE.
// The enumeration's request carries a required session id — resolution walks
// `session` then `project` then `shared` FROM somewhere, and the somewhere is a
// session. So a caller with no session has not got a narrower answer; it has no
// question to put, which is what `unasked` is. Rendering that as an empty list
// would be the console asserting that this context sees no definitions, which is a
// claim about the daemon nothing established.
//
// ONE READ PER MOUNT, AND NO POLLING, for `bridge/session-directory.ts`'s reason:
// a directory that refreshed itself on a timer is a second source of truth running
// beside the event stream, and the cheapest way to hold two answers to one question
// is to keep asking it. A navigation back to the surface remounts and re-reads,
// which is the moment a person expects a fresh list.
//
// THE FOUR STATES ARE FOUR FACTS AND NO OTHERS — nobody could ask, a read is in
// flight, an answer came back (possibly with no rows, which is a real answer), and
// the read refused. Collapsing any two is the conflation the five kinds of nothing
// exist to prevent.
//
// THE READ IS SETTLED RATHER THAN MERELY AWAITED. A growth call can also REJECT — a
// scenario that scripts a daemon refusal throws it verbatim, and the live seam will
// throw the same shape once the wire lands — so a fulfilment handler alone left the
// rejection unhandled and this hook in `reading` for the life of the window.
// `read-settlement.ts` turns every ending into one value; what arrives here is
// therefore an answer or a refusal, and never a promise nobody is waiting on.
//
// THE CURSOR IS KEPT, AND FOLLOWED ONLY WHEN A PERSON ASKS. The reply's
// `nextCursor` is the enumeration's own continuation token, and dropping it made
// every definition past the daemon's first-page limit unreachable — not slow to
// reach, unreachable, with nothing on screen saying so. Draining it on mount is the
// opposite mistake: an unbounded loop of reads for a list nobody has scrolled, on a
// wire whose page size no console controls. So the cursor is held and the hook
// hands its caller a control; the caller renders it while a cursor exists and not
// otherwise, which is the "absent, not disabled" rule the browser already obeys.
//
// AN EMPTY SCOPE IS NOT AN ANSWER UNTIL THE ENUMERATION IS EXHAUSTED. The cursor
// pages the whole resolved union at once, so a first page carrying `nextCursor` and
// no `shared` row says nothing about whether a later page holds one. The browser drew
// that as `No shared definitions` — a definitive claim about the daemon, standing
// while the continuation was in flight and standing again after it was refused. So
// what each group may say about itself is projected HERE, from the continuation the
// same read already carries, and the browser and the groups below it render the arm
// they are handed rather than each deciding the question again from a different half
// of the state.
//
// A CONTINUATION IS ITS OWN STATE, BESIDE THE PAGES AND NOT INSTEAD OF THEM. A
// second page that is in flight, or that the daemon refused, changes nothing about
// the rows already on screen: those were served and are still true. So the served
// arm carries a continuation with its own four facts — there is no more, there is
// more and you may ask, the asking is in flight, the asking was refused — and the
// pages survive all four. Collapsing the refused one into the whole directory's
// `unavailable` arm would withdraw a list the daemon never withdrew.

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { GrowthPort } from "../bridge/index.js";
import { useSubjectStampedRead, type SubjectStampedRead } from "../store/subject-stamped-state.js";
import {
  WORKFLOW_DEFINITION_SCOPES,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionScope,
} from "./DefinitionsBrowser.js";
import { settleGrowthRead, type SettledReadRefusal } from "./read-settlement.js";

/** What one settled page of the enumeration is, derived from the port's own answer. */
type SettledDefinitionPage =
  | Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>
  | SettledReadRefusal;

/**
 * What lies beyond the pages the browser holds, and whether it can be asked for.
 *
 * Four facts and no others, for the same reason the directory's own states are four:
 * the daemon said this was the last page, it said there is more and here is the
 * handle, that handle is in flight, or asking with it was refused. A boolean would
 * conflate the last three, and each of them is a different thing for a surface to
 * draw — nothing, a control, a wait, a refusal beside the control.
 */
export type WorkflowDefinitionContinuation =
  | { readonly status: "exhausted" }
  | { readonly status: "available"; readonly cursor: string }
  | { readonly status: "reading"; readonly cursor: string }
  | {
      readonly status: "unavailable";
      readonly cursor: string;
      readonly refusal: SettledReadRefusal;
    };

/** What this read looks like once its first page has an answer, either kind. */
type SettledDefinitionDirectory =
  | {
      readonly status: "served";
      readonly definitions: readonly WorkflowDefinitionRow[];
      readonly continuation: WorkflowDefinitionContinuation;
    }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What the browser knows about the definitions visible from here, at one moment.
 *
 * Four states and no others, and the two unsettled ones come from the shared shape in
 * `store/subject-stamped-state.ts` — the rule this hook established and the runs
 * directory and the run snapshot now hold to as well, written once so the three
 * cannot drift about which frame is allowed to claim nobody asked, or about which
 * frame is allowed to hold the previous bridge's answer.
 */
export type WorkflowDefinitionDirectoryState = SubjectStampedRead<SettledDefinitionDirectory>;

/**
 * What the pages read so far let each scope group say about itself.
 *
 * TWO FACTS AND NOT ONE, because they answer different questions and a group renders a
 * different absence for each. `pendingScopes` is which scopes are waiting on a page —
 * one read serves all three, so a wait genuinely belongs to every one of them.
 * `hasUnreadPages` is whether the enumeration is finished, which is what decides
 * whether an empty group may say so: a group with no rows and pages still unread has a
 * prefix rather than an answer, and `No <scope> definitions` under it is the console
 * asserting a result the daemon never gave.
 *
 * A refused continuation lands on the same `hasUnreadPages` as an unfollowed cursor,
 * and that is deliberate: the daemon's own sentence is rendered ONCE, under the groups,
 * beside the control that retries it. Repeating it inside each empty group would turn
 * one refused page into three refusals about three scopes — the mistake the whole-read
 * refusal already avoids by not distributing.
 */
export interface WorkflowDefinitionScopeResolution {
  /** Scopes whose page is in flight. Absent where nothing is being waited on. */
  readonly pendingScopes: readonly WorkflowDefinitionScope[] | undefined;
  /** True while the enumeration holds pages nobody has read. */
  readonly hasUnreadPages: boolean;
}

/** The directory a caller renders, and the one thing it can ask for. */
export interface WorkflowDefinitionDirectory {
  readonly state: WorkflowDefinitionDirectoryState;
  /** What the groups may claim, projected from the state rather than re-derived. */
  readonly scopeResolution: WorkflowDefinitionScopeResolution;
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
 * The effect is keyed on the port and the session id: the port is minted once per
 * bridge and is therefore stable for the life of a window, so a re-render never
 * re-reads, while a bridge swapped underneath — the fixture's scenario switch — and
 * a move to a different session both do.
 */
export function useWorkflowDefinitionDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory {
  // The state is stamped with the PORT AND THE SESSION it is about, and the
  // disagreement is settled DURING the render that brings a new pair rather than in the
  // effect below — which runs after the commit, so a hook that only reset there had one
  // committed render per subject in which `unasked` was true of a session the caller had
  // already asked about. The browser paints `unasked` as three served-looking empty
  // groups, so every scoped load flashed "No session definitions" and exposed that claim
  // to assistive technology before the request had answered. The port is half of the
  // stamp for the mirror-image reason: the fixture's scenario switch replaces the bridge
  // and keeps the session id, so a subject-only stamp committed the previous scenario's
  // definitions under the new one before the effect could reset them.
  const [state, setState] = useSubjectStampedRead<SettledDefinitionDirectory>(growth, sessionId);
  // Which read the state on screen belongs to. A page that comes back after the
  // subject changed — or after the surface went away — belongs to a list nobody is
  // looking at, and splicing it into the current one would show a session's
  // definitions under another session's name. A counter rather than a boolean
  // because the SAME hook serves the first read and every continuation after it.
  const readGeneration = useRef(0);

  useEffect(() => {
    readGeneration.current += 1;
    const generation = readGeneration.current;
    if (sessionId === undefined) {
      // Nothing to reset: the stamp already put this read at `unasked` during the
      // render that dropped the session, and there is no question to put — a spinner
      // over an address that names no session promises an answer never coming.
      return;
    }
    // No reset here. The stamp above covers a port swapped under an unchanged session
    // as well as a session change, and it covers it during the render rather than one
    // commit later — a reset stated again in this effect would be the same rule in two
    // places, agreeing until one of them moved.
    void settleGrowthRead(growth.workflowDefinitionList({ sessionId })).then((outcome) => {
      if (readGeneration.current !== generation) {
        // The unmount or the subject change already happened. Dropping the answer is
        // the point: a `setState` on an unmounted caller is exactly the leak the
        // endurance tier exists to catch, and a directory read outliving its surface
        // by one navigation is the ordinary case rather than the rare one.
        return;
      }
      setState(firstPageState(outcome));
    });
    return () => {
      readGeneration.current += 1;
    };
    // `setState` is the stamped read's own setter and is stable for the life of the
    // hook; it is named so the dependency list is the whole of what this effect uses.
  }, [growth, sessionId, setState]);

  const continueReading = useCallback(() => {
    if (sessionId === undefined || state.status !== "served") {
      return;
    }
    const cursor = askableCursorOf(state.continuation);
    if (cursor === undefined) {
      return;
    }
    const generation = readGeneration.current;
    setState({ ...state, continuation: { status: "reading", cursor } });
    void settleGrowthRead(growth.workflowDefinitionList({ sessionId, cursor })).then((outcome) => {
      if (readGeneration.current !== generation) {
        return;
      }
      // Folded over whatever is current rather than over the state this call closed
      // on, so a page cannot resurrect a list that has since been replaced.
      setState((current) => appendedPageState(current, cursor, outcome));
    });
  }, [growth, sessionId, setState, state]);

  // Memoized on the read state alone: the projection is a pure function of it, and the
  // pending tuple is the module constant rather than a fresh array, so the groups are
  // handed one stable identity across every render that changed nothing.
  const scopeResolution = useMemo(() => scopeResolutionOf(state), [state]);

  return { state, scopeResolution, continueReading };
}

/**
 * What each scope group may claim, given one read state.
 *
 * Exported beside the hook because it is the whole of the rule and a case that drove it
 * through a rendered surface would be asserting the rule and the rendering at once.
 *
 * `unasked` resolves to a definitive empty on purpose: nothing was asked, so there are
 * no unread pages, and the browser's three named groups on a bare rail address are the
 * design's own empty state rather than a claim about a read.
 */
export function scopeResolutionOf(
  state: WorkflowDefinitionDirectoryState,
): WorkflowDefinitionScopeResolution {
  if (state.status === "reading") {
    return { pendingScopes: WORKFLOW_DEFINITION_SCOPES, hasUnreadPages: true };
  }
  if (state.status !== "served") {
    return { pendingScopes: undefined, hasUnreadPages: false };
  }
  if (state.continuation.status === "reading") {
    return { pendingScopes: WORKFLOW_DEFINITION_SCOPES, hasUnreadPages: true };
  }
  return {
    pendingScopes: undefined,
    hasUnreadPages: state.continuation.status !== "exhausted",
  };
}

/**
 * The cursor a continuation can be asked with, if any.
 *
 * `available` and `unavailable` both carry one, and a refused continuation keeps it
 * on purpose: the refusal is an answer about one page rather than about the handle,
 * so the same ask is exactly what a person retries. `reading` withholds it so a
 * second request is not put for a page already in flight, and `exhausted` has none.
 */
function askableCursorOf(continuation: WorkflowDefinitionContinuation): string | undefined {
  return continuation.status === "available" || continuation.status === "unavailable"
    ? continuation.cursor
    : undefined;
}

/** What the daemon's `nextCursor` says about the pages after this one. */
function continuationFor(nextCursor: string | undefined): WorkflowDefinitionContinuation {
  return nextCursor === undefined
    ? { status: "exhausted" }
    : { status: "available", cursor: nextCursor };
}

/** The directory, given the first page's settlement. */
function firstPageState(outcome: SettledDefinitionPage): WorkflowDefinitionDirectoryState {
  return outcome.status === "served"
    ? {
        status: "served",
        definitions: outcome.value.definitions,
        continuation: continuationFor(outcome.value.nextCursor),
      }
    : { status: "unavailable", refusal: outcome };
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
  outcome: SettledDefinitionPage,
): WorkflowDefinitionDirectoryState {
  if (
    current.status !== "served" ||
    current.continuation.status !== "reading" ||
    current.continuation.cursor !== cursor
  ) {
    return current;
  }
  if (outcome.status !== "served") {
    // The rows already held stay. They were served, they are still true, and a
    // refused NEXT page says nothing about them.
    return { ...current, continuation: { status: "unavailable", cursor, refusal: outcome } };
  }
  return {
    status: "served",
    definitions: withUnseenDefinitions(current.definitions, outcome.value.definitions),
    continuation: continuationFor(outcome.value.nextCursor),
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
