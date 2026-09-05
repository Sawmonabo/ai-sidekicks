// The reveal gate — which characters may be published, and under which commit mode.
//
// BOTH ARE THIS MODULE'S, because no committed document states them: two closed commit
// modes, `direct` and `authoritative`, and a literal-safety predicate — the character
// class, the predecessor rule, and the carve-outs (digit-period, in-word apostrophe).
// `markdown-rules.ts` rule 1 is the reason both exist: an incomplete construct never
// mounts.
//
// THE PROBLEM THIS SOLVES. A stream arrives one token at a time, so at any moment
// the revealed tail may end mid-construct: `**bol` is not bold yet, and `[link`
// is not a link yet. Publishing that tail means either rendering a half-open
// construct — which the parser then closes at the end of the block, italicising
// the rest of the message — or rendering the raw markers, which then vanish a
// frame later. Both read as a glitch.
//
// THE ANSWER IS A CEILING, NOT A PARSER. The gate does not parse; it decides how
// far back from the revealed cursor the last SAFE character is, and the engine
// publishes to there. A volatile character is safe as literal text when it cannot
// open a construct at that position — which is what the predecessor rule decides —
// and the carve-outs are the two cases where the predecessor rule gets it wrong:
//
//   • **digit-period.** `1.` at the start of a line opens an ordered list even
//     though a digit is a perfectly ordinary predecessor, so the period is
//     withheld until the character after it settles the question.
//   • **in-word apostrophe.** `don't` has a letter on both sides and opens
//     nothing, so withholding it would stall a lane on ordinary prose.

import { REVEAL_LITERAL_BACKTRACK_CAP } from "../frame-bounds.js";

/**
 * How a delta claims to relate to what the lane already holds. Closed.
 *
 *   • `direct` — the delta is an append. The engine trusts it and queues it.
 *   • `authoritative` — the delta is the whole source as the producer now sees it.
 *     The engine checks that what it holds is a prefix of it, and says so loudly
 *     when it is not, rather than concatenating two disagreeing histories.
 */
export const REVEAL_COMMIT_MODES = ["direct", "authoritative"] as const;

/** One commit mode. Derived from the enumeration, never restated. */
export type RevealCommitMode = (typeof REVEAL_COMMIT_MODES)[number];

/**
 * The characters that can open a markdown construct.
 *
 * A string rather than a `RegExp` so the class is readable and so the membership
 * test is a lookup rather than a match: this predicate runs once per candidate
 * ceiling per lane per frame.
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
    // In-word apostrophe: a letter on the left and a letter on the right is
    // `don't`, which opens nothing in any dialect the console renders.
    const successor = text[index + 1];
    return (
      predecessor !== undefined &&
      successor !== undefined &&
      WORD_CHARACTER.test(predecessor) &&
      WORD_CHARACTER.test(successor)
    );
  }
  if (character === ".") {
    // Digit-period: safe everywhere EXCEPT after a digit that begins a line,
    // where it is an ordered-list marker whose meaning depends on what follows.
    return !(
      predecessor !== undefined &&
      DIGIT_CHARACTER.test(predecessor) &&
      startsLine(text, index - 1)
    );
  }
  // The predecessor rule: a construct opens at a boundary. A volatile character
  // whose predecessor is a word character cannot open one, so it is ordinary text.
  return predecessor !== undefined && WORD_CHARACTER.test(predecessor);
}

/**
 * The furthest position at or below `candidateCeiling` that is safe to publish.
 *
 * Walks back at most `REVEAL_LITERAL_BACKTRACK_CAP` characters. Past that the
 * ceiling stands: withholding more than a construct's worth of text to avoid a
 * marker would stall the lane, and a stalled lane is the failure `reveal-engine.ts`
 * forbids in the same breath as the flicker.
 */
export function safeRevealCeiling(text: string, candidateCeiling: number): number {
  const ceiling = Math.min(Math.max(0, candidateCeiling), text.length);
  if (ceiling === 0 || ceiling === text.length) {
    // A settled block has nothing to withhold: the construct either closed or it
    // never was one, and the parser sees the whole of it either way.
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
