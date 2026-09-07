// A child run, summarized on one line of the parent's ledger.
//
// `Spec-013 §Default Behavior` keeps background work summarized and expands it only
// when somebody asks, and the blueprint's ledger chapter fixes what the summary says:
// the child agent's hue, its state, how many entries it holds, and which node produced
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
// keeps the summary on screen with the refusal beside it — `Spec-013 §Fallback
// Behavior`'s rule, drawn rather than merely obeyed.

import { DerivedFigure, Glyph, LedgerRow, Nothing, WireFigure } from "../../../primitives/index.js";
import { formatCount } from "../../../primitives/index.js";
import { type RunId } from "@ai-sidekicks/contracts";

import { type ParticipantHueAssignment } from "../../../tokens/index.js";
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
}

/** One child run, as a summary row. */
export function ChildRunSummaryRow(props: ChildRunSummaryRowProps): React.JSX.Element {
  const { entry, expansion } = props;
  const { summary } = entry;
  const isExpanded = expansion.status === "expanded";
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
      {renderExpansion(expansion)}
    </LedgerRow>
  );
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
 * What the expansion left behind.
 *
 * The failure arm is the one this component exists to keep honest: the summary above
 * is still drawn, and the refusal is stated beside it rather than replacing it.
 */
function renderExpansion(expansion: ChildRunExpansion): React.JSX.Element | null {
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
  );
}
