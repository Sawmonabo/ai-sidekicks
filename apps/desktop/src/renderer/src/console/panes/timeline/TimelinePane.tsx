// The timeline pane: its chrome, and the hole where another plan's rows go.
//
// `Spec-023 §Console Design (Meridian)` §4.2 fixes the chrome: "A pane header:
// breadcrumb (session › channel › run › entity), kind glyph, the actor hue as the
// focus ring when the pane's entity is a run or an agent, neutral otherwise, and the
// pane's controls: close, open-in-window where the kind permits, and the kind's own
// actions." Everything below is that sentence and nothing beyond it.
//
// THE ROWS ARE NOT THIS FAMILY'S. The row vocabulary of `Spec-013 §Timeline Entry
// Types` is authored in `renderer/src/timeline/`, which the console imports through
// no path — it reaches this pane by CALLING `registerTimelineRowRenderer`. So the
// body here is a slot that reads the seat, and a row body written under `console/`
// for one of those entry types would be this family authoring somebody else's work.
//
// WHY THE TWO CONTROLS ARE HOST-SUPPLIED AND ABSENT WITHOUT A HOST. Closing a pane
// and tearing one off into a window are both the DECK's acts — it owns which panes
// exist and in what window. The honest rendering of a control whose act nobody can
// perform is to leave it out, not to draw it disabled: that is the same
// absent-not-disabled rule `src/shared/auxiliary-routes.ts` applies to the Window
// menu, and it is why neither handler is defaulted to a no-op. Inside the deck the
// acts arrive through `workspace/deck/pane-controls.ts`; outside it — the auxiliary
// timeline window, the full-width surface — no host is mounted and no control
// renders. Explicit props still win, for a host that owns this pane's lifetime and
// is not a deck.
//
// THE HEADER ITSELF IS `workspace/deck/PaneHeader.tsx` AND NOT THIS FILE'S. Eleven
// pane kinds across six view families want the same strip, and written per family it
// is six breadcrumbs and six sets of accessible names that agree until one of them
// ships. What this pane supplies is what genuinely differs: its kind, its name, and
// the heading id its own `<section>` points at.

import { useId } from "react";

import { Nothing } from "../../primitives/index.js";
import { routeSessionId } from "../../routing/index.js";
import { useFrameStore, type SessionStore } from "../../store/index.js";
import { tokenReference } from "../../tokens/index.js";
import {
  PaneHeader,
  timelineRowRenderer,
  type ConsolePaneContext,
  type OwnerSlotContract,
  type OwnerSlotProps,
  type TimelineRowRenderer,
} from "../../workspace/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

/**
 * Who owns the rows, what this pane owes them, and where the shell dies.
 *
 * DEVELOPER-FACING AND NEVER RENDERED — every member names governance work, and the
 * repository's standing rule keeps those ids off a participant's screen. The empty
 * state below names the FEATURE that has not been built; this names the people
 * building it.
 */
export const TIMELINE_ROW_SLOT: OwnerSlotContract = {
  owningTask: "Plan-013 Phase 4 — the Spec-013 row vocabulary in renderer/src/timeline/",
  mountObligation:
    "the projected row wire-verbatim, the author's hue assignment, whether a later rollback boundary supersedes it, and the list's collapse state for it",
  deleteShellIn:
    "the PR that registers the real row renderer — the seat is owner-scoped, so a shell left registered beside it refuses the real one by name",
};

/** Carries the pane's focus ring colour into the chrome's boundary rules. */
interface PaneFocusStyle extends React.CSSProperties {
  readonly "--meridian-pane-hue": string;
}

export interface TimelinePaneProps {
  readonly context: ConsolePaneContext;
  /** Supplied by whatever owns this pane's lifetime. Absent, no close is offered. */
  readonly onClose?: () => void;
  /** Supplied where a host can open the pane in a window of its own (§4.5). */
  readonly onOpenInWindow?: () => void;
}

export function TimelinePane(props: TimelinePaneProps): React.JSX.Element {
  const headingId = useId();
  const { context } = props;

  // Read through the store's own selector rather than off a snapshot: the pane has
  // to follow a navigation that changes which session it is a log of, and a
  // render-time snapshot read would leave it showing the session before last.
  const route = useFrameStore(context.frameStore, (state) => state.route);

  const focusStyle: PaneFocusStyle = {
    "--meridian-pane-hue": context.focusHue ?? tokenReference("edge-strong"),
  };

  return (
    <section
      className="meridian-pane meridian-pane--timeline"
      style={focusStyle}
      aria-labelledby={headingId}
    >
      <PaneHeader
        kind="timeline"
        title="Timeline"
        headingId={headingId}
        sessionId={routeSessionId(route)}
        entity={context.entity}
        {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
        {...(props.onOpenInWindow === undefined ? {} : { onOpenInWindow: props.onOpenInWindow })}
      />
      <TimelineRowHost
        contract={TIMELINE_ROW_SLOT}
        body={timelineRowRenderer()}
        sessionStore={context.sessionStore}
      />
    </section>
  );
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
function TimelineRowHost(
  props: OwnerSlotProps<TimelineRowRenderer> & {
    readonly sessionStore: SessionStore | undefined;
  },
): React.JSX.Element {
  const body = props.body;
  if (body === undefined) {
    return (
      <div className="meridian-pane__body">
        <Nothing
          kind="empty"
          placement="surface"
          title="The timeline rows have not been built yet."
          detail="The pane is reserved for them — nothing here failed, and nothing is missing from this session."
        />
      </div>
    );
  }
  if (props.sessionStore === undefined) {
    return (
      <div className="meridian-pane__body">
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="No session is open in this pane."
          detail="Open a session and its log appears here."
        />
      </div>
    );
  }
  return (
    <div className="meridian-pane__body">
      <LedgerFeed
        sessionStore={props.sessionStore}
        renderTimelineRow={body}
        feedLabel="Session timeline"
      />
    </div>
  );
}
