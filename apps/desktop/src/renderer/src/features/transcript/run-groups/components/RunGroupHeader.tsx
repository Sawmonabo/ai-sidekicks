// The run group header: one finished run folded to a line that opens. Its only control is the
// disclosure; the lifecycle, counts and row membership are the model's, never recomputed here.
// It shows the run's newest state (a terminal is one of its values) and mounts `RunGroupBody`
// underneath while open, so the clipped rows are reachable.

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RunGroupBody } from "./RunGroupBody.js";
import { HUE_WHEEL_STEPS } from "@renderer/styles/palette.js";
import { formatHueWheelTokenName, tokenReference } from "@renderer/styles/tokens.js";
import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { type RunGroup } from "../run-groups.js";

/** The props of a run group header. */
export interface RunGroupHeaderProps {
  readonly runGroup: RunGroup;
  /** Whether the run group's rows are on screen beneath this header. */
  readonly isOpen: boolean;
  /** The actor's allocated hue, or `undefined` where the wheel never admitted them. */
  readonly agentHue?: AgentHueAssignment | undefined;
  readonly onToggle: (runGroup: RunGroup) => void;
}

/** One run's run group, as a header. */
export function RunGroupHeader(props: RunGroupHeaderProps): React.JSX.Element {
  const { runGroup } = props;
  const hueStep = props.agentHue?.step ?? -1;
  return (
    <div
      className="meridian-run-group-header"
      style={
        hueStep < 0 || hueStep >= HUE_WHEEL_STEPS
          ? undefined
          : {
              // The same 2 px leading edge every transcript row wears, so a run group and
              // its rows are attributed by the same wheel. An edge, not a tint: a hue never
              // sits behind text.
              borderInlineStartColor: tokenReference(formatHueWheelTokenName(hueStep)),
            }
      }
    >
      <button
        type="button"
        className="meridian-run-group-header__disclosure"
        aria-expanded={props.isOpen}
        onClick={() => {
          props.onToggle(runGroup);
        }}
      >
        <Glyph name={props.isOpen ? "chevron-down" : "chevron-right"} />
        {props.isOpen ? "Fold" : "Open"}
      </button>
      {runGroup.actorId === undefined ? (
        <Nothing kind="empty" placement="inline" title="No row named an actor." />
      ) : (
        <span className="meridian-run-group-header__actor">{runGroup.actorId}</span>
      )}
      {/* The daemon's own word for what the run is doing, verbatim; nothing where the log has
          reported no state since the last rewind. */}
      {runGroup.runStateEventType === undefined ? null : (
        <span className="meridian-run-group-header__state">{runGroup.runStateEventType}</span>
      )}
      {/* The account the run was admitted under, where the log named one. */}
      {runGroup.payingAccountId === undefined ? null : (
        <span className="meridian-run-group-header__account">
          {"billed to "}
          <span className="meridian-run-group-header__figure">{runGroup.payingAccountId}</span>
        </span>
      )}
      <span className="meridian-run-group-header__counts">
        <span className="meridian-run-group-header__figure">{String(runGroup.rowCount)}</span>
        {runGroup.rowCount === 1 ? " entry" : " entries"}
        {runGroup.clippedRowCount === 0 ? null : (
          <>
            {", "}
            <span className="meridian-run-group-header__figure">
              {String(runGroup.clippedRowCount)}
            </span>
            {" clipped"}
          </>
        )}
      </span>
      {/* Only while open: a folded run group draws its header and receipt and nothing else. */}
      {props.isOpen ? <RunGroupBody runGroup={runGroup} /> : null}
    </div>
  );
}
