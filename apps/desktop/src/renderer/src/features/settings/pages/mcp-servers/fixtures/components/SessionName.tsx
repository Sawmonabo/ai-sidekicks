import type { ReactNode } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";

/**
 * A running session as the session list names it, an untitled one faint and italic. Until the
 * list names it, its name is drawn as still loading, as the session header draws an unread title;
 * its id never reaches the screen.
 */
export function SessionName(props: {
  readonly sessionId: string;
  readonly sessionDirectory: SessionDirectoryState;
}): ReactNode {
  const { sessionId, sessionDirectory } = props;
  const entry =
    sessionDirectory.status === "served"
      ? sessionDirectory.sessions.find((session) => session.sessionId === sessionId)
      : undefined;
  if (entry === undefined) {
    return <Nothing kind="not-loaded" placement="inline" title="Loading…" />;
  }
  const title = sessionDisplayTitleOf(entry);
  return title.isUntitled ? (
    <span className="meridian-mcp__untitled-session">{title.text}</span>
  ) : (
    formatWireString(title.text)
  );
}
