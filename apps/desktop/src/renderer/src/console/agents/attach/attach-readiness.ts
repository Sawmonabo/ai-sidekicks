// What a filled attach form still needs, and what it would send once it needs nothing.
//
// The RULE half of the attach form. `attach-model.ts` beside it holds the form: which
// arm is selected, which fields were explicitly entered, and what a field edit does to
// the entries below it. This module holds what those entries MEAN — the field
// vocabulary both arms are keyed by, the request the wire takes, and the reading that
// decides whether a form is submittable. They were one file and it was two jobs: the
// form is reviewed against what a caller may do to it, and the rule below is reviewed
// against what the daemon would refuse.
//
// PRESENCE IS NOT ENOUGH, AND NEITHER IS THE ENTERED HALF. Every axis of the RESOLVED
// chain has to be a member of the vocabulary its parent publishes, because the form's
// own field-edit chain cannot be the only guard: a catalog refresh can retire a model
// or an effort level under a form nobody touched, and an override lands in the middle
// of a chain whose other axes came from the definition. So this is a second reading of
// the same rule rather than a repetition of one act.
//
// A PURE FUNCTION OVER A READING rather than a method on the form, so the rule can be
// driven with a chain composed by hand — a state the form can reach only through a
// particular sequence of edits is one case here rather than a rehearsal.

import type { AgentAttachRequest } from "../../bridge/index.js";
import { PROVIDER_AXES, type ProviderAxis } from "../agent-wire.js";
import {
  unvouchedAxesOf,
  DEPENDENT_AXES,
  type DependentAxis,
  type ResolvedAxisChain,
} from "../dependent-axis-chain.js";
import type { DriverCatalogReading } from "../driver-catalog.js";

/** Which arm the caller is filling. The definition arm needs only an id. */
export const ATTACH_ARMS = ["definition", "inline"] as const;
export type AttachArm = (typeof ATTACH_ARMS)[number];

/**
 * The fields either arm may carry — the wire's own axis set less the one it cannot.
 *
 * A SUBTRACTION from {@link PROVIDER_AXES} rather than a list beside it, so a sixth
 * provider axis reaches this form's entered map, its per-field accessors, and the
 * request it composes through the filter and not through an edit here. `outputSpeed`
 * is the one exclusion because the attach request's configuration half is
 * `AgentResolvedConfiguration`, which carries no member for it — an attach stamps the
 * four snapshot axes and the speed axis is moved by `agent.configUpdate`.
 */
export type AttachField = Exclude<ProviderAxis, "outputSpeed">;
export const ATTACH_FIELDS: readonly AttachField[] = PROVIDER_AXES.filter(
  (axis): axis is AttachField => axis !== "outputSpeed",
);

/**
 * What each chain axis is called where the form says what is still needed.
 *
 * Words rather than field names, because this is read by a person: the chain rule
 * answers which axis no vocabulary carries and this says what to call it. The keys
 * are the chain's own, so an axis added there is a compile error here rather than an
 * axis that silently reports nothing.
 */
const UNVOUCHED_AXIS_WORDS: Record<DependentAxis, string> = {
  driverName: "a driver this catalog carries",
  modelId: "a model this driver carries",
  effort: "an effort this model carries",
};

/**
 * What the form would send, once it is complete: the wire's request, name required.
 *
 * DERIVED FROM THE REGISTERED REQUEST RATHER THAN RESTATED, for the reason
 * {@link AgentAttachRequest} gives on its own declaration: written out a second time,
 * the two drifted the first time an axis landed on one and not the other, and because
 * a hand-written copy is a structural SUBSET the compiler had nothing to say when the
 * form stopped being able to send an axis the wire had grown. What this adds is the
 * form's one narrowing — `name` is required here while the wire leaves it optional,
 * because a request missing it is refused by any conforming daemon whatever else it
 * carries. The session is not the form's to know: it is bound by the caller at
 * {@link attachReadinessFor}, and the name is the AGENT's rather than the
 * definition's, which is why no arm ever fills it in.
 */
export type AttachRequest = AgentAttachRequest & { readonly name: string };

export type AttachReadiness =
  | { readonly status: "ready"; readonly request: AttachRequest }
  | { readonly status: "incomplete"; readonly missing: readonly string[] };

/** One form, read as the rule below needs it: what was chosen, and what it resolves to. */
export interface AttachFormReading {
  readonly arm: AttachArm;
  /** Already trimmed by the form, because a name of spaces is not a name. */
  readonly name: string;
  readonly definitionId: string | undefined;
  /** Exactly the fields the caller explicitly entered, which is the merge signal. */
  readonly entered: Partial<Record<AttachField, string>>;
  /** Entry over definition, per field — the chain as the form DISPLAYS it. */
  readonly resolvedChain: ResolvedAxisChain;
}

/**
 * Which axes of a resolved chain no published vocabulary vouches for.
 *
 * The chain rule over one form's own resolved reading. Exported because the form
 * consults it on a field edit too: an entry the new vocabulary retires is dropped
 * there, and a rule read two ways would drop one entry and name another.
 */
export function unvouchedAttachAxes(
  reading: AttachFormReading,
  catalog: DriverCatalogReading | undefined,
): readonly DependentAxis[] {
  return unvouchedAxesOf(reading.resolvedChain, catalog);
}

/**
 * Which of those axes to NAME, as words a person reads.
 *
 * A form carrying no ENTRY among the three needs no catalog at all — which is what
 * keeps the definition arm submittable while the catalog read is still in flight,
 * since the daemon resolves a definition's own driver and model itself and a
 * definition is internally coherent by construction. The moment one IS entered the
 * whole chain is in question, because an entry can retire the vocabulary an inherited
 * axis was published under; an unread catalog is then named as the thing still missing
 * rather than treated as permission.
 */
function axesNoVocabularyCarries(
  reading: AttachFormReading,
  catalog: DriverCatalogReading | undefined,
): readonly string[] {
  if (!DEPENDENT_AXES.some((axis) => reading.entered[axis] !== undefined)) {
    return [];
  }
  if (catalog === undefined) {
    return ["the model catalog"];
  }
  return unvouchedAttachAxes(reading, catalog).map((axis) => UNVOUCHED_AXIS_WORDS[axis]);
}

/**
 * The request, or what is still missing.
 *
 * The definition arm sends the id plus ONLY the fields the caller entered, which is
 * what makes the merge per-field at the daemon rather than a whole-record replace
 * composed here.
 *
 * The session and the catalog are ARGUMENTS rather than form state: a form is opened
 * over whatever session the surface is showing and against whatever the catalog read
 * currently answers, and a copy of either held by the form would be a second answer to
 * a question the models already own.
 */
export function attachReadinessFor(
  reading: AttachFormReading,
  sessionId: string,
  catalog: DriverCatalogReading | undefined,
): AttachReadiness {
  const { name } = reading;
  const missing: string[] = [];
  if (name === "") {
    missing.push("a name");
  }
  const unvouched = axesNoVocabularyCarries(reading, catalog);
  if (reading.arm === "definition") {
    const { definitionId } = reading;
    if (definitionId === undefined) {
      missing.push("a definition");
    }
    missing.push(...unvouched);
    if (name === "" || definitionId === undefined || unvouched.length > 0) {
      return { status: "incomplete", missing };
    }
    return {
      status: "ready",
      request: { sessionId, name, definitionId, ...reading.entered },
    };
  }
  const driverName = reading.entered.driverName;
  const modelId = reading.entered.modelId;
  if (driverName === undefined) {
    missing.push("a driver");
  }
  if (modelId === undefined) {
    missing.push("a model");
  }
  missing.push(...unvouched);
  if (name === "" || driverName === undefined || modelId === undefined || unvouched.length > 0) {
    return { status: "incomplete", missing };
  }
  return {
    status: "ready",
    // The driver and model this arm requires are entered values, so the spread below
    // already carries them; naming them again here would be a second copy of the same
    // two members that could disagree with the first.
    request: { sessionId, name, ...reading.entered },
  };
}
