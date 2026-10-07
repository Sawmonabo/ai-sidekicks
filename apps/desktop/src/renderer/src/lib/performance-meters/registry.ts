// The dev-tier perf meters: frame time per feed, reveal drain per frame, apply latency and store
// size. Only frame time has a budget row (`tests/budget/document.json`, a p95 within one refresh);
// the other three are ways of spending that p95 which the p95 alone does not show.
//
// Compiled out of built bundles rather than gated at runtime: each recording entry point is an
// `if (import.meta.env.DEV)` body, which Vite replaces with a literal, so the registry is
// unreachable from a built entry. One bounded series type serves all four readings. The meters
// never schedule anything: a producer records what it already measured.

import { PERFORMANCE_METER_BOUNDS } from "./bounds.js";

/** The four things the app meters. */
export const PERFORMANCE_METER_KINDS = [
  // Milliseconds one scheduled frame spent draining its phases.
  "frame-time",
  // Reveal units one engine drained in one frame.
  "reveal-drain",
  // Milliseconds one store's apply chokepoint took to fold one batch.
  "apply-latency",
  // Entries one store's transcript holds. A gauge: the latest reading is the reading.
  "store-size",
] as const;

/** One of {@link PERFORMANCE_METER_KINDS}. */
export type PerformanceMeterKind = (typeof PERFORMANCE_METER_KINDS)[number];

/** What one series says when it is read. */
export interface PerformanceMeterReading {
  readonly kind: PerformanceMeterKind;
  /** The lane, store scope, or coordinator-scoped key the samples came from. */
  readonly seriesKey: string;
  /** Samples retained, which is at most the retention bound. */
  readonly sampleCount: number;
  /** Samples recorded, including those the ring has since dropped. */
  readonly recordedCount: number;
  readonly median: number;
  /** The percentile the bounds table names, over the retained samples. */
  readonly upperPercentile: number;
  readonly worst: number;
  /** The most recent sample, which is the whole reading for a gauge. */
  readonly latest: number;
}

/** The app's perf-meter registry; a class so each test gets its own samples. */
export class PerformanceMeterRegistry {
  /**
   * One map per kind rather than one map keyed by the two joined: a joined key needs a separator
   * no series key can contain, which would be a control character.
   */
  readonly #seriesByKind = new Map<PerformanceMeterKind, Map<string, BoundedSampleSeries>>();
  #openSeriesCount = 0;
  #refusedSeriesCount = 0;

  /** Record one sample. The series bound is over the whole registry, not each kind's map. */
  public record(kind: PerformanceMeterKind, seriesKey: string, sample: number): void {
    // A non-finite sample is a failed measurement; folding it in would skew every percentile.
    if (!Number.isFinite(sample)) {
      return;
    }
    const boundedKey = seriesKey.slice(0, PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount);
    let seriesForKind = this.#seriesByKind.get(kind);
    const existing = seriesForKind?.get(boundedKey);
    if (existing !== undefined) {
      existing.record(sample);
      return;
    }
    if (this.#openSeriesCount >= PERFORMANCE_METER_BOUNDS.seriesCount) {
      // Counted, not dropped silently: it means a key is minted per event, or a per-producer key
      // is never retired.
      this.#refusedSeriesCount += 1;
      return;
    }
    if (seriesForKind === undefined) {
      seriesForKind = new Map<string, BoundedSampleSeries>();
      this.#seriesByKind.set(kind, seriesForKind);
    }
    const opened = new BoundedSampleSeries();
    opened.record(sample);
    seriesForKind.set(boundedKey, opened);
    this.#openSeriesCount += 1;
  }

  /**
   * Retire one series so the bound counts live producers, not past ones; otherwise a feed that
   * mounts and unmounts would exhaust the bound and later series would be refused. Retired per
   * exact key, never by prefix, since a key is opaque except to its producer. Answers whether
   * anything was retired; truncation matches `record`.
   */
  public retire(kind: PerformanceMeterKind, seriesKey: string): boolean {
    const boundedKey = seriesKey.slice(0, PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount);
    const seriesForKind = this.#seriesByKind.get(kind);
    if (seriesForKind === undefined || !seriesForKind.delete(boundedKey)) {
      return false;
    }
    this.#openSeriesCount -= 1;
    if (seriesForKind.size === 0) {
      this.#seriesByKind.delete(kind);
    }
    return true;
  }

  /** One series' reading, or `null` where that series has recorded nothing. */
  public reading(kind: PerformanceMeterKind, seriesKey: string): PerformanceMeterReading | null {
    const boundedKey = seriesKey.slice(0, PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount);
    const series = this.#seriesByKind.get(kind)?.get(boundedKey);
    if (series === undefined || series.retainedCount === 0) {
      return null;
    }
    const sorted = series.sortedSamples();
    return {
      kind,
      seriesKey: boundedKey,
      sampleCount: series.retainedCount,
      recordedCount: series.recordedCount,
      median: nearestRankSample(sorted, 50),
      upperPercentile: nearestRankSample(sorted, PERFORMANCE_METER_BOUNDS.reportedPercentile),
      worst: sorted[sorted.length - 1] ?? 0,
      latest: series.latest,
    };
  }

  /** Every reading the registry holds, in the order the series were opened. */
  public readings(): readonly PerformanceMeterReading[] {
    const collected: PerformanceMeterReading[] = [];
    for (const [kind, seriesForKind] of this.#seriesByKind) {
      for (const seriesKey of seriesForKind.keys()) {
        const reading = this.reading(kind, seriesKey);
        if (reading !== null) {
          collected.push(reading);
        }
      }
    }
    return collected;
  }

  /** How many series the registry refused to open because it was already full. */
  public get refusedSeriesCount(): number {
    return this.#refusedSeriesCount;
  }

  /** How many series are open, across every kind. */
  public get seriesCount(): number {
    return this.#openSeriesCount;
  }

  /** Forget every sample and every refusal. */
  public reset(): void {
    this.#seriesByKind.clear();
    this.#openSeriesCount = 0;
    this.#refusedSeriesCount = 0;
  }
}

/**
 * One bounded sample series: a fixed-length array written round-robin, since `shift` is O(n) per
 * sample and the meter must not slow a frame that is already slow.
 */
class BoundedSampleSeries {
  readonly #samples = new Float64Array(PERFORMANCE_METER_BOUNDS.seriesSampleCount);
  #writeIndex = 0;
  #retainedCount = 0;
  #recordedCount = 0;

  public record(sample: number): void {
    this.#samples[this.#writeIndex] = sample;
    this.#writeIndex = (this.#writeIndex + 1) % PERFORMANCE_METER_BOUNDS.seriesSampleCount;
    this.#recordedCount += 1;
    if (this.#retainedCount < PERFORMANCE_METER_BOUNDS.seriesSampleCount) {
      this.#retainedCount += 1;
    }
  }

  public get recordedCount(): number {
    return this.#recordedCount;
  }

  public get retainedCount(): number {
    return this.#retainedCount;
  }

  /** The most recent sample, or zero when nothing has been recorded. */
  public get latest(): number {
    if (this.#retainedCount === 0) {
      return 0;
    }
    const latestIndex =
      (this.#writeIndex + PERFORMANCE_METER_BOUNDS.seriesSampleCount - 1) %
      PERFORMANCE_METER_BOUNDS.seriesSampleCount;
    return this.#samples[latestIndex] ?? 0;
  }

  /** The retained samples, ascending; sorted on read so the write path stays cheap. */
  public sortedSamples(): readonly number[] {
    const retained = Array.from(this.#samples.slice(0, this.#retainedCount));
    return retained.sort((left, right) => left - right);
  }
}

/** The nearest-rank percentile, so the reading is always a sample actually observed. */
function nearestRankSample(sortedSamples: readonly number[], percentile: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  const index = Math.min(Math.max(rank, 1), sortedSamples.length) - 1;
  return sortedSamples[index] ?? 0;
}

/**
 * The app's registry in development, and `null` in a built bundle, where the build-time
 * literal folds this to `null` and the class becomes unreachable.
 */
export const developmentPerformanceMeters: PerformanceMeterRegistry | null = import.meta.env.DEV
  ? new PerformanceMeterRegistry()
  : null;

/**
 * The instant a producer measures a duration against: `performance.now()` in development, `0`
 * in a built bundle. Not the app's `Clock`, whose one-millisecond resolution would read a
 * frame as 0 or 17 ms. Values from here are only subtracted from each other.
 */
export function readPerformanceMeterTime(): number {
  return import.meta.env.DEV ? performance.now() : 0;
}

/**
 * Record a frame's cost. The guard is the build literal, not a null check on
 * `developmentPerformanceMeters`, so the body and the call fold away in a built bundle.
 */
export function recordFrameTime(seriesKey: string, milliseconds: number): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.record("frame-time", seriesKey, milliseconds);
  }
}

/**
 * Record what one reveal engine's drain revealed in one frame, keyed by its coordinator and frame
 * task. Not per lane: an engine drains every lane in one frame, so the sample is the whole drain.
 */
export function recordRevealDrain(seriesKey: string, revealedUnitCount: number): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.record("reveal-drain", seriesKey, revealedUnitCount);
  }
}

/**
 * Retire the frame-time series one coordinator opened; called from its dispose. Only the two
 * kinds keyed by instance retire; the other two key by store scope, a fixed vocabulary.
 */
export function retireFrameTimeSeries(seriesKey: string): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.retire("frame-time", seriesKey);
  }
}

/** Retire one composed reveal-drain series. Called from the coordinator's dispose. */
export function retireRevealDrainSeries(seriesKey: string): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.retire("reveal-drain", seriesKey);
  }
}

/** Record how long one store's apply chokepoint took to fold one batch. */
export function recordApplyLatency(storeScope: string, milliseconds: number): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.record("apply-latency", storeScope, milliseconds);
  }
}

/** Record how many entries one store's partition holds. */
export function recordStoreSize(storeScope: string, entryCount: number): void {
  if (import.meta.env.DEV) {
    developmentPerformanceMeters?.record("store-size", storeScope, entryCount);
  }
}
