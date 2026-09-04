// Filler prose for the reveal cases, written once.
//
// Three suites drive the reveal engine — the engine's own, the React binding's, and
// the row channel's — and every one of them needs text the reveal GATE will hand
// over in full. Markdown is what the gate withholds a tail of, so the filler has to
// contain none of it, and a per-suite copy of that rule is three chances for one of
// them to drift into text whose reveal is bounded by something other than the frame
// budget. A fixture module beside the code it serves, on `scroll-surface-fixture.ts`'
// terms.

import { REVEAL_FRAME_CHARACTER_BUDGET } from "./frame-bounds.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Exactly `characterCount` characters of plain prose, with no markdown in it.
 *
 * The count is exact rather than approximate because the cases that matter compare a
 * revealed length against a source length, and a filler that rounded up would make
 * every such comparison off by the rounding.
 */
export function revealProse(characterCount: number): string {
  let text = "";
  while (text.length < characterCount) {
    text += `${ALPHABET} `;
  }
  return text.slice(0, characterCount);
}

/**
 * A source twice one frame's budget, which is the length every reveal claim needs.
 *
 * A lane whose whole source fits in one frame cannot tell revealed text apart from
 * the delta echoed back, so both the binding's and the row channel's cases size their
 * filler against the budget rather than against a literal — and against the same
 * multiple, so "one frame's worth" means one thing in both.
 */
export const TWO_FRAME_REVEAL_SOURCE: string = revealProse(REVEAL_FRAME_CHARACTER_BUDGET * 2);
