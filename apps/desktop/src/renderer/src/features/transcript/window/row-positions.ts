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
  // One walk over the ascending positions, asked once per index in order.
  let nextPosition = 0;
  return items.filter((_item, index) => {
    if (positions[nextPosition] !== index) {
      return true;
    }
    nextPosition += 1;
    return false;
  });
}
