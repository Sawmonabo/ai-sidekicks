// Narrows `usage.context_window_update` and `usage.context_compacted` rows into a per-run
// context-window reading. Neither payload has a registered schema, so this is the one place an
// unknown record becomes a figure; a payload missing a member yields no reading, never a
// partial one. Pure fold over the rows it is given: no bridge, clock or store. The store keeps the
// rows it folds among its standing events, which measure the window by the same reader.

import {
  CONTEXT_WINDOW_SOURCES,
  type ContextWindowSource,
} from "@ai-sidekicks/contracts/context-window";
import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";

/** Event type of a context-window update row. */
export const CONTEXT_WINDOW_EVENT_KIND = "usage.context_window_update";

/** Event type of a compaction row, the only evidence that a compaction happened. */
export const CONTEXT_COMPACTED_EVENT_KIND = "usage.context_compacted";

/** How full one run's conversation is, as the daemon last reported it. */
export interface ContextWindowReading {
  /**
   * Whole percent, 0 to 100, derived from the counts because the wire carries no
   * percentage. Clamped: a provider can report more used than its window holds.
   */
  readonly usagePercent: number;
  readonly windowUsedTokens: number;
  readonly windowMaxTokens: number;
  /** Absent means the wire did not name a provenance. */
  readonly windowSource: ContextWindowSource | undefined;
  /** Carried as sent; absence is the wire not saying, never "the window is fine". */
  readonly exceeded: boolean | undefined;
  /** Sequence of the source row, so two readings can be ordered. */
  readonly sequence: number;
}

/**
 * The newest reading for one run among `events`, or `undefined` when no run is addressed or no
 * row qualifies. Newest by `sequence`, not `occurredAt`: two rows can share a millisecond. A
 * newer compaction boundary supersedes the last update, and a row with no readable
 * `runId` belongs to no run.
 */
export function newestContextWindowReading(
  events: readonly ProjectedSessionEvent[],
  targetRunId: string | undefined,
): ContextWindowReading | undefined {
  const addressedRunId = readWireString(targetRunId);
  if (addressedRunId === undefined) {
    return undefined;
  }
  let newest: ContextWindowReading | undefined;
  for (const event of events) {
    if (event.kind !== CONTEXT_WINDOW_EVENT_KIND) {
      continue;
    }
    if (readWireString(event.payload?.["runId"]) !== addressedRunId) {
      continue;
    }
    const reading = readContextWindow(event);
    if (reading !== undefined && (newest === undefined || reading.sequence > newest.sequence)) {
      newest = reading;
    }
  }
  const boundary = newestCompactionBoundary(events, addressedRunId);
  if (boundary === undefined || (newest !== undefined && newest.sequence > boundary.sequence)) {
    return newest;
  }
  return readingAfterCompaction(newest, boundary);
}

/**
 * One update row's reading, or `undefined` for a row that measures no window: one without both
 * counts, or with a window of zero.
 */
export function readContextWindow(event: ProjectedSessionEvent): ContextWindowReading | undefined {
  const windowUsedTokens = wholeCount(event.payload?.["windowUsedTokens"]);
  const windowMaxTokens = wholeCount(event.payload?.["windowMaxTokens"]);
  // A zero denominator is a window size the row did not state. Counts travel as a pair: a row with
  // only provenance and `exceeded` is not read, as this meter draws a ratio and acting on that
  // signal is not a bar's job.
  if (windowUsedTokens === undefined || windowMaxTokens === undefined || windowMaxTokens === 0) {
    return undefined;
  }
  return {
    usagePercent: percentOf(windowUsedTokens, windowMaxTokens),
    windowUsedTokens,
    windowMaxTokens,
    windowSource: contextWindowSource(event.payload?.["windowSource"]),
    exceeded: booleanOrUndefined(event.payload?.["exceeded"]),
    sequence: event.sequence,
  };
}

/**
 * The reading once a compaction has superseded the last update: the boundary's
 * `postCompactionTokens` against the window the superseded update measured, or none when
 * either is missing (unknown until the next update).
 */
function readingAfterCompaction(
  superseded: ContextWindowReading | undefined,
  boundary: CompactionBoundary,
): ContextWindowReading | undefined {
  if (superseded === undefined || boundary.postCompactionTokens === undefined) {
    return undefined;
  }
  return {
    usagePercent: percentOf(boundary.postCompactionTokens, superseded.windowMaxTokens),
    windowUsedTokens: boundary.postCompactionTokens,
    windowMaxTokens: superseded.windowMaxTokens,
    // The provenance travels with the window: dropping it would render a model-default window as
    // if the provider had reported it.
    windowSource: superseded.windowSource,
    // A compaction ends the state the flag reported.
    exceeded: undefined,
    sequence: boundary.sequence,
  };
}

interface CompactionBoundary {
  readonly sequence: number;
  readonly postCompactionTokens: number | undefined;
}

function newestCompactionBoundary(
  events: readonly ProjectedSessionEvent[],
  addressedRunId: string | undefined,
): CompactionBoundary | undefined {
  if (addressedRunId === undefined) {
    return undefined;
  }
  let newest: CompactionBoundary | undefined;
  for (const event of events) {
    if (event.kind !== CONTEXT_COMPACTED_EVENT_KIND) {
      continue;
    }
    if (readWireString(event.payload?.["runId"]) !== addressedRunId) {
      continue;
    }
    if (newest === undefined || event.sequence > newest.sequence) {
      newest = {
        sequence: event.sequence,
        postCompactionTokens: wholeCount(event.payload?.["postCompactionTokens"]),
      };
    }
  }
  return newest;
}

function percentOf(used: number, max: number): number {
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

function contextWindowSource(value: unknown): ContextWindowSource | undefined {
  return CONTEXT_WINDOW_SOURCES.find((source) => source === value);
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
