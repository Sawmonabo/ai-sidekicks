// The one thing a session's own surface says about its resume cycle: that there is
// not one.
//
// WHY THIS EXISTS AT ALL. `store/timeline-resume.ts` decides what a read's cursor
// block means and refuses the cycle SDK-locally where the responder carries no floor
// to resume against, and `open-session-entry.ts` keeps that decision so a surface can
// render it. Nothing read it. A refusal computed and never rendered is worse than one
// never computed: the console knows it will not resume this session's stream after a
// reconnect, and the person looking at it sees an ordinary session opening.
//
// WHY IT RENDERS `not-checked` RATHER THAN AN ERROR. Nothing failed. The responder
// predates the read surface the resume rule is stated on, so the console did not put
// the question — which is exactly the absence the console's refusal grammar reserves
// that kind for, and the kind `frame/ContextPicker.tsx` already uses for the sibling
// case where the registry carries a refusal instead of a reader. It is also a STANDING
// state rather than an incident: every read answers the same way for the life of that
// pairing, so it is not dismissible and it does not take the banner stack, which is
// for refusals a person can act on and put away.
//
// WHY IT IS NOT A BLANK SURFACE. The store still projects, and the subscription still
// replays and tails; what is lost is the reconnect-time resume, not the session. So
// this renders ABOVE the workspace body and never in place of it — a surface that
// replaced the room would report an outage the daemon is not having.
//
// WHY THE LEDGER FAMILY OWNS IT. This family's surface is what mounts a session's
// workspace, so it is the one place holding the registry, the store, and the route's
// session id together. The workspace body is deliberately handed everything BUT the
// registry (`index.ts` says why), and reversing that to carry one reading down would
// hand a surface that renders one session the set of all of them.

import { Nothing } from "../primitives/index.js";
import { useTimelineResume, type SessionStore, type SessionStoreRegistry } from "../store/index.js";

export interface SessionResumeAbsenceProps {
  readonly registry: SessionStoreRegistry;
  /**
   * The session's store. Taken as a REQUIRED prop rather than read from the registry,
   * because it is what this reading subscribes through — and a component that resolved
   * its own subscription source would be free to render before one exists, which is a
   * conditional hook one refactor away.
   */
  readonly store: SessionStore;
  readonly sessionId: string;
}

/**
 * The refused arm of the resume decision, or nothing at all.
 *
 * `null` for BOTH the resumable arm and the interval before any read has landed. They
 * are different facts and neither is this surface's to report: a session that resumes
 * needs no sentence about resuming, and a read still in flight is already rendered as
 * one by the surface above.
 */
export function SessionResumeAbsence(props: SessionResumeAbsenceProps): React.JSX.Element | null {
  const decision = useTimelineResume(props.registry, props.store, props.sessionId);
  if (decision === undefined || decision.outcome !== "refused") {
    return null;
  }
  return (
    <Nothing
      kind="not-checked"
      // NAMED rather than defaulted, and the primitive's own rule is why: a badge
      // carries its second line as a tooltip, and the second line here is the
      // refusal's sentence — the only place the responder's skew is described. A
      // person who has to hover to learn why a session will not resume has not been
      // told. This band spans the room, so it is a surface.
      placement="surface"
      title="This session's stream will not resume where it left off."
      detail={decision.refusal.detail}
    />
  );
}
