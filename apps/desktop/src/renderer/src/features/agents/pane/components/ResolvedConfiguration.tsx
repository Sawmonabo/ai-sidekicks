// The configuration an agent runs under, drawn as the card reads it.
//
// Split out of `AgentCard.tsx` because it answers a different question: the card
// draws an agent's LIVE state — its binding, its run, the axes it is switching — and
// this draws the resolved configuration the roster reported, fixed for the agent's
// life. The two change for different reasons.
//
// IT IS NEVER RE-READ FROM THE DEFINITION REGISTRY. The registry row may already have
// moved, and a configuration naming NO definition is never attributed to one.

import { WireFigure } from "@renderer/console/primitives/index.js";
import type { AgentResolvedConfiguration } from "@renderer/services/wire-shapes/agents.js";
import { type AgentToolAllowlistPosition } from "../tool-allowlist.js";
import { ToolAllowlist } from "./ToolAllowlist.js";
import { ProseRow } from "./ProseRow.js";

/**
 * The resolved configuration, fixed for the agent's life and never re-read.
 *
 * The definition row turns on whether one was NAMED, because the configuration is
 * present either way.
 */
export function ResolvedConfiguration(props: {
  readonly resolved: AgentResolvedConfiguration;
  readonly definitionId: string | undefined;
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
      {props.definitionId === undefined ? null : (
        <div className="meridian-agent-card__resolved-row">
          <dt>Definition</dt>
          <dd>
            <WireFigure value={props.definitionId} />
          </dd>
        </div>
      )}
      <div className="meridian-agent-card__resolved-row">
        <dt>Execution posture</dt>
        <dd>
          {resolved.executionPostureMode === undefined ? (
            <span className="meridian-agent-card__axis-absent">not reported</span>
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
