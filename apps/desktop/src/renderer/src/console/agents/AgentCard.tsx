// The binding one agent is running under right now, and what is only promised.
//
// `Spec-023 §Console Design (Meridian)` §The agent card gives this surface one hard
// rule and four refusals, and every one of them is about keeping two lines apart:
//
//   • The EFFECTIVE line is the binding the agent runs under NOW. It moves only when
//     a terminal event lands, so a pending switch never touches it.
//   • The PENDING line is a promise. It carries its own id, the boundary the daemon
//     resolved, whether an interrupt was requested, the moved axes WITH their target
//     values, and the id it displaced.
//
// The refusals, stated where they are enforced below: `appliesAt` is never
// re-derived from the axis names, `interruptRequested` is never re-derived from
// `appliesAt`, `observedOutputSpeed` absence is never rendered as "off" and
// `outputSpeed` is never substituted for it, the resolved configuration is never
// re-read from the definition registry — the attach echo is the only read, and the
// registry row may already have moved — and an echo naming NO definition is never
// attributed to one, because an inline attach resolves a configuration too.
//
// TWO FIELDS ARE DELIBERATELY NOT RENDERED ANYWHERE: the admitting principal and the
// interrupt-dispatch progress marker. Both live in the durable slot as recovery
// inputs and reach no caller at all.

import { useId } from "react";
import { type ConsoleRefusal } from "../core/index.js";
import { InlineRefusal } from "../primitives/index.js";
import { type AgentRosterEntry } from "../bridge/index.js";
import { ResolvedConfigurationEcho } from "./ResolvedConfigurationEcho.js";
import { BindingAxis } from "./BindingAxis.js";
import { AgentStateChip } from "./AgentStateChip.js";
import { ObservedOutputSpeed } from "./ObservedOutputSpeed.js";
import { PendingSwitchLine } from "./PendingSwitchLine.js";

export interface AgentCardProps {
  readonly agent: AgentRosterEntry;
  /** Renderer-local: follow this agent into the ledger, in the hue it already carries. */
  readonly onFollow?: ((agentId: string) => void) | undefined;
  /** Opens the binding control. Absent where the surface offers no switch. */
  readonly onChangeBinding?: ((agentId: string) => void) | undefined;
  /** Detach moves `state` to `disabled` and is reversible by re-attaching. */
  readonly onDetach?: ((agentId: string) => void) | undefined;
  /**
   * Whether a mutation on this agent's binding is outstanding.
   *
   * Detach is durable and shares its caller's latch with the binding switch, so the
   * control is disabled and `aria-busy` while one is in flight: a press the latch
   * will refuse is not offered silently. It also says WHY through
   * `aria-describedby`, because a disabled control with no reason reads as broken
   * rather than as busy. Follow and change-binding are navigation and are
   * unaffected.
   */
  readonly isMutating?: boolean | undefined;
  /**
   * Why the last move on THIS agent's binding did not happen.
   *
   * On the card rather than beside the switch form, because the card is the only
   * surface that exists in every address shape the console can be opened at: a bare
   * auxiliary address in a session with two or more agents shows the whole roster and
   * no switch form at all, and a detach refused there reached no pixel. The caller
   * hands it to the row the round was submitted for and to no other.
   */
  readonly bindingRefusal?: ConsoleRefusal | undefined;
}

export function AgentCard(props: AgentCardProps): React.JSX.Element {
  const { agent } = props;
  const label = agent.name ?? agent.agentId;
  const mutatingReasonId = useId();
  const isMutating = props.isMutating === true;

  return (
    <article className="meridian-agent-card" aria-label={`Agent ${label}`}>
      <header className="meridian-agent-card__head">
        <h4 className="meridian-agent-card__name">{label}</h4>
        <AgentStateChip state={agent.state} defaultNodeId={agent.defaultNodeId} />
      </header>

      <p className="meridian-agent-card__effective">
        <span className="meridian-agent-card__line-label">Running under</span>{" "}
        <BindingAxis label="driver" value={agent.driverName} />
        <BindingAxis label="model" value={agent.modelId} />
        <BindingAxis
          label="account"
          value={agent.config?.providerAccountId}
          absenceMeaning="the provider's registered default"
        />
        <BindingAxis
          label="effort"
          value={agent.config?.effort}
          absenceMeaning="the driver's default for this model"
        />
        <BindingAxis
          label="output speed"
          value={agent.config?.outputSpeed}
          absenceMeaning="never set"
        />
      </p>

      <ObservedOutputSpeed agent={agent} />
      <PendingSwitchLine pendingSwitch={agent.pendingSwitch} />

      {agent.resolvedConfiguration === undefined ? null : (
        <details className="meridian-agent-card__disclosure">
          <summary className="meridian-agent-card__disclosure-summary">
            {agent.resolvedFromDefinitionId === undefined
              ? "Resolved configuration"
              : "Attached from a definition"}
          </summary>
          <ResolvedConfigurationEcho
            resolved={agent.resolvedConfiguration}
            definitionId={agent.resolvedFromDefinitionId}
          />
        </details>
      )}

      <div className="meridian-agent-card__actions">
        {props.onFollow === undefined ? null : (
          <button
            type="button"
            className="meridian-agent-card__action"
            onClick={() => props.onFollow?.(agent.agentId)}
          >
            Follow in the timeline
          </button>
        )}
        {props.onChangeBinding === undefined ? null : (
          <button
            type="button"
            className="meridian-agent-card__action"
            onClick={() => props.onChangeBinding?.(agent.agentId)}
          >
            Change the binding
          </button>
        )}
        {props.onDetach === undefined ? null : (
          <button
            type="button"
            className="meridian-agent-card__action"
            disabled={isMutating}
            aria-busy={isMutating}
            aria-describedby={isMutating ? mutatingReasonId : undefined}
            onClick={() => props.onDetach?.(agent.agentId)}
          >
            Detach
          </button>
        )}
        {isMutating ? (
          // Reached by the control rather than laid out beside it: the actions row
          // is a row of buttons and this family's stylesheet has no line to put a
          // sentence on there. The reason is what a person needs, and it is the
          // control itself that carries them to it.
          <span className="meridian-visually-hidden" id={mutatingReasonId}>
            A change to this agent&apos;s binding is already outstanding. Nothing here cancels a
            request, so this control takes no second change until the daemon answers the first.
          </span>
        ) : null}
      </div>

      {/* Inline, because nothing changed and the controls above are all still there. */}
      {props.bindingRefusal === undefined ? null : <InlineRefusal {...props.bindingRefusal} />}
    </article>
  );
}
