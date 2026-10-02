// Filler prose for the reveal suites: plain text with no markdown, so the gate hands it over in
// full and only the frame budget bounds the reveal.

import { REVEAL_FRAME_CHARACTER_BUDGET } from "./reveal-caps.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Exactly `characterCount` characters of plain prose with no markdown. Exact, because cases
 * compare a revealed length against a source length.
 */
export function revealProse(characterCount: number): string {
  let text = "";
  while (text.length < characterCount) {
    text += `${ALPHABET} `;
  }
  return text.slice(0, characterCount);
}

/**
 * A source twice one frame's budget. A lane whose whole source fits in one frame cannot tell
 * revealed text apart from the delta echoed back.
 */
export const TWO_FRAME_REVEAL_SOURCE: string = revealProse(REVEAL_FRAME_CHARACTER_BUDGET * 2);
