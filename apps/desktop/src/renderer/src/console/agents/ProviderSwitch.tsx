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

import { useState } from "react";

import { Nothing, RefusalCard } from "../primitives/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import type { PushDrivenReadState } from "../collaboration/push-driven-read.js";
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

export interface ProviderSwitchProps {
  readonly agent: AgentRosterEntry;
  readonly catalog: PushDrivenReadState<DriverCatalogReading>;
  /** Submits `agent.configUpdate`. The immediate arm dispatches the interrupt. */
  readonly onApply: (axes: AxisDraft, interruptAndSwitch: boolean) => void;
  /** The reply's `switch` member. Its presence is the wire's switch discriminator. */
  readonly settlement?: AgentSwitchSettlement | undefined;
  readonly refusal?: ConsoleRefusal | undefined;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function ProviderSwitch(props: ProviderSwitchProps): React.JSX.Element {
  const { agent, catalog } = props;
  const [draft, setDraft] = useState<AxisDraft>({});
  const editedAxes = Object.keys(draft) as ProviderAxis[];
  const catalogValue = catalog.kind === "loaded" ? catalog.value : undefined;

  const targetDriver = draft.driverName ?? agent.driverName;
  const targetModel = draft.modelId ?? agent.modelId;
  const setAxis = (axis: ProviderAxis, value: string | undefined): void => {
    setDraft((previous) => {
      const next: AxisDraft = { ...previous };
      if (value === undefined || value === "") {
        delete next[axis];
      } else {
        next[axis] = value;
      }
      return next;
    });
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
        options={
          mayMutateModel
            ? modelsFor(catalogValue, targetDriver).map((model) => model.id)
            : undefined
        }
        value={targetModel}
        onValueChange={(next) => setAxis("modelId", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Effort"
        options={
          mayMutateModel ? effortLevelsFor(catalogValue, targetDriver, targetModel) : undefined
        }
        value={draft.effort ?? agent.config?.effort}
        onValueChange={(next) => setAxis("effort", next)}
        overlayContainer={props.overlayContainer}
      />
      <AxisCombobox
        label="Output speed"
        options={mayMutateSpeed ? outputSpeedLevelsFor(catalogValue, targetDriver) : undefined}
        value={draft.outputSpeed ?? agent.config?.outputSpeed}
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

      {editedAxes.length === 0 ? null : (
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
          <div className="meridian-switch__actions">
            <button
              type="button"
              className="meridian-switch__apply"
              onClick={() => props.onApply(draft, false)}
            >
              Switch at the next boundary
            </button>
            <button
              type="button"
              className="meridian-switch__apply"
              onClick={() => props.onApply(draft, true)}
            >
              Switch now, interrupting the run
            </button>
          </div>
        </>
      )}

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
