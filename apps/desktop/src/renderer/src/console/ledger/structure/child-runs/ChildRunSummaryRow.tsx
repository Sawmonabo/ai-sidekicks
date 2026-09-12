// A child run, summarized on one line of the parent's ledger.
//
// Background work stays summarized and expands only when somebody asks, and what the
// summary says is fixed: the child agent's hue, its state, how many entries it holds,
// and which node produced
// it. Before this row, all of that reached the screen as a single incompleteness
// marker on the chapter header — a child run that failed was indistinguishable from
// one that had barely started, and a child run that succeeded was invisible.
//
// EVERY PART IS A VALUE, NEVER A PHRASE. The run state is the daemon's own word in
// mono; the entry count is `Intl`-formatted from the exact figure and carries it in
// the title; the producing node is the id verbatim, and its absence is drawn as an
// absence rather than as "unknown", because `ChildRunSummary` says a child projected
// before its node is resolved "has no honest value to put there".
//
// THE COUNT IS A LOWER BOUND ON THE INCOMPLETE ARM, and the row says so rather than
// letting a reader take it for a total: the contract states that a summary whose
// completeness is `incomplete` holds "the count this daemon currently holds, not the
// child run's true total, which by definition it cannot know while rows are missing".
//
// THE EXPAND CONTROL IS FAIL-CLOSED IN BOTH DIRECTIONS. It offers the act and renders
// whatever came back; it decides no eligibility of its own, and a failed expansion
// keeps the summary on screen with the refusal beside it — the fallback rule, drawn
// rather than merely obeyed.
//
// AND AN EXPANSION SHOWS THE CHILD'S OWN WORK, WHICH IS THE WHOLE POINT OF ASKING FOR
// ONE. `timeline.childRunExpand` answers with the child run's rows, and this row used
// to read that page only to count it — "12 entries read", with the twelve entries
// nowhere on screen. So the entries are drawn, through the LEDGER'S OWN ROW BODY SEAT:
// the renderer the feed dispatches its own rows through, handed down as a prop from
// the same place the feed reads it. A second row renderer here would be a second
// answer to "what does a timeline row look like", and the child's rows would drift
// from the parent's the first time either moved.
//
// AND AN EXPANDED PAGE IS ITS OWN WINDOW FOR AN ASK'S TERMINAL. A driver ask is opened
// by one row and settled by a later one, so whether a request still needs answering is
// a fact about the window holding both — which for these entries is `expansion.entries`
// and never the parent ledger the outer provider folded. Rendered under that outer map
// the child's request found no terminal, kept offering its answer controls, and let a
// participant re-answer an ask the log had already settled. The fold is the one the
// ledger's card family declares; what this row supplies is the window it runs over.
//
// MOUNTED AS COMPONENTS AND NOT CALLED AS FUNCTIONS. The seat's renderer holds hooks,
// and the page's length moves with each expansion, so calling it once per entry inside
// this component's own body would make the hook order a function of how many rows the
// daemon served. Each entry is its own element, so each gets its own hook list.

import { useMemo } from "react";

import { DerivedFigure, Glyph, LedgerRow, Nothing, WireFigure } from "../../../primitives/index.js";
import { formatCount } from "../../../primitives/index.js";
import { type RunId, type TimelineRow } from "@ai-sidekicks/contracts";

import { type TimelineRowRenderer } from "../../../seats/index.js";
import { type ParticipantHueAssignment } from "../../../tokens/index.js";
// The ledger's own rollback ranking, taken from the module that declares it rather
// than approximated here: an expanded page can hold the child's own rollback
// boundaries, and rows past one are superseded in the child's log exactly as they are
// in the parent's.
import { SupersededIndex } from "../seams/superseded-bands.js";
// Deeply rather than through `cards/index.ts`, which is what an intra-family import
// is for — and the two halves of the ask seam are taken from the modules that declare
// them, so this row publishes no second answer about what settles an ask.
import { LedgerAskTerminalProvider } from "../../cards/bodies/AskTerminalProvider.js";
import { deriveDriverAskTerminals, type DriverAskReading } from "../../cards/bodies/input-ask.js";
import { type ChildRunEntry } from "./child-run-entries.js";
import { type ChildRunExpansion } from "./child-run-expansion.js";

export interface ChildRunSummaryRowProps {
  readonly entry: ChildRunEntry;
  /** The wire type of the row this summary rides, drawn in the row's kind slot. */
  readonly wireType: string;
  /** The child agent's allocated hue, or `undefined` on an unattributed row. */
  readonly participantHue?: ParticipantHueAssignment | undefined;
  /** Whether a rollback later in the log put this row behind it. */
  readonly isSuperseded?: boolean | undefined;
  readonly expansion: ChildRunExpansion;
  readonly onToggleExpansion: (childRunId: RunId) => void;
  /**
   * The ledger's row body seat, for the entries an expansion returned.
   *
   * STABLE FOR THE LIFE OF THE REGISTRATION, and handed down rather than read here for
   * the reason the feed hands it down: the seat is filled by whichever plan owns a
   * session's row bodies, and one lookup at the top of the list is what keeps every
   * row — the parent's and a child's alike — drawn by the same renderer.
   */
  readonly renderTimelineRow: TimelineRowRenderer;
  /**
   * The session's hue allocation, asked per entry actor.
   *
   * The allocation is over the SESSION's join log rather than over a window, so a
   * child run's entries carry the same author colours their actors wear in the parent
   * log. Resolving them here rather than dropping them would be the same participant
   * drawn two ways on one screen.
   */
  readonly hueForActor: (participantId: string) => ParticipantHueAssignment | undefined;
}

/** One child run, as a summary row. */
export function ChildRunSummaryRow(props: ChildRunSummaryRowProps): React.JSX.Element {
  const { entry, expansion } = props;
  const { summary } = entry;
  const isExpanded = expansion.status === "expanded";
  // Over the PAGE and not over the window: the entries are the child's rows and the
  // parent's boundaries rank none of them. Memoised on the page's identity, which the
  // expansion state holds across renders until a fresh expansion replaces it.
  const superseded = useMemo(() => new SupersededIndex(expansion.entries), [expansion.entries]);
  // Over the PAGE and not over the parent window, for the same reason the ranking above
  // is: the request and the row that answered, expired or cancelled it are both the
  // child's, and the parent's map holds neither.
  const askTerminalByAskIdentity = useMemo(
    () => deriveDriverAskTerminals(expansion.entries),
    [expansion.entries],
  );
  const entryDecisions: ChildRunEntryDecisions = {
    renderTimelineRow: props.renderTimelineRow,
    hueForActor: props.hueForActor,
    superseded,
    askTerminalByAskIdentity,
  };
  return (
    <LedgerRow
      participantHueStep={props.participantHue?.step ?? -1}
      {...(props.participantHue === undefined
        ? {}
        : { ringTreatment: props.participantHue.ringTreatment })}
      occurredAtIso={entry.timestamp}
      actorLabel={entry.actorId ?? "Child run"}
      kindLabel={props.wireType}
      {...(props.isSuperseded === undefined ? {} : { isSuperseded: props.isSuperseded })}
    >
      <p className="meridian-child-run-row">
        <Glyph name="run" title="Child run" />
        <WireFigure value={summary.runId} />
        <span className="meridian-child-run-row__state">
          <WireFigure value={summary.state} />
        </span>
        <span className="meridian-child-run-row__count">
          <DerivedFigure text={formatCount(summary.eventCount)} />
          {summary.eventCount === 1 ? " entry" : " entries"}
          {summary.completeness.state === "incomplete" ? " so far" : null}
        </span>
        {summary.producingNodeId === undefined ? (
          <Nothing
            kind="empty"
            placement="inline"
            title="No producing node is resolved for this child run."
          />
        ) : (
          <span className="meridian-child-run-row__node">
            <WireFigure value={summary.producingNodeId} />
          </span>
        )}
        <button
          type="button"
          className="meridian-child-run-row__disclosure"
          aria-expanded={isExpanded}
          disabled={expansion.status === "expanding"}
          onClick={() => {
            props.onToggleExpansion(summary.runId);
          }}
        >
          <Glyph name={isExpanded ? "chevron-down" : "chevron-right"} />
          {expansionControlLabel(expansion.status)}
        </button>
      </p>
      {renderIncompleteness(summary.completeness)}
      {renderExpansion(expansion, entryDecisions)}
    </LedgerRow>
  );
}

/**
 * How the expanded page resolves each of the three decisions the seat is handed, and
 * the terminal map the ask rows among those entries read.
 *
 * The map travels beside them rather than being folded where the list is drawn, for
 * the reason every other derivation on this row travels: it is derived once per page
 * in the component, so a re-render of the parent does not re-fold the child's log.
 */
interface ChildRunEntryDecisions {
  readonly renderTimelineRow: TimelineRowRenderer;
  readonly hueForActor: (participantId: string) => ParticipantHueAssignment | undefined;
  readonly superseded: SupersededIndex;
  readonly askTerminalByAskIdentity: ReadonlyMap<string, DriverAskReading>;
}

/** What the disclosure says, one word per state and none of them invented. */
function expansionControlLabel(status: ChildRunExpansion["status"]): string {
  switch (status) {
    case "expanding":
      return "Expanding";
    case "expanded":
      return "Fold";
    case "expand-failed":
      return "Retry";
    case "summarized":
      return "Expand";
  }
}

/**
 * The wire's own incompleteness marker, drawn as an absence with its cause.
 *
 * The cause is rendered verbatim and the observation time with it: two of the three
 * causes are transient, so a reader deciding whether to try again needs to know how
 * old the reading is — which is the contract's own reason for requiring `observedAt`
 * on that arm.
 */
function renderIncompleteness(
  completeness: ChildRunEntry["summary"]["completeness"],
): React.JSX.Element | null {
  if (completeness.state === "complete") {
    return null;
  }
  return (
    <Nothing
      kind="not-loaded"
      placement="inline"
      title="This child run's summary is incomplete."
      detail={`${completeness.cause}, observed ${completeness.observedAt}.`}
    />
  );
}

/**
 * What the expansion left behind: what it read, and the rows it read.
 *
 * The failure arm is the one this component exists to keep honest: the summary above
 * is still drawn, and the refusal is stated beside it rather than replacing it.
 *
 * The count line stays above the rows rather than being replaced by them, because it
 * says something the rows cannot: how much of the child run this page IS. `hasMore`
 * on the reply is a fact about the remainder, and a list that just stopped would read
 * as the whole of the child's work.
 */
function renderExpansion(
  expansion: ChildRunExpansion,
  decisions: ChildRunEntryDecisions,
): React.JSX.Element | null {
  if (expansion.status === "expand-failed") {
    return (
      <Nothing
        kind="error"
        placement="inline"
        title="This child run could not be expanded."
        detail={expansion.refusal?.detail ?? "The daemon refused without saying why."}
      />
    );
  }
  if (expansion.status !== "expanded") {
    return null;
  }
  return (
    <>
      <p className="meridian-child-run-row__expansion">
        <DerivedFigure text={formatCount(expansion.entries.length)} />
        {expansion.entries.length === 1 ? " entry read" : " entries read"}
        {expansion.hasUnreadEntries ? (
          <Nothing
            kind="not-loaded"
            placement="inline"
            title="This child run has entries beyond the ones read here."
          />
        ) : null}
      </p>
      {renderExpandedEntries(expansion.entries, decisions)}
    </>
  );
}

/**
 * The child run's own rows, each through the ledger's row body seat.
 *
 * DENSITY IS `collapsed` FOR EVERY ONE OF THEM, and that is a reading of the design
 * rather than a default taken for want of one: background work stays summarized, so a
 * child run opened inside a parent's line shows its
 * rows at the density the rule gives them. There is no lease to consult — the lease
 * table is keyed by the rows of the list, and these rows are not in it.
 *
 * An expansion that read nothing draws no list at all; the count line above it has
 * already said the page was empty, and an empty `ol` would be a heading over nothing.
 */
function renderExpandedEntries(
  entries: readonly TimelineRow[],
  decisions: ChildRunEntryDecisions,
): React.JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }
  const EntryBody = decisions.renderTimelineRow;
  return (
    <LedgerAskTerminalProvider terminalsByAskIdentity={decisions.askTerminalByAskIdentity}>
      <ol className="meridian-child-run-row__entries" aria-label="this child run's own entries">
        {entries.map((row) => (
          <li key={row.id} className="meridian-child-run-row__entry">
            <EntryBody
              row={row}
              participantHue={
                row.actor === undefined ? undefined : decisions.hueForActor(row.actor)
              }
              isSuperseded={decisions.superseded.isSuperseded(row.id)}
              density="collapsed"
            />
          </li>
        ))}
      </ol>
    </LedgerAskTerminalProvider>
  );
}
