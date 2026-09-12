// What session this is: the short id, the display title where one exists, and the
// state chip.
//
// THE THREE ARE ONE ANSWER AND ONE READ. The session identity sits at the head of the
// header, and a nameless session is rendered by its identifier rather than by an
// invented title. So the id is unconditional and in mono, the title is rendered when
// the read carries one, and the state is the wire's own word.
//
// THE TWO RULES THAT WERE WRITTEN HERE MOVED WITH THEIR COMPONENTS. What a nameless
// session renders, and why a wire word is a mono chip rather than prose, are each
// stated in the module that obeys them — `SessionHeaderSessionTitle.tsx` and
// `SessionHeaderSessionState.tsx`. This module arranges the three and decides nothing.

import { type GrowthSessionSummary } from "../../../bridge/index.js";
import { Nothing, WireFigure } from "../../../primitives/index.js";
import { type SessionHeaderReadState } from "../model/session-header-read-projection.js";
import { SessionHeaderSessionState } from "./SessionHeaderSessionState.js";
import { SessionHeaderSessionTitle } from "./SessionHeaderSessionTitle.js";

export interface SessionHeaderIdentityProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** The identity read, which is `reading` for as long as there is nothing to read. */
  readonly identity: SessionHeaderReadState<GrowthSessionSummary>;
}

export function SessionHeaderIdentity(props: SessionHeaderIdentityProps): React.JSX.Element {
  return (
    <span className="meridian-session-header__identity">
      {props.sessionId === undefined ? (
        <Nothing kind="empty" title="No session" />
      ) : (
        <>
          <WireFigure value={props.sessionId} title="Session id" />
          <SessionHeaderSessionTitle identity={props.identity} />
          <SessionHeaderSessionState identity={props.identity} />
        </>
      )}
    </span>
  );
}
