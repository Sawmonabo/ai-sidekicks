// The transcript pane: the address it hands its chrome, and the seat its rows fill.
//
// THE CHROME IS NOT THIS FEATURE'S AND IT IS NOT PASSED IN EITHER. The shared pane chrome
// draws every pane's frame, so every pane kind shares one spacing and one answer to where
// the focus ring goes. What this pane supplies is what genuinely differs — its kind, the
// address its trail reads, and the hue it is attributed to.
//
// THE ROWS ARRIVE THROUGH THE ROW SEAT. Whatever fills the seat (`registerTranscriptRowRenderer`)
// draws each row's body, so the body here is a slot that reads the seat rather than a
// dispatcher of its own.
//
// WHY THE CLOSE CONTROL IS NOT DEFAULTED. Closing a pane is the PANE LAYOUT's act. The honest
// rendering of a control whose act nobody can perform is to leave it out, not to draw it
// disabled, so the chrome takes it from the host's context and this pane forwards a prop
// only where its own caller owns the pane's lifetime.

import { routeSessionId } from "@renderer/routing/route-readers.js";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import {
  PaneFrame,
  findTranscriptRowRenderer,
  type PaneContextOf,
} from "@renderer/console/seats/index.js";
import { TranscriptRowHost } from "./feed/components/TranscriptRowHost.js";

/**
 * The pane context, narrowed to the arm this body can serve.
 *
 * `PaneContextOf` is the seat's own narrowing rather than a second `Extract` written
 * here: one registry holds every kind, and a body does not.
 */
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

  // Read through the store's own selector rather than off a snapshot: the pane has
  // to follow a navigation that changes which session it is a log of, and a
  // render-time snapshot read would leave it showing the session before last.
  const route = useWindowStore(context.frameStore, (state) => state.route);

  return (
    <PaneFrame
      kind="transcript"
      sessionId={routeSessionId(route)}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the sheet's own neutral fallback applies, which is one answer rather than
      // a default written here and a fallback written there.
      focusHue={context.focusHue}
      {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
    >
      <TranscriptRowHost
        body={findTranscriptRowRenderer()}
        paneId={context.paneId}
        sessionStore={context.sessionStore}
      />
    </PaneFrame>
  );
}
