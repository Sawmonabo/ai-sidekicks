// The entity-body member a surface may only have after it has been checked.
//
// WHY IT LIVES IN THE BRIDGE AND NOT BESIDE THE STORE'S OTHER SELECTORS. The read
// takes a member some projector wrote into an entity body — an untyped record — and
// answers a REGISTERED wire shape, so it has to narrow `unknown` against the shape
// the corpus registers rather than against a mirror of it. A mirror is what stood
// here before and it is exactly what the console's schema chokepoint forbids above
// this family: the hand-written narrowing checked what its author remembered to
// check, and admitted an empty or NUL-bearing `credentialPolicyRef`, an empty
// writable-root path, a whitespace-only `profileName`, and any unregistered member
// beside them — every one a value the contract refuses outright — then handed the
// result to a surface as a valid permission posture.
//
// So the read sits where the canonical shapes may be imported. That is not a
// relocation of convenience: `store/` is BELOW `bridge/` on the console DAG, so a
// store module cannot reach this narrowing by import at all, and the seam that
// carries one downward is a parameter.
//
// IT RETURNS A STORED REFERENCE, never a value built per call, so it stays usable as
// a `useStore` selector: the read returns the stored object it narrowed rather than a
// copy of it.

import { RunStateChangeEventSchema } from "@ai-sidekicks/contracts";
import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "../../store/index.js";

/**
 * The execution posture the daemon stamped on a run, or `undefined`.
 *
 * WHY THIS IS A READ AND NOT A SECOND SUBSCRIPTION. `run.running` is an
 * ordinary session event: it reaches this store through the apply chokepoint like
 * every other one, and the run-lifecycle payload carries `executionPosture` on that
 * durable body, stamped on `run.running` alone —
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
 * projector is what puts a payload member there. `frame/run-projection/run-lifecycle-projector.ts`
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
 * The body member `run.running` stamps the posture on, spelled as the registered
 * shape spells it.
 *
 * Read off `packages/contracts/src/runControl.ts` — `RunStateChangeEvent`'s
 * `executionPosture?`, whose comment records the same stamping rule the
 * run-lifecycle payload does. `event.ts` is deliberately not the source here: it
 * registers no `run.running` payload variant at all and the string appears nowhere
 * in it, so the name would have had to be invented from that file rather than
 * read.
 */
const STAMPED_EXECUTION_POSTURE_MEMBER = "executionPosture";

/**
 * The five members the registered event requires beside the posture.
 *
 * Placeholders, every one: they are never read, never rendered, and never sent.
 * They exist because the only reachable parse for a posture is declared per EVENT
 * and is strict, so the posture cannot be presented to it on its own — the same
 * constraint `bridge/scenario/wire-truth/wire-truth.ts` records about having to present a
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
 * driver-owned symbol name in this package's barrel, and `provider-driver.ts` —
 * which owns the type — ships none either. `RunStateChangeEventSchema` is the one
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
