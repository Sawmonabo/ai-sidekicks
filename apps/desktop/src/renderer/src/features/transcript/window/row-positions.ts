// How one derivation's input moved since its last pass, read off the two arrays by identity, and
// where a row sits in a list kept in log order. A stage that can apply only what moved asks these
// first and derives whole when the answer is anything but growth at the end.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

/** How a row list grew: rows replaced in place by a same-id object, and the rows appended. */
export interface RowGrowth {
  /** Positions, ascending, whose row is a new object with the same id. */
  readonly replacedPositions: readonly number[];
  /** Where the appended rows start: the earlier list's length. */
  readonly appendedFrom: number;
}

/**
 * The items `next` holds after the ones `previous` held, when `next` starts with exactly those
 * objects in that order; `undefined` when any of them was removed, moved or replaced.
 */
export function appendedStretchOf<TItem>(
  previous: readonly TItem[],
  next: readonly TItem[],
): readonly TItem[] | undefined {
  if (next.length < previous.length) {
    return undefined;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return undefined;
    }
  }
  return next.slice(previous.length);
}

/** Whether two lists hold the same objects in the same order. Allocates nothing. */
export function holdsSameObjects<TItem>(left: readonly TItem[], right: readonly TItem[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * How `next` grew from `previous`, or `undefined` when a row was removed, moved, or replaced by one
 * with another id. A row replaced by a new object of its id is a row projected again.
 */
export function rowGrowthOf(
  previous: readonly TranscriptEventRow[],
  next: readonly TranscriptEventRow[],
): RowGrowth | undefined {
  if (next.length < previous.length) {
    return undefined;
  }
  const replacedPositions: number[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    const previousRow = previous[index] as TranscriptEventRow;
    const nextRow = next[index] as TranscriptEventRow;
    if (previousRow !== nextRow) {
      if (previousRow.id !== nextRow.id) {
        return undefined;
      }
      replacedPositions.push(index);
    }
  }
  return { replacedPositions, appendedFrom: previous.length };
}

/**
 * Where `row` sits in `rows`, a list in log order, or `-1`. A log is in sequence order, so a
 * binary search finds it; one it does not find there is looked for in every position.
 */
export function positionOfRow(
  rows: readonly TranscriptEventRow[],
  row: TranscriptEventRow,
): number {
  const position = sequenceInsertionPosition(rows, row.sequence);
  return rows[position] === row ? position : rows.indexOf(row);
}

/**
 * The first position in `rows`, a list in log order and so in sequence order, whose row's sequence
 * is not below `sequence`: where a row of that sequence goes to keep the list in log order.
 */
export function sequenceInsertionPosition(
  rows: readonly TranscriptEventRow[],
  sequence: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle] as TranscriptEventRow).sequence < sequence) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
