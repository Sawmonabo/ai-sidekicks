// The body seam: what goes INSIDE a card, as opposed to the frame around it.
//
// THE SEAM THIS DIRECTORY OWNS. A card is a frame — an author, a time, a receipt, a
// boundary. What sits inside it is a different job with different failure modes: machine
// output that may be markdown or ANSI or neither, a participant's own words streamed a
// token at a time, a body the build cannot render, and a body too long to show whole.
// Each of those has to say honestly what it is showing and what it is not, which is why
// the truncation notice and the unavailable body live here beside the renderers rather
// than being a flag on one of them.
//
// WHAT LEAVES. The two bodies a card frame chooses between. The streaming renderer, the
// settled block, and the two notices are reached by their siblings inside this directory,
// deeply, which is what an intra-family import is for.

export { MachineBody } from "./MachineBody.js";
export { ParticipantBody } from "./ParticipantBody.js";

// The two plan-owned row bodies, and exactly what the sibling that mounts them
// takes. Each is a slot with a shell behind it and each dies with the change that
// authors the real body — the declarations carry the three facts that arrangement
// owes.
//
// THE LIST IS THE FIXTURE SHELL'S IMPORTS AND NOTHING ELSE. Every other name these
// two modules declare — the tail cut, the arm copy, the ask's own reading and option
// shapes, the two body-props types — is read by a sibling INSIDE this directory or
// by the co-located suites, both of which take the declaring module directly. A door
// line with no reader outside the directory is a dead export the barrel census fails,
// so this door is never widened for symmetry.
export { InputAskCard } from "./InputAskCard.js";
export {
  ASK_ANSWER_UNSENT,
  INPUT_ASK_SLOT,
  readDriverAsk,
  type DriverAskDelivery,
} from "./input-ask.js";
export { ReasoningSurface } from "./ReasoningSurface.js";
export {
  REASONING_SURFACE_SLOT,
  reasoningRunIdOf,
  type ReasoningSurfaceReading,
} from "./reasoning-surface.js";
