// The transcript pane's body: the feed, or the one absence that stands in for it.
//
// Its own module for the one-component rule: the pane above decides the chrome and the
// address, and this decides what stands in the body while no session is open.
//
// NOTHING HERE DRAWS THE BODY BOX. `PaneFrame` renders
// `.meridian-pane__body` around whatever a pane hands it, so a wrapper here would be
// a second box inside the first — and the flex chain the feed's scroll container
// depends on would run through two elements only one of which is sized.

import { Nothing } from "@renderer/console/primitives/index.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TranscriptRowRenderer } from "@renderer/console/seats/index.js";
import { TranscriptFeed } from "./TranscriptFeed.js";

/** What the body needs to choose between the feed and its absence. */
export interface TranscriptPaneBodyProps {
  /** The registered row renderer. */
  readonly renderTranscriptRow: TranscriptRowRenderer;
  readonly sessionStore: SessionStore | undefined;
}

/**
 * The feed of the pane's session, or the sentence for no session.
 *
 * A route that names no session means there is nothing to be a log OF, and the pane
 * says so. An open session with no rows is the FEED's to render rather than this
 * file's — `TranscriptViewport` shows it inside the scroll container, where a row
 * would appear the moment one arrived — so the empty session is not a case here.
 */
export function TranscriptPaneBody(props: TranscriptPaneBodyProps): React.JSX.Element {
  if (props.sessionStore === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="block"
        title="No session is open in this pane."
        detail="Open a session and its log appears here."
      />
    );
  }
  return (
    <TranscriptFeed
      sessionStore={props.sessionStore}
      renderTranscriptRow={props.renderTranscriptRow}
      feedLabel="Transcript"
    />
  );
}
