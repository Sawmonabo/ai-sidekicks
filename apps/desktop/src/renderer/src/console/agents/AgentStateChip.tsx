import { Chip, WireFigure } from "../primitives/index.js";
import { AGENT_STATES, isKnownMember } from "./agent-wire.js";

/**
 * The state, with the one degraded reading named as a reason rather than a fault.
 *
 * `configured` means the pinned node is not attached — the agent is configured and
 * cannot run yet — which is a sentence about the machine, not about the agent.
 */
export function AgentStateChip(props: {
  readonly state: string | undefined;
  readonly defaultNodeId: string | undefined;
}): React.JSX.Element {
  const { state } = props;
  if (state === undefined) {
    return <Chip tone="neutral" label="state not reported" />;
  }
  if (!isKnownMember(AGENT_STATES, state)) {
    return <Chip tone="neutral" mono label={state} />;
  }
  if (state === "configured") {
    return (
      <span className="meridian-agent-card__state">
        <Chip tone="attention" mono label={state} />
        <span className="meridian-agent-card__state-reason">
          {props.defaultNodeId === undefined
            ? "waiting on its pinned machine to attach"
            : "waiting on its pinned machine to attach: "}
          {props.defaultNodeId === undefined ? null : <WireFigure value={props.defaultNodeId} />}
        </span>
      </span>
    );
  }
  return <Chip tone={state === "ready" ? "accent" : "neutral"} mono label={state} />;
}
