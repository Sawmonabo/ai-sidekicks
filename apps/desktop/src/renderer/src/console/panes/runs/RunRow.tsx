// One run: its status, its elapsed, its controls, and everything else one click
// away.
//
// THIS ROW'S OWN DENSITY RULE, because no committed document states it: one row per
// run with status, elapsed, and the posture chip, while queue, intervention
// history, and per-run detail are collapsed and one click away — the shape
// `Spec-023 §Meridian, the design language` rule 7 gives every console surface,
// where "secondary controls live one click away". The posture chip is deliberately absent
// here and not merely unimplemented: `RunStateChangeEvent.executionPosture` is
// stamped only on `run.running`, so a row for a run in any other state has no
// posture to show, and rendering the last one seen would claim a posture the run no
// longer has.
//
// THREE STATEMENTS THE ROW MAKES, EACH OF THEM THE WIRE'S.
//
//   • **The state is the nine-member `RunState`, verbatim.** The chip's label is
//     the wire string, so `errored` — a gloss the enum does not carry — cannot
//     appear here whatever anybody types elsewhere.
//   • **A run that stopped because a limit fired says which limit, in those
//     words.** `RunStateChangeEvent.trigger` is the stop-condition provenance and
//     this row is its named reader.
//   • **A clean close is never a crash.** `intendedClose` marks a daemon-initiated
//     close, and the row says so beside a terminal that would otherwise read as a
//     failure.
//
// ELAPSED IS BETWEEN TWO WIRE INSTANTS. The row never asks what time it is now, so
// it needs no clock, no interval, and no re-render on a tick — which is what keeps
// a list of runs free at idle.

import { useCallback, useId, useState } from "react";
import type { ConsoleBridge, DriverCapabilityReadout } from "../../bridge/index.js";
import {
  Chip,
  DerivedFigure,
  LedgerRow,
  WireFigure,
  formatDuration,
} from "../../primitives/index.js";
import { InputAskSlot, INPUT_ASK_SLOT_CONTRACT } from "./InputAskSlot.js";
import { InterventionHistory } from "./InterventionHistory.js";
import { RunControls } from "./RunControls.js";
import type { RunControlSurface } from "./run-control-surface.js";
import { runElapsedMilliseconds, type RunProjection } from "./run-state-projection.js";
import {
  RUN_CLEAN_CLOSE_SENTENCE,
  RUN_STATE_TONES,
  RUN_TRIGGER_PHRASES,
  isBlockedRunState,
} from "./run-status.js";
import { StatusHistory } from "./StatusHistory.js";

/**
 * The hue step a run row's attribution edge takes.
 *
 * `RunStateChangeEvent` carries no participant and no agent member, so there is
 * nobody to attribute a run to — and `LedgerRow` treats a step outside the wheel as
 * unattributed and takes the neutral boundary rather than borrowing a hue. `-1` is
 * how this row states that, and it is deliberately not `0`, which would attribute
 * every run to whoever holds the first step.
 */
const UNATTRIBUTED_HUE_STEP = -1;

export interface RunRowProps {
  readonly run: RunProjection;
  readonly surface: RunControlSurface;
  readonly bridge: ConsoleBridge;
  /** Passed through to the control row, which resolves it for this row's run. */
  readonly driverCapabilities: DriverCapabilityReadout | undefined;
  /** Ask the pane to compose a rewind for this run. */
  readonly onRequestRewind: (runId: string) => void;
  /** Ask the pane to compose a steer for this run. */
  readonly onRequestSteer: (runId: string) => void;
}

export function RunRow(props: RunRowProps): React.JSX.Element {
  const { run } = props;
  const [isDetailOpen, setDetailOpen] = useState(false);
  const detailId = useId();
  const elapsedMs = runElapsedMilliseconds(run);

  // Taking the floor is the pane-local half of stepping in: the run's own detail
  // opens so the person can read its history and steer it. The other half —
  // addressing the composer at this run — belongs to the deck's focused-pane
  // state, which no surface holds yet, so this row promises only what it can do.
  const onTakeTheFloor = useCallback(() => {
    setDetailOpen(true);
  }, []);

  const onRequestRewind = useCallback(() => {
    props.onRequestRewind(run.runId);
  }, [props, run.runId]);

  const onRequestSteer = useCallback(() => {
    props.onRequestSteer(run.runId);
  }, [props, run.runId]);

  return (
    <LedgerRow
      participantHueStep={UNATTRIBUTED_HUE_STEP}
      occurredAtIso={run.updatedAtIso}
      actorLabel={run.runId}
      kindLabel={run.state}
      footer={
        <RunControls
          run={run}
          surface={props.surface}
          bridge={props.bridge}
          driverCapabilities={props.driverCapabilities}
          onTakeTheFloor={onTakeTheFloor}
          onRequestRewind={onRequestRewind}
          onRequestSteer={onRequestSteer}
        />
      }
    >
      <div className="meridian-run-row__reading">
        <Chip tone={RUN_STATE_TONES[run.state]} label={run.state} mono />
        <Chip tone="neutral" label={`v${String(run.runVersion)}`} mono />
        {elapsedMs === undefined ? null : <DerivedFigure text={formatDuration(elapsedMs)} />}
        {run.rewoundToPosition === undefined ? null : (
          <Chip tone="attention" label={`rewound to ${String(run.rewoundToPosition)}`} />
        )}
      </div>
      {run.trigger === undefined ? null : (
        <p className="meridian-run-row__trigger">
          This run stopped because {RUN_TRIGGER_PHRASES[run.trigger]}.
        </p>
      )}
      {run.intendedClose ? (
        <p className="meridian-run-row__clean-close">{RUN_CLEAN_CLOSE_SENTENCE}</p>
      ) : null}
      {run.failureCategory === undefined ? null : (
        <p className="meridian-run-row__failure">
          <WireFigure value={run.failureCategory} />
          {run.providerFailureDetail === undefined ? null : (
            <span className="meridian-run-row__failure-detail">
              <WireFigure value={run.providerFailureDetail} />
            </span>
          )}
        </p>
      )}
      {run.state === "waiting_for_input" ? (
        <InputAskSlot contract={INPUT_ASK_SLOT_CONTRACT} body={undefined} runId={run.runId} />
      ) : null}
      {isBlockedRunState(run.state) ? (
        <p className="meridian-run-row__blocked">
          This run is blocked on someone. It is not paused: nothing here resumes it, and it moves
          when the thing it is waiting on resolves.
        </p>
      ) : null}
      <button
        type="button"
        className="meridian-run-row__detail-toggle"
        aria-expanded={isDetailOpen}
        aria-controls={detailId}
        onClick={() => {
          setDetailOpen((open) => !open);
        }}
      >
        {isDetailOpen ? "Hide detail" : "Show detail"}
      </button>
      <div className="meridian-run-row__detail" id={detailId} hidden={!isDetailOpen}>
        <section
          className="meridian-run-row__section"
          aria-label={`Status history for run ${run.runId}`}
        >
          <h4 className="meridian-run-row__section-title">Status history</h4>
          <StatusHistory rows={run.statusRows} />
        </section>
        <section
          className="meridian-run-row__section"
          aria-label={`Intervention history for run ${run.runId}`}
        >
          <h4 className="meridian-run-row__section-title">Interventions</h4>
          <InterventionHistory records={props.surface.records} runId={run.runId} />
        </section>
      </div>
    </LedgerRow>
  );
}
