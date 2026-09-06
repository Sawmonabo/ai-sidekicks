import { WireFigure } from "../primitives/index.js";
import { type AgentRosterEntry } from "../bridge/index.js";

/**
 * The mode the provider declared, beside the one that was requested.
 *
 * Never folded into the requested value and never substituted for it. Absence has
 * exactly three causes and none of them is "the mode is off", so the card reads NOT
 * YET OBSERVED and names the three rather than implying a fourth.
 */
export function ObservedOutputSpeed(props: {
  readonly agent: AgentRosterEntry;
}): React.JSX.Element {
  const observed = props.agent.observedOutputSpeed;
  if (observed === undefined) {
    return (
      <p className="meridian-agent-card__observed">
        <span className="meridian-agent-card__line-label">Output speed, as declared</span> not yet
        observed — the driver declares no output-speed axis, no turn-bearing exchange has carried
        the handshake, or no binding is live.
      </p>
    );
  }
  return (
    <p className="meridian-agent-card__observed">
      <span className="meridian-agent-card__line-label">Output speed, as declared</span>{" "}
      <WireFigure value={observed.declared} />
      {observed.reason === undefined ? null : (
        <span className="meridian-agent-card__observed-reason"> — {observed.reason}</span>
      )}
    </p>
  );
}
