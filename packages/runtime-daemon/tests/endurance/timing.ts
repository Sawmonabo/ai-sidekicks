// The percentiles an endurance measurement reports, read from the durations of its runs.

/** The 50th and 95th percentile of a measurement's runs, in milliseconds. */
export interface Timing {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

/** The percentiles of `durationsMs` by nearest rank; zero for no runs. */
export function timingOf(durationsMs: readonly number[]): Timing {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const at = (percent: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0;
  return { p50Ms: at(50), p95Ms: at(95) };
}
