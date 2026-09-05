// The one place a reported RUNTIME NODE STATE is read out of an event payload.
//
// WHY IT IS HERE AND NOT BESIDE THE FOLD THAT USES IT. `NodeState` is a registered
// wire vocabulary, and narrowing an untyped payload member against it means importing
// the contract's own schema — which the console admits in `bridge/` and nowhere else
// (`Spec-023 §Console Design (Meridian)`, the rule the schema chokepoint enforces).
// A view family that narrowed it itself would be writing a second copy of a closed
// set, and the copy that drifts is the one nothing parses against: this exact member
// is spelled `newState` on two DIFFERENT payload bases, and the reduced capability
// base carries `CapabilityDetails` snapshots under that name rather than node states.
// So the guard is the contract's, taken once.
//
// IT ANSWERS `undefined` RATHER THAN A DEFAULT. A member that failed to parse is a
// member this console cannot read, which is a different fact from every value in the
// vocabulary; the fold above turns it into its own "unknown" arm, and a stand-in
// state here would have that arm assert a reading nobody took.

import { NodeStateSchema } from "@ai-sidekicks/contracts";
import type { NodeState } from "@ai-sidekicks/contracts";

/** The reported node state a payload member carries, or `undefined` where it carries none. */
export function readNodeState(candidate: unknown): NodeState | undefined {
  const parsed = NodeStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
