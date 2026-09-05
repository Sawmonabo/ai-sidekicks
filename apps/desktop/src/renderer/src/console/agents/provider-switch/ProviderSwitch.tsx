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
// THE VIEW, AND ONLY THE VIEW. Which axes a draft clears, what the agent would run
// under once it is applied, and what reaches the wire are `provider-switch-draft.ts`'s
// — a model with its own suite, because those are properties of an EDIT rather than
// of the render that follows one. What is here is which controls exist, which reason
// is shown, and when the two actions may be pressed.
//
// AN OMITTED AXIS MEANS UNCHANGED, AND THAT CUTS BOTH WAYS. It is why a driver move
// clears the axes that driver governs — carrying them across submits a value the
// target never published — and it is equally why an axis the caller did NOT edit is
// still this form's problem: the request leaves it out, the daemon merges the agent's
// own value back in, and validates it against whatever the switch DID name. So the
// actions are held against the resolved chain rather than against the draft, and the
// reason names the axis that is wrong rather than reporting a refusal after the fact.
//
// THREE CONTROLS THIS SURFACE DELIBERATELY DOES NOT HAVE
//
//   • No CLEAR on any provider axis. No operation returns one to a driver default,
//     so a reset control would have nothing behind it — and drawing one disabled
//     would assert that the operation exists and is momentarily unavailable. Which
//     is also why a model publishing no effort at all is a dead end stated plainly
//     rather than an instruction the caller cannot follow.
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

import { useId } from "react";

import { Nothing, RefusalCard } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { AxisCombobox } from "../AxisCombobox.js";
import { unvouchedAxesOf, type DependentAxis } from "../dependent-axis-chain.js";
import {
  capabilityFlagFor,
  driverNamesOf,
  effortLevelsFor,
  modelsFor,
  outputSpeedLevelsFor,
  type DriverCatalogReading,
} from "../driver-catalog.js";
import {
  driverMovedIn,
  submittableAxes,
  targetChainOf,
  useProviderSwitchDraft,
  type AxisDraft,
} from "./provider-switch-draft.js";
import { SwitchSettlementLine } from "./SwitchSettlementLine.js";
import type { AgentRosterEntry, AgentSwitchSettlement } from "../../bridge/index.js";

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
   * the latch will refuse is not offered silently, `aria-busy`, because a screen
   * reader is told the act is under way rather than handed a dead control, and a
   * described REASON, because "busy" says the act is running and not why a second
   * one is not being taken.
   */
  readonly isSubmitting?: boolean | undefined;
  /** The reply's `switch` member. Its presence is the wire's switch discriminator. */
  readonly settlement?: AgentSwitchSettlement | undefined;
  readonly refusal?: ConsoleRefusal | undefined;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function ProviderSwitch(props: ProviderSwitchProps): React.JSX.Element {
  const { agent, catalog } = props;
  const submittingReasonId = useId();
  const isSubmitting = props.isSubmitting === true;
  const catalogValue = catalog.kind === "loaded" ? catalog.value : undefined;
  // The draft and the binding it is a difference FROM, kept in step by the hook: this
  // form stays mounted while the agent it is about is re-read, and a draft that
  // outlived the values it was composed against would submit a second switch.
  const { binding, axes: draft, setAxis } = useProviderSwitchDraft(agent, catalogValue);

  if (catalog.kind === "failed") {
    return <RefusalCard {...catalog.refusal} />;
  }
  if (catalogValue === undefined) {
    return <Nothing kind="not-loaded" title="Reading what this agent may be moved to" />;
  }

  const target = targetChainOf(draft, binding);
  const driverMoved = driverMovedIn(draft, binding);
  // `model_mutation` gates the two per-turn axes and `output_speed` gates the speed
  // axis. An unanswered flag is treated exactly as a false one: the console asserts
  // no capability it was not told about, in either direction.
  const mayMutateModel = capabilityFlagFor(catalogValue, target.driverName, "model_mutation");
  const mayMutateSpeed = capabilityFlagFor(catalogValue, target.driverName, "output_speed");
  const targetModels = modelsFor(catalogValue, target.driverName);
  const targetEffortLevels =
    mayMutateModel === true
      ? effortLevelsFor(catalogValue, target.driverName, target.modelId)
      : undefined;
  const submitted = submittableAxes(draft, catalogValue, target.driverName);
  const hasEdit = Object.keys(submitted).length > 0;
  // The target driver has to be TOLD its model. An omitted axis is unchanged, so a
  // move that named no model would hand the daemon the previous driver's model.
  const needsTargetModel = driverMoved && !targetModels.some((model) => model.id === draft.modelId);
  // And its account, but only where the agent HAS an explicit one: an omitted account
  // on an agent running under its provider's registered default is a move the daemon
  // resolves for itself, while an omitted account on an agent pinned to one means the
  // source provider's account, which the target cannot be run under.
  const needsTargetAccount =
    driverMoved && binding.providerAccountId !== undefined && draft.providerAccountId === undefined;
  // And every axis of the resolved chain has to be one a published vocabulary carries,
  // whether the caller set it or the agent arrived with it — see the header.
  const unvouchedAxes = unvouchedAxesOf(target, catalogValue);
  const heldBack = needsTargetModel || needsTargetAccount || unvouchedAxes.length > 0;

  return (
    <section className="meridian-switch" aria-label="Change the binding">
      <AxisCombobox
        label="Driver"
        options={driverNamesOf(catalogValue)}
        value={target.driverName}
        onValueChange={(next) => setAxis("driverName", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Model"
        options={mayMutateModel === true ? targetModels.map((model) => model.id) : undefined}
        value={target.modelId}
        onValueChange={(next) => setAxis("modelId", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Effort"
        options={targetEffortLevels}
        value={target.effort}
        advisory={
          unvouchedAxes.includes("effort")
            ? "Not one this model publishes. Choose a level it does."
            : undefined
        }
        onValueChange={(next) => setAxis("effort", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Output speed"
        options={
          mayMutateSpeed === true
            ? outputSpeedLevelsFor(catalogValue, target.driverName)
            : undefined
        }
        value={draft.outputSpeed ?? (driverMoved ? undefined : binding.outputSpeed)}
        onValueChange={(next) => setAxis("outputSpeed", next)}
        overlayContainer={props.overlayContainer}
      />
      <label className="meridian-axis-field">
        <span className="meridian-axis-field__label">Provider account</span>
        <input
          className="meridian-axis-field__text"
          // A driver move makes the agent's own account a description of a binding
          // that no longer applies, exactly as it does for the model above.
          value={draft.providerAccountId ?? (driverMoved ? "" : (binding.providerAccountId ?? ""))}
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
          {needsTargetAccount ? (
            <p className="meridian-switch__driver-move">
              This agent runs under an account of its current provider, and an account belongs to
              one provider — so a move to another has to name an account registered there.
            </p>
          ) : null}
          {unvouchedAxes.map((axis) => (
            <p key={axis} className="meridian-switch__driver-move">
              {unvouchedAxisReason(axis, targetEffortLevels)}
            </p>
          ))}
          {isSubmitting ? (
            <p className="meridian-switch__driver-move" id={submittingReasonId}>
              A change to this agent&apos;s binding is already outstanding. Nothing here cancels a
              request, so these controls take no second change until the daemon answers the first.
            </p>
          ) : null}
          <div className="meridian-switch__actions">
            <button
              type="button"
              className="meridian-switch__apply"
              disabled={heldBack || isSubmitting}
              aria-busy={isSubmitting}
              aria-describedby={isSubmitting ? submittingReasonId : undefined}
              onClick={() => props.onApply(submitted, false)}
            >
              Switch at the next boundary
            </button>
            <button
              type="button"
              className="meridian-switch__apply"
              disabled={heldBack || isSubmitting}
              aria-busy={isSubmitting}
              aria-describedby={isSubmitting ? submittingReasonId : undefined}
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

/**
 * Why one axis of the resolved chain holds the actions back.
 *
 * The effort arm splits on whether a vocabulary exists at all, because those are two
 * different situations for the person reading it: one is answered by choosing a level
 * and the other cannot be answered on this axis at all, and a form that said "choose
 * one" over a control it draws nowhere would be asking for an act it does not offer.
 */
function unvouchedAxisReason(
  axis: DependentAxis,
  targetEffortLevels: readonly string[] | undefined,
): string {
  switch (axis) {
    case "driverName":
      return "The catalog no longer carries this agent's driver, so nothing here can vouch for what it would be moved to.";
    case "modelId":
      return "The model this switch would leave the agent on is not one this driver's catalog carries, so the switch has to name one that is.";
    case "effort":
      return targetEffortLevels === undefined || targetEffortLevels.length === 0
        ? "This model publishes no effort at all, and an omitted axis means unchanged — so the effort this agent runs under would follow it there. Nothing here clears an axis."
        : "The effort this agent runs under is not one this model publishes, and an omitted axis means unchanged — so this switch has to name one that is.";
  }
}
