// What the composer's meters read, and the one place a reading is narrowed.
//
// THE WIRE POSITION, STATED RATHER THAN ASSUMED. `usage.context_window_update` and
// `usage.context_compacted` are registered session EVENT TYPES — each is in
// `SESSION_EVENT_TYPES` and in the category map — and `SessionEventSchema` registers
// a payload variant for neither. There is no schema to parse against and no
// generated type to import: the payload reaches the store as
// `Readonly<Record<string, unknown>>`, and this module is the only place in the
// composer that turns one into a figure.
//
// AND WHY THE RATE-LIMIT FOLD IS NO LONGER HERE. It used to be — a third fold over
// `usage.rate_limit_update` rows, keyed `(providerAccountId, limitId)`, producing the
// composer's quota chips. That event is ACCOUNT-PLANE: `Spec-006 §Daemon-Scope Event
// Binding And Node-Scope Anchoring` binds it to the reserved node-scope sentinel
// session, so a live session store holds none of them and the chips could appear only
// under a fixture that put one in a session's log. The fold moved whole to
// `console/bridge/quotas/provider-account-quota.ts`, which reads the registry the wire
// actually publishes it on; the two readings this module still narrows are genuinely
// session-scoped and stay.
//
// That makes the narrowing rule sharp. A reading is produced only when every member
// it needs is present at the right type; a payload short one member yields NO
// reading rather than a partial one, because a meter drawn from half a payload is a
// meter that invented the other half. The surfaces above then render the
// "not checked" absence, which is the honest answer to "we have not been told".
//
// AND THE MEMBERS ARE THE REGISTERED ONES, NOT THE ONES A FIXTURE HAPPENED TO SEND.
// The context reading used to be narrowed from `usagePercent`, `tokenCount`, and
// `maxTokens` — three names that appear in this repository's own fixtures and in no
// registered payload. `Spec-006 §Usage Telemetry (usage_telemetry)` gives this
// type `windowUsedTokens?`, `windowMaxTokens?`, `windowSource?`, and `exceeded?`, so
// the shipped narrowing could never have matched a daemon-sent row and the meter
// would have rendered the "not reported" absence against a live session forever. The
// adaptation happens HERE and nowhere above: the wire sends counts and this module
// derives the presentation percentage from them, because the wire sends no
// percentage and a surface that read one would be reading a member that does not
// exist.
//
// AND EVERY READING IS ONE RUN'S. A session holds as many provider conversations as
// it has runs, and a context window belongs to one of them: the newest row anywhere
// in the session was answering "how full is that conversation" about whichever run
// spoke last. So the context reading takes the ADDRESSED run as an input exactly as
// the compaction fold does, and a row whose `runId` is absent, empty, or not a
// string is read for no run at all — attributing an unattributed row to whichever
// run the composer happens to point at is the same fabrication in the other
// direction. `Spec-006 §Usage Telemetry (usage_telemetry)` types that member
// `runId?`, so the absence is a shape the wire admits and this module answers with
// no reading rather than with a guess. A composer addressed to a channel asks for
// no reading at all.
//
// AND A COMPACTION BOUNDARY IS PART OF THE READING, not a separate fact beside it.
// `Spec-006 §Usage Telemetry (usage_telemetry)` states the consumer obligation in
// terms: a compaction invalidates the run's last used-tokens reading — "replaced by
// `postCompactionTokens` when present, else unknown until the next
// `usage.context_window_update`". A fold that read only the update rows honoured
// neither arm: the meter stayed at the pre-compaction figure, indefinitely where no
// update followed, and went on advising a compaction that had already happened. So
// the newest boundary ABOVE the newest update is what decides, and its two arms are
// the wire's own. What the compacted arm carries forward from the superseded update
// is the DENOMINATOR and its grade — a compaction shrinks the conversation, not the
// window, and dropping the grade would silently promote an estimated window to the
// ungraded render a provider-reported one gets — while `exceeded` is dropped,
// because a compaction is the wire's own evidence that the state that flag reported
// has ended.
//
// THE COUNTS TRAVEL AS A PAIR, and this reading requires both. A payload naming one
// of them is an emitter bug by that spec's own words, and the reading it would
// otherwise produce is worse than none: a numerator with no denominator renders as
// 0% of an unknown window, which is a confident answer to a question nobody asked.
// The recorded limit is the mirror case — a counts-absent row carrying only
// provenance and `exceeded` is a headroom-unknown signal this meter does not read,
// because this meter draws a ratio and there is none; the protective responses that
// signal authorizes belong to the run-control layer and are not a bar's to make.
//
// Nothing here reaches the bridge, a clock, or a store. It is a pure fold over rows
// the store already holds, so one input always yields one reading and a test can
// state the whole contract with three literals.

import { readWireString } from "../../../console/core/index.js";
import type { ConsoleSessionEvent } from "../../../console/store/index.js";

/** The registered event type the context meter reads. Verbatim, never composed. */
export const CONTEXT_WINDOW_EVENT_KIND = "usage.context_window_update";

/**
 * The registered event type that is the ONLY evidence a compaction happened.
 *
 * The compaction control settles on its own call; the COMPLETED state is this row
 * and nothing else, which is why the constant sits beside the other two rather than
 * inside the control — the control offers, and the log records.
 */
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
   * Absent is pre-amendment history rather than a fourth grade — a post-B1 emitter
   * MUST set it — and a surface renders provenance only where the wire named one.
   */
  readonly windowSource: ContextWindowSource | undefined;
  /**
   * The provider's own terminal statement that the window is exhausted.
   *
   * Carried as sent. A surface renders the exceeded arm on `true` alone and never
   * on an absence, because absence is what a pre-amendment emitter sends and not a
   * provider saying the window is fine.
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
 * last thing it was told rather than the last thing that happened.
 *
 * The run filter is what makes the answer a reading of the conversation the
 * composer is addressed to. Without it a session running two agents at once showed
 * the composer addressed to one of them the other's fullness, and offered to
 * compact on the strength of it.
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
 * that no longer exists.
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
    // window the provider called full is no longer the window in front of anyone.
    exceeded: undefined,
    sequence: boundary.sequence,
  };
}

/**
 * The sequence of the newest compaction boundary recorded for ONE run, or
 * `undefined` when that run has none.
 *
 * THE RUN FILTER IS THE WHOLE FOLD, AND THE POSITION IS THE ROW'S OWN SLOT. The
 * registered payload for this type is `{ sessionId, runId, provider,
 * preCompactionTokens?, postCompactionTokens? }` — there is no boundary-position
 * member to read, and the wire's own name for the pathological case is a compaction
 * row with no recoverable timeline slot. So `sequence` IS the position, and what
 * this fold owes is selecting the ADDRESSED run's rows rather than the session's: a
 * session with two runs was showing one run's boundary under the other's control.
 *
 * A row whose `runId` is absent, empty, or not a string yields NO reading, the way
 * every other narrowing in this module does — counting it as the addressed run's
 * would be the console asserting a boundary it was never told belongs here. A
 * composer addressed to no run asks for nothing at all.
 */
export function newestCompactionBoundarySequence(
  timeline: readonly ConsoleSessionEvent[],
  targetRunId: string | undefined,
): number | undefined {
  return newestCompactionBoundary(timeline, readWireString(targetRunId))?.sequence;
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
 * One selection serving two questions — where the control's completed line points,
 * and whether the meter's last update has been superseded — because two loops over
 * the same rows would be two answers to "which row is this run's newest boundary"
 * and they would disagree the first time either was edited.
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
