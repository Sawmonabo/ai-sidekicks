// The binding one agent runs under now, with its identity and tool allowlist. The allowlist
// position is
// resolved once here and handed to the line and the echo's Tools row so they cannot disagree; the
// resolved configuration is never re-read from the registry, whose row may have moved. `createdAt`
// sits in the head, not the effective line, whose members are all provider axes.

import "./AgentBindingCard.css";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import type { AgentListEntry } from "@ai-sidekicks/contracts/agent/methods";
import { ResolvedConfiguration } from "./ResolvedConfiguration.js";
import { BindingAxis } from "./BindingAxis.js";
import { ToolAllowlistLine } from "../tool-allowlist/components/ToolAllowlistLine.js";
import { agentToolAllowlistPosition } from "../tool-allowlist/position.js";

/** What one agent card shows. */
export interface AgentBindingCardProps {
  readonly agent: AgentListEntry;
}

/** One agent: its identity, the binding it runs under, and the tool allowlist it holds. */
export function AgentBindingCard(props: AgentBindingCardProps): React.JSX.Element {
  const { agent } = props;
  const { binding } = agent;
  const toolAllowlist = agentToolAllowlistPosition(agent);

  return (
    <article className="meridian-agent-card" aria-label={`Agent ${agent.name}`}>
      <header className="meridian-agent-card__head">
        <h4 className="meridian-agent-card__name">{agent.name}</h4>
        <span className="meridian-agent-card__created">
          <span className="meridian-form__label">Created</span>{" "}
          <WireFigure value={formatDateTime(agent.createdAt)} title={agent.createdAt} />
        </span>
      </header>

      <p className="meridian-agent-card__effective">
        <span className="meridian-form__label">Running under</span>{" "}
        <BindingAxis label="provider" value={binding.driverName} />
        <BindingAxis label="model" value={binding.modelId} />
        <BindingAxis
          label="account"
          value={binding.providerAccountId}
          absenceMeaning="the provider's current account"
        />
        <BindingAxis
          label="effort"
          value={binding.effort}
          absenceMeaning="the provider's default for this model"
        />
        <BindingAxis label="output speed" value={binding.outputSpeed} absenceMeaning="never set" />
      </p>

      <ToolAllowlistLine position={toolAllowlist} />

      {agent.resolvedConfiguration === undefined ? null : (
        <details className="meridian-agent-card__disclosure">
          <summary className="meridian-agent-card__disclosure-summary">
            Resolved configuration
          </summary>
          <ResolvedConfiguration
            resolved={agent.resolvedConfiguration}
            toolAllowlist={toolAllowlist}
          />
        </details>
      )}
    </article>
  );
}
