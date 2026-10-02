// Order statistics over a series of samples, shared by the tiers that summarize one. Each throws on
// an empty series, since a summary of nothing would be read as a measurement.

function sortedAscending(samples: readonly number[], statistic: string): readonly number[] {
  if (samples.length === 0) {
    throw new Error(`refusing to take the ${statistic} of an empty sample series`);
  }
  return [...samples].sort((left, right) => left - right);
}

/**
 * The nearest-rank percentile: the smallest sample with at least `fraction` of the series at or
 * below it, the one definition that returns a value the run observed.
 */
export function percentileByNearestRank(samples: readonly number[], fraction: number): number {
  const sorted = sortedAscending(samples, "percentile");
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] as number;
}

/** The median, averaging the two middle samples of an even-length series. */
export function medianOf(samples: readonly number[]): number {
  const sorted = sortedAscending(samples, "median");
  const upperMiddle = Math.floor(sorted.length / 2);
  const lowerMiddle = sorted.length % 2 === 0 ? upperMiddle - 1 : upperMiddle;
  return ((sorted[lowerMiddle] as number) + (sorted[upperMiddle] as number)) / 2;
}
