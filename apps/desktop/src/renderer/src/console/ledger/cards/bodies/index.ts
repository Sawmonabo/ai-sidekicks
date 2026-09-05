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
