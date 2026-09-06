// The one thing a session's own surface says about its resume cycle: that the
// position it remembered was refused, and the log was re-read from the start instead.
//
// WHY THIS EXISTS AT ALL. `store/timeline-resume.ts` decides where a session's next
// read begins and `open-session-entry.ts` submits that position on the read it already
// performs. A daemon that cannot resolve the position answers `event.cursor_unresolvable`,
// and the entry recovers by forgetting it and re-reading the window from its beginning.
// That recovery is correct and it is also invisible: every row is present, the feed
// looks ordinary, and what actually happened is that the console silently gave up a
// place it was keeping. This is the surface that says so.
//
// WHY A BANNER AND NOT AN ABSENCE. This position used to hold a `Nothing` in its
// `not-checked` kind, for a refusal that fired on every read from every responder —
// a permanent band above every workspace reporting a version skew nothing was skewed
// by. That refusal is gone (`timeline-resume.ts` says why), and what is left is a real
// answer to a real request: the daemon refused something the console sent. So it takes
// the refusal grammar's BANNER, whose own rule is the fit — what the whole room can do
// has changed, because the room's stream was re-read from a different place — and it
// carries no `onDismiss`, which is that primitive's way of saying a notice clears when
// its condition does rather than when a person waves it away.
//
// AND IT IS NOT PERMANENT. The decision it renders is the newest completed read's, so
// the next read that resumes or restarts normally replaces it and this renders nothing.
// A person is told once, about the read it happened on.
//
// WHY IT IS NOT A BLANK SURFACE. The store still projects and the subscription still
// replays and tails; what was lost is a remembered position. So this renders ABOVE the
// workspace body and never in place of it — a surface that replaced the room would
// report an outage the daemon is not having.
//
// WHY THE LEDGER FAMILY OWNS IT. This family's surface is what mounts a session's
// workspace, so it is the one place holding the registry and the route's session id
// together. The workspace body is deliberately handed everything BUT the registry
// (`index.ts` says why), and reversing that to carry one reading down would hand a
// surface that renders one session the set of all of them.

import { RefusalBanner } from "../primitives/index.js";
import { useTimelineResume, type SessionStoreRegistry } from "../store/index.js";

export interface SessionResumeDegradedProps {
  readonly registry: SessionStoreRegistry;
  readonly sessionId: string;
}

/**
 * The refused arm of the resume decision, or nothing at all.
 *
 * `null` for every other arm and for the interval before any read has landed. A
 * session that resumed, one that started from the beginning because nothing had been
 * acknowledged, and one whose first read is still in flight are three different facts
 * and none of them is this surface's to report — the first two are the ordinary course
 * and the third is already rendered as loading by the surface above.
 */
export function SessionResumeDegraded(props: SessionResumeDegradedProps): React.JSX.Element | null {
  const decision = useTimelineResume(props.registry, props.sessionId);
  if (decision === undefined || decision.outcome !== "refused") {
    return null;
  }
  // Spread, so the code and the sentence are the refusal's own. `refusal-contract.ts`'
  // rule 1 is that the console renders the code verbatim and does not write a second
  // sentence explaining what the refusal meant.
  return <RefusalBanner {...decision.refusal} />;
}
