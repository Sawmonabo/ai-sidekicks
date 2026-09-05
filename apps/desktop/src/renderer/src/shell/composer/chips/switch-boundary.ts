// The sentence a pending provider switch is announced with.
//
// A CLOSED RECORD AND NEVER AN INTERPOLATION. The boundary arrives as one of two
// wire-verbatim words, and the chip used to compose `Switch applies at the next
// ${…}` around whatever string it found — which reads as English only for values
// nobody chose it to receive, and which would have rendered a daemon's new third
// boundary as prose nobody wrote. `Record<GrowthAgentSwitchBoundary, string>` is
// total over the vocabulary the reply declares, so a boundary added to that
// vocabulary fails to compile here rather than reaching a person as a fragment.
//
// Its own module rather than a constant inside the component: the vocabulary is the
// bridge's and the sentence is the design's, and a unit that drives the mapping
// should not have to mount a chip to reach it.

import { type GrowthAgentSwitchBoundary } from "../../../console/bridge/index.js";

/** What each boundary means, in the words a person reads. */
const BOUNDARY_SENTENCE: Readonly<Record<GrowthAgentSwitchBoundary, string>> = {
  turn_boundary: "Switch applies at the next turn",
  run_boundary: "Switch applies at the next run",
};

/** The sentence for one pending switch's boundary. */
export function switchBoundarySentence(boundary: GrowthAgentSwitchBoundary): string {
  return BOUNDARY_SENTENCE[boundary];
}
