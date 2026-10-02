// The reveal gate: which characters may be published. A stream can end mid-construct (`**bol`,
// `[link`); publishing that either renders a half-open construct the parser closes at block end
// or shows raw markers that vanish a frame later. The gate does not parse: it finds how far
// back from the revealed cursor the last safe character is, and the engine publishes to there.

import { REVEAL_LITERAL_BACKTRACK_CAP } from "./reveal-caps.js";

/**
 * How a delta relates to what the lane holds. `direct` is a trusted append; `authoritative` is
 * the producer's whole source, checked to extend what the lane holds and reported when it does
 * not, rather than concatenated onto a disagreeing history.
 */
export const REVEAL_COMMIT_MODES = ["direct", "authoritative"] as const;

/** One commit mode. Derived from the enumeration, never restated. */
export type RevealCommitMode = (typeof REVEAL_COMMIT_MODES)[number];

/**
 * The characters that can open a markdown construct. A `Set`, so membership is a lookup: this
 * runs once per candidate ceiling per lane per frame.
 */
const VOLATILE_CHARACTERS = new Set([
  "*",
  "_",
  "~",
  "`",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "|",
  "#",
  "!",
  ".",
  "'",
]);

const WORD_CHARACTER = /[\p{Letter}\p{Number}]/u;
const DIGIT_CHARACTER = /\p{Number}/u;

/** Whether the character at `index` may be published as literal text. */
export function isLiteralSafeAt(text: string, index: number): boolean {
  const character = text[index];
  if (character === undefined || !VOLATILE_CHARACTERS.has(character)) {
    return true;
  }
  const predecessor = index === 0 ? undefined : text[index - 1];
  if (character === "'") {
    // In-word apostrophe: a letter on each side is `don't`, which opens nothing.
    const successor = text[index + 1];
    return (
      predecessor !== undefined &&
      successor !== undefined &&
      WORD_CHARACTER.test(predecessor) &&
      WORD_CHARACTER.test(successor)
    );
  }
  if (character === ".") {
    // Digit-period: safe except after a digit that begins a line, where it is an ordered-list
    // marker whose meaning depends on what follows.
    return !(
      predecessor !== undefined &&
      DIGIT_CHARACTER.test(predecessor) &&
      startsLine(text, index - 1)
    );
  }
  // The predecessor rule: a construct opens at a boundary, so a volatile character after a
  // word character cannot open one and is ordinary text.
  return predecessor !== undefined && WORD_CHARACTER.test(predecessor);
}

/**
 * The furthest position at or below `candidateCeiling` that is safe to publish. Walks back at
 * most `REVEAL_LITERAL_BACKTRACK_CAP` characters; past that the ceiling stands, since a stalled
 * lane is as bad as flicker.
 */
export function safeRevealCeiling(text: string, candidateCeiling: number): number {
  const ceiling = Math.min(Math.max(0, candidateCeiling), text.length);
  if (ceiling === 0 || ceiling === text.length) {
    // A settled block has nothing to withhold: the construct closed or never was one.
    return ceiling;
  }
  const floor = Math.max(0, ceiling - REVEAL_LITERAL_BACKTRACK_CAP);
  for (let position = ceiling; position > floor; position -= 1) {
    if (isLiteralSafeAt(text, position - 1)) {
      return position;
    }
  }
  return ceiling;
}

/** Whether `index` is the first character on its line. */
function startsLine(text: string, index: number): boolean {
  for (let position = index - 1; position >= 0; position -= 1) {
    const character = text[position];
    if (character === "\n") {
      return true;
    }
    if (character !== " " && character !== "\t") {
      return false;
    }
  }
  return true;
}
