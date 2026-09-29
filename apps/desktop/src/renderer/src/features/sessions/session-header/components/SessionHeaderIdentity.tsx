// What session this is: the short id, and the display title where one exists.
//
// THE TWO ARE ONE ANSWER. The session identity sits at the head of the header, and a
// nameless session is rendered by its identifier rather than by an invented title. So the
// id is unconditional and in mono, and the title is rendered when the session carries one.
//
// What a nameless session renders is stated in the module that obeys it,
// `SessionHeaderSessionTitle.tsx`. This module arranges the two and decides nothing.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { SessionTitle } from "./SessionTitle.js";

export interface SessionHeaderIdentityProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** The session's display title, where it has one. */
  readonly title: string | undefined;
}

/** The session's id and, where it has one, its display title. */
export function SessionHeaderIdentity(props: SessionHeaderIdentityProps): React.JSX.Element {
  return (
    <span className="meridian-session-header__identity">
      {props.sessionId === undefined ? (
        <Nothing kind="empty" title="No session" />
      ) : (
        <>
          <WireFigure value={props.sessionId} title="Session id" />
          <SessionTitle title={props.title} />
        </>
      )}
    </span>
  );
}
