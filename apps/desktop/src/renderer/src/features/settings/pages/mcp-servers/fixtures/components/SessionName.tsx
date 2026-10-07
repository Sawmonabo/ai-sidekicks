import type { ReactNode } from "react";

import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";

/**
 * A running session as the session list names it, an untitled one faint and italic. A caller
 * draws it only for a session the list has named, so its id never reaches the screen.
 */
export function SessionName(props: { readonly entry: SessionListEntry }): ReactNode {
  const title = sessionDisplayTitleOf(props.entry);
  return title.isUntitled ? (
    <span className="meridian-mcp__untitled-session">{title.text}</span>
  ) : (
    sessionNameWords(props.entry)
  );
}

/** The words `SessionName` draws, for a line that reads the name out. */
export function sessionNameWords(entry: SessionListEntry): string {
  const title = sessionDisplayTitleOf(entry);
  return title.isUntitled ? title.text : formatWireString(title.text);
}
