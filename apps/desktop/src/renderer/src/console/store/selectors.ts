// The narrow reads a surface is allowed to make of a session store's state.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules, rule 6: a store is read
// through its selector and never by reaching into its state. These are those
// selectors, and they are narrow on purpose — a whole-partition or single-entity
// pick, never a composed whole-pane object, so `useSyncExternalStore`'s equality
// check bails on `Object.is` for every kind the last transition did not touch.
//
// WHY A SELECTOR MAY NAME A WIRE MEMBER WHERE A PROJECTOR MAY NOT. `entities.ts`
// frames `ConsoleSessionEvent` as a renderer-local projection contract so this
// family holds no wire knowledge, and `frame/run-lifecycle-projector.ts` lives
// where it does for that reason. A projector is the other half of that seam: it
// CHOOSES the mapping from a payload into a body and is registered by the
// composition root, which puts it at or below the frame. A selector chooses
// nothing — it reads a member some projector already wrote, and its job is to
// refuse to hand a surface a value that is not the shape the surface's type says
// it is. So the body read below names a member and then VALIDATES it, and it
// decides nothing about what any event means.
//
// THE BODY READ BELOW RETURNS A STORED REFERENCE, never a value
// built per call, so it stays usable inside a `useStore` selector: the posture
// read answers the stored object it narrowed rather than a copy of it.

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ConsoleEntity, ConsoleEntityKind, ConsoleEntityRef } from "./entities.js";
import type { SessionStoreState } from "./session-state.js";

/** Every entity of one kind. A narrow pick, never a whole-pane object. */
export function selectPartition(
  state: SessionStoreState,
  kind: ConsoleEntityKind,
): Readonly<Record<string, ConsoleEntity>> {
  return state.partitions[kind];
}

/** One entity, or `undefined` when the store has never seen it. */
export function selectEntity(
  state: SessionStoreState,
  ref: ConsoleEntityRef,
): ConsoleEntity | undefined {
  return state.partitions[ref.kind][ref.id];
}

/**
 * The execution posture the daemon stamped on a run, or `undefined`.
 *
 * WHY THIS IS A SELECTOR AND NOT A SECOND SUBSCRIPTION. `run.running` is an
 * ordinary session event: it reaches this store through the apply chokepoint like
 * every other one, and `Spec-006 §Run Lifecycle (run_lifecycle)` puts
 * `executionPosture` on that durable payload, stamped on `run.running` alone —
 * the post-setup-gate transition where the resolved root and effective posture are
 * final. So the posture a surface wants is already in the run's body by the time
 * the run is on screen, and opening `run.subscribeState` to obtain it would be a
 * second stream of the same fact: two arrival paths, two orderings, and no way to
 * say which one is right when they disagree. That subscription's projection is a
 * different shape for a different job (a live run-state feed), not a second source
 * for this member.
 *
 * `undefined` for an absent member and equally for one this module cannot
 * validate — never a default. A posture is a permission surface, and a surface
 * that rendered a stand-in for one would be asserting what a run was allowed to do
 * on evidence it does not have. Absent reads as the "not checked" kind of nothing;
 * a default would read as a checked answer.
 *
 * WHAT THE PROJECTOR STILL OWES. This selector reads the run entity's body; the
 * projector is what puts a payload member there. `frame/run-lifecycle-projector.ts`
 * claims every `run_lifecycle` kind and today keeps four members —
 * `runVersion`, the two state strings, and `agentId` — so the stamped posture does
 * not reach the run partition at all, and this selector answers `undefined` for
 * every run in a live session. The read is correct and the path is incomplete: the
 * projector has to carry the registered owner-defined members of the payloads it
 * claims, and the end-to-end assertion belongs with that change. The cases below
 * build a body from a `run.running` payload directly for exactly that reason —
 * driving them through the projector would make this module's test fail for the
 * projector's gap and pass again the day the gap closes, which tests the wrong
 * module in both directions.
 */
export function stampedExecutionPostureOf(
  entity: ConsoleEntity | undefined,
): ExecutionPosture | undefined {
  const stamped = entity?.body?.[STAMPED_EXECUTION_POSTURE_MEMBER];
  return isExecutionPosture(stamped) ? stamped : undefined;
}

/**
 * The body member `run.running` stamps the posture on, spelled as the registered
 * shape spells it.
 *
 * Read off `packages/contracts/src/runControl.ts` — `RunStateChangeEvent`'s
 * `executionPosture?`, whose comment records the same stamping rule Spec-006's
 * run-lifecycle payload does. `event.ts` is deliberately not the source here: it
 * registers no `run.running` payload variant at all and the string appears nowhere
 * in it, so the name would have had to be invented from that file rather than
 * read.
 */
const STAMPED_EXECUTION_POSTURE_MEMBER = "executionPosture";

/**
 * The posture's mode arms, split by whether the contract requires a
 * credential-policy reference alongside them.
 *
 * WHY THIS MODULE NARROWS BY HAND INSTEAD OF PARSING. `@ai-sidekicks/contracts`
 * exports the `ExecutionPosture` TYPE and no parser for it: `runControl.ts` keeps
 * `executionPostureSchema` module-private on purpose, because exporting one there
 * would claim a Plan-005 symbol name in this package's barrel, and
 * `provider-driver.ts` — which owns the type — ships none either. The only
 * reachable parse runs inside `RunStateChangeEventSchema`, over a whole
 * subscription event this store never holds. So the choice is between trusting an
 * `unknown` body member and checking it here; a permission surface rendered off an
 * unchecked shape is the worse of the two.
 *
 * The two annotations below fail the build if the contract RENAMES or REMOVES a
 * mode. A contract that adds one fails closed at runtime instead — an unknown mode
 * reads as absent, and the surface renders "not checked" rather than a posture it
 * could not classify. That asymmetry is the same one `runControl.ts` records about
 * its own `z.ZodType<ExecutionPosture>` annotation, and it is stated rather than
 * hidden. The day contracts exports a parser, everything below `isExecutionPosture`
 * is deleted and the selector calls it.
 */
const CREDENTIAL_POLICY_FREE_MODES = [
  "trusted",
] as const satisfies readonly ExecutionPosture["mode"][];

const CREDENTIAL_POLICY_BEARING_MODES = [
  "workspace-sandboxed",
  "readonly-sandboxed",
] as const satisfies readonly ExecutionPosture["mode"][];

/** Network arms that carry no domain allow-list, spelled as the contract spells them. */
const UNLISTED_NETWORK_ACCESS = [
  "none",
  "full",
] as const satisfies readonly ExecutionPosture["networkAccess"][];

/** The network arm whose allow-list is non-empty by construction. */
const LISTED_NETWORK_ACCESS = "allowed-domains" satisfies ExecutionPosture["networkAccess"];

/**
 * Whether an unknown value is a well-formed `ExecutionPosture`.
 *
 * Both of the contract's structural invariants are checked, because both are what
 * make a posture readable at all: `allowedDomains` exists only under the
 * allow-list arm and is non-empty there, and `credentialPolicyRef` is required on
 * the two sandboxed modes and absent under `trusted`. A value satisfying the
 * member types but violating an arm is not a posture the contract can produce, and
 * admitting one would put a surface in the position of rendering a trusted run
 * that also claims an enforced credential constraint.
 */
function isExecutionPosture(candidate: unknown): candidate is ExecutionPosture {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return false;
  }
  const posture = candidate as Record<string, unknown>;
  return (
    isStringArray(posture["writableRoots"]) &&
    isAbsentOrString(posture["profileName"]) &&
    hasWellFormedNetworkArm(posture) &&
    hasWellFormedModeArm(posture)
  );
}

function hasWellFormedNetworkArm(posture: Record<string, unknown>): boolean {
  const networkAccess = posture["networkAccess"];
  const allowedDomains = posture["allowedDomains"];
  if (isMemberOf(UNLISTED_NETWORK_ACCESS, networkAccess)) {
    return allowedDomains === undefined;
  }
  return (
    networkAccess === LISTED_NETWORK_ACCESS &&
    isStringArray(allowedDomains) &&
    allowedDomains.length > 0
  );
}

function hasWellFormedModeArm(posture: Record<string, unknown>): boolean {
  const mode = posture["mode"];
  const credentialPolicyRef = posture["credentialPolicyRef"];
  if (isMemberOf(CREDENTIAL_POLICY_FREE_MODES, mode)) {
    return credentialPolicyRef === undefined;
  }
  return (
    isMemberOf(CREDENTIAL_POLICY_BEARING_MODES, mode) && typeof credentialPolicyRef === "string"
  );
}

function isMemberOf(members: readonly string[], candidate: unknown): boolean {
  return typeof candidate === "string" && members.includes(candidate);
}

function isStringArray(candidate: unknown): candidate is readonly string[] {
  return Array.isArray(candidate) && candidate.every((element) => typeof element === "string");
}

function isAbsentOrString(candidate: unknown): boolean {
  return candidate === undefined || typeof candidate === "string";
}
