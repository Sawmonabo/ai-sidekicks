// The binding one agent is running under right now.
//
// The refusals, stated where they are enforced below: `observedOutputSpeed` absence is
// never rendered as "off" and `outputSpeed` is never substituted for it, the resolved
// configuration is never re-read from the definition registry — the registry row may
// already have moved — and a configuration naming NO definition is never attributed to
// one.
//
// THE TOOL GRANT IS A LINE OF ITS OWN, above the resolved-configuration disclosure
// rather than inside it. The allowlist is the per-agent control over every tool source
// the daemon serves this agent — the browser's page tool set included — and a
// governance ceiling a reader has to open a disclosure to find is a ceiling nobody
// reads. `ToolAllowlistLine.tsx` states the split it keeps from the echo beside it, and
// `tool-grant.ts` states why the line carries a count and never the names.
//
// AND IT IS READ ONCE. The line and the echo's Tools row state one wire value, so the
// position is resolved here and handed to both — the card is the only place that has
// the whole roster row, and a second read inside the disclosure is how the two came to
// disagree about a configuration that carried no allowlist. The NODE-WIDE half of that
// governance rule is not on this card at all: `ToolAllowlistCeiling.tsx` states it once
// beside the roster, because it is true of every agent.
//
// TWO FIELDS ARE DELIBERATELY NOT RENDERED ANYWHERE: the admitting principal and the
// interrupt-dispatch progress marker. Both live in the durable slot as recovery
// inputs and reach no caller at all.
//
// `createdAt` IS RENDERED, AND IN THE HEAD RATHER THAN THE EFFECTIVE LINE. It is part
// of the identity and lifecycle the roster reply carries: a roster of several agents
// gives no other way to tell the one created this morning from the one that has been
// in the session since it opened. It is deliberately NOT on the effective line, whose
// members are all provider axes: an instant sitting among them would read as one more
// axis of the binding.

import { WireFigure, formatDateTime } from "@renderer/console/primitives/index.js";
import { type AgentListEntry } from "@renderer/services/wire-shapes/agents.js";
import { ResolvedConfiguration } from "./ResolvedConfiguration.js";
import { BindingAxis } from "./BindingAxis.js";
import { ObservedOutputSpeed } from "./ObservedOutputSpeed.js";
import { ToolAllowlistLine } from "./ToolAllowlistLine.js";
import { agentToolAllowlistPosition } from "../tool-allowlist.js";

/** What one agent card shows. */
export interface AgentBindingCardProps {
  readonly agent: AgentListEntry;
}

/** One agent: its identity, the binding it runs under, and the tool grant it holds. */
export function AgentBindingCard(props: AgentBindingCardProps): React.JSX.Element {
  const { agent } = props;
  const label = agent.name ?? agent.agentId;
  const toolGrant = agentToolAllowlistPosition(agent);

  return (
    <article className="meridian-agent-card" aria-label={`Agent ${label}`}>
      <header className="meridian-agent-card__head">
        <h4 className="meridian-agent-card__name">{label}</h4>
        {agent.createdAt === undefined ? null : (
          <span className="meridian-agent-card__created">
            <span className="meridian-agent-card__line-label">Created</span>{" "}
            <WireFigure value={formatDateTime(agent.createdAt)} title={agent.createdAt} />
          </span>
        )}
      </header>

      <p className="meridian-agent-card__effective">
        <span className="meridian-agent-card__line-label">Running under</span>{" "}
        <BindingAxis label="provider" value={agent.driverName} />
        <BindingAxis label="model" value={agent.modelId} />
        <BindingAxis
          label="account"
          value={agent.config?.providerAccountId}
          absenceMeaning="the provider's registered default"
        />
        <BindingAxis
          label="effort"
          value={agent.config?.effort}
          absenceMeaning="the provider's default for this model"
        />
        <BindingAxis
          label="output speed"
          value={agent.config?.outputSpeed}
          absenceMeaning="never set"
        />
      </p>

      <ObservedOutputSpeed agent={agent} />
      <ToolAllowlistLine position={toolGrant} />

      {agent.resolvedConfiguration === undefined ? null : (
        <details className="meridian-agent-card__disclosure">
          <summary className="meridian-agent-card__disclosure-summary">
            Resolved configuration
          </summary>
          <ResolvedConfiguration
            resolved={agent.resolvedConfiguration}
            definitionId={agent.resolvedFromDefinitionId}
            toolGrant={toolGrant}
          />
        </details>
      )}
    </article>
  );
}
