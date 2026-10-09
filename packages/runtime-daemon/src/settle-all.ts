// Parallel steps that all settle before anyone cleans up after them, so no step still writes once
// the cleanup starts.

/**
 * Waits until every one of `work` has settled, so nothing still runs when a caller cleans up, then
 * throws the one failure, or every distinct failure in one `AggregateError` (steps that share an
 * input that failed throw it once); otherwise resolves with each value in order.
 */
export async function settleAll<const Work extends readonly unknown[]>(
  work: Work,
  operation: string,
): Promise<{ -readonly [Index in keyof Work]: Awaited<Work[Index]> }> {
  const outcomes = await Promise.allSettled(work);
  const failures = [
    ...new Set(
      outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      ),
    ),
  ];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${operation} failed`);
  }
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value) as {
    -readonly [Index in keyof Work]: Awaited<Work[Index]>;
  };
}
