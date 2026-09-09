// The dev-tier perf meters.
//
// Four readings an author needs while the console is running and no shipped build
// should pay for: frame time per feed, reveal drain per frame, apply latency, and
// store sizes.
//
// EXACTLY ONE OF THE FOUR IS A FIGURE A BUDGET IS STATED OVER, and saying so is the
// point of this paragraph. `Spec-023 §Budgets` is an eight-row table, and the one row
// naming a reading this module takes is "Frame time, four lanes streaming | p95 ≤
// 16.7 ms on the reference machine". Reveal drain, apply latency, and store size are
// stated over no budget row in that table and carry no row in `budgets.json` either:
// they are what THIS module proposes, because the frame budget is the only one of the
// four whose regressions the others make legible — an overrunning drain, a stalled
// apply, and a store that grew are each a way of spending the p95 that budget bounds,
// and none of them is visible in the p95 itself. Naming the split is what lets a later
// lane re-derive the budget set from `budgets.json` and find it agrees.
//
// COMPILED OUT OF RELEASE BY THE FIXTURE DEFINE, not gated at runtime. Every
// recording entry point below is a `if (__SIDEKICKS_CONSOLE_FIXTURES__)` body, which
// is a build-time literal, so Rollup folds the call to nothing and the registry that
// would have received it is unreachable from a release entry. A runtime flag would
// leave the measurement code — and its retained samples — in the shipped bundle,
// which is the cost the meters exist to avoid paying twice.
//
// WHY A REGISTRY OF SERIES AND NOT FOUR COUNTERS. All four readings are the same
// question asked of different producers: what does this thing usually cost, and what
// does it cost when it is bad. One bounded series type answers it once, so the p95
// the frame-time budget is written against and the p95 an author reads for apply
// latency are the same computation rather than two that agree until one is edited.
//
// OWNER. The measurement task of Plan-023 Phase 1C, T-023p-1C-8, whose text names
// the budgets and the tiers that read them but not the meters that feed them. No
// other task's text names this module; naming it here is the proposal.
//
// AND THE METERS NEVER SCHEDULE ANYTHING. There is no sampling timer, no animation
// frame, no interval: a producer records what it already measured, and a reader
// computes on demand. A meter that woke the process to observe an idle console
// would be spending exactly the budget it reports on.

import { PERF_METER_BOUNDS } from "./perf-meter-bounds.js";

/** The four things the console meters. Closed — the tuple is the declaration. */
export const PERF_METER_KINDS = [
  // Milliseconds one scheduled frame spent draining its phases.
  "frame-time",
  // Reveal units one engine drained in one frame.
  "reveal-drain",
  // Milliseconds one store's apply chokepoint took to fold one batch.
  "apply-latency",
  // Entries one store's timeline holds. A gauge: the latest reading is the reading.
  "store-size",
] as const;

/** One metered kind, derived so the set is declared exactly once. */
export type PerfMeterKind = (typeof PERF_METER_KINDS)[number];

/** What one series says when it is read. */
export interface PerfMeterReading {
  readonly kind: PerfMeterKind;
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

/**
 * The console's perf-meter registry.
 *
 * A class rather than module-level maps so a test constructs one, drives it, and
 * drops it. Module-level state would carry samples between cases and make every
 * percentile assertion depend on what ran before it.
 */
export class PerfMeterRegistry {
  /**
   * One map per kind, rather than one map keyed by the two joined.
   *
   * A joined key needs a separator no series key can contain, and the only characters
   * that qualify are control characters — which make the module that holds one a
   * binary file to every diff tool that reads it. Nesting needs no separator at all,
   * so a lane named with any character at all is a key here and `readings()` recovers
   * the kind by standing in its map rather than by parsing it back out of a string.
   */
  readonly #seriesByKind = new Map<PerfMeterKind, Map<string, BoundedSampleSeries>>();
  #openSeriesCount = 0;
  #refusedSeriesCount = 0;

  /**
   * Record one sample.
   *
   * The series bound is over the registry and not over one kind's map, so four kinds
   * cannot quietly hold four times what the bound says.
   */
  public record(kind: PerfMeterKind, seriesKey: string, sample: number): void {
    // A non-finite sample is a measurement that failed, not a slow frame. Folding one
    // into the series would move every percentile permanently and silently.
    if (!Number.isFinite(sample)) {
      return;
    }
    const boundedKey = seriesKey.slice(0, PERF_METER_BOUNDS.seriesKeyCharacterCount);
    let seriesForKind = this.#seriesByKind.get(kind);
    const existing = seriesForKind?.get(boundedKey);
    if (existing !== undefined) {
      existing.record(sample);
      return;
    }
    if (this.#openSeriesCount >= PERF_METER_BOUNDS.seriesCount) {
      // Counted rather than dropped in silence: the count IS the finding, and it says
      // either that a producer is minting a key per event instead of per producer, or
      // that one which mints a key per producer is not retiring it when that producer
      // goes away — which reads identically here and is the failure `retire` closes.
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
   * Retire one series, so the bound above counts LIVE producers and not past ones.
   *
   * WITHOUT THIS THE BOUND IS OVER HISTORY, which is the same thing as no bound at
   * all for any producer whose key names an instance. A ledger feed mints a
   * coordinator on mount and disposes it on unmount; 64 mounts later every further
   * series is refused, and the p95 an author reads is the p95 of feeds that closed
   * hours ago while the feed on screen contributes nothing. That failure is silent —
   * the refusal count is the only trace, and nothing reads it yet.
   *
   * PER KEY AND NEVER BY PREFIX. The composed keys are readable, so a "retire
   * everything starting with this" would work and would also be the string-parsing
   * this registry deliberately avoids by nesting its maps: a key is opaque to
   * everything except the producer that minted it, and that producer is the one
   * holding the exact string it opened.
   *
   * Answers whether it retired anything, so a caller that expected to own a series
   * can tell "closed it" from "there was nothing there" rather than inferring it from
   * a count that moved. Truncation runs the same way `record` runs it, so a key past
   * the character bound retires the series it opened.
   */
  public retire(kind: PerfMeterKind, seriesKey: string): boolean {
    const boundedKey = seriesKey.slice(0, PERF_METER_BOUNDS.seriesKeyCharacterCount);
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
  public reading(kind: PerfMeterKind, seriesKey: string): PerfMeterReading | null {
    const boundedKey = seriesKey.slice(0, PERF_METER_BOUNDS.seriesKeyCharacterCount);
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
      upperPercentile: nearestRankSample(sorted, PERF_METER_BOUNDS.reportedPercentile),
      worst: sorted[sorted.length - 1] ?? 0,
      latest: series.latest,
    };
  }

  /** Every reading the registry holds, in the order the series were opened. */
  public readings(): readonly PerfMeterReading[] {
    const collected: PerfMeterReading[] = [];
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
 * One bounded sample series.
 *
 * A fixed-length backing array written round-robin rather than an array that is
 * pushed and shifted: `shift` is O(n) per sample at the exact moment the console is
 * already behind, and the meter must not be the reason a slow frame is slower.
 */
class BoundedSampleSeries {
  readonly #samples = new Float64Array(PERF_METER_BOUNDS.seriesSampleCount);
  #writeIndex = 0;
  #retainedCount = 0;
  #recordedCount = 0;

  public record(sample: number): void {
    this.#samples[this.#writeIndex] = sample;
    this.#writeIndex = (this.#writeIndex + 1) % PERF_METER_BOUNDS.seriesSampleCount;
    this.#recordedCount += 1;
    if (this.#retainedCount < PERF_METER_BOUNDS.seriesSampleCount) {
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
      (this.#writeIndex + PERF_METER_BOUNDS.seriesSampleCount - 1) %
      PERF_METER_BOUNDS.seriesSampleCount;
    return this.#samples[latestIndex] ?? 0;
  }

  /**
   * The retained samples, ascending.
   *
   * Sorted on READ and never on write, because a reader is an author looking at a
   * panel and a writer is the frame the panel is measuring.
   */
  public sortedSamples(): readonly number[] {
    const retained = Array.from(this.#samples.slice(0, this.#retainedCount));
    return retained.sort((left, right) => left - right);
  }
}

/**
 * Where a percentile falls in an ascending sample list.
 *
 * Nearest-rank, which is the definition that needs no interpolation and therefore
 * always reports a sample the console actually observed. An interpolated p95 is a
 * number no frame ever cost, and the reading is used to decide whether a real frame
 * blew the budget.
 */
function nearestRankSample(sortedSamples: readonly number[], percentile: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  const index = Math.min(Math.max(rank, 1), sortedSamples.length) - 1;
  return sortedSamples[index] ?? 0;
}

/**
 * The console's registry under a fixture or development build, and `null` in a
 * release one.
 *
 * The ternary's condition is a build-time literal, so a release bundle folds this to
 * `null` and the class above becomes unreachable from every release entry — which is
 * what "compiled out" means here, as opposed to constructed and then not consulted.
 */
export const devPerfMeters: PerfMeterRegistry | null = __SIDEKICKS_CONSOLE_FIXTURES__
  ? new PerfMeterRegistry()
  : null;

/**
 * The instant a producer measures a duration against.
 *
 * `performance.now()` and not the console's `ConsoleClock`, whose `now()` answers
 * `Date.now()`: its resolution is one millisecond, which is the whole of a frame
 * budget, so a frame timed against it reads 0 ms or 17 ms and nothing in between.
 *
 * It is not a second clock seam. Nothing here schedules, every call site is inside a
 * `__SIDEKICKS_CONSOLE_FIXTURES__` branch that folds away with the recording it
 * feeds, and a value from here is only ever subtracted from another value from here.
 * One home rather than a `performance.now()` at each producer, so the four durations
 * a reader compares are all measured off the same source.
 */
export function perfMeterNow(): number {
  return performance.now();
}

/**
 * Record a frame's cost. The call site shape every producer uses.
 *
 * The guard is the define and not a null check on `devPerfMeters`, so the argument
 * expressions at the call site fold away with the call in a release build. A null
 * check would leave the producer computing a figure nothing reads.
 */
export function recordFrameTime(seriesKey: string, milliseconds: number): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.record("frame-time", seriesKey, milliseconds);
  }
}

/**
 * Record what one reveal engine's drain revealed in one frame, keyed by its
 * coordinator and its frame task.
 *
 * NOT PER LANE, and the distinction is the reading: an engine drains every lane it
 * holds inside one frame, so the sample is that whole drain and a key naming a lane
 * would promise a per-lane figure the producer never measures.
 */
export function recordRevealDrain(seriesKey: string, revealedUnitCount: number): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.record("reveal-drain", seriesKey, revealedUnitCount);
  }
}

/**
 * Retire the frame-time series one coordinator opened. Called from its dispose.
 *
 * The retiring entry points exist for the two kinds whose key names an INSTANCE. The
 * other two key by store scope, which is a fixed vocabulary a session does not mint
 * more of, so neither has a producer with anything to retire and neither is given a
 * door it would never call.
 */
export function retireFrameTimeSeries(seriesKey: string): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.retire("frame-time", seriesKey);
  }
}

/** Retire one composed reveal-drain series. Called from the coordinator's dispose. */
export function retireRevealDrainSeries(seriesKey: string): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.retire("reveal-drain", seriesKey);
  }
}

/** Record how long one store's apply chokepoint took to fold one batch. */
export function recordApplyLatency(storeScope: string, milliseconds: number): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.record("apply-latency", storeScope, milliseconds);
  }
}

/** Record how many entries one store's partition holds. */
export function recordStoreSize(storeScope: string, entryCount: number): void {
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    devPerfMeters?.record("store-size", storeScope, entryCount);
  }
}
