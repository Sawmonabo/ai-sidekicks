// Putting a configured sidekick into a session in one act.
//
// TWO ARMS OF ONE FORM, NOT A WIZARD. The definition arm needs only a definition;
// the inline arm needs a driver and a model. The union refuses exactly one shape — a
// request naming neither — so everything else is a field and there are no steps.
//
// WHAT THE CONFIRMATION IS. `AgentAttachResponse.resolvedConfiguration`, every axis
// as APPLIED, and never the definition row: the daemon resolves the merge, and a
// confirmation composed from the row the caller picked would be the console
// asserting a resolution it did not perform. Four of those axes — execution posture,
// tool allowlist, instructions, goal — are stamped on the agent row at attach and
// are fixed for its life, which is why the confirmation says so in a sentence rather
// than leaving a person to discover it by editing the definition later.
//
// THE ACCOUNT'S READINESS IS ADVISORY AND NEVER A GATE. Resolution tests registry
// MEMBERSHIP; authentication is settled at spawn by a live probe. A form that
// refused on readiness would refuse an account that is about to work, and one that
// silently fell back to a provider default would change who pays without saying so.
//
// EFFORT IS PER MODEL AND NEVER HARDCODED. The vocabulary comes from the selected
// model's own `effortLevels` on the catalog read, and a model that publishes no
// effort surface gets NO effort control at all — `AxisCombobox` enforces that, which
// is why this file passes the vocabulary straight through rather than defaulting it.

import { Dialog } from "@base-ui/react/dialog";

import type { ConsoleRefusal } from "../core/index.js";
import { Chip, Nothing, RefusalCard, WireFigure } from "../primitives/index.js";
import type { PushDrivenReadState } from "../collaboration/push-driven-read.js";
import { AxisCombobox } from "./AxisCombobox.js";
import { ATTACH_ARMS, type AttachArm, type AttachSidekickForm } from "./attach-model.js";
import {
  driverNamesOf,
  effortLevelsFor,
  modelsFor,
  type DriverCatalogReading,
} from "./driver-catalog.js";
import type {
  AgentAttachReading,
  AgentResolvedConfiguration,
  SidekickDefinitionListReading,
} from "./agent-wire.js";

export interface AttachSidekickProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly form: AttachSidekickForm;
  /** The session the agent joins. Required by both arms of the registered request. */
  readonly sessionId: string;
  readonly catalog: PushDrivenReadState<DriverCatalogReading>;
  readonly definitions: PushDrivenReadState<SidekickDefinitionListReading>;
  readonly onSubmit: () => void;
  /**
   * Whether the caller has an attach outstanding.
   *
   * The form does not own this: `agent.attach` creates a durable agent, so the
   * latch that admits one attempt at a time belongs to whoever performs the call,
   * and a second flag here would be a second answer to the same question. What
   * this form owes is that the control SAYS so — disabled, so a second press is
   * refused where a person can see it rather than only inside the latch, and
   * `aria-busy`, so a screen reader is told the act is under way rather than
   * being handed a dead control with no reason.
   */
  readonly isSubmitting?: boolean | undefined;
  /** The daemon's own reply, rendered as applied. Never the definition row. */
  readonly confirmation?: AgentAttachReading | undefined;
  /** The daemon's refusal, rendered verbatim. */
  readonly refusal?: ConsoleRefusal | undefined;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function AttachSidekick(props: AttachSidekickProps): React.JSX.Element {
  const { form, catalog, definitions } = props;
  const readiness = form.readiness(props.sessionId);
  const catalogValue = catalog.kind === "loaded" ? catalog.value : undefined;
  const driverName = form.effectiveValue("driverName");
  const modelId = form.effectiveValue("modelId");

  // A definition read that FAILED collapses the form to the inline arm rather than
  // blocking attach — the inline arm is unaffected by a definition plane that cannot
  // be reached, and blocking would make one subsystem's outage the whole surface's.
  const definitionArmAvailable = definitions.kind !== "failed";

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal="trap-focus">
      <Dialog.Portal container={props.overlayContainer}>
        <Dialog.Backdrop className="meridian-attach__backdrop" />
        <Dialog.Popup className="meridian-attach__popup" aria-label="Attach a sidekick">
          <h3 className="meridian-attach__title">Attach a sidekick</h3>

          {/* Above the arms because it belongs to neither: the registered request
              requires a name of both, and no definition supplies one — the name on a
              definition row is the definition's. So this is typed, never filled in,
              and a placeholder is as far as the form goes. */}
          <label className="meridian-axis-field">
            <span className="meridian-axis-field__label">Name</span>
            <input
              className="meridian-axis-field__text"
              value={form.name}
              placeholder="What this agent is called here"
              onChange={(event) => form.setName(event.target.value)}
            />
            <span className="meridian-axis-field__advisory">
              Required on both arms. This is the agent&rsquo;s own name — a definition&rsquo;s name
              stays the definition&rsquo;s.
            </span>
          </label>

          <div className="meridian-attach__arms" role="group" aria-label="How to attach">
            {ATTACH_ARMS.map((arm) => (
              <button
                key={arm}
                type="button"
                className="meridian-attach__arm"
                aria-pressed={form.arm === arm}
                disabled={arm === "definition" && !definitionArmAvailable}
                onClick={() => form.selectArm(arm)}
              >
                {armLabel(arm)}
              </button>
            ))}
          </div>

          {form.arm === "definition" ? (
            <DefinitionPicker form={form} definitions={definitions} />
          ) : null}

          {catalog.kind === "not-loaded" ? (
            <>
              <Nothing kind="not-loaded" title="Reading the model catalog" />
              <p className="meridian-attach__catalog-note">
                The definition arm stays submittable while this is in flight: the daemon resolves a
                definition&apos;s driver and model itself.
              </p>
            </>
          ) : null}
          {catalog.kind === "failed" ? <RefusalCard {...catalog.refusal} /> : null}

          <AxisCombobox
            label="Driver"
            options={catalogValue === undefined ? undefined : driverNamesOf(catalogValue)}
            value={driverName}
            onValueChange={(next) => form.setField("driverName", next ?? "")}
            isOverridden={form.isOverridden("driverName")}
            overlayContainer={props.overlayContainer}
          />
          <AxisCombobox
            label="Model"
            options={
              catalogValue === undefined
                ? undefined
                : modelsFor(catalogValue, driverName).map((model) => model.id)
            }
            value={modelId}
            onValueChange={(next) => form.setField("modelId", next ?? "")}
            isOverridden={form.isOverridden("modelId")}
            overlayContainer={props.overlayContainer}
          />
          <AxisCombobox
            label="Effort"
            options={
              catalogValue === undefined
                ? undefined
                : effortLevelsFor(catalogValue, driverName, modelId)
            }
            value={form.effectiveValue("effort")}
            onValueChange={(next) => form.setField("effort", next ?? "")}
            isOverridden={form.isOverridden("effort")}
            overlayContainer={props.overlayContainer}
          />

          <label className="meridian-axis-field">
            <span className="meridian-axis-field__label">
              Provider account
              {form.isOverridden("providerAccountId") ? (
                <span className="meridian-axis-field__overridden"> overridden</span>
              ) : null}
            </span>
            <input
              className="meridian-axis-field__text"
              value={form.effectiveValue("providerAccountId") ?? ""}
              onChange={(event) => form.setField("providerAccountId", event.target.value)}
            />
            <span className="meridian-axis-field__advisory">
              An account&rsquo;s stored readiness is advisory here and never a gate — a pinned
              account that has left the registry refuses rather than falling back to a default.
            </span>
          </label>

          <p className="meridian-attach__snapshot">
            The agent takes a <strong>snapshot</strong> of what this resolves to. Editing or
            deleting the definition afterwards reaches it never, and its posture, tools,
            instructions, and goal are fixed for its life.
          </p>

          {readiness.status === "incomplete" ? (
            <p className="meridian-attach__incomplete">
              Still needed: {readiness.missing.join(", ")}.
            </p>
          ) : null}

          <div className="meridian-attach__actions">
            <button
              type="button"
              className="meridian-attach__submit"
              disabled={readiness.status !== "ready" || props.isSubmitting === true}
              aria-busy={props.isSubmitting === true}
              onClick={props.onSubmit}
            >
              Attach
            </button>
          </div>

          {props.refusal === undefined ? null : <RefusalCard {...props.refusal} />}
          {props.confirmation === undefined ? null : (
            <AttachConfirmation confirmation={props.confirmation} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function armLabel(arm: AttachArm): string {
  return arm === "definition" ? "From a definition" : "Spell it out";
}

/** The definition arm's picker, with the whole definition folded into one line. */
function DefinitionPicker(props: {
  readonly form: AttachSidekickForm;
  readonly definitions: PushDrivenReadState<SidekickDefinitionListReading>;
}): React.JSX.Element {
  const { definitions, form } = props;
  if (definitions.kind === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading the definitions" />;
  }
  if (definitions.kind === "failed") {
    // Not reachable through the arm button, which is disabled in this state; kept
    // because a read can fail while the arm is already selected.
    return <RefusalCard {...definitions.refusal} />;
  }
  const rows = definitions.value.definitions;
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="No sidekick definitions exist yet."
        detail="Spelling out a driver and a model attaches an agent without one."
      />
    );
  }
  return (
    <ul className="meridian-attach__definitions">
      {rows.map((definition) => (
        <li key={definition.definitionId} className="meridian-attach__definition">
          <button
            type="button"
            className="meridian-attach__definition-button"
            aria-pressed={form.definition?.definitionId === definition.definitionId}
            onClick={() => form.selectDefinition(definition)}
          >
            <span className="meridian-attach__definition-name">
              {definition.name ?? definition.definitionId}
            </span>
            <span className="meridian-attach__definition-summary">
              {[definition.driverName, definition.modelId, definition.effort]
                .filter((axis): axis is string => axis !== undefined)
                .join(" · ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The reply, as applied. Every axis the daemon resolved, and no row it did not. */
function AttachConfirmation(props: {
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
