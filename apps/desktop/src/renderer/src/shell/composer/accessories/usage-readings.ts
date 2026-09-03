// What the composer's meters read, and the one place a reading is narrowed.
//
// THE WIRE POSITION, STATED RATHER THAN ASSUMED. `usage.context_window_update`,
// `usage.rate_limit_update`, and `usage.context_compacted` are registered session
// EVENT TYPES — each is in `SESSION_EVENT_TYPES` and in the category map — and
// `SessionEventSchema` registers a payload variant for none of them. There is no
// schema to parse against and no generated type to import: the payload reaches the
// store as `Readonly<Record<string, unknown>>`, and this module is the only place
// in the composer that turns one into a figure.
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

import type { ConsoleSessionEvent } from "../../../console/store/index.js";

/** The registered event type the context meter reads. Verbatim, never composed. */
export const CONTEXT_WINDOW_EVENT_KIND = "usage.context_window_update";

/** The registered event type the rate chips read. */
export const RATE_LIMIT_EVENT_KIND = "usage.rate_limit_update";

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
 * One provider account's quota in one limit window.
 *
 * Keyed by `(providerAccountId, limitId)` — the pair these readings were re-keyed
 * to when a pinned provider surface turned out to publish three distinct windows of
 * the same length, which a duration key cannot hold.
 */
export interface RateLimitReading {
  readonly providerAccountId: string;
  readonly limitId: string;
  /** The account's own label. Mandatory: an unlabelled chip names no account. */
  readonly accountLabel: string;
  /** The window's own label. Mandatory for the same reason. */
  readonly limitLabel: string;
  /** Whole percent consumed, as given. Remaining is derived from it and never sent. */
  readonly usedPercent: number;
  /** ISO-8601, when the wire carried one. A countdown renders only if it did. */
  readonly resetsAt: string | undefined;
  /** ISO-8601 observation instant — the merge key. */
  readonly observedAt: string;
  /** Which credential generation observed it, when the wire carried one. */
  readonly credentialGeneration: number | undefined;
  readonly sequence: number;
}

/** A reading plus the one thing only the fold can say about it. */
export interface FoldedRateLimitReading extends RateLimitReading {
  /**
   * True when a LATER reading for this same account carried a higher credential
   * generation than this one did.
   *
   * Derived from rows the console holds and from nothing else. The account plane's
   * own stored readings are the other source the design names, and no bridge
   * namespace and no growth-port operation reaches them today — so "behind" here
   * means behind what this session has itself observed, which is a claim the
   * console can actually support.
   */
  readonly isStale: boolean;
}

/**
 * The newest context-window reading in a timeline, or `undefined`.
 *
 * Newest by SEQUENCE and not by `occurredAt`: sequence is the session's own total
 * order and the store already dedupes and gap-checks on it, while two rows can
 * share a millisecond. The meter never redraws from a prediction, so it renders the
 * last thing it was told rather than the last thing that happened.
 */
export function newestContextWindowReading(
  timeline: readonly ConsoleSessionEvent[],
): ContextWindowReading | undefined {
  let newest: ContextWindowReading | undefined;
  for (const event of timeline) {
    if (event.kind !== CONTEXT_WINDOW_EVENT_KIND) {
      continue;
    }
    const reading = readContextWindow(event);
    if (reading !== undefined && (newest === undefined || reading.sequence > newest.sequence)) {
      newest = reading;
    }
  }
  return newest;
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
  const addressedRunId = nonEmptyString(targetRunId);
  if (addressedRunId === undefined) {
    return undefined;
  }
  let newest: number | undefined;
  for (const event of timeline) {
    if (event.kind !== CONTEXT_COMPACTED_EVENT_KIND) {
      continue;
    }
    if (nonEmptyString(event.payload?.["runId"]) !== addressedRunId) {
      continue;
    }
    if (newest === undefined || event.sequence > newest) {
      newest = event.sequence;
    }
  }
  return newest;
}

/**
 * Every rate-limit reading a timeline carries, one per `(account, limit)` pair.
 *
 * THE MERGE RULE, in two clauses rather than one. The design merges by newest
 * `observedAt` with the source breaking an exact tie. The console reaches one source
 * today, so the tie-break is expressed as the session's own total order — a later
 * sequence wins an exact `observedAt` tie — which is a real order the store
 * maintains rather than an arbitrary one this module invented. A second source lands
 * as a second input to this fold, never as a second fold.
 *
 * The result is ordered by `(accountLabel, limitLabel)`, so two renders of one
 * timeline place a chip in the same position. Deliberately NOT by urgency: a chip
 * that moves when its own number moves is a chip a person has to re-find at the
 * moment they most need to read it.
 */
export function foldRateLimitReadings(
  timeline: readonly ConsoleSessionEvent[],
): readonly FoldedRateLimitReading[] {
  const newestByKey = new Map<string, RateLimitReading>();
  const newestGenerationByAccount = new Map<string, number>();

  for (const event of timeline) {
    if (event.kind !== RATE_LIMIT_EVENT_KIND) {
      continue;
    }
    const reading = readRateLimit(event);
    if (reading === undefined) {
      continue;
    }
    rememberNewestGeneration(newestGenerationByAccount, reading);
    const key = `${reading.providerAccountId} ${reading.limitId}`;
    const held = newestByKey.get(key);
    if (held === undefined || supersedes(reading, held)) {
      newestByKey.set(key, reading);
    }
  }

  return [...newestByKey.values()]
    .map((reading) => ({
      ...reading,
      isStale: isBehindNewestGeneration(reading, newestGenerationByAccount),
    }))
    .sort(compareByLabels);
}

/** Remaining quota, from the consumed figure the wire supplies. Never sent as such. */
export function remainingPercentOf(reading: RateLimitReading): number {
  return 100 - reading.usedPercent;
}

function rememberNewestGeneration(
  newestGenerationByAccount: Map<string, number>,
  reading: RateLimitReading,
): void {
  if (reading.credentialGeneration === undefined) {
    return;
  }
  const known = newestGenerationByAccount.get(reading.providerAccountId);
  if (known === undefined || reading.credentialGeneration > known) {
    newestGenerationByAccount.set(reading.providerAccountId, reading.credentialGeneration);
  }
}

function supersedes(candidate: RateLimitReading, held: RateLimitReading): boolean {
  if (candidate.observedAt === held.observedAt) {
    return candidate.sequence > held.sequence;
  }
  return candidate.observedAt > held.observedAt;
}

function isBehindNewestGeneration(
  reading: RateLimitReading,
  newestGenerationByAccount: ReadonlyMap<string, number>,
): boolean {
  const newest = newestGenerationByAccount.get(reading.providerAccountId);
  if (newest === undefined || reading.credentialGeneration === undefined) {
    return false;
  }
  return reading.credentialGeneration < newest;
}

function compareByLabels(left: FoldedRateLimitReading, right: FoldedRateLimitReading): number {
  const byAccount = left.accountLabel.localeCompare(right.accountLabel);
  return byAccount === 0 ? left.limitLabel.localeCompare(right.limitLabel) : byAccount;
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

function readRateLimit(event: ConsoleSessionEvent): RateLimitReading | undefined {
  const providerAccountId = nonEmptyString(event.payload?.["providerAccountId"]);
  const limitId = nonEmptyString(event.payload?.["limitId"]);
  const accountLabel = nonEmptyString(event.payload?.["accountLabel"]);
  const limitLabel = nonEmptyString(event.payload?.["limitLabel"]);
  const usedPercent = wholePercent(event.payload?.["usedPercent"]);
  const observedAt = nonEmptyString(event.payload?.["observedAt"]);
  if (
    providerAccountId === undefined ||
    limitId === undefined ||
    accountLabel === undefined ||
    limitLabel === undefined ||
    usedPercent === undefined ||
    observedAt === undefined
  ) {
    return undefined;
  }
  return {
    providerAccountId,
    limitId,
    accountLabel,
    limitLabel,
    usedPercent,
    observedAt,
    resetsAt: nonEmptyString(event.payload?.["resetsAt"]),
    credentialGeneration: wholeCount(event.payload?.["credentialGeneration"]),
    sequence: event.sequence,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A whole percent in `[0, 100]`, or nothing.
 *
 * Out of range is refused rather than clamped: a clamp would draw a full meter for
 * a payload reporting 140, which reads as a confident answer to a question the
 * console should be saying it cannot answer.
 */
function wholePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

/** A non-negative integer count, or nothing. */
function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
