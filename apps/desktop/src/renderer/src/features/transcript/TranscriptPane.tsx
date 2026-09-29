// The transcript pane: the address it hands its chrome, and the renderer its rows are drawn with.
//
// THE CHROME IS NOT THIS FEATURE'S AND IT IS NOT PASSED IN EITHER. The shared pane chrome
// draws every pane's frame, so every pane kind shares one spacing and one answer to where
// the focus ring goes. What this pane supplies is what genuinely differs — its kind, the
// address its trail reads, and the hue it is attributed to.
//
// THE ROWS ARRIVE THROUGH THE ROW RENDERER. Whatever `registerTranscriptRowRenderer` registered
// draws each row's body, so the body here reads that renderer rather than being a
// dispatcher of its own.
//
// WHY THE CLOSE CONTROL IS NOT DEFAULTED. Closing a pane is the PANE LAYOUT's act. The honest
// rendering of a control whose act nobody can perform is to leave it out, not to draw it
// disabled, so the chrome takes it from the pane layout's pane controls and this pane
// forwards a prop only where its own caller owns the pane's lifetime.

import { routeSessionId } from "@renderer/routing/route-readers.js";
import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import {
  findTranscriptRowRenderer,
  type TranscriptRowRenderer,
} from "./transcript-row-renderer.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { TranscriptPaneBody } from "./feed/components/TranscriptPaneBody.js";

/**
 * The pane context, narrowed to the arm this body can serve.
 *
 * `PaneContextOf` is the pane registry's own narrowing rather than a second `Extract` written
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
      <TranscriptPaneBody
        renderTranscriptRow={registeredTranscriptRowRenderer()}
        sessionStore={context.sessionStore}
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
      "No transcript row renderer is registered. The transcript pane's body registers it when it loads.",
    );
  }
  return renderer;
}
