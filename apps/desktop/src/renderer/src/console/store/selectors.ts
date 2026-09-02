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
// it is. So the two body reads below name a member and then VALIDATE it, and
// neither of them decides what any event means.
//
// THE TWO BODY READS BELOW RETURN PRIMITIVES OR STORED REFERENCES, never a value
// built per call, so they stay usable as `useStore` selectors: `Object.is` on a
// string is value equality, and the posture read returns the stored object it
// narrowed rather than a copy of it.

import {
  MembershipRoleSchema,
  RunStateChangeEventSchema,
  type MembershipRole,
} from "@ai-sidekicks/contracts";
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
  return isRegisteredExecutionPosture(stamped) ? stamped : undefined;
}

/**
 * The membership role the roster carries for one participant, or `undefined`.
 *
 * `bridge/growth-signatures.ts` states the reasoning this selector is the other
 * half of: the session's participant roster already carries every member's role,
 * so a role member on the caller-identity read would be a second source of truth
 * for a fact this partition owns — and the two could disagree with nothing able to
 * say which was right. What no registered read supplies is which entry in the
 * roster this window IS; given that, the role is this lookup.
 *
 * `undefined` when the participant is not in the partition and equally when the
 * entry carries no parseable role. Never a default role: an unread role rendered
 * as `viewer` would hide a control an owner is entitled to, and one rendered as
 * `owner` would offer a control the daemon will refuse.
 *
 * Takes the STATE rather than the store, unlike the signature a caller might
 * expect: `session-store.ts` re-exports this module, so naming `SessionStore` here
 * — even as a type, which the layering gate resolves like any other edge — would
 * close an import cycle. Taking the state is also what makes it usable as a
 * `useStore` selector, which is how a component is supposed to reach it.
 */
export function membershipRoleOf(
  state: SessionStoreState,
  participantId: string,
): MembershipRole | undefined {
  const participant = state.partitions.participant[participantId];
  const parsed = MembershipRoleSchema.safeParse(participant?.body?.[MEMBERSHIP_ROLE_MEMBER]);
  return parsed.success ? parsed.data : undefined;
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

/** The body member a participant entry carries its role on, spelled as the roster spells it. */
const MEMBERSHIP_ROLE_MEMBER = "role";

/**
 * The five members the registered event requires beside the posture.
 *
 * Placeholders, every one: they are never read, never rendered, and never sent.
 * They exist because the only reachable parse for a posture is declared per EVENT
 * and is strict, so the posture cannot be presented to it on its own — the same
 * constraint `bridge/scenarios/wire-truth.ts` records about having to present a
 * beat as the whole envelope it claims to be.
 *
 * A member added to the registered event would make this carrier stop parsing and
 * every posture read as absent, so the carrier's own admissibility is asserted
 * directly in this module's test rather than only through a posture case.
 */
const POSTURE_CARRIER_MEMBERS = {
  runId: "00000000-0000-4000-8000-000000000000",
  runVersion: 0,
  previousState: "queued",
  currentState: "starting",
  timestamp: "1970-01-01T00:00:00.000Z",
} as const;

/**
 * Whether an unknown value is a posture the registered shape admits.
 *
 * WHY THE PARSE RUNS THROUGH AN EVENT. `@ai-sidekicks/contracts` exports the
 * `ExecutionPosture` TYPE and no parser for it: `runControl.ts` keeps its posture
 * schema module-private on purpose, because exporting one there would claim a
 * Plan-005 symbol name in this package's barrel, and `provider-driver.ts` — which
 * owns the type — ships none either. `RunStateChangeEventSchema` is the one
 * exported shape that composes that schema, so running it over a fixed carrier is
 * the only way to reach the canonical parse, and reaching it is worth a carrier.
 *
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS NOT COSMETIC. This module used to
 * narrow by hand — member types plus the two arm invariants — which is a mirror of
 * a shape rather than the shape. A mirror checks what its author remembered to
 * check, and this one checked neither the wire string rules nor the strictness the
 * contract composes through: an empty or NUL-bearing `credentialPolicyRef`, an
 * empty writable-root path, a whitespace-only `profileName`, and any unregistered
 * member alongside them were all admitted and handed to a surface as a valid
 * permission posture. Every one of those is a value the contract refuses outright.
 *
 * `undefined` is excluded here rather than left to the parse: the posture member is
 * optional on the registered event, so a carrier with no posture parses cleanly,
 * and an absent member must read as absent rather than as admitted.
 */
function isRegisteredExecutionPosture(candidate: unknown): candidate is ExecutionPosture {
  if (candidate === undefined) {
    return false;
  }
  return RunStateChangeEventSchema.safeParse({
    ...POSTURE_CARRIER_MEMBERS,
    executionPosture: candidate,
  }).success;
}
