// The switch form's draft: one edit at a time, and what the agent would run under.
//
// A MODEL RATHER THAN A RENDER BODY, for the reason `apps/desktop/AGENTS.md` gives:
// the clearing and resolution rules below are properties of the EDIT and of the
// binding, not of the render that happens to follow one, and a body recomputing them
// would leave the draft and what is submitted free to disagree. The view composes
// controls over what this answers and decides nothing itself.
//
// AN OMITTED AXIS MEANS UNCHANGED. That one wire fact settles every rule here.
//
//   • A DRIVER MOVE CLEARS THE AXES THAT DRIVER GOVERNS, because `modelId`, `effort`,
//     and `outputSpeed` are published by the driver or its model and a provider
//     ACCOUNT belongs to one provider. Carried across, each would submit a value the
//     target never published; left out, the daemon would validate the OLD value
//     against the NEW driver. So they are dropped in the same act that moves the
//     driver, and the view holds its actions until the target's own are named.
//
//   • A MODEL CHANGE DROPS AN EFFORT THE NEW MODEL DOES NOT PUBLISH, which is the
//     attach form's own rule on the same two axes — an effort vocabulary is the
//     MODEL's, so choosing another model retires the vocabulary the drafted level
//     was chosen from. What cannot be dropped is the effort the AGENT runs under: it
//     is not in the draft, it rides the request as an omission, and the daemon
//     validates it against the new model and refuses. `dependent-axis-chain.ts`
//     names it, and the view holds the actions until a compatible one is chosen.
//
//   • WHICH IS WHY THE TARGET CHAIN RESOLVES `effort` FROM THE BINDING AND `modelId`
//     ONLY WHERE THE DRIVER HELD STILL. The two are asymmetric because the form is:
//     a driver move REQUIRES a model of the target driver, so the agent's own model
//     never rides such a request and does not stand in for one; nothing requires an
//     effort, so the agent's own is exactly what the switch would leave it running
//     under, and it is judged as such.
//
// THE CAPABILITY GATE IS SEPARATE FROM THE VOCABULARY RULE and stays here. A flag can
// go false under a draft nobody touched — a catalog refresh is enough — and an axis
// the target driver declares no capability for refuses outright rather than as an
// invalid value, so it is dropped at submission rather than held back: no control for
// it is drawn in that state, so there is nothing on screen the caller could be said
// to have chosen. A value the driver CAN take and this model cannot is the other
// rule's, and that one is held back rather than dropped, because the caller can see
// the control and can fix it.
//
// AND THE DRAFT IS STAMPED WITH THE BINDING IT WAS COMPOSED AGAINST. The view stays
// mounted while the agent it is about is re-read — a terminal event applying the
// switch, another participant moving the same agent — so an unstamped draft would go
// on taking precedence over values that had already moved, keep its actions offered,
// and submit a second switch that moved the agent BACK. A draft is a proposed
// difference from a binding, so when the binding moves the difference is recomputed
// against the new one: an axis the binding has caught up with stops being an edit and
// is dropped, and an axis still being edited is kept and re-validated. The stamp is
// ADVANCED rather than only compared, because a comparison against the binding a
// draft was born under cannot record that an axis was already settled — three moves
// later the same value would come back as an edit nobody made.

import { useReducer } from "react";

import { type AgentRosterEntry } from "../../bridge/index.js";
import { PROVIDER_AXES, type ProviderAxis } from "../agent-wire.js";
import {
  unvouchedAxesOf,
  DEPENDENT_AXES,
  type DependentAxis,
  type ResolvedAxisChain,
} from "../dependent-axis-chain.js";
import { capabilityFlagFor, type DriverCatalogReading } from "../driver-catalog.js";

/** The axes a caller has edited. Same shape as a binding, so the two compare key by key. */
export type AxisDraft = Partial<Record<ProviderAxis, string>>;

export const EMPTY_AXIS_DRAFT: AxisDraft = {};

/**
 * The axes the driver governs, which a driver move therefore invalidates.
 *
 * `modelId` is drawn from the driver's own catalog, `effort` from the chosen MODEL's
 * published vocabulary, and `outputSpeed` from the driver's declared level set. None
 * of the three survives a move to a provider that published none of them.
 *
 * `providerAccountId` is here for a different reason and the same consequence: an
 * account is registered against ONE provider and a run is bound to its account for
 * the run's lifetime, so the source provider's account is not a value the target can
 * take. Left in the draft it rode the request unchanged and the daemon had no answer
 * but to refuse it.
 */
const DRIVER_GOVERNED_AXES: readonly ProviderAxis[] = [
  "modelId",
  "effort",
  "outputSpeed",
  "providerAccountId",
];

/** The draft, with the binding it was composed against. */
export interface HeldAxisDraft {
  readonly binding: AxisDraft;
  readonly axes: AxisDraft;
}

/**
 * The two things that move a draft: a person editing one axis, and the binding itself
 * moving under it. Both carry the binding, because both are resolved against it.
 */
export type AxisDraftAction =
  | {
      readonly kind: "edit";
      readonly axis: ProviderAxis;
      readonly value: string | undefined;
      /** The binding the agent runs under now — what a draft is a move AWAY from. */
      readonly binding: AxisDraft;
      /** Judged against, never held: the catalog is a read the models own. */
      readonly catalog: DriverCatalogReading | undefined;
    }
  | { readonly kind: "rebase"; readonly binding: AxisDraft };

/**
 * The agent's effective binding as an axis record.
 *
 * Total over the closed axis set by construction, so an axis added to the mutation is
 * a compile error here rather than a value the binding silently stops carrying. An
 * absent axis stays absent: `undefined` is what "the provider's default", "never set",
 * and "not reported" all reach this form as, and none of them is a value to compare.
 */
export function bindingSnapshotOf(agent: AgentRosterEntry): AxisDraft {
  const effective: Record<ProviderAxis, string | undefined> = {
    driverName: agent.driverName,
    modelId: agent.modelId,
    providerAccountId: agent.config?.providerAccountId,
    effort: agent.config?.effort,
    outputSpeed: agent.config?.outputSpeed,
  };
  const snapshot: AxisDraft = {};
  for (const axis of PROVIDER_AXES) {
    const value = effective[axis];
    if (value !== undefined) {
      snapshot[axis] = value;
    }
  }
  return snapshot;
}

/** Whether this draft moves the agent to another provider. */
export function driverMovedIn(draft: AxisDraft, binding: AxisDraft): boolean {
  return draft.driverName !== undefined && draft.driverName !== binding.driverName;
}

/**
 * What the agent would run under once this draft is applied — see the header for why
 * the model and the effort resolve differently.
 */
export function targetChainOf(draft: AxisDraft, binding: AxisDraft): ResolvedAxisChain {
  const driverMoved = driverMovedIn(draft, binding);
  const resolved: Record<DependentAxis, string | undefined> = {
    driverName: draft.driverName ?? binding.driverName,
    modelId: draft.modelId ?? (driverMoved ? undefined : binding.modelId),
    effort: draft.effort ?? binding.effort,
  };
  const chain: ResolvedAxisChain = {};
  for (const axis of DEPENDENT_AXES) {
    const value = resolved[axis];
    if (value !== undefined) {
      chain[axis] = value;
    }
  }
  return chain;
}

/** Whether two readings of a binding are the same one, axis by axis. */
function isSameBinding(left: AxisDraft, right: AxisDraft): boolean {
  return PROVIDER_AXES.every((axis) => left[axis] === right[axis]);
}

/**
 * The draft as it stands against THIS binding.
 *
 * An axis the binding has caught up with is no longer a difference and stops being an
 * edit: its control returns to showing the agent's own value and, where it was the
 * only edit, the actions go away rather than offering a switch that would move
 * nothing. An axis that still differs is the participant's work and is kept.
 */
export function rebasedAxes(held: HeldAxisDraft, binding: AxisDraft): AxisDraft {
  if (isSameBinding(held.binding, binding)) {
    return held.axes;
  }
  const rebased: AxisDraft = {};
  for (const axis of PROVIDER_AXES) {
    const drafted = held.axes[axis];
    if (drafted !== undefined && drafted !== binding[axis]) {
      rebased[axis] = drafted;
    }
  }
  return rebased;
}

/** One action, rebased onto the binding it names and then applied. */
export function applyDraftAction(held: HeldAxisDraft, action: AxisDraftAction): HeldAxisDraft {
  const standing = rebasedAxes(held, action.binding);
  if (action.kind === "rebase") {
    return { binding: action.binding, axes: standing };
  }
  const next: AxisDraft = { ...standing };
  if (action.value === undefined || action.value === "") {
    delete next[action.axis];
  } else {
    next[action.axis] = action.value;
  }
  if (action.axis === "driverName") {
    const previousTargetDriver = standing.driverName ?? action.binding.driverName;
    const nextTargetDriver = next.driverName ?? action.binding.driverName;
    if (nextTargetDriver !== previousTargetDriver) {
      for (const governedAxis of DRIVER_GOVERNED_AXES) {
        delete next[governedAxis];
      }
    }
    return { binding: action.binding, axes: next };
  }
  if (
    action.axis === "modelId" &&
    next.effort !== undefined &&
    unvouchedAxesOf(targetChainOf(next, action.binding), action.catalog).includes("effort")
  ) {
    // The chosen model retires the vocabulary this level was chosen from — the same
    // act the attach form performs on the same pair of axes.
    delete next.effort;
  }
  return { binding: action.binding, axes: next };
}

/** What one mounted switch form holds: the binding it is about, and the edits on it. */
export interface ProviderSwitchDraft {
  readonly binding: AxisDraft;
  readonly axes: AxisDraft;
  readonly setAxis: (axis: ProviderAxis, value: string | undefined) => void;
}

/**
 * The draft for one agent, kept in step with the binding the roster reports.
 *
 * A hook rather than a render body, and a rebase taken DURING the render rather than
 * from an effect: an effect lands one committed frame later, and that frame is the
 * defect — the retired binding's draft over the arriving binding's values, with both
 * actions live. Dispatching during the render is React's own answer to state that has
 * to follow a prop; the render's output is discarded and re-run, so no such frame
 * exists. It settles after one pass, because the stamp it installs is the binding it
 * was compared against.
 */
export function useProviderSwitchDraft(
  agent: AgentRosterEntry,
  catalog: DriverCatalogReading | undefined,
): ProviderSwitchDraft {
  const [held, dispatch] = useReducer(applyDraftAction, agent, heldDraftFor);
  const binding = bindingSnapshotOf(agent);
  if (!isSameBinding(held.binding, binding)) {
    dispatch({ kind: "rebase", binding });
  }
  return {
    binding,
    // Read rather than awaited: the rebase above advances the STAMP, and this render
    // is entitled to the answer without waiting for the pass that records it.
    axes: rebasedAxes(held, binding),
    setAxis: (axis, value) => dispatch({ kind: "edit", axis, value, binding, catalog }),
  };
}

/** A form opened on an agent starts stamped with that agent's own binding. */
function heldDraftFor(agent: AgentRosterEntry): HeldAxisDraft {
  return { binding: bindingSnapshotOf(agent), axes: EMPTY_AXIS_DRAFT };
}

/**
 * What the two actions actually put on the wire.
 *
 * The CAPABILITY gate and nothing else: an axis the target driver declares no
 * capability for refuses outright, and a flag can go false under a draft nobody
 * touched. Whether a value is a member of a published vocabulary is the chain rule's
 * question, and its answer holds the actions back rather than reaching here.
 */
export function submittableAxes(
  draft: AxisDraft,
  catalog: DriverCatalogReading,
  targetDriver: string | undefined,
): AxisDraft {
  const axes: AxisDraft = { ...draft };
  if (capabilityFlagFor(catalog, targetDriver, "output_speed") !== true) {
    delete axes.outputSpeed;
  }
  if (capabilityFlagFor(catalog, targetDriver, "model_mutation") !== true) {
    delete axes.modelId;
    delete axes.effort;
  }
  return axes;
}
