// What this session is waiting on, counted once per cause rather than once per run.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `RunList.tsx`, on the package's
// one-component-per-`.tsx` rule and the precedent `RunListItem.tsx` sets beside it.
//
// WHAT THIS DRAWS AND WHAT THE ROWS BELOW IT DRAW. This is the FOLD: the engine
// stamps every phase parked against one provider account with the same
// `parkAttentionKey`, and six runs waiting on one spent account are one thing an
// operator can act on, not six. Each row below still says what its own run is waiting
// on, because that is a fact about that run; this says how many runs one cause is
// holding, which no row can say.
//
// IT DERIVES NOTHING. The fold, the affected-run count, the reasons and the amber are
// `run-list-projection.ts`'s and arrive as values. A component that re-walked the
// parks would be the second authority the projection exists to prevent — and the one
// most likely to count phases where the projection counted runs.
//
// IT OFFERS NOTHING. An attention entry gates no control: starting, resuming,
// cancelling and re-pinning are the daemon's adjudications reaching the console as
// typed refusals, and a line that disabled one would be a renderer deciding a question
// it does not own. Nor does anything here notify — `Spec-019` owns whether a person is
// interrupted, and this surface mints no OS notification.

import { Chip, DerivedFigure, WireFigure, formatCount } from "../../primitives/index.js";
import { ParkBadge } from "../parks/ParkBadge.js";
import { PARK_REASON_LABELS, parkAttentionTone } from "../parks/park-presentation.js";
import type { WorkflowParkAttentionEntry, WorkflowFoldedParks } from "./park-attention-fold.js";

export interface RunParkAttentionProps {
  readonly entries: readonly WorkflowParkAttentionEntry[];
}

/** Every live wait, folded where the engine correlated it. Nothing where none is. */
export function RunParkAttention(props: RunParkAttentionProps): React.JSX.Element | null {
  if (props.entries.length === 0) {
    // NOTHING rather than an empty-state card. Nothing waiting is the ordinary state
    // of a healthy session, and a permanent panel reporting the absence of news is
    // furniture — the list's own rows are what a person came here to read.
    return null;
  }
  return (
    <ul className="meridian-run-attention">
      {props.entries.map((entry) =>
        entry.kind === "folded" ? (
          renderFoldedParks(entry)
        ) : (
          /*
            An uncorrelated park stands for its own run, which is the fail-open
            direction the fold takes when the engine could not correlate a wait. It
            draws the SAME card the run's row draws, through the same component —
            what this line adds is the run it belongs to, which the card does not
            carry and which is the only way to tell two identical waits apart.
          */
          <li
            key={`park:${entry.workflowRunId}:${entry.parked.phaseId}`}
            className="meridian-run-attention__entry meridian-run-attention__entry--single"
          >
            <WireFigure value={entry.workflowRunId} />
            <ParkBadge parked={entry.parked} />
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * What a folded entry is called: the reasons it holds, read off the fold.
 *
 * The reasons are joined rather than reduced to one, because a fold is allowed to
 * span both — the wire admits the key on any parked phase — and naming only the first
 * would report a wait as one kind while it is also the other. The separator is prose
 * and the wire values travel beside the label as figures.
 */
function foldedParksLabel(entry: WorkflowFoldedParks): string {
  return entry.parkReasons.map((reason) => PARK_REASON_LABELS[reason]).join(" · ");
}

/**
 * One folded cause: what it is, which key correlated it, and how many runs it holds.
 *
 * A FUNCTION RETURNING THE ROW rather than a second component in this file, which is
 * the package's one-component-per-`.tsx` rule. It is not a component and is not
 * rendered as one — it composes the `<li>` this list's own map returns, so React sees
 * one component here and the arm that needs the most markup still reads apart from
 * the one that needs three lines.
 */
function renderFoldedParks(entry: WorkflowFoldedParks): React.JSX.Element {
  return (
    <li key={`fold:${entry.parkAttentionKey}`} className="meridian-run-attention__entry">
      <Chip
        tone={parkAttentionTone(entry.awaitsPerson)}
        glyph="fold"
        label={foldedParksLabel(entry)}
      />
      {/*
        The engine's correlation key, verbatim and in mono. It is the one thing on
        this line a person can paste into a search, and the console has no name for
        it: no read maps a `parkAttentionKey` to a provider account's label, so a
        friendly name here would be one this renderer invented.
      */}
      <WireFigure value={entry.parkAttentionKey} />
      {/*
        The count wears the derived signature because the console counted it. The
        noun sits beside the figure rather than inside a sentence, on `RunList`'s
        own rule: a count folded into prose would have to pluralize, and this
        console has one figure formatter and no pluralizer.
      */}
      <span className="meridian-run-attention__count">
        Runs affected <DerivedFigure text={formatCount(entry.affectedRunCount)} />
      </span>
    </li>
  );
}
