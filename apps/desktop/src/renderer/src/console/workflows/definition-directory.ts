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
// ONE READ PER MOUNT, AND NO POLLING, for `frame/session-directory.ts`'s reason:
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

import { useEffect, useState } from "react";

import type { GrowthPort } from "../bridge/index.js";
import type { WorkflowDefinitionRow } from "./DefinitionsBrowser.js";
import { settleGrowthRead, type SettledReadRefusal } from "./read-settlement.js";

/** What the browser knows about the definitions visible from here, at one moment. */
export type WorkflowDefinitionDirectoryState =
  | { readonly status: "unasked" }
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly definitions: readonly WorkflowDefinitionRow[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * Read every definition visible from one session, once, for as long as the caller
 * is mounted.
 *
 * The effect is keyed on the port and the session id: the port is minted once per
 * bridge and is therefore stable for the life of a window, so a re-render never
 * re-reads, while a bridge swapped underneath — the fixture's scenario switch — and
 * a move to a different session both do.
 *
 * The paging cursor is deliberately not followed here. The reply's `nextCursor` is
 * the enumeration's own continuation token and a surface that drained it on mount
 * would turn one read into an unbounded loop against a wire no daemon serves yet;
 * the first page is what this hook reads, and the control that asks for a second is
 * the caller's the day a person can press it.
 */
export function useWorkflowDefinitionDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowDefinitionDirectoryState {
  const [state, setState] = useState<WorkflowDefinitionDirectoryState>({ status: "unasked" });
  useEffect(() => {
    if (sessionId === undefined) {
      // Not `reading`: there is no question to put, and a spinner over an address
      // that names no session would promise an answer that is never coming.
      setState({ status: "unasked" });
      return;
    }
    // Reset rather than leaving the previous session's rows on screen while the new
    // read runs: a stale list under a fresh subject reads as a current one, and
    // nothing about it says otherwise.
    setState({ status: "reading" });
    let isMounted = true;
    void settleGrowthRead(growth.workflowDefinitionList({ sessionId })).then((outcome) => {
      if (!isMounted) {
        // The unmount already happened. Dropping the answer is the point: a
        // `setState` on an unmounted caller is exactly the leak the endurance tier
        // exists to catch, and a directory read outliving its surface by one
        // navigation is the ordinary case rather than the rare one.
        return;
      }
      setState(
        outcome.status === "served"
          ? { status: "served", definitions: outcome.value.definitions }
          : { status: "unavailable", refusal: outcome },
      );
    });
    return () => {
      isMounted = false;
    };
  }, [growth, sessionId]);
  return state;
}
