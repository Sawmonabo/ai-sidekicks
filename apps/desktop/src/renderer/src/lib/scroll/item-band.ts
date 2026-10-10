// The band of items a windowed list draws around the ones its viewport intersects, reached in
// pixels rather than in items, so a list of short items draws as far past each edge as a list of
// tall ones.

/** A run of item indexes, both ends inclusive, out of `count` items. */
export interface ItemIndexRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly count: number;
}

/**
 * The first and last index of `range` widened by the items within `headPx` before it and `tailPx`
 * after it, each side including the item that crosses its edge, clamped to `[0, count - 1]`.
 * `sizeAtPx` answers an item's laid-out size, measured or estimated.
 */
export function widenRangeByPixels(
  range: ItemIndexRange,
  headPx: number,
  tailPx: number,
  sizeAtPx: (index: number) => number,
): { readonly startIndex: number; readonly endIndex: number } {
  let startIndex = range.startIndex;
  for (let drawnPx = 0; startIndex > 0 && drawnPx < headPx; ) {
    startIndex -= 1;
    drawnPx += sizeAtPx(startIndex);
  }
  let endIndex = range.endIndex;
  for (let drawnPx = 0; endIndex < range.count - 1 && drawnPx < tailPx; ) {
    endIndex += 1;
    drawnPx += sizeAtPx(endIndex);
  }
  return { startIndex, endIndex };
}
