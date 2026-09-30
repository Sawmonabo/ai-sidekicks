// What session this is: the short id, always, in mono, and the display title where one exists. A
// nameless session is rendered by its identifier, never by an invented title. `SessionTitle.tsx`
// decides what a nameless session renders; this module only arranges the two.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { SessionTitle } from "./SessionTitle.js";

/** What the identity renders from. */
export interface SessionHeaderIdentityProps {
  /** `undefined` on a route that names no session, rendered as an absence. */
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
