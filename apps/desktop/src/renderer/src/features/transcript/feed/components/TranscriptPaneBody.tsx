// The transcript pane's body: the feed, or the one absence that stands in for it while no session
// is open. It draws no body box: `PaneFrame` renders `.meridian-pane__body`, and a wrapper would
// break the flex chain the feed's scroll container depends on.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TranscriptRowRenderer } from "../../transcript-row-renderer.js";
import { TranscriptFeed } from "./TranscriptFeed.js";

/** What the body needs to choose between the feed and its absence. */
export interface TranscriptPaneBodyProps {
  /** The registered row renderer. */
  readonly renderTranscriptRow: TranscriptRowRenderer;
  readonly sessionStore: SessionStore | undefined;
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
  return (
    <TranscriptFeed
      sessionStore={props.sessionStore}
      renderTranscriptRow={props.renderTranscriptRow}
      feedLabel="Transcript"
    />
  );
}
