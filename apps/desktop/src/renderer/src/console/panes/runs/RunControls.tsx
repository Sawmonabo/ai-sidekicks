// The six controls, as a row of buttons that decide nothing.
//
// THIS COMPONENT'S OWN DENSITY RULE, because no committed document states it:
// pause or resume and Stop are always visible on an active run, while steer,
// cancel, and rollback live one click away in the control row's overflow, each with
// its keyboard path. The one-click-away half is `Spec-023 §Meridian, the design
// language` rule 7 applied here — "secondary controls live one click away — a row's
// hover footer or its context menu — never as a second visible button".
//
// FOUR THINGS THIS COMPONENT DOES NOT DO, THE FIRST TWO ON THE CORPUS'S RULES AND
// THE LAST TWO ON ITS OWN.
//
//   • It derives no eligibility. Every offered control dispatches, and the daemon's
//     typed refusal is what renders. There is no role check, no authorship check,
//     and no state precondition in this file — `run-control-gating.ts` decides only
//     whether a driver DECLARED a capability, which is a read and not a rule.
//   • It threads no guard of its own. The comparand is the dispatcher's own
//     reconciliation of two wire figures — the freshest run version the daemon has
//     answered with and the one this row's projection currently carries — and the
//     rule that picks between them lives at that chokepoint, not here.
//   • It never settles optimistically. A control goes busy the moment it is
//     pressed; what it SAYS comes only from the daemon's answer.
//   • It offers no reorder, no priority, no dequeue distinct from cancel, and no
//     move-to-background. None of the four exists on the wire.
//
// PAUSE IS `StepIn` ON A RUN THAT IS NOT ALREADY PAUSED. Stepping in is pause plus
// taking the floor — one wire call, `run.pause`, and one further act this pane
// performs locally — so the row offers the composite there and the plain resume
// verb once the run is at rest. A bare pause button beside `StepIn` would be two
// buttons for one call, which is the redundancy rule 7 exists to prevent.

import { useCallback, useMemo, useState } from "react";

import { StepIn } from "../../../shell/composer/accessories/index.js";
import type { ConsoleBridge, DriverCapabilityReadout } from "../../bridge/index.js";
import { Glyph, InlineRefusal, type GlyphName } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { type RunControl } from "./run-control-dispatch.js";
import { isControlOffered } from "./run-control-gating.js";
import { inFlightKeyFor, type RunControlSurface } from "./run-control-surface.js";
import { type RunProjection } from "./run-state-feed.js";
import { isLiveRunState } from "./run-status.js";

const CONTROL_GLYPH_SIZE = 12;

/** What each control is called on screen, and the mark it wears. Total over the six. */
const CONTROL_PRESENTATION: Readonly<Record<RunControl, { label: string; glyph: GlyphName }>> = {
  pause: { label: "Pause", glyph: "pause" },
  resume: { label: "Resume", glyph: "play" },
  steer: { label: "Steer", glyph: "pencil" },
  interrupt: { label: "Stop", glyph: "stop" },
  cancel: { label: "Cancel", glyph: "close" },
  rollback: { label: "Rewind", glyph: "external" },
};

/**
 * The controls that live one click away, in the design's own order.
 *
 * `pause`, `resume`, and `interrupt` are the always-visible half and are not on
 * this list; `pause` reaches the row through `StepIn`, which sends it.
 */
const OVERFLOW_CONTROLS: readonly RunControl[] = ["steer", "cancel", "rollback"];

export interface RunControlsProps {
  readonly run: RunProjection;
  readonly surface: RunControlSurface;
  /** Handed to `StepIn`, which owns its own `run.pause` dispatch and its receipt. */
  readonly bridge: ConsoleBridge;
  /**
   * The capability read, retained per driver. This row resolves it for ITS OWN run:
   * a session with two drivers must not let either one's declaration decide the
   * other's controls.
   */
  readonly driverCapabilities: DriverCapabilityReadout | undefined;
  /** Pause settled: open this run's detail and put focus in it. */
  readonly onTakeTheFloor: () => void;
  /** Compose a rewind. The pane owns the preview; this row only asks for one. */
  readonly onRequestRewind: () => void;
  /** Compose a steer. Same split, same reason. */
  readonly onRequestSteer: () => void;
}

export function RunControls(props: RunControlsProps): React.JSX.Element {
  const { run, surface, driverCapabilities } = props;
  const [isOverflowOpen, setOverflowOpen] = useState(false);
  const comparand = surface.dispatcher.comparandFor(run.runId, run.runVersion);

  const onResume = useCallback(() => {
    surface.dispatch(run.runId, "resume", (dispatcher) =>
      dispatcher.resume({ runId: run.runId, expectedRunVersion: comparand }),
    );
  }, [surface, run.runId, comparand]);

  const onInterrupt = useCallback(() => {
    surface.dispatch(run.runId, "interrupt", (dispatcher) =>
      dispatcher.interrupt({ runId: run.runId, expectedRunVersion: comparand }),
    );
  }, [surface, run.runId, comparand]);

  const onCancel = useCallback(() => {
    surface.dispatch(run.runId, "cancel", (dispatcher) =>
      dispatcher.cancel({ runId: run.runId, expectedRunVersion: comparand }),
    );
  }, [surface, run.runId, comparand]);

  const onOverflowPress: Readonly<Record<RunControl, () => void>> = useMemo(
    () => ({
      pause: props.onTakeTheFloor,
      resume: onResume,
      steer: props.onRequestSteer,
      interrupt: onInterrupt,
      cancel: onCancel,
      rollback: props.onRequestRewind,
    }),
    [
      props.onTakeTheFloor,
      props.onRequestSteer,
      props.onRequestRewind,
      onResume,
      onInterrupt,
      onCancel,
    ],
  );

  const offeredOverflow = OVERFLOW_CONTROLS.filter((control) =>
    isControlOffered(control, driverCapabilities, run.runId),
  );
  const isLive = isLiveRunState(run.state);
  const refusal = latestRefusalFor(surface, run.runId);

  return (
    <div className="meridian-run-controls">
      <div className="meridian-run-controls__primary">
        {isLive && run.state === "paused" ? (
          <ControlButton
            control="resume"
            isBusy={surface.inFlightKeys.has(inFlightKeyFor(run.runId, "resume"))}
            onPress={onResume}
          />
        ) : null}
        {isLive && run.state !== "paused" ? (
          <StepIn
            bridge={props.bridge}
            targetRunId={run.runId}
            expectedRunVersion={comparand}
            // The run's own identifier: `RunStateChangeEvent` carries no agent
            // member (three orchestration-linkage members are deliberately omitted
            // from the registered shape), so there is no name to render and the
            // wire-verbatim id is the honest stand-in.
            agentLabel={run.runId}
            onTakeTheFloor={props.onTakeTheFloor}
          />
        ) : null}
        {isLive ? (
          <ControlButton
            control="interrupt"
            isBusy={surface.inFlightKeys.has(inFlightKeyFor(run.runId, "interrupt"))}
            onPress={onInterrupt}
          />
        ) : null}
        {offeredOverflow.length === 0 ? null : (
          <button
            type="button"
            className="meridian-run-controls__overflow-toggle"
            aria-expanded={isOverflowOpen}
            aria-label={`More controls for run ${run.runId}`}
            onClick={() => {
              setOverflowOpen((open) => !open);
            }}
          >
            <Glyph name="more" size={CONTROL_GLYPH_SIZE} />
          </button>
        )}
      </div>
      {isOverflowOpen && offeredOverflow.length > 0 ? (
        <div
          className="meridian-run-controls__overflow"
          role="group"
          aria-label="More run controls"
        >
          {offeredOverflow.map((control) => (
            <ControlButton
              key={control}
              control={control}
              isBusy={surface.inFlightKeys.has(inFlightKeyFor(run.runId, control))}
              onPress={onOverflowPress[control]}
            />
          ))}
        </div>
      ) : null}
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </div>
  );
}

/** One control. Named, focusable, and busy while its dispatch is in flight. */
function ControlButton(props: {
  readonly control: RunControl;
  readonly isBusy: boolean;
  readonly onPress: () => void;
}): React.JSX.Element {
  const presentation = CONTROL_PRESENTATION[props.control];
  return (
    <button
      type="button"
      className={`meridian-run-controls__action meridian-run-controls__action--${props.control}`}
      aria-busy={props.isBusy}
      onClick={props.onPress}
    >
      <Glyph name={presentation.glyph} size={CONTROL_GLYPH_SIZE} />
      {presentation.label}
    </button>
  );
}

/**
 * The refusal this run's controls most recently came back with, if the newest
 * settlement was one.
 *
 * Newest-settlement-only rather than newest-refusal-ever: a refusal that has since
 * been superseded by a successful control is not what the row is in, and leaving it
 * on screen would report a state the daemon has moved past.
 */
function latestRefusalFor(surface: RunControlSurface, runId: string): ConsoleRefusal | undefined {
  for (let position = surface.records.length - 1; position >= 0; position -= 1) {
    const record = surface.records[position];
    if (record === undefined || record.runId !== runId) {
      continue;
    }
    return record.outcome.kind === "refused" ? record.outcome.refusal : undefined;
  }
  return undefined;
}
