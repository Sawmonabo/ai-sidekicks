// The runs a session holds, as a surface can honestly know them.
//
// `RunList` renders snapshots and reads none: its own header says the registered
// workflow registry has no run enumeration at all, so the rows have always had to
// reach it from a caller. This hook is that caller's read, and it goes through the
// growth port for exactly the reason the header gives — the enumeration is a wire
// nobody has registered, the port is where an unregistered wire is asked for
// honestly, and a live bridge refuses it by name rather than answering with
// something invented.
//
// THE READ IS SESSION-SCOPED, for `definition-directory.ts`'s reason and one of its
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
// THE FOUR STATES ARE FOUR FACTS AND NO OTHERS — nobody could ask, a read is in
// flight, an answer came back (possibly with no runs, which is a real answer), and
// the read refused. Collapsing any two is the conflation the five kinds of nothing
// exist to prevent.
//
// THE READ IS SETTLED RATHER THAN MERELY AWAITED. Two different failures reach this
// hook and both are refusals a person should read: the port's own
// `wire-unregistered` outcome, and a DAEMON refusal, which the scripted-reply seam
// throws verbatim rather than folding into the outcome union — deliberately, so a
// fixture never paraphrases a daemon's `{code, message}` into a growth vocabulary.
// A hook that attached only a fulfilment handler would leave the second one
// unhandled and the surface reading forever. `read-settlement.ts` turns every ending
// into one value, so what arrives here is an answer or a refusal and never a promise
// nobody is waiting on — and the refusal's `origin` is what still says which of the
// two authors raised it.

import { useEffect } from "react";

// The ENTRY the port answers with, which is the bridge's declaration rather than the
// list projection's. A hook that retyped the answer would be asserting a shape the
// wire never promised, and the projection accepts what the bridge sends because it is
// the reader, not the source. `WorkflowRunListEntry` and not the run READ's snapshot:
// the enumeration carries each run's definition name and that definition's newest
// version id, which is what lets a row read as more than an id and lets the frozen
// pin be an inequality rather than a guess.
import type { GrowthPort, WorkflowRunListEntry } from "../bridge/index.js";
import { useSubjectStampedRead, type SubjectStampedRead } from "../store/index.js";
import { settleGrowthRead, type SettledReadRefusal } from "./read-settlement.js";

/** What this read looks like once it has an answer, either kind. */
type SettledRunDirectory =
  | { readonly status: "served"; readonly runs: readonly WorkflowRunListEntry[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What a runs surface knows about the runs this session holds, at one moment.
 *
 * Four states and no others, and the two unsettled ones are the shared shape rather
 * than a third spelling of it: `store/subject-stamped-state.ts` owns what a
 * subject-keyed read starts as, so this hook and the two beside it cannot drift about
 * which frame is allowed to claim nobody asked, or about which frame is allowed to
 * hold the previous bridge's answer.
 */
export type WorkflowRunDirectoryState = SubjectStampedRead<SettledRunDirectory>;

/**
 * Read every run one session holds, once, for as long as the caller is mounted.
 *
 * The effect is keyed on the port and the session id: the port is minted once per
 * bridge and is stable for the life of a window, so a re-render never re-reads,
 * while a bridge swapped underneath — the fixture's scenario switch — and a move to
 * a different session both do.
 *
 * THE STATE IS STAMPED WITH THE PORT AND THE SESSION IT IS ABOUT, so either change is
 * settled during the render that brings it rather than in the effect after the commit.
 * Before that, a mounted list committed one frame of `unasked` under a session it had
 * already asked about — which the runs surface draws as an assertion that this context
 * holds no runs — and, across a move from one session to another, kept the previous
 * session's rows renderable under the new session's name. The port is half of the stamp
 * because the fixture's scenario switch replaces the bridge and keeps the session id,
 * so a subject-only stamp committed the previous scenario's runs under the new one.
 */
export function useWorkflowRunDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowRunDirectoryState {
  const [state, setState] = useSubjectStampedRead<SettledRunDirectory>(growth, sessionId);
  useEffect(() => {
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
    let isMounted = true;
    void settleGrowthRead(growth.workflowRunList({ sessionId })).then((outcome) => {
      if (!isMounted) {
        // The unmount already happened. Dropping the answer is the point: a
        // `setState` on an unmounted caller is the leak the endurance tier exists
        // to catch, and a directory read outliving its surface by one navigation
        // is the ordinary case rather than the rare one.
        return;
      }
      setState(
        outcome.status === "served"
          ? { status: "served", runs: outcome.value.runs }
          : { status: "unavailable", refusal: outcome },
      );
    });
    return () => {
      isMounted = false;
    };
    // `setState` is the stamped read's own setter and is stable for the life of the
    // hook; it is named so the dependency list is the whole of what this effect uses.
  }, [growth, sessionId, setState]);
  return state;
}
