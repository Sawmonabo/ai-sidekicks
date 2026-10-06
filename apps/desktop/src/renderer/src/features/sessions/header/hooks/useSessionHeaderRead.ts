// The read the session header puts, and the shape it settles into. A session's display title is a
// projection the daemon serves, not part of the log the session store holds, so the header reads
// it; the call is the caller's, taken as an argument.
//
// One read per subject, through `useSubjectRead`, again only when the call or the subject moves;
// no polling. The state is held per subject and re-seeded to `reading` during the render that first
// sees a new session. A rejected call is not caught here; it propagates to the caller of the call.

import { useSubjectRead } from "#renderer/hooks/useSubjectRead.js";

/**
 * What the header knows about one of its reads at one moment. There is no `unasked` arm: a
 * route naming no session stays at `reading` and the header draws that empty state itself.
 */
export type SessionHeaderReadState<TValue> =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly value: TValue };

/** The one shared `reading` value, so its identity is stable across renders. */
const READING: SessionHeaderReadState<never> = { status: "reading" };

/**
 * Puts the header's read for one session and holds its answer against that session. With an
 * `undefined` `subject` nothing is read and the state stays `reading`.
 */
export function useSessionHeaderRead<TValue>(
  read: (subject: string, signal: AbortSignal) => Promise<TValue>,
  subject: string | undefined,
): SessionHeaderReadState<TValue> {
  const { value: state } = useSubjectRead<TValue, SessionHeaderReadState<TValue>>(
    read,
    subject,
    (key, signal) => (key === undefined ? undefined : read(key, signal)),
    { unsettled: () => READING, settled: (value) => ({ status: "served", value }) },
  );
  return state;
}
