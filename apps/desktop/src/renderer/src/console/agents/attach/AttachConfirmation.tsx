import { Chip, WireFigure } from "../../primitives/index.js";
import type { AgentAttachReading, AgentResolvedConfiguration } from "../../bridge/index.js";

/** The reply, as applied. Every axis the daemon resolved, and no row it did not. */
export function AttachConfirmation(props: {
  readonly confirmation: AgentAttachReading;
}): React.JSX.Element {
  const resolved: AgentResolvedConfiguration = props.confirmation.resolvedConfiguration ?? {};
  return (
    <section className="meridian-attach__confirmation" aria-label="Attached">
      <p className="meridian-attach__confirmation-head">
        Attached as <WireFigure value={props.confirmation.agentId} />.
      </p>
      <ul className="meridian-attach__resolved">
        {(
          [
            ["driver", resolved.driverName],
            ["model", resolved.modelId],
            ["account", resolved.providerAccountId],
            ["effort", resolved.effort],
            ["posture", resolved.executionPostureMode],
          ] as const
        ).map(([label, value]) => (
          <li key={label} className="meridian-attach__resolved-axis">
            <span className="meridian-axis-field__label">{label}</span>{" "}
            {value === undefined ? (
              <Chip tone="neutral" label="not reported" />
            ) : (
              <WireFigure value={value} />
            )}
          </li>
        ))}
      </ul>
      {resolved.instructions === undefined ? null : (
        <p className="meridian-attach__resolved-prose">{resolved.instructions}</p>
      )}
      {resolved.goal === undefined ? null : (
        <p className="meridian-attach__resolved-prose">{resolved.goal}</p>
      )}
    </section>
  );
}
