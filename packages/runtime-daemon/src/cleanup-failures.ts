// What a failed operation throws once cleaning up after it failed too.

/**
 * `original` carrying the cleanup failures on its `cause`, so its type and code still reach the
 * caller; a cause it already had is kept first beside them in one `AggregateError`. An `original`
 * that is not an `Error` is thrown with them in one `AggregateError`.
 */
export function withCleanupFailures(
  original: unknown,
  cleanupFailures: readonly unknown[],
  operation: string,
): unknown {
  if (cleanupFailures.length === 0) {
    return original;
  }
  if (!(original instanceof Error)) {
    return new AggregateError(
      [original, ...cleanupFailures],
      `${operation} failed, and cleaning up after it failed too`,
    );
  }
  const causes: readonly unknown[] =
    original.cause === undefined ? cleanupFailures : [original.cause, ...cleanupFailures];
  original.cause =
    causes.length === 1
      ? causes[0]
      : new AggregateError(causes, `the ${operation} failure's cause, then its cleanup failures`);
  return original;
}
