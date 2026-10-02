// The session header: which session this is. It renders the identity (short id and display
// title where the session has one) and, while the session's store has not opened, a placeholder
// that holds the header's height. The title is handed in as data; `hooks/useSessionHeaderRead.ts`
// is the read that will supply it.
//
// The header is one line and every clause truncates in CSS, since truncating a wire-derived
// string in JavaScript would transform it.

import "./SessionHeader.css";

import { type SessionStore } from "@renderer/store/session/session-store.js";
import { SessionHeaderIdentity } from "./SessionHeaderIdentity.js";
import { SessionHeaderSkeleton } from "./SessionHeaderSkeleton.js";

/** What the session header renders from. */
export interface SessionHeaderProps {
  /** `undefined` on a route that names no session, rendered as an empty state. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened: the loading arm. */
  readonly sessionStore: SessionStore | undefined;
  /** The session's display title. Absent where the session has none. */
  readonly title?: string;
}

/** The session's identity, over a placeholder while its store is still opening. */
export function SessionHeader(props: SessionHeaderProps): React.JSX.Element {
  return (
    <header className="meridian-session-header" aria-label="Session">
      <SessionHeaderIdentity sessionId={props.sessionId} title={props.title} />
      {props.sessionStore === undefined ? <SessionHeaderSkeleton /> : null}
    </header>
  );
}
