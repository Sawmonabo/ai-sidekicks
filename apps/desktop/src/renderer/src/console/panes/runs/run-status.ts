// The run-status vocabulary: the nine states, the subtypes derived from a
// transition, and the words the pane puts beside a wire figure.
//
// `Spec-023 §Console Design (Meridian)` §7.1 fixes two rules this module encodes.
//
//   • **The status vocabulary is `RunState` verbatim.** Nine members, and the
//     canonical failure terminal is `failed`. `errored` is a gloss the enum does
//     not carry and no chip here can produce one, because every chip's label is
//     the wire string itself.
//   • **Waiting is not pausing.** `waiting_for_approval` and `waiting_for_input`
//     are states in themselves and read as blocked-on-someone. That distinction is
//     the reason `RUN_STATE_TONES` is a total record rather than a two-way split
//     on "is it running": a table with a fallback would have quietly grouped them
//     with `paused` the first time somebody added a state.
//
// WHY THE SUBTYPE IS DERIVED AND NOT READ. §7.1's table gives seven run-state
// subtypes with a SOURCE CONDITION for each — "run transitions to `paused`",
// "run transitions from `paused` to `running`", "run enters `waiting_for_*`". Four
// of those names (`run.resumed`, `run.blocked`, `run.unblocked`, and the two
// `agent.provider_switch*` rows) are NOT members of the registered
// `SessionEventType` census in `packages/contracts/src/event.ts`, so a pane that
// rendered them as wire kinds would be publishing event-type strings the corpus
// does not carry. The condition, however, is exactly a `(previousState,
// currentState)` pair, which `RunStateChangeEvent` does carry — so the subtype is
// COMPUTED from the transition and rendered as the console's own derived phrase,
// with the two wire states shown verbatim beside it.

import type { RunState, RunStateChangeEvent } from "@ai-sidekicks/contracts";
import type { ChipTone, GlyphName } from "../../primitives/index.js";

/**
 * What a transition means, as §7.1's table names it.
 *
 * Closed, and declared once — the union is derived from the tuple rather than
 * written beside it. `transitioned` is the honest residue: a pair the table names
 * no subtype for is a state change and nothing more, and inventing a sixth mark
 * for it would be the console adding a meaning the design did not give it.
 */
export const RUN_STATUS_SUBTYPES = [
  "paused",
  "resumed",
  "blocked",
  "unblocked",
  "rewound",
  "transitioned",
] as const;

/** One derived subtype. */
export type RunStatusSubtype = (typeof RUN_STATUS_SUBTYPES)[number];

/** The states in which a run is blocked on someone rather than working or stopped. */
const BLOCKED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "waiting_for_approval",
  "waiting_for_input",
]);

/**
 * The subtype a transition carries, per §7.1's source-condition column.
 *
 * Order matters and is the table's own: a run that leaves `paused` for a blocked
 * state is `unblocked`? No — it is `blocked`, because the destination is what the
 * person is waiting on. So the destination is read first, and only a destination
 * that names no subtype falls through to what the run came FROM.
 */
export function runStatusSubtypeFor(
  previousState: RunState,
  currentState: RunState,
): RunStatusSubtype {
  if (currentState === "paused") {
    return "paused";
  }
  if (BLOCKED_STATES.has(currentState)) {
    return "blocked";
  }
  if (previousState === "paused") {
    return "resumed";
  }
  if (BLOCKED_STATES.has(previousState)) {
    return "unblocked";
  }
  return "transitioned";
}

/** The mark each subtype wears, and the phrase beside it. Total by construction. */
interface RunStatusSubtypeTraits {
  readonly glyph: GlyphName;
  /** Console prose. Never a wire string — the wire states render beside it. */
  readonly label: string;
}

const SUBTYPE_TRAITS: Readonly<Record<RunStatusSubtype, RunStatusSubtypeTraits>> = {
  paused: { glyph: "pause", label: "Paused" },
  resumed: { glyph: "play", label: "Resumed" },
  blocked: { glyph: "clock", label: "Blocked" },
  unblocked: { glyph: "check", label: "Unblocked" },
  rewound: { glyph: "external", label: "Rewound" },
  transitioned: { glyph: "dot", label: "Changed" },
};

/** How one subtype is drawn. */
export function runStatusSubtypeTraits(subtype: RunStatusSubtype): RunStatusSubtypeTraits {
  return SUBTYPE_TRAITS[subtype];
}

/**
 * The chip tone each of the nine states takes.
 *
 * Total over `RunState`, so a tenth state fails to compile here rather than
 * rendering in whichever tone a fallback happened to pick. `waiting_for_*` take
 * `attention` and `paused` takes `neutral`, which is the visual half of "waiting
 * is not pausing": one is somebody owing an answer, the other is a run at rest.
 */
export const RUN_STATE_TONES: Readonly<Record<RunState, ChipTone>> = {
  queued: "neutral",
  starting: "neutral",
  running: "accent",
  waiting_for_approval: "attention",
  waiting_for_input: "attention",
  paused: "neutral",
  completed: "neutral",
  interrupted: "attention",
  failed: "failure",
};

/**
 * The states in which a run is still the daemon's to move.
 *
 * Used to decide which controls a row OFFERS, never whether the daemon will admit
 * one: eligibility is the daemon's and reaches the surface as a typed refusal
 * (§7.2). What this answers is the narrower question of whether a control is
 * meaningful at all — a `completed` run has no turn to interrupt.
 */
const LIVE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
]);

/** Whether a run is still moving, by the state the daemon last reported. */
export function isLiveRunState(state: RunState): boolean {
  return LIVE_STATES.has(state);
}

/** Whether the run is blocked on a person or an approval rather than working. */
export function isBlockedRunState(state: RunState): boolean {
  return BLOCKED_STATES.has(state);
}

/**
 * One stop-condition trigger, taken from the wire rather than restated.
 *
 * `RunStateChangeEvent.trigger` is a closed five-member optional union; naming it
 * through the event type is what makes the phrase table below total against the
 * CONTRACT instead of against a copy of it that could fall behind.
 */
export type RunStopTrigger = NonNullable<RunStateChangeEvent["trigger"]>;

/**
 * What a stop-condition trigger says, in the words §7.1 asks for.
 *
 * "A run that stopped because a limit fired says which limit, in those words." A
 * total record over the wire union, so a sixth trigger fails to compile here rather
 * than reaching a person as a bare wire token dropped into an English sentence.
 */
export const RUN_TRIGGER_PHRASES: Readonly<Record<RunStopTrigger, string>> = {
  turn_limit: "the run reached its turn limit",
  budget_exhausted: "the run exhausted its budget",
  idle_timeout: "the run passed its idle timeout",
  moderation_denied: "moderation denied the turn",
  workflow_phase_cancelled: "the workflow phase was cancelled",
};
