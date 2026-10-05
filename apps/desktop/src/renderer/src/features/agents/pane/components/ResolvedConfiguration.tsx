// The configuration an agent runs under, as the agent list reported it. Split from
// `AgentBindingCard.tsx` because it is fixed for the agent's life, where the card's binding is
// live. It is never re-read from the definition registry, whose row may already have moved.

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { AgentResolvedConfiguration } from "@ai-sidekicks/contracts/agent/definition";
import { type AgentToolAllowlistPosition } from "../tool-allowlist/tool-allowlist.js";
import { ToolAllowlist } from "../tool-allowlist/components/ToolAllowlist.js";
import { ProseRow } from "./ProseRow.js";

/** The resolved configuration, fixed for the agent's life and never re-read. */
export function ResolvedConfiguration(props: {
  readonly resolved: AgentResolvedConfiguration;
  /** The allowlist the card already read, so the Tools row and the line above state it one way. */
  readonly toolAllowlist: AgentToolAllowlistPosition;
}): React.JSX.Element {
  const { resolved } = props;
  return (
    <dl className="meridian-agent-card__resolved">
      <div className="meridian-agent-card__resolved-row">
        <dt>Definition</dt>
        <dd>
          <WireFigure value={resolved.resolvedFromDefinitionId} />
        </dd>
      </div>
      <div className="meridian-agent-card__resolved-row">
        <dt>Tools</dt>
        <dd>
          <ToolAllowlist position={props.toolAllowlist} />
        </dd>
      </div>
      <ProseRow label="Instructions" text={resolved.instructions} />
      <ProseRow label="Goal" text={resolved.goal} />
    </dl>
  );
}
