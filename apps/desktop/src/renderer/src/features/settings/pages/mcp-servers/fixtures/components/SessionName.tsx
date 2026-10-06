import type { ReactNode } from "react";

import { formatWireString } from "#renderer/lib/wire/figures.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";

/**
 * A running session as the session list names it, an untitled one faint and italic. Where the
 * directory does not name it, the caller's `unnamed` stands in its place.
 */
export function SessionName(props: {
  readonly sessionId: string;
  readonly sessionDirectory: SessionDirectoryState | undefined;
  readonly unnamed: ReactNode;
}): ReactNode {
  const { sessionId, sessionDirectory, unnamed } = props;
  const entry =
    sessionDirectory?.status === "served"
      ? sessionDirectory.sessions.find((session) => session.sessionId === sessionId)
      : undefined;
  if (entry === undefined) {
    return unnamed;
  }
  const title = sessionDisplayTitleOf(entry);
  return title.isUntitled ? (
    <span className="meridian-mcp__untitled-session">{title.text}</span>
  ) : (
    formatWireString(title.text)
  );
}
