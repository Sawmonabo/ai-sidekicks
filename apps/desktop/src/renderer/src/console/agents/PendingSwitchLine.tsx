import { WireFigure } from "../primitives/index.js";
import { boundaryPhrase } from "./provider-switch/switch-settlement.js";
import { type AgentPendingSwitch } from "../bridge/index.js";

/**
 * A switch the daemon accepted and has not applied, as a line of its own.
 *
 * It survives a daemon restart because the daemon re-arms it from the agent row, so
 * this line is a durable promise rather than an optimistic echo of a request.
 */
export function PendingSwitchLine(props: {
  readonly pendingSwitch: AgentPendingSwitch | undefined;
}): React.JSX.Element | null {
  const pending = props.pendingSwitch;
  if (pending === undefined) {
    return null;
  }
  return (
    <p className="meridian-agent-card__pending">
      <span className="meridian-agent-card__line-label">Promised</span>{" "}
      {pending.pendingAxes.length === 0 ? (
        <span className="meridian-agent-card__axis-absent">no axis was named</span>
      ) : (
        pending.pendingAxes.map((axis) => (
          <span key={axis.axis} className="meridian-agent-card__axis">
            <span className="meridian-agent-card__axis-label">{axis.axis}</span>{" "}
            <WireFigure value={axis.value} />
          </span>
        ))
      )}
      <span className="meridian-agent-card__pending-when">
        {/* Read from the durable row. The boundary is resolved against the target
            driver's declared vocabulary and a multi-axis update takes the widest of
            them, so the axis names here cannot produce it — and the phrase itself
            comes from the family's one mapping rather than a second copy. */}{" "}
        {boundaryPhrase(pending.appliesAt)}
        {/* A deferred switch and an interrupted one both read `turn_boundary`, so
            this is read from its own field and never inferred from the one above. */}
        {pending.interruptRequested ? ", reached by interrupting the run now" : ""}.
      </span>
      {pending.replacedSwitchId === undefined ? null : (
        <span className="meridian-agent-card__pending-superseded">
          {" "}
          This supersedes <WireFigure value={pending.replacedSwitchId} />, which reaches no
          settlement of its own.
        </span>
      )}
    </p>
  );
}
