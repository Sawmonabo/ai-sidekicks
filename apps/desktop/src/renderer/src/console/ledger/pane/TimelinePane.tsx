// The timeline pane: the address it hands its chrome, and the hole where another
// plan's rows go.
//
// THE CHROME IS NOT THIS FAMILY'S AND IT IS NOT PASSED IN EITHER. `seats/` draws
// every pane's frame — its contents are fixed, and six families each drawing their own
// would be six spacings and six answers to where the
// focus ring goes. It sits in `seats/` rather than in the deck for the reason every
// other seat does: the deck is a SIBLING view family and a sibling may not be
// imported, so the one frame six families share lives in the family whose whole job
// is holding contracts siblings share. What this pane supplies is what genuinely
// differs — its kind, the address its trail reads, and the hue it is attributed to.
//
// THE ROWS ARE NOT THIS FAMILY'S EITHER. The timeline row vocabulary is authored in
// `renderer/src/timeline/`, which the console imports
// through no path — it reaches this pane by CALLING `registerTimelineRowRenderer`. So
// the body here is a slot that reads the seat, and a row body written under
// `console/` for one of those entry types would be this family authoring somebody
// else's work.
//
// WHY THE CLOSE CONTROL IS NOT DEFAULTED. Closing a pane is the DECK's act. The honest
// rendering of a control whose act nobody can perform is to leave it out, not to draw it
// disabled, so the chrome takes it from the host's context and this pane forwards a prop
// only where its own caller owns the pane's lifetime.

import { routeSessionId } from "../../routing/index.js";
import { useFrameStore } from "../../store/index.js";
import { ConsolePaneChrome, timelineRowRenderer, type PaneContextOf } from "../../seats/index.js";
import { TimelineRowHost } from "./feed/surface/TimelineRowHost.js";

/**
 * The pane context, narrowed to the arm this body can serve.
 *
 * `PaneContextOf` is the seat's own narrowing rather than a second `Extract` written
 * here: one registry holds every kind, and a body does not.
 */
export type TimelinePaneContext = PaneContextOf<"timeline">;

/** What a deck hands the timeline pane: its context and the close control it may offer. */
export interface TimelinePaneProps {
  readonly context: TimelinePaneContext;
  /** Supplied by whatever owns this pane's lifetime. Absent, no close is offered. */
  readonly onClose?: () => void;
}

/** The timeline pane: the chrome around the feed of the session the route names. */
export function TimelinePane(props: TimelinePaneProps): React.JSX.Element {
  const { context } = props;

  // Read through the store's own selector rather than off a snapshot: the pane has
  // to follow a navigation that changes which session it is a log of, and a
  // render-time snapshot read would leave it showing the session before last.
  const route = useFrameStore(context.frameStore, (state) => state.route);

  return (
    <ConsolePaneChrome
      kind="timeline"
      sessionId={routeSessionId(route)}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the sheet's own neutral fallback applies, which is one answer rather than
      // a default written here and a fallback written there.
      focusHue={context.focusHue}
      {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
    >
      <TimelineRowHost
        body={timelineRowRenderer()}
        paneId={context.paneId}
        sessionStore={context.sessionStore}
      />
    </ConsolePaneChrome>
  );
}
