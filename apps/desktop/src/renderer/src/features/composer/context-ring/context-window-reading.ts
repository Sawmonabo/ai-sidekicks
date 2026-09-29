// What the composer's meters read, and the one place a reading is narrowed.
//
// THE WIRE POSITION. `usage.context_window_update` and `usage.context_compacted` are
// registered session EVENT TYPES, each in `SESSION_EVENT_TYPES` and in the category map,
// and `SessionEventSchema` registers a payload variant for neither. There is no schema to
// parse against and no generated type to import: the payload reaches the store as
// `Readonly<Record<string, unknown>>`, and this module is the only place in the composer
// that turns one into a figure. The account-plane quota reading is folded in
// `console/bridge/quotas/provider-quota-fold.ts`; the two readings here are session-scoped.
//
// THE NARROWING RULE. A reading is produced only when every member it needs is present at
// the right type; a payload short one member yields NO reading rather than a partial one,
// because a meter drawn from half a payload is a meter that invented the other half. The
// surfaces above render the "not checked" absence, which is the honest answer to "we have
// not been told".
//
// THE MEMBERS ARE THE REGISTERED ONES. The registered usage-telemetry payload carries
// `windowUsedTokens?`, `windowMaxTokens?`, `windowSource?`, and `exceeded?`. The wire sends
// counts and no percentage, so this module derives the presentation percentage from the
// counts; a surface that read a percentage would be reading a member that does not exist.
//
// EVERY READING IS ONE RUN'S. A session holds as many provider conversations as it has
// runs, and a context window belongs to one of them, so the reading takes the ADDRESSED run
// as an input, as the compaction fold does. A row whose `runId` is absent, empty, or not a
// string is read for no run at all: attributing an unattributed row to whichever run the
// composer points at would be a fabrication. A composer addressed to the session asks for
// no reading at all.
//
// A COMPACTION BOUNDARY IS PART OF THE READING. The wire states the consumer obligation: a
// compaction invalidates the run's last used-tokens reading, replaced by
// `postCompactionTokens` when present, else unknown before the next
// `usage.context_window_update`. So the newest boundary ABOVE the newest update decides,
// and its two arms are the wire's own. The compacted arm carries forward the DENOMINATOR
// and its grade from the superseded update, because a compaction shrinks the conversation
// and not the window, and dropping the grade would promote an estimated window to the
// ungraded render a provider-reported one gets. `exceeded` is dropped, because a compaction
// is the wire's own evidence that the state that flag reported has ended.
//
// THE COUNTS TRAVEL AS A PAIR, and this reading requires both. A payload naming one of
// them is an emitter bug, and the reading it would otherwise produce is worse than
// none: a numerator with no denominator renders as 0% of an unknown window, which is a
// confident answer to a question nobody asked. The recorded limit is the mirror case —
// a counts-absent row carrying only provenance and `exceeded` is a headroom-unknown
// signal this meter does not read, because this meter draws a ratio and there is none;
// the protective responses that signal authorizes belong to the run-control layer and
// are not a bar's to make.
//
// Nothing here reaches the bridge, a clock, or a store. It is a pure fold over rows
// the store already holds, so one input always yields one reading and a test can
// state the whole contract with three literals.

import { readWireString } from "@renderer/lib/wire-strings.js";
import type { ConsoleSessionEvent } from "@renderer/console/store/entities/entities.js";

/** The registered event type the context meter reads. Verbatim, never composed. */
export const CONTEXT_WINDOW_EVENT_KIND = "usage.context_window_update";

/** The registered event type that is the ONLY evidence a compaction happened. */
export const CONTEXT_COMPACTED_EVENT_KIND = "usage.context_compacted";

/**
 * How the counts in a context-window row were obtained.
 *
 * The registered vocabulary, closed and declared once, so a fourth value fails to
 * narrow rather than rendering under whichever arm a fallback picked.
 */
export const CONTEXT_WINDOW_SOURCES = ["provider_reported", "model_default", "estimated"] as const;

/** One such provenance. Derived from the enumeration above. */
export type ContextWindowSource = (typeof CONTEXT_WINDOW_SOURCES)[number];

/** How full the conversation is, as the daemon last reported it. */
export interface ContextWindowReading {
  /**
   * Whole percent, 0 to 100, DERIVED from the pair below.
   *
   * Derived and not read: the registered payload carries no percentage at all. It
   * is rounded to a whole percent because that is what the bar and the figure both
   * render, and clamped because a provider reporting more used than its own window
   * holds is a real reading of an exceeded window rather than a reason to draw
   * nothing.
   */
  readonly usagePercent: number;
  readonly windowUsedTokens: number;
  readonly windowMaxTokens: number;
  /**
   * How the counts were obtained, when the wire named it.
   *
   * Absent means the wire did not say, not a fourth grade, and a surface renders
   * provenance only where the wire named one.
   */
  readonly windowSource: ContextWindowSource | undefined;
  /**
   * The provider's own terminal statement that the window is exhausted.
   *
   * Carried as sent. A surface renders the exceeded arm on `true` alone and never
   * on an absence, because absence is the wire not saying and not a provider saying
   * the window is fine.
   */
  readonly exceeded: boolean | undefined;
  /** The row this reading came from, so two readings can be ordered. */
  readonly sequence: number;
}

/**
 * The newest context-window reading recorded for ONE run, or `undefined`.
 *
 * Newest by SEQUENCE and not by `occurredAt`: sequence is the session's own total
 * order and the store already dedupes and gap-checks on it, while two rows can
 * share a millisecond. The meter never redraws from a prediction, so it renders the
 * last reading it received rather than the last thing that happened.
 *
 * The run filter is what makes the answer a reading of the conversation the composer is
 * addressed to: with two agents running at once, each reports its own fullness.
 */
export function newestContextWindowReading(
  timeline: readonly ConsoleSessionEvent[],
  targetRunId: string | undefined,
): ContextWindowReading | undefined {
  const addressedRunId = readWireString(targetRunId);
  if (addressedRunId === undefined) {
    return undefined;
  }
  let newest: ContextWindowReading | undefined;
  for (const event of timeline) {
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
  const boundary = newestCompactionBoundary(timeline, addressedRunId);
  if (boundary === undefined || (newest !== undefined && newest.sequence > boundary.sequence)) {
    // No boundary at all, or an update after the newest one: the update is then the
    // freshest thing the daemon has said about this conversation, and it stands.
    return newest;
  }
  return readingAfterCompaction(newest, boundary);
}

/**
 * What the meter reads once a compaction has superseded the last update.
 *
 * Both arms are the wire's, and neither invents a count. A boundary carrying
 * `postCompactionTokens` restates the numerator against the window the superseded
 * update measured; one carrying none leaves the ratio UNKNOWN, and unknown is no
 * reading — the surfaces above then render the absence, which is the honest answer
 * to "how full is it now" while the only figure available describes a conversation
 * the compaction ended.
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
    windowSource: superseded.windowSource,
    // Never carried across a boundary: the compaction is the evidence that the
    // window the provider called full is not the window in front of anyone.
    exceeded: undefined,
    sequence: boundary.sequence,
  };
}

/** One recorded compaction: where it sits in the log, and what it left behind. */
interface CompactionBoundary {
  readonly sequence: number;
  /** The post-compaction count, when the row carried a readable one. */
  readonly postCompactionTokens: number | undefined;
}

/**
 * The newest compaction boundary recorded for one run.
 *
 * Whether the meter's last update has been superseded by a compaction is asked of
 * this one selection, so there is a single answer to "which row is this run's newest
 * boundary".
 */
function newestCompactionBoundary(
  timeline: readonly ConsoleSessionEvent[],
  addressedRunId: string | undefined,
): CompactionBoundary | undefined {
  if (addressedRunId === undefined) {
    return undefined;
  }
  let newest: CompactionBoundary | undefined;
  for (const event of timeline) {
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

function readContextWindow(event: ConsoleSessionEvent): ContextWindowReading | undefined {
  const windowUsedTokens = wholeCount(event.payload?.["windowUsedTokens"]);
  const windowMaxTokens = wholeCount(event.payload?.["windowMaxTokens"]);
  // A zero denominator joins the absent ones: it is not a full window and it is not
  // an empty one, it is a window whose size the row did not state.
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

/** The presentation percentage: whole, and clamped into the bar's own range. */
function percentOf(used: number, max: number): number {
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

/** One registered provenance value, or nothing. Never a free string. */
function contextWindowSource(value: unknown): ContextWindowSource | undefined {
  return CONTEXT_WINDOW_SOURCES.find((source) => source === value);
}

/** A boolean exactly as sent, or nothing. A truthy non-boolean is not a boolean. */
function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A non-negative integer count, or nothing. */
function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
