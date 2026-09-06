// The timeline pane: the address it hands its chrome, and the hole where another
// plan's rows go.
//
// THE CHROME IS NOT THIS FAMILY'S AND IT IS NOT PASSED IN EITHER. `seats/` draws
// every pane's frame — `Spec-023 §The surface set` fixes its contents, and six
// families each drawing their own would be six spacings and six answers to where the
// focus ring goes. It sits in `seats/` rather than in the deck for the reason every
// other seat does: the deck is a SIBLING view family and a sibling may not be
// imported, so the one frame six families share lives in the family whose whole job
// is holding contracts siblings share. What this pane supplies is what genuinely
// differs — its kind, the address its trail reads, and the hue it is attributed to.
//
// THE ROWS ARE NOT THIS FAMILY'S EITHER. The row vocabulary of `Spec-013 §Timeline
// Entry Types` is authored in `renderer/src/timeline/`, which the console imports
// through no path — it reaches this pane by CALLING `registerTimelineRowRenderer`. So
// the body here is a slot that reads the seat, and a row body written under
// `console/` for one of those entry types would be this family authoring somebody
// else's work.
//
// WHY NEITHER CONTROL IS DEFAULTED. Closing a pane and tearing one off into a window
// are both the DECK's acts. The honest rendering of a control whose act nobody can
// perform is to leave it out, not to draw it disabled — the absent-not-disabled rule
// `src/shared/auxiliary-routes.ts` applies to the Window menu — so the chrome takes
// both from the host's context and this pane forwards a prop only where its own
// caller owns the pane's lifetime.

import { routeSessionId } from "../../routing/index.js";
import { useFrameStore } from "../../store/index.js";
import {
  ConsolePaneChrome,
  timelineRowRenderer,
  type OwnerSlotContract,
  type PaneContextOf,
} from "../../seats/index.js";
import { TimelineRowHost } from "./feed/TimelineRowHost.js";

/**
 * Who owns the rows, what this pane owes them, and where the shell dies.
 *
 * DEVELOPER-FACING AND NEVER RENDERED — every member names work in flight, and the
 * empty state below names the FEATURE that has not been built while this names the
 * people building it.
 *
 * AND THE GOVERNANCE IDS LIVE IN THIS COMMENT RATHER THAN IN THE VALUES. The owner
 * is Plan-013 Phase 4, authoring the `Spec-013 §Timeline Entry Types` vocabulary in
 * `renderer/src/timeline/`, and that is what every member below is about — but the
 * repository's standing rule keeps those ids out of runtime strings, because a
 * string is one bad render away from a participant's screen and a comment is not.
 * The suite beside this file asserts the absence rather than trusting it.
 */
export const TIMELINE_ROW_SLOT: OwnerSlotContract = {
  owningTask: "the timeline row vocabulary, authored in renderer/src/timeline/",
  mountObligation:
    "the projected row wire-verbatim, the author's hue assignment, whether a later rollback boundary supersedes it, and the list's collapse state for it",
  deleteShellIn:
    "the PR that registers the real row renderer — the seat is owner-scoped, so a shell left registered beside it refuses the real one by name",
};

/**
 * The pane context, narrowed to the arm this body can serve.
 *
 * `PaneContextOf` is the seat's own narrowing rather than a second `Extract` written
 * here: one registry holds every kind, and a body does not. Narrowing on `kind`
 * narrows the entity with it — this pane's entity is a channel reference or nothing,
 * and an artifact or a run reference is not representable.
 *
 * AND THE ENTITY IS THE PANE'S SCOPE, NOT DECORATION. A channel address used to
 * reach the trail and stop there, while the body below it was handed the whole
 * session store — so a pane headed by one channel rendered every channel's rows, and
 * the head was the only thing on screen saying otherwise.
 */
export type TimelinePaneContext = PaneContextOf<"timeline">;

export interface TimelinePaneProps {
  readonly context: TimelinePaneContext;
  /** Supplied by whatever owns this pane's lifetime. Absent, no close is offered. */
  readonly onClose?: () => void;
  /** Supplied where a host can open the pane in a window of its own
   * (`Spec-023 §The surface set`, auxiliary windows). */
  readonly onOpenInWindow?: () => void;
}

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
      entity={context.entity}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the sheet's own neutral fallback applies, which is one answer rather than
      // a default written here and a fallback written there.
      focusHue={context.focusHue}
      {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
      {...(props.onOpenInWindow === undefined ? {} : { onOpenInWindow: props.onOpenInWindow })}
    >
      <TimelineRowHost
        contract={TIMELINE_ROW_SLOT}
        body={timelineRowRenderer()}
        paneId={context.paneId}
        sessionStore={context.sessionStore}
        {...(context.entity === undefined ? {} : { channelId: context.entity.id })}
      />
    </ConsolePaneChrome>
  );
}
