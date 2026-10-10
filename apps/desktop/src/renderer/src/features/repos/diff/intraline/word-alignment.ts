// The word-level comparison of one replaced line pair, for any length of line. jsdiff's word
// tokenizer splits the text, and its Myers differ (`diffArrays`) aligns a stretch exactly when
// the stretch is small. A long stretch is first split at the words that occur exactly once on
// each side (patience diffing, as `git diff --patience` does), so the work grows with the line's
// length rather than with the product of the two lengths. A stretch with no such word and an edit
// distance past the Myers bound is marked changed whole, which is a true diff of it, never a
// dropped one: every pair keeps its marks.

import { diffArrays } from "diff/lib/diff/array.js";
import { wordsWithSpaceDiff } from "diff/lib/diff/word.js";

import { wholeLineSegments, type DiffIntralineSegment } from "../model.js";

/** Both sides of one line pair's comparison, from the one alignment. */
export interface IntralineSegmentPair {
  readonly deleted: readonly DiffIntralineSegment[];
  readonly inserted: readonly DiffIntralineSegment[];
}

/**
 * Segment one changed line pair at its word boundaries, for both sides from one comparison,
 * so the two highlights cannot disagree about which words survived. Whitespace runs are tokens,
 * so an indentation change stays visible.
 */
export function intralineSegments(previousText: string, nextText: string): IntralineSegmentPair {
  const previousWords = wordsOf(previousText);
  const nextWords = wordsOf(nextText);
  const deleted: DiffIntralineSegment[] = [];
  const inserted: DiffIntralineSegment[] = [];
  for (const run of alignedRuns(previousWords, nextWords)) {
    if (run.kind !== "added") {
      appendSegment(deleted, previousWords, run.previousStart, run.previousEnd, run.kind);
    }
    if (run.kind !== "removed") {
      appendSegment(inserted, nextWords, run.nextStart, run.nextEnd, run.kind);
    }
  }
  return {
    deleted: deleted.length === 0 ? wholeLineSegments("") : deleted,
    inserted: inserted.length === 0 ? wholeLineSegments("") : inserted,
  };
}

/**
 * The largest product of two stretch lengths, in words, Myers aligns without first splitting at
 * unique words: past it the quadratic worst case outgrows a frame.
 */
const EXACT_ALIGNMENT_WORD_PRODUCT = 65_536;

/**
 * The work, in words walked, the Myers fallback may spend on a stretch with no unique word: its
 * edit bound is this over the stretch's length, so the fallback stays linear in the stretch.
 */
const FALLBACK_ALIGNMENT_WORD_WORK = 4_000_000;

/** What one run of words is: carried over, or on one side only. */
type RunKind = "kept" | "removed" | "added";

/** One run of the alignment, as word ranges on each side (end exclusive). */
interface AlignedRun {
  readonly kind: RunKind;
  readonly previousStart: number;
  readonly previousEnd: number;
  readonly nextStart: number;
  readonly nextEnd: number;
}

/** A stretch still to align: word ranges on each side, end exclusive. */
interface Stretch {
  readonly previousStart: number;
  readonly previousEnd: number;
  readonly nextStart: number;
  readonly nextEnd: number;
}

/** Work left to do, in output order: a stretch to align, or a run already settled. */
type AlignmentStep = { readonly step: "stretch"; readonly stretch: Stretch } | AlignedRunStep;

interface AlignedRunStep {
  readonly step: "run";
  readonly run: AlignedRun;
}

function wordsOf(text: string): readonly string[] {
  return wordsWithSpaceDiff.tokenize(text);
}

/**
 * The runs aligning two word lists, in order. A stack of pending steps rather than recursion,
 * so a deeply nested split cannot exhaust the call stack.
 */
function alignedRuns(previous: readonly string[], next: readonly string[]): AlignedRun[] {
  const runs: AlignedRun[] = [];
  const pending: AlignmentStep[] = [
    {
      step: "stretch",
      stretch: {
        previousStart: 0,
        previousEnd: previous.length,
        nextStart: 0,
        nextEnd: next.length,
      },
    },
  ];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.step === "run") {
      runs.push(item.run);
      continue;
    }
    // Pushed in reverse, so they pop in order.
    pending.push(...stepsFor(previous, next, item.stretch).reverse());
  }
  return runs;
}

/** One stretch's alignment, as settled runs and smaller stretches, in order. */
function stepsFor(
  previous: readonly string[],
  next: readonly string[],
  stretch: Stretch,
): AlignmentStep[] {
  let { previousStart, previousEnd, nextStart, nextEnd } = stretch;
  const head = previousStart;
  while (
    previousStart < previousEnd &&
    nextStart < nextEnd &&
    previous[previousStart] === next[nextStart]
  ) {
    previousStart += 1;
    nextStart += 1;
  }
  const headLength = previousStart - head;
  let tailLength = 0;
  while (
    previousEnd > previousStart &&
    nextEnd > nextStart &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
    tailLength += 1;
  }

  const steps: AlignmentStep[] = [];
  if (headLength > 0) {
    steps.push(keptStep(previousStart - headLength, nextStart - headLength, headLength));
  }
  steps.push(...middleSteps(previous, next, { previousStart, previousEnd, nextStart, nextEnd }));
  if (tailLength > 0) {
    steps.push(keptStep(previousEnd, nextEnd, tailLength));
  }
  return steps;
}

/** The middle of a stretch, its common head and tail already taken off. */
function middleSteps(
  previous: readonly string[],
  next: readonly string[],
  stretch: Stretch,
): AlignmentStep[] {
  const previousLength = stretch.previousEnd - stretch.previousStart;
  const nextLength = stretch.nextEnd - stretch.nextStart;
  if (previousLength === 0 && nextLength === 0) {
    return [];
  }
  if (previousLength === 0 || nextLength === 0) {
    return [{ step: "run", run: { kind: previousLength === 0 ? "added" : "removed", ...stretch } }];
  }
  if (previousLength * nextLength <= EXACT_ALIGNMENT_WORD_PRODUCT) {
    return myersSteps(previous, next, stretch, undefined);
  }
  const anchors = uniqueWordAnchors(previous, next, stretch);
  if (anchors.length === 0) {
    const editBound = Math.max(
      1,
      Math.floor(FALLBACK_ALIGNMENT_WORD_WORK / (previousLength + nextLength)),
    );
    return myersSteps(previous, next, stretch, editBound);
  }
  const steps: AlignmentStep[] = [];
  let previousCursor = stretch.previousStart;
  let nextCursor = stretch.nextStart;
  for (const anchor of anchors) {
    steps.push({
      step: "stretch",
      stretch: {
        previousStart: previousCursor,
        previousEnd: anchor.previousIndex,
        nextStart: nextCursor,
        nextEnd: anchor.nextIndex,
      },
    });
    steps.push(keptStep(anchor.previousIndex, anchor.nextIndex, 1));
    previousCursor = anchor.previousIndex + 1;
    nextCursor = anchor.nextIndex + 1;
  }
  steps.push({
    step: "stretch",
    stretch: {
      previousStart: previousCursor,
      previousEnd: stretch.previousEnd,
      nextStart: nextCursor,
      nextEnd: stretch.nextEnd,
    },
  });
  return steps;
}

/**
 * A stretch aligned by jsdiff's Myers differ, exactly, or within `editBound` edits. Past the
 * bound the stretch is one removal and one addition.
 */
function myersSteps(
  previous: readonly string[],
  next: readonly string[],
  stretch: Stretch,
  editBound: number | undefined,
): AlignmentStep[] {
  const previousSlice = previous.slice(stretch.previousStart, stretch.previousEnd);
  const nextSlice = next.slice(stretch.nextStart, stretch.nextEnd);
  const changes =
    editBound === undefined
      ? diffArrays(previousSlice, nextSlice)
      : diffArrays(previousSlice, nextSlice, { maxEditLength: editBound });
  if (changes === undefined) {
    return [
      { step: "run", run: { kind: "removed", ...stretch, nextEnd: stretch.nextStart } },
      { step: "run", run: { kind: "added", ...stretch, previousStart: stretch.previousEnd } },
    ];
  }
  const steps: AlignmentStep[] = [];
  let previousCursor = stretch.previousStart;
  let nextCursor = stretch.nextStart;
  for (const change of changes) {
    const kind: RunKind = change.added ? "added" : change.removed ? "removed" : "kept";
    const previousCount = kind === "added" ? 0 : change.count;
    const nextCount = kind === "removed" ? 0 : change.count;
    steps.push({
      step: "run",
      run: {
        kind,
        previousStart: previousCursor,
        previousEnd: previousCursor + previousCount,
        nextStart: nextCursor,
        nextEnd: nextCursor + nextCount,
      },
    });
    previousCursor += previousCount;
    nextCursor += nextCount;
  }
  return steps;
}

/** A word that occurs once on each side of a stretch, at its index on each. */
interface WordAnchor {
  readonly previousIndex: number;
  readonly nextIndex: number;
}

/**
 * The words occurring exactly once on each side of a stretch, as the longest run of them in the
 * same order on both sides (patience sorting, `O(k log k)` in the `k` candidates).
 */
function uniqueWordAnchors(
  previous: readonly string[],
  next: readonly string[],
  stretch: Stretch,
): WordAnchor[] {
  const occurrences = new Map<string, WordOccurrence>();
  for (let index = stretch.previousStart; index < stretch.previousEnd; index += 1) {
    const word = previous[index] ?? "";
    const occurrence = occurrences.get(word);
    if (occurrence === undefined) {
      occurrences.set(word, {
        previousCount: 1,
        previousIndex: index,
        nextCount: 0,
        nextIndex: -1,
      });
    } else {
      occurrence.previousCount += 1;
    }
  }
  for (let index = stretch.nextStart; index < stretch.nextEnd; index += 1) {
    const occurrence = occurrences.get(next[index] ?? "");
    if (occurrence !== undefined) {
      occurrence.nextCount += 1;
      occurrence.nextIndex = index;
    }
  }
  const candidates: WordAnchor[] = [];
  for (let index = stretch.previousStart; index < stretch.previousEnd; index += 1) {
    const occurrence = occurrences.get(previous[index] ?? "");
    if (occurrence !== undefined && occurrence.previousCount === 1 && occurrence.nextCount === 1) {
      candidates.push({ previousIndex: index, nextIndex: occurrence.nextIndex });
    }
  }
  return longestIncreasingRun(candidates);
}

/** How often a word occurs on each side of a stretch, and where it last did. */
interface WordOccurrence {
  previousCount: number;
  previousIndex: number;
  nextCount: number;
  nextIndex: number;
}

/**
 * The longest subsequence of `candidates` (already ordered by `previousIndex`) whose
 * `nextIndex` also increases.
 */
function longestIncreasingRun(candidates: readonly WordAnchor[]): WordAnchor[] {
  // `tails[length - 1]` is the candidate index ending the best run of that length so far.
  const tails: number[] = [];
  const predecessors: number[] = new Array<number>(candidates.length).fill(-1);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const nextIndex = candidates[candidateIndex]?.nextIndex ?? 0;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((candidates[tails[middle] ?? 0]?.nextIndex ?? 0) < nextIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    predecessors[candidateIndex] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = candidateIndex;
  }
  const run: WordAnchor[] = [];
  for (let at = tails.at(-1) ?? -1; at !== -1; at = predecessors[at] ?? -1) {
    const candidate = candidates[at];
    if (candidate !== undefined) {
      run.push(candidate);
    }
  }
  return run.reverse();
}

function keptStep(previousStart: number, nextStart: number, length: number): AlignedRunStep {
  return {
    step: "run",
    run: {
      kind: "kept",
      previousStart,
      previousEnd: previousStart + length,
      nextStart,
      nextEnd: nextStart + length,
    },
  };
}

/** Append one side's words as a segment, joined to the last one when it is of the same kind. */
function appendSegment(
  segments: DiffIntralineSegment[],
  words: readonly string[],
  start: number,
  end: number,
  kind: RunKind,
): void {
  if (start === end) {
    return;
  }
  const text = words.slice(start, end).join("");
  const changed = kind !== "kept";
  const last = segments.at(-1);
  if (last !== undefined && last.changed === changed) {
    segments[segments.length - 1] = { text: last.text + text, changed };
    return;
  }
  segments.push({ text, changed });
}
