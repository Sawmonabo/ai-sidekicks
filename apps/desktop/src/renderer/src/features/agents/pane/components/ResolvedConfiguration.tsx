// The configuration an agent runs under, drawn as the card reads it.
//
// Split out of `AgentBindingCard.tsx` because it answers a different question: the card
// draws an agent's LIVE state — its binding, its run, the axes it is switching — and
// this draws the resolved configuration the roster reported, fixed for the agent's
// life. The two change for different reasons.
//
// IT IS NEVER RE-READ FROM THE DEFINITION REGISTRY. The registry row may already have
// moved, and the agent keeps what it was given.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { AgentResolvedConfiguration } from "@ai-sidekicks/contracts";
import { type AgentToolAllowlistPosition } from "../tool-allowlist.js";
import { ToolAllowlist } from "./ToolAllowlist.js";
import { ProseRow } from "./ProseRow.js";

/** The resolved configuration, fixed for the agent's life and never re-read. */
export function ResolvedConfiguration(props: {
  readonly resolved: AgentResolvedConfiguration;
  /**
   * The grant the card already read, handed down rather than re-read here.
   *
   * The Tools row and the governance line above the disclosure state one wire value,
   * and a second read of `resolved.toolAllowlist` in this subtree is how they came to
   * state it two different ways.
   */
  readonly toolGrant: AgentToolAllowlistPosition;
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
        <dt>Execution posture</dt>
        <dd>
          {resolved.executionPostureMode === null ? (
            <span className="meridian-agent-card__axis-absent">not pinned</span>
          ) : (
            <WireFigure value={resolved.executionPostureMode} />
          )}
        </dd>
      </div>
      <div className="meridian-agent-card__resolved-row">
        <dt>Tools</dt>
        <dd>
          <ToolAllowlist position={props.toolGrant} />
        </dd>
      </div>
      <ProseRow label="Instructions" text={resolved.instructions} />
      <ProseRow label="Goal" text={resolved.goal} />
    </dl>
  );
}
