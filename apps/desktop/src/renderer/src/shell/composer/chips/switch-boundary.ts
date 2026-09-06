// The sentence a pending provider switch is announced with.
//
// A KNOWN-VALUE RECORD AND NEVER AN INTERPOLATION. The boundary arrives on
// `AgentPendingSwitch.appliesAt`, which the wire shape types `string` on purpose —
// `bridge/wire-shapes/agent-plane.ts` states the rule and its reason: a member a
// later amendment adds must render as ITSELF rather than vanish. So the two values
// this design has a sentence for get one, and anything else is quoted verbatim
// rather than wrapped in `Switch applies at the next ${…}`, which reads as English
// only for values nobody chose it to receive.
//
// Its own module rather than a constant inside the component: the value is the
// bridge's and the sentence is the design's, and a unit that drives the mapping
// should not have to mount a chip to reach it.

/** What each boundary this console has a sentence for means, in a person's words. */
const BOUNDARY_SENTENCE: Readonly<Record<string, string>> = {
  turn_boundary: "Switch applies at the next turn",
  run_boundary: "Switch applies at the next run",
};

/** The sentence for one pending switch's boundary, or the value as the wire sent it. */
export function switchBoundarySentence(boundary: string): string {
  return BOUNDARY_SENTENCE[boundary] ?? `Switch applies at "${boundary}"`;
}
