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
// exist and in what window — and the deck has not shipped. The honest rendering of a
// control whose act nobody can perform is to leave it out, not to draw it disabled:
// that is the same absent-not-disabled rule `src/shared/auxiliary-routes.ts` applies
// to the Window menu, and it is why neither handler is defaulted to a no-op. The
// mount in `index.ts` supplies neither today; the deck supplies both.
//
// The header is a `<header>` inside a `<section>` named by the pane's own heading, so
// a screen reader walking the window hears which pane it entered before it hears the
// log inside it.

import { useId } from "react";

import { Glyph, Nothing, WireFigure } from "../../primitives/index.js";
import { routeSessionId } from "../../routing/index.js";
import { useFrameStore } from "../../store/index.js";
import { tokenReference } from "../../tokens/index.js";
import {
  timelineRowRenderer,
  type ConsolePaneContext,
  type OwnerSlotContract,
  type OwnerSlotProps,
  type TimelineRowRenderer,
} from "../../workspace/index.js";

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

const PANE_CONTROL_GLYPH_SIZE = 14;
const PANE_KIND_GLYPH_SIZE = 16;

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
      <header className="meridian-pane__header">
        <span className="meridian-pane__kind">
          <Glyph name="timeline" size={PANE_KIND_GLYPH_SIZE} />
          <span className="meridian-pane__heading" id={headingId}>
            Timeline
          </span>
        </span>
        <PaneBreadcrumb sessionId={routeSessionId(route)} entity={context.entity} />
        <span className="meridian-pane__controls">
          {props.onOpenInWindow === undefined ? null : (
            <button
              type="button"
              className="meridian-pane__control"
              onClick={props.onOpenInWindow}
              aria-label="Open this timeline in its own window"
            >
              <Glyph name="external" size={PANE_CONTROL_GLYPH_SIZE} />
            </button>
          )}
          {props.onClose === undefined ? null : (
            <button
              type="button"
              className="meridian-pane__control"
              onClick={props.onClose}
              aria-label="Close this pane"
            >
              <Glyph name="close" size={PANE_CONTROL_GLYPH_SIZE} />
            </button>
          )}
        </span>
      </header>
      <TimelineRowHost contract={TIMELINE_ROW_SLOT} body={timelineRowRenderer()} />
    </section>
  );
}

interface PaneBreadcrumbProps {
  readonly sessionId: string | undefined;
  readonly entity: ConsolePaneContext["entity"];
}

/**
 * Session › channel › run › entity, as far as the pane's address reaches.
 *
 * Every crumb is a wire string and wears the provenance signature that says so
 * (rule 4), through the one module allowed to format one. A crumb the address does
 * not carry is left out rather than rendered as a placeholder — the breadcrumb
 * describes where this pane is, and an em dash standing in for a channel would say
 * the pane is scoped to a channel it has not got.
 */
function PaneBreadcrumb(props: PaneBreadcrumbProps): React.JSX.Element {
  const crumbs: readonly string[] = [
    ...(props.sessionId === undefined ? [] : [props.sessionId]),
    ...(props.entity === undefined ? [] : [props.entity.id]),
  ];
  if (crumbs.length === 0) {
    // Reachable: the auxiliary timeline window opens on a bare route and the frame
    // resolves its subject through the context picker. Saying so beats an empty
    // strip that reads as a breadcrumb that failed to render.
    return (
      <nav className="meridian-pane__breadcrumb" aria-label="Pane context">
        <span className="meridian-pane__crumb-absent">No session</span>
      </nav>
    );
  }
  return (
    <nav className="meridian-pane__breadcrumb" aria-label="Pane context">
      {crumbs.map((crumb, position) => (
        <span className="meridian-pane__crumb" key={crumb}>
          {position === 0 ? null : <Glyph name="chevron-right" size={PANE_CONTROL_GLYPH_SIZE} />}
          <WireFigure value={crumb} />
        </span>
      ))}
    </nav>
  );
}

/**
 * The rows' hole, and the two different nothings it can hold.
 *
 * `role="feed"` because the log grows at one end while a person reads the other, and
 * the rows themselves are `<article>`s — which is what makes the nesting valid.
 *
 * The two absences are kept apart because a person's next move differs (rule 8): a
 * seat nobody has filled means the feature has not shipped, and a filled seat with
 * nothing to show means this session has not done anything yet. Collapsing them into
 * one empty state would tell somebody their session was empty when the truth is that
 * the console cannot draw it.
 */
function TimelineRowHost(props: OwnerSlotProps<TimelineRowRenderer>): React.JSX.Element {
  return (
    <div className="meridian-pane__body">
      <div className="meridian-pane__feed" role="feed" aria-label="Session timeline">
        {props.body === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="The timeline rows have not been built yet."
            detail="The pane is reserved for them — nothing here failed, and nothing is missing from this session."
          />
        ) : (
          <Nothing
            kind="empty"
            placement="surface"
            title="Nothing has happened in this session yet."
            detail="Entries appear here as people and agents work."
          />
        )}
      </div>
    </div>
  );
}
