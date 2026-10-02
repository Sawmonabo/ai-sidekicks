// The product's one fuzzy matcher, shared by the desktop's command palette, settings search and
// keybinding map. It is own-built because, measured over 100,000 candidates, each library that ran
// faster either missed subsequence matches or held a prepared index of every candidate, tens to
// hundreds of MiB more heap; this is one pure function over two strings that keeps nothing. It
// returns `matchedIndices`, which the renderer uses to emphasize the typed characters.
//
// A candidate matches when the query is a case-insensitive subsequence of it. The score is the best
// embedding, found by dynamic programming: a greedy left-to-right walk gets "cs" -> "Copy SHA"
// wrong, committing to the 'c' of "Copy" and leaving the 's' of "SHA" reachable only mid-word.
//
// Time and memory are O(candidate x query), behind an O(candidate) greedy bail. The gap penalty is
// linear on purpose: that admits the running-maximum recurrence in the inner loop, where a capped
// penalty would need an inner scan and make the whole O(candidate^2 x query).
//
// No regular expressions: word boundaries come from a flag table computed once per call. Score
// ties resolve to the earliest end position, so row order does not flicker between keystrokes; the
// caller breaks equal scores with its own stable key.

/** A scored embedding of a query inside a candidate. */
export interface SubsequenceMatch {
  /** Higher is better. Unbounded in both directions; only the ordering is meaningful. */
  readonly score: number;
  /** Indices into the ORIGINAL candidate, ascending, one per query character. */
  readonly matchedIndices: readonly number[];
}

// Bonuses and penalties live together because changing one changes result order everywhere.

/**
 * Paid for every matched character. Query length is constant within one search, so this is the
 * same for every result and only keeps a good match positive after the penalties.
 */
const SUBSEQUENCE_BASE_CHARACTER_SCORE = 16;

/** Paid when the typed character matches the candidate's case exactly: a typed capital is meant. */
const SUBSEQUENCE_EXACT_CASE_BONUS = 8;

/**
 * Paid at the start of a word: index 0, after a separator, or on a camelCase hump. It makes
 * initialisms work: "cs" reaches "Copy SHA" over "class" because both characters are boundary hits.
 */
const SUBSEQUENCE_WORD_BOUNDARY_BONUS = 24;

/**
 * Paid when a match is adjacent to the previous one, so "rest" prefers "Restart run" to
 * "Reveal in the session tree".
 */
const SUBSEQUENCE_CONSECUTIVE_BONUS = 20;

/**
 * Paid once, when the first character matches at index 0. The strongest single signal: "op"
 * usually means a title that starts with it.
 */
const SUBSEQUENCE_PREFIX_BONUS = 32;

/** Charged per character skipped between two matches. Linear; see the file header. */
const SUBSEQUENCE_GAP_PENALTY_PER_CHARACTER = 3;

/**
 * Charged per character skipped before the first match. Lighter than an interior gap: the prefix
 * bonus already carries the preference for an early start.
 */
const SUBSEQUENCE_LEADING_GAP_PENALTY_PER_CHARACTER = 1;

/** Charged per character left after the last match; it breaks ties toward the shorter title. */
const SUBSEQUENCE_TRAILING_PENALTY_PER_CHARACTER = 0.5;

/**
 * Characters that open a word when they precede a matched character. Path and identifier
 * separators are included because titles, settings paths and repo paths all use this matcher.
 */
const WORD_SEPARATOR_CHARACTERS = " \t-_./\\:,()[]{}@#";

/** The score of a cell no embedding can reach. */
const NO_PATH = Number.NEGATIVE_INFINITY;

/**
 * Scores one candidate against one query. Returns `undefined` when the query is not a subsequence
 * of the candidate, and also when it is empty: an empty query is a different state, not a match of
 * everything, and the palette shows recents for it rather than every result at score zero.
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

  // `previousRow[k]` / `currentRow[k]` hold the best score of an embedding of the query prefix
  // that ends with candidate character k. `parents` records the earlier candidate index each came
  // from, so the winning embedding can be walked back out for `matchedIndices`.
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

    // The running maximum that keeps this loop linear in `candidateLength`. Entering iteration k,
    // `bestGapReachableScore` holds max over j <= k-2 of (previousRow[j] - GAP * (k - 2 - j)), so
    // the best gap-crossing transition into k is that minus one more GAP. The linear penalty lets
    // it advance with one comparison per step.
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
    // Strictly greater, so the earliest end position wins a tie and the result is stable.
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
 * Folds one character to lower case without changing the string's length. `toLowerCase` can turn
 * one code unit into two (the Turkish dotted capital I), which would shift `matchedIndices` away
 * from the original string, so a fold that changes the length is skipped.
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
 * Word-boundary flags for every position of the candidate. A boundary is index 0, a position after
 * a separator, or a camelCase hump (an upper-case letter after a lower-case letter or a digit), so
 * `parseJSONPayload` has boundaries at `p`, `J` and `P`.
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
 * Scores the candidate character at `candidateIndex` against the query character at `queryIndex`,
 * ignoring how it was reached; the caller adds the consecutive and gap terms.
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
 * Whether the query is a case-insensitive subsequence of the candidate at all. One greedy pass is
 * exact for existence, though not for quality, so it is a sound early bail before the DP.
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
