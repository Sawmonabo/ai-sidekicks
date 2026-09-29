// The session header: which session this is.
//
// WHAT IT RENDERS. The identity — short id and display title where the session has one —
// and, while the session's store has not opened, a placeholder that holds the header's
// height. The title is handed in as data; the read that fetches it is
// `model/session-header-readings.ts`'s.
//
// AND ONE THING THE FRAME OWNS RATHER THAN THIS HEADER. A version-compatibility banner
// has no surface anywhere in this console yet, and the two banner stacks that DO exist —
// the frame's own and the session screen's — both render in this same column, immediately
// above this header and always visible beside it. A compact mark here would therefore be
// the same sentence twice on one screen.
//
// The header is one line and every clause truncates, which is a CSS property here rather
// than a string operation: truncating in JavaScript would put a wire-derived string
// through a transformation the figure rules forbid.

import "./SessionHeader.css";

import { type SessionStore } from "@renderer/store/session/session-store.js";
import { SessionHeaderIdentity } from "./SessionHeaderIdentity.js";
import { SessionHeaderSkeleton } from "./SessionHeaderSkeleton.js";

export interface SessionHeaderProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened — the loading arm. */
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
