/** Each value an earlier value in the list already holds, with its index, in list order. */
export function findRepeats<Value>(values: readonly Value[]): { index: number; value: Value }[] {
  const seen = new Set<Value>();
  return values.flatMap((value, index) => {
    const isRepeat = seen.has(value);
    seen.add(value);
    return isRepeat ? [{ index, value }] : [];
  });
}
