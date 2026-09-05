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

import { Chip, Nothing, WireFigure, formatCount } from "../primitives/index.js";
import { RESOLVED_PROSE_INLINE_CAP, TOOL_ALLOWLIST_NAMED_CAP } from "../core/index.js";
import { boundaryPhrase } from "./switch-settlement.js";
import {
  type AgentPendingSwitch,
  type AgentResolvedConfiguration,
  type AgentRosterEntry,
} from "../bridge/index.js";
import { AGENT_STATES, isKnownMember } from "./agent-wire.js";

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
    </article>
  );
}

/**
 * One axis of the effective binding.
 *
 * An absent axis is not blank and is not a fault: each absence MEANS something
 * specific, and the card says which. An axis the reply did not carry at all — the
 * roster read today answers identity and lifecycle and no binding — says that
 * instead, because "the provider's default" would be a claim nobody made.
 */
function BindingAxis(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly absenceMeaning?: string;
}): React.JSX.Element {
  return (
    <span className="meridian-agent-card__axis">
      <span className="meridian-agent-card__axis-label">{props.label}</span>{" "}
      {props.value === undefined ? (
        <span className="meridian-agent-card__axis-absent">
          {props.absenceMeaning ?? "not reported"}
        </span>
      ) : (
        <WireFigure value={props.value} />
      )}
    </span>
  );
}

/**
 * The state, with the one degraded reading named as a reason rather than a fault.
 *
 * `configured` means the pinned node is not attached — the agent is configured and
 * cannot run yet — which is a sentence about the machine, not about the agent.
 */
function AgentStateChip(props: {
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

/**
 * The mode the provider declared, beside the one that was requested.
 *
 * Never folded into the requested value and never substituted for it. Absence has
 * exactly three causes and none of them is "the mode is off", so the card reads NOT
 * YET OBSERVED and names the three rather than implying a fourth.
 */
function ObservedOutputSpeed(props: { readonly agent: AgentRosterEntry }): React.JSX.Element {
  const observed = props.agent.observedOutputSpeed;
  if (observed === undefined) {
    return (
      <p className="meridian-agent-card__observed">
        <span className="meridian-agent-card__line-label">Output speed, as declared</span> not yet
        observed — the driver declares no output-speed axis, no turn-bearing exchange has carried
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

/**
 * A switch the daemon accepted and has not applied, as a line of its own.
 *
 * It survives a daemon restart because the daemon re-arms it from the agent row, so
 * this line is a durable promise rather than an optimistic echo of a request.
 */
function PendingSwitchLine(props: {
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

/**
 * The echo captured at attach. Fixed for the agent's life; never re-read.
 *
 * The definition row and the note turn on whether one was NAMED, because the echo is
 * present either way and an inline attach has no row to edit or delete.
 *
 * THE NOTE SITS OUTSIDE THE LIST. A `<dl>` admits `<dt>`/`<dd>` pairs and the
 * `<div>` groups that wrap them, and nothing else — a `<p>` among them is content an
 * accessibility validator flags and a screen reader may fold into the preceding
 * description, so the note would be heard as part of the goal it follows. It is
 * prose ABOUT the list rather than a term in it, which is why it becomes a sibling
 * rather than a term/description group: inventing a `<dt>` to hold it would be
 * naming a definition nothing defines.
 */
function ResolvedConfigurationEcho(props: {
  readonly resolved: AgentResolvedConfiguration;
  readonly definitionId: string | undefined;
}): React.JSX.Element {
  const { resolved } = props;
  return (
    <>
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
            <ToolAllowlist allowlist={resolved.toolAllowlist} />
          </dd>
        </div>
        <ProseRow label="Instructions" text={resolved.instructions} />
        <ProseRow label="Goal" text={resolved.goal} />
      </dl>
      <p className="meridian-agent-card__snapshot-note">
        {props.definitionId === undefined
          ? "This is what the attach resolved to, captured then. No definition was named, so there is none to edit, and no update carries these four axes."
          : "This is a snapshot taken when the agent was attached. Editing or deleting the definition afterwards reaches this agent never, and no update carries these four axes."}
      </p>
    </>
  );
}

/**
 * The tool allowlist as applied — presence first, emptiness second.
 *
 * An ABSENT member is the daemon not reporting the axis. A PRESENT empty array is
 * the applied configuration "no tools at all", which is a restriction somebody chose
 * and the strictest posture this agent can have. Rendering them alike would be the
 * conflation the whole card exists to refuse. The empty case is a derived sentence
 * rather than a wire figure because there is no wire value to print.
 */
function ToolAllowlist(props: {
  readonly allowlist: readonly string[] | undefined;
}): React.JSX.Element {
  const { allowlist } = props;
  if (allowlist === undefined) {
    return <span className="meridian-agent-card__axis-absent">not reported</span>;
  }
  if (allowlist.length === 0) {
    return (
      <span className="meridian-agent-card__axis-derived">
        No tools. This agent was attached with an empty allowlist.
      </span>
    );
  }
  return (
    <>
      {allowlist.slice(0, TOOL_ALLOWLIST_NAMED_CAP).map((toolName) => (
        <WireFigure key={toolName} value={toolName} />
      ))}
      {allowlist.length > TOOL_ALLOWLIST_NAMED_CAP
        ? ` and ${formatCount(allowlist.length - TOOL_ALLOWLIST_NAMED_CAP)} more`
        : null}
    </>
  );
}

function ProseRow(props: {
  readonly label: string;
  readonly text: string | undefined;
}): React.JSX.Element {
  return (
    <div className="meridian-agent-card__resolved-row">
      <dt>{props.label}</dt>
      <dd>
        {props.text === undefined ? (
          <span className="meridian-agent-card__axis-absent">not reported</span>
        ) : (
          clampProse(props.text)
        )}
      </dd>
    </div>
  );
}

/** Leading prose, clamped at the named bound. Never re-wrapped and never summarized. */
function clampProse(text: string): string {
  return text.length <= RESOLVED_PROSE_INLINE_CAP
    ? text
    : `${text.slice(0, RESOLVED_PROSE_INLINE_CAP)}…`;
}

/** What an empty roster says: the one action there is, and nothing else. */
export function AgentRosterEmpty(props: {
  readonly onAttach?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No agent is attached to this session."
      detail="Attaching one puts a configured sidekick into the session under a binding you choose or a definition supplies."
      action={
        props.onAttach === undefined ? undefined : (
          <button type="button" className="meridian-agent-card__action" onClick={props.onAttach}>
            Attach a sidekick
          </button>
        )
      }
    />
  );
}
