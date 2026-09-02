// Moving a running agent's provider, account, model, effort, or output speed.
//
// FIVE AXES ON ONE MUTATION, and the daemon decides where each lands. `driverName`
// and `providerAccountId` are spawn-bound on every driver because a run's account is
// bound for the run's lifetime; `outputSpeed` is spawn-bound too; `modelId` and
// `effort` are per-turn on one provider and spawn-bound on the other. So the
// BOUNDARY IS QUOTED FROM THE REPLY and never predicted here — a multi-axis update
// takes the widest of them, which is a fact about the target driver's declared
// vocabulary that this form does not hold.
//
// AN OMITTED AXIS MEANS UNCHANGED, WHICH IS WHY A DRIVER MOVE CLEARS THE AXES THAT
// DRIVER GOVERNS. `modelId` and `effort` are per driver and per model — an effort
// vocabulary is the MODEL's own — and `outputSpeed` is declared by the driver or not
// at all. Carrying any of them across a driver change would submit a value the target
// driver never published, and submitting `{ driverName }` alone would leave the
// daemon validating the OLD model against the NEW driver, which is a refusal on the
// most ordinary cross-provider move there is. So the draft drops them in the same act
// that moves the driver, and the actions stay out of reach until a model in the
// target driver's own catalog is named.
//
// THREE CONTROLS THIS SURFACE DELIBERATELY DOES NOT HAVE
//
//   • No CLEAR on any provider axis. No operation returns one to a driver default,
//     so a reset control would have nothing behind it — and drawing one disabled
//     would assert that the operation exists and is momentarily unavailable.
//   • No CANCEL on a pending switch. The wire carries supersession and no cancel
//     verb; submitting again is how a pending intent is displaced, and this form
//     says so and names the id being displaced.
//   • No control for an axis whose capability flag is `false`. Absent rather than
//     disabled, for the reason above (`Spec-023 §Console Design (Meridian)` §The eight
//     rules, restated for these axes in the composer).
//
// AND ONE IT DOES: `interruptAndSwitch`, beside "switch at the next boundary",
// labelled with what it actually does — it dispatches the EXISTING `interrupt`
// intervention on the target run. It is not a sixth run control and the closed run
// control set does not move.

import { useReducer } from "react";

import { Nothing, RefusalCard } from "../primitives/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import type { PushDrivenReadState } from "../seats/index.js";
import { AxisCombobox } from "./AxisCombobox.js";
import {
  capabilityFlagFor,
  driverNamesOf,
  effortLevelsFor,
  modelsFor,
  outputSpeedLevelsFor,
  type DriverCatalogReading,
} from "./driver-catalog.js";
import { SwitchSettlementLine } from "./SwitchSettlementLine.js";
import type { AgentRosterEntry, AgentSwitchSettlement, ProviderAxis } from "./agent-wire.js";

type AxisDraft = Partial<Record<ProviderAxis, string>>;

const EMPTY_DRAFT: AxisDraft = {};

/**
 * The axes the driver governs, which a driver move therefore invalidates.
 *
 * `modelId` is drawn from the driver's own catalog, `effort` from the chosen MODEL's
 * published vocabulary, and `outputSpeed` from the driver's declared level set. None
 * of the three survives a move to a provider that published none of them.
 */
const DRIVER_GOVERNED_AXES = ["modelId", "effort", "outputSpeed"] as const;

interface AxisDraftEdit {
  readonly axis: ProviderAxis;
  readonly value: string | undefined;
  /** The binding the agent runs under now — what a draft driver is a move AWAY from. */
  readonly agentDriverName: string | undefined;
}

/**
 * One edit, with the driver's own consequence applied in the same act.
 *
 * A reducer rather than three branches around a `useState` setter: the clearing rule
 * is a property of the edit and not of the render that happens to follow it, and a
 * render-body recomputation would leave the draft and what is submitted disagreeing.
 */
function applyAxisDraftEdit(previous: AxisDraft, edit: AxisDraftEdit): AxisDraft {
  const next: AxisDraft = { ...previous };
  if (edit.value === undefined || edit.value === "") {
    delete next[edit.axis];
  } else {
    next[edit.axis] = edit.value;
  }
  if (edit.axis !== "driverName") {
    return next;
  }
  const previousTargetDriver = previous.driverName ?? edit.agentDriverName;
  const nextTargetDriver = next.driverName ?? edit.agentDriverName;
  if (nextTargetDriver === previousTargetDriver) {
    return next;
  }
  for (const governedAxis of DRIVER_GOVERNED_AXES) {
    delete next[governedAxis];
  }
  return next;
}

/**
 * What the two actions actually put on the wire.
 *
 * A retained axis the TARGET driver cannot take is dropped rather than submitted: a
 * speed the target declares no flag for refuses `driver.capability_unsupported`, and
 * an effort outside the target model's own published vocabulary refuses as an invalid
 * axis. Dropping is the honest move because neither control is drawn in that state,
 * so there is nothing on screen the caller could be said to have chosen.
 */
function submittableAxes(
  draft: AxisDraft,
  catalog: DriverCatalogReading,
  targetDriver: string | undefined,
  targetModel: string | undefined,
): AxisDraft {
  const axes: AxisDraft = { ...draft };
  if (
    axes.outputSpeed !== undefined &&
    capabilityFlagFor(catalog, targetDriver, "output_speed") !== true
  ) {
    delete axes.outputSpeed;
  }
  const targetEffortLevels = effortLevelsFor(catalog, targetDriver, targetModel);
  if (axes.effort !== undefined && !(targetEffortLevels ?? []).includes(axes.effort)) {
    delete axes.effort;
  }
  return axes;
}

export interface ProviderSwitchProps {
  readonly agent: AgentRosterEntry;
  readonly catalog: PushDrivenReadState<DriverCatalogReading>;
  /** Submits `agent.configUpdate`. The immediate arm dispatches the interrupt. */
  readonly onApply: (axes: AxisDraft, interruptAndSwitch: boolean) => void;
  /**
   * Whether a mutation on this agent's binding is outstanding.
   *
   * This form owns no latch — the caller performs the call and holds it — but it
   * owes the participant that the controls SAY so: disabled, because a press that
   * the latch will refuse is not offered silently, and `aria-busy`, because a
   * screen reader is told the act is under way rather than handed a dead control.
   */
  readonly isSubmitting?: boolean | undefined;
  /** The reply's `switch` member. Its presence is the wire's switch discriminator. */
  readonly settlement?: AgentSwitchSettlement | undefined;
  readonly refusal?: ConsoleRefusal | undefined;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function ProviderSwitch(props: ProviderSwitchProps): React.JSX.Element {
  const { agent, catalog } = props;
  const [draft, editDraft] = useReducer(applyAxisDraftEdit, EMPTY_DRAFT);
  const catalogValue = catalog.kind === "loaded" ? catalog.value : undefined;

  const targetDriver = draft.driverName ?? agent.driverName;
  // A driver move makes the agent's own model, effort, and speed descriptions of a
  // binding that no longer applies, so they stop standing in as the field's value.
  const driverMoved = draft.driverName !== undefined && draft.driverName !== agent.driverName;
  const targetModel = draft.modelId ?? (driverMoved ? undefined : agent.modelId);
  const setAxis = (axis: ProviderAxis, value: string | undefined): void => {
    editDraft({ axis, value, agentDriverName: agent.driverName });
  };

  if (catalog.kind === "failed") {
    return <RefusalCard {...catalog.refusal} />;
  }
  if (catalogValue === undefined) {
    return <Nothing kind="not-loaded" title="Reading what this agent may be moved to" />;
  }

  // `model_mutation` gates the two per-turn axes and `output_speed` gates the speed
  // axis. An unanswered flag is treated exactly as a false one: the console asserts
  // no capability it was not told about, in either direction.
  const mayMutateModel = capabilityFlagFor(catalogValue, targetDriver, "model_mutation") === true;
  const mayMutateSpeed = capabilityFlagFor(catalogValue, targetDriver, "output_speed") === true;
  const targetModels = modelsFor(catalogValue, targetDriver);
  const submitted = submittableAxes(draft, catalogValue, targetDriver, targetModel);
  const hasEdit = Object.keys(submitted).length > 0;
  // The target driver has to be TOLD its model. An omitted axis is unchanged, so a
  // move that named no model would hand the daemon the previous driver's model.
  const needsTargetModel = driverMoved && !targetModels.some((model) => model.id === draft.modelId);

  return (
    <section className="meridian-switch" aria-label="Change the binding">
      <AxisCombobox
        label="Driver"
        options={driverNamesOf(catalogValue)}
        value={targetDriver}
        onValueChange={(next) => setAxis("driverName", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Model"
        options={mayMutateModel ? targetModels.map((model) => model.id) : undefined}
        value={targetModel}
        onValueChange={(next) => setAxis("modelId", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Effort"
        options={
          mayMutateModel ? effortLevelsFor(catalogValue, targetDriver, targetModel) : undefined
        }
        value={draft.effort ?? (driverMoved ? undefined : agent.config?.effort)}
        onValueChange={(next) => setAxis("effort", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Output speed"
        options={mayMutateSpeed ? outputSpeedLevelsFor(catalogValue, targetDriver) : undefined}
        value={draft.outputSpeed ?? (driverMoved ? undefined : agent.config?.outputSpeed)}
        onValueChange={(next) => setAxis("outputSpeed", next)}
        overlayContainer={props.overlayContainer}
      />
      <label className="meridian-axis-field">
        <span className="meridian-axis-field__label">Provider account</span>
        <input
          className="meridian-axis-field__text"
          value={draft.providerAccountId ?? agent.config?.providerAccountId ?? ""}
          onChange={(event) => setAxis("providerAccountId", event.target.value)}
        />
      </label>

      {hasEdit ? (
        <>
          {/* Told, not consented to twice: the rule is that the participant knows,
              and no axis is exempt from the assumption. */}
          <p className="meridian-switch__cache-note">
            Every switch is assumed to lose the provider-side prompt cache. No axis is exempt.
          </p>
          {agent.pendingSwitch === undefined ? null : (
            <p className="meridian-switch__supersedes">
              Submitting supersedes the switch already pending, {agent.pendingSwitch.switchId},
              which then reaches no settlement of its own.
            </p>
          )}
          {needsTargetModel ? (
            <p className="meridian-switch__driver-move">
              An omitted axis means unchanged, so a move to another provider has to name the model
              it moves to.
            </p>
          ) : null}
          <div className="meridian-switch__actions">
            <button
              type="button"
              className="meridian-switch__apply"
              disabled={needsTargetModel || props.isSubmitting === true}
              aria-busy={props.isSubmitting === true}
              onClick={() => props.onApply(submitted, false)}
            >
              Switch at the next boundary
            </button>
            <button
              type="button"
              className="meridian-switch__apply"
              disabled={needsTargetModel || props.isSubmitting === true}
              aria-busy={props.isSubmitting === true}
              onClick={() => props.onApply(submitted, true)}
            >
              Switch now, interrupting the run
            </button>
          </div>
        </>
      ) : null}

      {props.refusal === undefined ? null : <RefusalCard {...props.refusal} />}
      {props.settlement === undefined ? null : (
        <SwitchSettlementLine
          settlement={props.settlement}
          agentLabel={agent.name ?? agent.agentId}
        />
      )}
    </section>
  );
}
