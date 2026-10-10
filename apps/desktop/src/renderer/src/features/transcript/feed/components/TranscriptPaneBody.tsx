// The transcript pane's body: the feed, or the one empty state that stands in for it while no
// session is open. It draws no body box: `PaneFrame` renders `.meridian-pane__body`, and a wrapper
// would break the flex chain the feed's scroll container depends on.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { TranscriptFeed } from "./TranscriptFeed.js";

/** What the body needs to choose between the feed and its empty state. */
export interface TranscriptPaneBodyProps {
  /** The registered row renderer. */
  readonly rowRenderer: TranscriptRowRenderer;
  readonly sessionStore: SessionStore | undefined;
  /** The event cursor of the message the route opens the session at, or `undefined`. */
  readonly messageAnchorCursor: string | undefined;
  /** The `transcript.read` the feed reads its history past the store's window with. */
  readonly readTranscriptPage: TranscriptPageRead;
}

/**
 * The feed of the pane's session, or the sentence for no session. An open session with no rows
 * is the feed's to render (`TranscriptViewport` shows it inside the scroll container).
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
  // Keyed on the session, so a navigation to another session mints a fresh viewport: the reading
  // mode, the anchor and the measured rows belong to the session they were taken in.
  return (
    <TranscriptFeed
      key={props.sessionStore.sessionId}
      sessionStore={props.sessionStore}
      rowRenderer={props.rowRenderer}
      feedLabel="Transcript"
      messageAnchorCursor={props.messageAnchorCursor}
      readTranscriptPage={props.readTranscriptPage}
    />
  );
}
