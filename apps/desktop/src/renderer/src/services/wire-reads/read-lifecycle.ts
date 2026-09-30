// How far a wire reading has got and why it did not get further: the phase-and-refusal pair
// every reading publishes. A phase and a `readRefusal` set by separate writers could publish
// `phase: "read"` beside a refusal from an older read, so {@link findReadRefusal} derives what a
// view renders from the phase, and a reading that forgets to clear the refusal still renders
// honestly. This is not the scheduler (`lib/reads/refresh-scheduler.ts` decides when,
// `store/reads/read-triggers.ts` which moments): it holds no bridge, opens no stream and publishes
// nothing.

import type { Refusal } from "@renderer/lib/refusal.js";

/** How a wire read has gone; none of the three is an empty list. */
export type WireReadPhase = "reading" | "read" | "refused";

/**
 * The phase-and-refusal pair every wire reading publishes, spread onto each reading's readout so a
 * view rendering "why is this empty" reads the same two members whichever reading it holds.
 */
export interface WireReadState {
  readonly phase: WireReadPhase;
  /**
   * Why the newest read could not be taken. Carried rather than swallowed: a chip's absence is not
   * a health reading, so a failed read and a genuinely empty answer would otherwise look alike.
   */
  readonly readRefusal: Refusal | undefined;
}

/**
 * The refusal a view renders for this reading, or `undefined` when there is none. Every consumer
 * goes through it so the phase-and-refusal coupling is stated once, and a reading whose newest
 * read served answers `undefined` even if a later arm forgets the clear.
 */
export function findReadRefusal(state: WireReadState): Refusal | undefined {
  return state.phase === "refused" ? state.readRefusal : undefined;
}
