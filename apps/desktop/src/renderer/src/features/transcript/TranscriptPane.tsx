// The transcript pane: the address it hands the shared pane chrome, the registered row renderer
// its rows are drawn with, and the `transcript.read` its history is read through. The close
// control is not defaulted: a control nobody can perform is left out, so a close prop is
// forwarded only where the caller owns the pane.

import { useMemo } from "react";

import { transcriptPageReadThroughDaemon } from "#renderer/services/daemon/transcript/page.js";
import { routeSessionId, sessionMessageAnchorCursor } from "#renderer/routing/readers.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { findTranscriptRowRenderer, type TranscriptRowRenderer } from "./rows/renderer.js";
import { type PaneContextOf } from "#renderer/registries/panes/body-for-kind.js";
import { TranscriptPaneBody } from "./feed/components/TranscriptPaneBody.js";

/** The pane context narrowed to the transcript arm, using the pane registry's own narrowing. */
export type TranscriptPaneContext = PaneContextOf<"transcript">;

/** What a pane layout hands the transcript pane: its context and the close control it may offer. */
export interface TranscriptPaneProps {
  readonly context: TranscriptPaneContext;
  /** Supplied by whatever owns this pane's lifetime. Absent, no close is offered. */
  readonly onClose?: () => void;
}

/** The transcript pane: the chrome around the feed of the session the route names. */
export function TranscriptPane(props: TranscriptPaneProps): React.JSX.Element {
  const { context } = props;

  // Read through the store's selector so the pane follows a navigation to another session.
  const route = useWindowStore(context.frameStore, (state) => state.route);
  const { bridge } = context;
  const readTranscriptPage = useMemo(() => transcriptPageReadThroughDaemon(bridge), [bridge]);

  return (
    <PaneFrame
      kind="transcript"
      sessionId={routeSessionId(route)}
      // Straight through, including the absent arm: an unattributed pane sets no hue and the
      // sheet's neutral fallback applies.
      {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
    >
      <TranscriptPaneBody
        rowRenderer={registeredTranscriptRowRenderer()}
        sessionStore={context.sessionStore}
        messageAnchorCursor={sessionMessageAnchorCursor(route)}
        readTranscriptPage={readTranscriptPage}
      />
    </PaneFrame>
  );
}

/**
 * The registered row renderer, which the pane's lazily loaded body registers before the
 * pane can render. Its absence is a composition defect rather than a state to draw.
 */
function registeredTranscriptRowRenderer(): TranscriptRowRenderer {
  const renderer = findTranscriptRowRenderer();
  if (renderer === undefined) {
    throw new Error(
      "No transcript row renderer is registered. The transcript pane's " +
        "body registers it when it loads.",
    );
  }
  return renderer;
}
