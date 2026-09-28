// The read the session header puts, and the shape it settles into.
//
// The session store answers what the LOG says. A session's display title is not in the
// log: it is a projection the daemon serves, so the header reads it. The call that reads
// it is the caller's, taken as an argument, so this module keeps only its own logic.
//
// ONE READ PER SUBJECT, AND NO POLLING. The read is put once per session, from the effect
// below, and again only when the call or the subject moves. A header that refreshed its
// own title on a timer would be a second cadence beside the event stream.
//
// THE STATE IS SUBJECT-SCOPED. The answer read for one session stops being an answer the
// instant the header is pointed at another, so it is held by the console's subject-scoped
// holder and re-seeded to `reading` during the render that first sees the new session.
//
// A rejected call is not caught here: it propagates to the caller of the call.

import { useEffect } from "react";

import {
  isReadAbandoned,
  settleUnlessAbandoned,
  useReadScope,
  useSubjectScopedState,
} from "../../../store/index.js";

/**
 * What the header knows about one of its reads at one moment.
 *
 * There is no `unasked` arm: where the header holds no subject it renders no reading at
 * all, so a route naming no session stays at `reading` and the surface says the absence
 * in its own words.
 */
export type SessionHeaderReadState<TValue> =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly value: TValue };

/** The reading every unsettled arm answers with, as one identity across renders. */
const READING: SessionHeaderReadState<never> = { status: "reading" };

/**
 * Put the header's read for one session, and hold its answer against that session.
 *
 * `subject` is `undefined` where there is no question — the caller holds no session id —
 * and nothing is put; the state stays `reading`.
 */
export function useSessionHeaderRead<TValue>(
  read: (subject: string, signal: AbortSignal) => Promise<TValue>,
  subject: string | undefined,
): SessionHeaderReadState<TValue> {
  const { value: state, publish } = useSubjectScopedState<SessionHeaderReadState<TValue>>(
    read,
    subject,
    () => READING,
  );
  const readScope = useReadScope(read, subject);
  useEffect(() => {
    if (subject === undefined) {
      return;
    }
    const round = readScope.openRound();
    if (isReadAbandoned(round.signal)) {
      return;
    }
    void settleUnlessAbandoned(read(subject, round.signal), round.signal).then((settlement) => {
      if (settlement.status === "abandoned") {
        return;
      }
      round.settle(() => {
        publish({ status: "served", value: settlement.value });
      });
    });
  }, [read, subject, publish, readScope]);
  return state;
}
