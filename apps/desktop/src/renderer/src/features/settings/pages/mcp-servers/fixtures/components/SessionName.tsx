import type { ReactNode } from "react";

import { formatWireString } from "#renderer/lib/wire/figures.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";

/** What a session the directory does not name reads as: words, never its id. */
const UNNAMED_SESSION_WORDS = "A session";

/**
 * A running session as the session list names it, an untitled one faint and italic, and one no
 * directory names as `A session`. Its id never reaches the screen.
 */
export function SessionName(props: {
  readonly sessionId: string;
  readonly sessionDirectory: SessionDirectoryState | undefined;
}): ReactNode {
  const { sessionId, sessionDirectory } = props;
  const entry =
    sessionDirectory?.status === "served"
      ? sessionDirectory.sessions.find((session) => session.sessionId === sessionId)
      : undefined;
  if (entry === undefined) {
    return UNNAMED_SESSION_WORDS;
  }
  const title = sessionDisplayTitleOf(entry);
  return title.isUntitled ? (
    <span className="meridian-mcp__untitled-session">{title.text}</span>
  ) : (
    formatWireString(title.text)
  );
}
