// The rows' hole, and the three different nothings it can hold.
//
// Its own module for the one-component rule, and the split puts the seat's absence
// where a reader looks for it: the pane above decides the chrome and the address, and
// this decides what stands in the body while the seat, the session, or the rows are
// not there.
//
// NOTHING HERE DRAWS THE BODY BOX. `seats/ConsolePaneChrome` renders
// `.meridian-pane__body` around whatever a pane hands it, so a wrapper here would be
// a second box inside the first — and the flex chain the feed's scroll container
// depends on would run through two elements only one of which is sized.

import { Nothing } from "@renderer/console/primitives/index.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TimelineRowRenderer } from "@renderer/console/seats/index.js";
import { LedgerFeed } from "./TranscriptFeed.js";

/** What the rows' hole needs to choose between its three nothings and the feed. */
export interface TimelineRowHostProps {
  /** The registered row renderer, or `undefined` while none is registered. */
  readonly body: TimelineRowRenderer | undefined;
  readonly sessionStore: SessionStore | undefined;
  /** The deck pane this body fills, for the seat the feed claims under it. */
  readonly paneId: string;
}

/**
 * The rows' hole, and the three different nothings it can hold.
 *
 * The three are kept apart because a person's next move differs (rule 8): a seat
 * nobody has filled means the feature has not shipped; a route that names no session
 * means there is nothing to be a log OF; and a filled seat over an open session with
 * no rows means this session has not done anything yet. Collapsing any two of them
 * would tell somebody their session was empty when the truth is that the console
 * cannot draw it, or has not been asked to.
 *
 * The third is the FEED's to render rather than this file's — `LedgerViewport` shows
 * it inside the scroll container, where a row would appear the moment one arrived —
 * so the empty session is not a case here at all.
 */
export function TimelineRowHost(props: TimelineRowHostProps): React.JSX.Element {
  const body = props.body;
  if (body === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The timeline rows have not been built yet."
        detail="The pane is reserved for them — nothing here failed, and nothing is missing from this session."
      />
    );
  }
  if (props.sessionStore === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="No session is open in this pane."
        detail="Open a session and its log appears here."
      />
    );
  }
  return (
    <LedgerFeed
      sessionStore={props.sessionStore}
      paneId={props.paneId}
      renderTimelineRow={body}
      feedLabel="Session timeline"
    />
  );
}
