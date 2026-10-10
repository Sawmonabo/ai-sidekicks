// The run group header: one run on a line, live or ended, which is also the group's fold control.
// The whole line is one button; the lifecycle, counts and row membership are the model's, never
// recomputed here. It shows the run's newest state (a terminal is one of its values) and mounts
// `RunGroupBody` beside the button while open, so the clipped rows are reachable and the body's
// own scroller is never inside a control.

import "./RunGroupHeader.css";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { RunGroupBody } from "./RunGroupBody.js";
import { isHueWheelStep } from "#renderer/styles/palette.js";
import { formatHueWheelTokenName, tokenReference } from "#renderer/styles/tokens.js";
import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import { type RunGroup } from "../groups.js";

/** The props of a run group header. */
export interface RunGroupHeaderProps {
  readonly runGroup: RunGroup;
  /** Whether the run group's rows are on screen beneath this header. */
  readonly isOpen: boolean;
  /** The actor's allocated hue, or `undefined` where the wheel never admitted them. */
  readonly agentHue?: AgentHueAssignment | undefined;
  /** Fold the group or open it, by its run id. */
  readonly onToggle: (runId: string) => void;
}

/** One run's run group, as a header that folds and opens it. */
export function RunGroupHeader(props: RunGroupHeaderProps): React.JSX.Element {
  const { runGroup } = props;
  const hueStep = props.agentHue?.step ?? -1;
  return (
    <div
      className="meridian-run-group-header"
      style={
        isHueWheelStep(hueStep)
          ? {
              // The same 2 px leading edge every transcript row wears, so a run group and
              // its rows are attributed by the same wheel. An edge, not a tint: a hue never
              // sits behind text.
              borderInlineStartColor: tokenReference(formatHueWheelTokenName(hueStep)),
            }
          : undefined
      }
    >
      {/* The header's own text is the button's name. A space between two parts draws nothing in
          the flex row; it keeps them apart in that name and in text copied out of it. */}
      <button
        type="button"
        className="meridian-run-group-header__disclosure"
        aria-expanded={props.isOpen}
        onClick={() => {
          props.onToggle(runGroup.runId);
        }}
      >
        <Glyph name={props.isOpen ? "chevron-down" : "chevron-right"} />
        {runGroup.actorId === undefined ? null : (
          <>
            <span className="meridian-run-group-header__actor">{runGroup.actorId}</span>{" "}
          </>
        )}
        {/* The daemon's own word for what the run is doing, verbatim; nothing where the log has
            reported no state since the last rewind. */}
        {runGroup.runStateEventType === undefined ? null : (
          <>
            <span className="meridian-run-group-header__state">
              {runGroup.runStateEventType}
            </span>{" "}
          </>
        )}
        {/* The account the run was admitted under, where the log named one. */}
        {runGroup.payingAccountId === undefined ? null : (
          <>
            <span className="meridian-run-group-header__account">
              {"billed to "}
              <WireFigure value={runGroup.payingAccountId} />
            </span>{" "}
          </>
        )}
        <span className="meridian-run-group-header__counts">
          <DerivedFigure text={formatCount(runGroup.rowCount)} />
          {runGroup.rowCount === 1 ? " entry" : " entries"}
          {runGroup.clippedRowCount === 0 ? null : (
            <>
              {", "}
              <DerivedFigure text={formatCount(runGroup.clippedRowCount)} />
              {" clipped"}
            </>
          )}
        </span>
      </button>
      {/* Only while open: a folded run group draws its header line and nothing else. */}
      {props.isOpen ? <RunGroupBody runGroup={runGroup} /> : null}
    </div>
  );
}
