// The subsequence scorer — the console's one matcher.
//
// WHY THIS IS OWN-BUILT. `Spec-023 §Console Libraries`, the "State, storage,
// forms, search, dates" row, reads: "OWN-BUILD the subsequence scorer shared by
// the palette, settings search, sidebar filter, and find … AVOID … fuse.js, fzf,
// minisearch". That is a verdict, not a preference, and the reason is visible in
// what this file is: one pure function over two strings, no index to build, no
// tokenizer, no options object, no per-keystroke allocation beyond four small
// typed arrays. A matching library buys none of that back and costs bytes on a
// budget the spec measures. It also cannot give us the one output the palette
// actually needs — `matchedIndices`, so the renderer can emphasise the characters
// the person typed — without reaching into its internals.
//
// WHAT IT SCORES. A candidate matches when the query is a case-insensitive
// SUBSEQUENCE of it: every query character appears, in order, not necessarily
// adjacent. Among the many ways one query can be embedded in one candidate the
// score is the best one, chosen by dynamic programming rather than by a greedy
// left-to-right walk. Greedy gets "cs" → "Copy SHA" wrong: it commits to the 'c'
// of "Copy", and the 's' of "SHA" is then reachable only as a mid-word hit.
//
// COMPLEXITY. O(candidate × query) time and memory, behind an O(candidate)
// greedy bail, so a candidate that cannot match at all costs one linear scan.
// The gap penalty is deliberately LINEAR — not capped, not quadratic — because a
// linear penalty admits the running-maximum recurrence in the inner loop below.
// Capping it would force an inner scan over every earlier match position and
// make the whole thing O(candidate² × query).
//
// NO REGEX. Nothing here constructs a `RegExp`. Word boundaries are decided by
// character comparison against a flag table computed once per call.
//
// DETERMINISM. Ties are broken by the EARLIEST end position, so two embeddings of
// equal score always resolve the same way and the palette's row order never
// flickers between keystrokes. The caller breaks SCORE ties with its own stable
// secondary key (see `command-registry.ts`).

/** A scored embedding of a query inside a candidate. */
export interface SubsequenceMatch {
  /** Higher is better. Unbounded in both directions; only the ordering is meaningful. */
  readonly score: number;
  /** Indices into the ORIGINAL candidate, ascending, one per query character. */
  readonly matchedIndices: readonly number[];
}

// The bonus and penalty table. Every value is a decision, so each carries the
// reason it exists; changing one changes result order everywhere the console
// searches, which is why they live together rather than inline at their use.

/**
 * Paid for every matched character. A floor rather than a discriminator — the
 * query length is constant across candidates within one search, so this term is
 * identical for every result and exists only to keep a good match positive after
 * the penalties below have been subtracted.
 */
export const SUBSEQUENCE_BASE_CHARACTER_SCORE = 16;

/**
 * Paid when the typed character matches the candidate's case exactly. A person
 * who typed a capital meant it; a person who typed lower case pays nothing,
 * because lower case is what people type when they do not care.
 */
export const SUBSEQUENCE_EXACT_CASE_BONUS = 8;

/**
 * Paid at the start of a word — index 0, after a separator, or on a camelCase
 * hump. This is the bonus that makes initialisms work: "cs" reaches "Copy SHA"
 * over "class" because both of its characters are boundary hits.
 */
export const SUBSEQUENCE_WORD_BOUNDARY_BONUS = 24;

/**
 * Paid when a match is adjacent to the previous one. A run is stronger evidence
 * of intent than the same characters scattered, so "rest" prefers "Restart run"
 * to "Reveal in the session tree".
 */
export const SUBSEQUENCE_CONSECUTIVE_BONUS = 20;

/**
 * Paid once, when the first character matches at index 0. The strongest single
 * signal there is: a person typing "op" almost always means a title that starts
 * with it.
 */
export const SUBSEQUENCE_PREFIX_BONUS = 32;

/**
 * Charged per character skipped BETWEEN two matches. Linear by construction —
 * see the complexity note in the file header.
 */
export const SUBSEQUENCE_GAP_PENALTY_PER_CHARACTER = 3;

/**
 * Charged per character skipped BEFORE the first match. Lighter than an interior
 * gap: starting late is weaker evidence of a bad match than fragmenting is, and
 * the preference for an early start is already carried by the prefix bonus.
 */
export const SUBSEQUENCE_LEADING_GAP_PENALTY_PER_CHARACTER = 1;

/**
 * Charged per character left over AFTER the last match. Lighter still. Its only
 * job is to break the tie between two titles that match identically, in favour
 * of the shorter one, because the shorter one is the more exact answer.
 */
export const SUBSEQUENCE_TRAILING_PENALTY_PER_CHARACTER = 0.5;

/**
 * Characters that open a word when they PRECEDE a matched character. Path and
 * identifier separators are included because command titles, settings paths, and
 * repo paths all flow through this one matcher.
 */
const WORD_SEPARATOR_CHARACTERS = " \t-_./\\:,()[]{}@#";

/** The score of a cell no embedding can reach. */
const NO_PATH = Number.NEGATIVE_INFINITY;

function readScore(row: Float64Array, index: number): number {
  return row[index] ?? NO_PATH;
}

function readParent(parents: Int32Array, index: number): number {
  return parents[index] ?? -1;
}

function isAsciiDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isLowercaseLetter(character: string): boolean {
  return character !== character.toUpperCase() && character === character.toLowerCase();
}

function isUppercaseLetter(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase();
}

/**
 * Fold one character to lower case WITHOUT changing the string's length.
 *
 * `String.prototype.toLowerCase` is not length-preserving for every code point
 * (the Turkish dotted capital I folds to two code units), and a single such
 * character in a repo path would desynchronise `matchedIndices` from the original
 * string — the renderer would then embolden the wrong characters. So the fold is
 * per character and declines to apply itself when it would change the length,
 * which costs nothing and keeps every index honest.
 */
function foldedCharacterCode(source: string, index: number): number {
  const character = source.charAt(index);
  const folded = character.toLowerCase();
  return folded.length === 1 ? folded.charCodeAt(0) : character.charCodeAt(0);
}

function foldToCodes(source: string): Int32Array {
  const codes = new Int32Array(source.length);
  for (let characterIndex = 0; characterIndex < source.length; characterIndex += 1) {
    codes[characterIndex] = foldedCharacterCode(source, characterIndex);
  }
  return codes;
}

/**
 * Word-boundary flags for every position of the candidate, computed once.
 *
 * A boundary is index 0, any position whose predecessor is a separator, or a
 * camelCase hump — an upper-case letter following a lower-case letter or a digit.
 * `parseJSONPayload` therefore has boundaries at `p`, `J`, and `P`, which is what
 * a person means when they type "pjp".
 */
function computeWordBoundaryFlags(candidate: string): Uint8Array {
  const flags = new Uint8Array(candidate.length);
  for (let characterIndex = 0; characterIndex < candidate.length; characterIndex += 1) {
    if (characterIndex === 0) {
      flags[characterIndex] = 1;
      continue;
    }
    const previousCharacter = candidate.charAt(characterIndex - 1);
    if (WORD_SEPARATOR_CHARACTERS.includes(previousCharacter)) {
      flags[characterIndex] = 1;
      continue;
    }
    const currentCharacter = candidate.charAt(characterIndex);
    const isCamelHump =
      isUppercaseLetter(currentCharacter) &&
      (isLowercaseLetter(previousCharacter) || isAsciiDigit(previousCharacter));
    flags[characterIndex] = isCamelHump ? 1 : 0;
  }
  return flags;
}

/**
 * Score the candidate character at `candidateIndex` against the query character
 * at `queryIndex`, ignoring how it was reached. The transition bonuses
 * (consecutive, gap) are added by the caller, which is the only place that knows
 * where the previous match landed.
 */
function characterScore(
  candidate: string,
  query: string,
  candidateIndex: number,
  queryIndex: number,
  wordBoundaryFlags: Uint8Array,
): number {
  let score = SUBSEQUENCE_BASE_CHARACTER_SCORE;
  if (candidate.charCodeAt(candidateIndex) === query.charCodeAt(queryIndex)) {
    score += SUBSEQUENCE_EXACT_CASE_BONUS;
  }
  if (wordBoundaryFlags[candidateIndex] === 1) {
    score += SUBSEQUENCE_WORD_BOUNDARY_BONUS;
  }
  if (candidateIndex === 0) {
    score += SUBSEQUENCE_PREFIX_BONUS;
  }
  return score;
}

/**
 * Is the query a case-insensitive subsequence of the candidate at all?
 *
 * One greedy left-to-right pass. Greedy is exact for the EXISTENCE question even
 * though it is wrong for the QUALITY question, so this is a sound early bail:
 * everything it rejects has no embedding at all, and the O(candidate × query) DP
 * below never runs for it.
 */
function isSubsequence(candidateCodes: Int32Array, queryCodes: Int32Array): boolean {
  let queryCursor = 0;
  for (
    let candidateCursor = 0;
    candidateCursor < candidateCodes.length && queryCursor < queryCodes.length;
    candidateCursor += 1
  ) {
    if (candidateCodes[candidateCursor] === queryCodes[queryCursor]) {
      queryCursor += 1;
    }
  }
  return queryCursor === queryCodes.length;
}

/**
 * Score one candidate against one query.
 *
 * Returns `undefined` when the query is not a subsequence of the candidate, and
 * ALSO when the query is empty — an empty query is not a match of everything, it
 * is a different state, and conflating the two is exactly the mistake
 * `Spec-023 §Console Design (Meridian)` rule 8 forbids. The palette's empty-query
 * arm is recents, not "every result at score zero".
 */
export function scoreSubsequence(candidate: string, query: string): SubsequenceMatch | undefined {
  const candidateLength = candidate.length;
  const queryLength = query.length;
  if (queryLength === 0 || candidateLength === 0 || queryLength > candidateLength) {
    return undefined;
  }

  const candidateCodes = foldToCodes(candidate);
  const queryCodes = foldToCodes(query);
  if (!isSubsequence(candidateCodes, queryCodes)) {
    return undefined;
  }

  const wordBoundaryFlags = computeWordBoundaryFlags(candidate);

  // `previousRow[k]` / `currentRow[k]`: the best score of an embedding of the
  // query prefix that ENDS with candidate character k. `parents` remembers which
  // earlier candidate index each of those came from, so the winning embedding can
  // be walked back out for `matchedIndices`.
  let previousRow = new Float64Array(candidateLength).fill(NO_PATH);
  let currentRow = new Float64Array(candidateLength).fill(NO_PATH);
  const parents = new Int32Array(queryLength * candidateLength).fill(-1);

  for (let candidateIndex = 0; candidateIndex < candidateLength; candidateIndex += 1) {
    if (candidateCodes[candidateIndex] !== queryCodes[0]) {
      continue;
    }
    currentRow[candidateIndex] =
      characterScore(candidate, query, candidateIndex, 0, wordBoundaryFlags) -
      SUBSEQUENCE_LEADING_GAP_PENALTY_PER_CHARACTER * candidateIndex;
  }

  for (let queryIndex = 1; queryIndex < queryLength; queryIndex += 1) {
    const recycledRow = previousRow;
    previousRow = currentRow;
    currentRow = recycledRow.fill(NO_PATH);

    // The running maximum that keeps this loop linear in `candidateLength`.
    // Entering iteration k, `bestGapReachableScore` holds
    //   max over j <= k-2 of ( previousRow[j] - GAP * (k - 2 - j) ),
    // so the best gap-crossing transition into k is that value minus one more
    // GAP. Because the gap penalty is linear the maximum advances by a single
    // comparison per step — no inner scan over earlier match positions.
    let bestGapReachableScore = NO_PATH;
    let bestGapReachableIndex = -1;

    for (let candidateIndex = queryIndex; candidateIndex < candidateLength; candidateIndex += 1) {
      if (candidateCodes[candidateIndex] === queryCodes[queryIndex]) {
        const adjacentScore = readScore(previousRow, candidateIndex - 1);
        const consecutiveOption =
          adjacentScore === NO_PATH ? NO_PATH : adjacentScore + SUBSEQUENCE_CONSECUTIVE_BONUS;
        const gapOption =
          bestGapReachableScore === NO_PATH
            ? NO_PATH
            : bestGapReachableScore - SUBSEQUENCE_GAP_PENALTY_PER_CHARACTER;

        let transitionScore = NO_PATH;
        let parentIndex = -1;
        if (consecutiveOption !== NO_PATH && consecutiveOption >= gapOption) {
          transitionScore = consecutiveOption;
          parentIndex = candidateIndex - 1;
        } else if (gapOption !== NO_PATH) {
          transitionScore = gapOption;
          parentIndex = bestGapReachableIndex;
        }

        if (transitionScore !== NO_PATH && parentIndex >= 0) {
          currentRow[candidateIndex] =
            transitionScore +
            characterScore(candidate, query, candidateIndex, queryIndex, wordBoundaryFlags);
          parents[queryIndex * candidateLength + candidateIndex] = parentIndex;
        }
      }

      const decayedScore =
        bestGapReachableScore === NO_PATH
          ? NO_PATH
          : bestGapReachableScore - SUBSEQUENCE_GAP_PENALTY_PER_CHARACTER;
      const arrivingScore = readScore(previousRow, candidateIndex - 1);
      if (arrivingScore !== NO_PATH && arrivingScore >= decayedScore) {
        bestGapReachableScore = arrivingScore;
        bestGapReachableIndex = candidateIndex - 1;
      } else {
        bestGapReachableScore = decayedScore;
      }
    }
  }

  let bestTotalScore = NO_PATH;
  let bestEndIndex = -1;
  for (
    let candidateIndex = queryLength - 1;
    candidateIndex < candidateLength;
    candidateIndex += 1
  ) {
    const endScore = readScore(currentRow, candidateIndex);
    if (endScore === NO_PATH) {
      continue;
    }
    const totalScore =
      endScore -
      SUBSEQUENCE_TRAILING_PENALTY_PER_CHARACTER * (candidateLength - 1 - candidateIndex);
    // Strictly greater, so the EARLIEST end position wins a tie. That is the
    // stable secondary key: same inputs, same embedding, every keystroke.
    if (totalScore > bestTotalScore) {
      bestTotalScore = totalScore;
      bestEndIndex = candidateIndex;
    }
  }

  if (bestEndIndex < 0) {
    return undefined;
  }

  const matchedIndices = new Array<number>(queryLength);
  let walkIndex = bestEndIndex;
  for (let queryIndex = queryLength - 1; queryIndex >= 0; queryIndex -= 1) {
    matchedIndices[queryIndex] = walkIndex;
    if (queryIndex > 0) {
      walkIndex = readParent(parents, queryIndex * candidateLength + walkIndex);
    }
  }

  return { score: bestTotalScore, matchedIndices };
}
