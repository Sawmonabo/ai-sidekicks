// Fixtures for the hand-over brief's tests: canonical transcript turns and the request a render
// reads.

import {
  defaultBriefBudgetPolicy,
  type BriefBudgetPolicy,
  type BriefRenderRequest,
} from "../projection.js";
import { RUN_ID, SESSION_ID } from "../../__tests__/canonical-transcript.test-support.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../../../driver/contract.js";

/** A budget wide enough that the whole fixture fits, so eviction is opt-in per case. */
const ROOMY_BUDGET: BriefBudgetPolicy = defaultBriefBudgetPolicy(1_000_000);

// A fixture omits each segment's position: `turn` stamps the turn's position onto all of them, as
// the fold does. Distributive, because a bare `Omit` over a union keeps only the members its arms
// share and would let a `tool_call` fixture drop its identifier.
type WithoutPosition<TSegment> = TSegment extends unknown ? Omit<TSegment, "position"> : never;
/** A transcript segment as a fixture writes it, before `turn` stamps its position. */
export type TurnSegmentFixture = WithoutPosition<CanonicalTranscriptSegment>;

/** One turn at `position`, each segment stamped with it. */
export function turn(
  position: number,
  role: "user" | "assistant",
  segments: readonly TurnSegmentFixture[],
): CanonicalTranscriptTurn {
  return {
    position,
    role,
    segments: segments.map((segment): CanonicalTranscriptSegment => ({ ...segment, position })),
  };
}

/** A projection of `turns` in the fixture session and run. */
export function projectionOf(
  turns: readonly CanonicalTranscriptTurn[],
): CanonicalTranscriptProjection {
  return { sessionId: SESSION_ID, runId: RUN_ID, builtAtPosition: 100, turns };
}

/** A render request for `projection`, within `budget`. */
export function requestFor(
  projection: CanonicalTranscriptProjection,
  budget: BriefBudgetPolicy = ROOMY_BUDGET,
): BriefRenderRequest {
  return { projection, budget };
}
