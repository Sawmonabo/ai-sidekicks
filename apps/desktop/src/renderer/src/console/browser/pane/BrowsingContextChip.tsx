// The strip's leading chip: the browsing context name the agent set.
//
// Its own module for `apps/desktop/AGENTS.md`'s one-component rule, and it reads as
// one: the strip draws the session's pages, and this draws the CONTEXT those pages
// belong to, which is a different subject with a different source.
//
// IT RENDERS ITS OWN ABSENCE rather than falling back to a word like "Browser". The
// context name is a thing an agent sets through a tool, and a chip that invented one
// would tell a person the agent had named its context when it had not.

import type { PageListReading } from "./page-state.js";

export function BrowsingContextChip(props: {
  readonly reading: PageListReading;
}): React.JSX.Element {
  const contextName = props.reading.kind === "served" ? props.reading.frame.contextName : null;
  return contextName === null || contextName.length === 0 ? (
    <span className="meridian-browser-tabs__context meridian-browser-tabs__context--unnamed">
      Unnamed context
    </span>
  ) : (
    <span className="meridian-browser-tabs__context">{contextName}</span>
  );
}
