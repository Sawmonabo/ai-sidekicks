// A decision about which rows leave a list, held as their positions so a later pass can apply it to
// that pass's row objects without asking every row again. A streamed update replaces a row's object
// but not its place, so the positions stay right until the list's membership moves, which
// `holdsSameObjects` tells apart without allocating.

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

/** The positions of the items `isRemoved` picks, ascending. */
export function findPositions<TItem>(
  items: readonly TItem[],
  isRemoved: (item: TItem) => boolean,
): number[] {
  const positions: number[] = [];
  items.forEach((item, index) => {
    if (isRemoved(item)) {
      positions.push(index);
    }
  });
  return positions;
}

/** The items outside `positions`, in list order; `positions` ascend. */
export function itemsOutsidePositions<TItem>(
  items: readonly TItem[],
  positions: readonly number[],
): TItem[] {
  const isAtPosition = sitsAtPositions(positions);
  return items.filter((_item, index) => !isAtPosition(index));
}

/** The items outside `positions` and the items at them, each in list order; `positions` ascend. */
export function partitionByPositions<TItem>(
  items: readonly TItem[],
  positions: readonly number[],
): { readonly kept: TItem[]; readonly removed: TItem[] } {
  const isAtPosition = sitsAtPositions(positions);
  const kept: TItem[] = [];
  const removed: TItem[] = [];
  items.forEach((item, index) => {
    (isAtPosition(index) ? removed : kept).push(item);
  });
  return { kept, removed };
}

/**
 * A test asked once per index, in ascending order, of whether that index is the next of
 * `positions`; the one walk both readers above share.
 */
function sitsAtPositions(positions: readonly number[]): (index: number) => boolean {
  let nextPosition = 0;
  return (index) => {
    if (positions[nextPosition] !== index) {
      return false;
    }
    nextPosition += 1;
    return true;
  };
}
