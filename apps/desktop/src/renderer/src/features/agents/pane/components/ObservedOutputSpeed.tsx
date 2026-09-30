import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { type AgentListEntry } from "@ai-sidekicks/contracts";

/**
 * The mode the provider declared, beside the one requested; never folded into or substituted for
 * it. Absence has three causes, none of them "off", so the card says "not yet observed" and
 * names all three.
 */
export function ObservedOutputSpeed(props: { readonly agent: AgentListEntry }): React.JSX.Element {
  const observed = props.agent.observedOutputSpeed;
  if (observed === undefined) {
    return (
      <p className="meridian-agent-card__observed">
        <span className="meridian-agent-card__line-label">Output speed, as declared</span> not yet
        observed — the provider declares no output-speed axis, no turn-bearing exchange has carried
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
