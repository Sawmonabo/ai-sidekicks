// What one trace says about one scroll gesture: the gaps between the frames the window presented
// while the gesture moved the content, each moving update's wait for the frame that drew it, and
// whether the compositor found the scroller on its own.
//
// An update moved the content when Chromium's `ScrollJankV4` record for it says so: an update that
// arrives once the content is at its end moves nothing, and Chromium closes its record on whatever
// frame the window submits next, so it is counted apart rather than timed. Each moving update is
// timed from the input it was made from, a wheel turn or a touch move, reaching the renderer's
// compositor (`BrowserMainToRendererCompositor`), to the submit of the frame its
// `display_trace_id` names; the input shares the update's time stamp and arrives before it, so an
// input a handler holds is timed from when it arrived.
//
// A gesture's scroller is found by the compositor's own hit test unless that test cannot be
// trusted, as under a rounded clip, when the compositor asks the main thread to find it and the
// gesture waits for that answer before it moves anything (`PostingHitTestToMainThread`).

import type { TraceEvent } from "./recording.js";
import { readRefreshIntervalMs } from "./refresh.js";

/** The categories a scroll reading needs recorded. */
export const SCROLL_TRACE_CATEGORIES: readonly string[] = ["benchmark", "input"];

/** What one trace says about one gesture. */
export interface ScrollReading {
  /** One refresh of the display the window presented on, in milliseconds. */
  readonly refreshIntervalMs: number;
  /** The gaps between presented frames while the gesture moved the content, in whole refreshes. */
  readonly presentedFrameGapsInRefreshes: readonly number[];
  readonly movingUpdateCount: number;
  /** Updates with no frame of their own: they moved nothing, or Chromium merged them into the next. */
  readonly stillUpdateCount: number;
  /** Each moving update that no presented frame drew. */
  readonly undrawnUpdates: readonly string[];
  readonly gestureCount: number;
  /** Gestures whose scroller the compositor asked the main thread to find. */
  readonly mainThreadHitTestCount: number;
  /** The moving update that waited longest for the frame that drew it. */
  readonly slowestInputToSubmit: InputToSubmit;
}

/** One moving update's wait, from its input reaching the window to its frame's submit. */
export interface InputToSubmit {
  /** The update by type and time into the scroll, as a printed line or a failure names it. */
  readonly update: string;
  readonly durationMs: number;
  /** The same wait in refreshes of the display it was drawn on. */
  readonly refreshes: number;
}

/** The arrivals and submits recorded under one async id, in trace microseconds. */
interface StageTimes {
  readonly arrivedUs: number[];
  readonly submittedUs: number[];
}

/** The start and the end of one async trace record. */
interface TraceSpan {
  readonly begin: TraceEvent;
  readonly end: TraceEvent;
}

/** One compositor frame the window submitted, as Chromium's report of it describes it. */
interface SubmittedFrame {
  readonly submittedUs: number;
  readonly presentedAtUs: number | undefined;
}

const SCROLL_UPDATE_TYPES: ReadonlySet<string> = new Set([
  "FIRST_GESTURE_SCROLL_UPDATE",
  "GESTURE_SCROLL_UPDATE",
  "INERTIAL_GESTURE_SCROLL_UPDATE",
]);

const PRESENTED_FRAME_STATES: ReadonlySet<string> = new Set([
  "STATE_PRESENTED_ALL",
  "STATE_PRESENTED_PARTIAL",
]);

/** Chromium's damage type for a scroll frame that moved the content. */
const MOVING_DAMAGE_TYPE = "DAMAGING";

/** The instant the compositor records when it hands a gesture's hit test to the main thread. */
const MAIN_THREAD_HIT_TEST_RECORD = "PostingHitTestToMainThread";

/**
 * Reads one gesture from the records of the renderer it scrolled. Throws when no gesture reached
 * the window, when nothing moved the content, or when the trace holds no refresh interval.
 */
export function readScrollTrace(events: readonly TraceEvent[]): ScrollReading {
  const latencies = pairSpans(events, "EventLatency");
  const scrollBegins = latencies.filter(
    (span) => latencyOf(span.begin)["event_type"] === "GESTURE_SCROLL_BEGIN",
  );
  const firstScrollBegin = scrollBegins[0];
  if (firstScrollBegin === undefined) {
    throw new Error("no scroll gesture reached the window in the trace");
  }
  const rendererPid = firstScrollBegin.begin.pid;
  const refreshIntervalMs = readRefreshIntervalMs(
    events.filter((event) => event.pid === rendererPid),
  );
  // An update's stages share its async id and sit inside its span; ids are reused, so a stage is
  // matched by id and by falling inside the span.
  const stageTimesByKey = new Map<string, StageTimes>();
  const damageByResultId = new Map<string, string>();
  let mainThreadHitTestCount = 0;
  for (const event of events) {
    if (event.pid !== rendererPid) {
      continue;
    }
    const isArrival = event.name === "BrowserMainToRendererCompositor" && event.ph === "e";
    const isSubmit =
      event.name === "SubmitCompositorFrameToPresentationCompositorFrame" && event.ph === "b";
    if (isArrival || isSubmit) {
      const stages = stageTimesByKey.get(spanKey(event)) ?? { arrivedUs: [], submittedUs: [] };
      (isArrival ? stages.arrivedUs : stages.submittedUs).push(event.ts);
      stageTimesByKey.set(spanKey(event), stages);
    }
    if (event.name === "ScrollJankV4" && event.ph === "b") {
      const result = recordOf(event, "scroll_jank_v4");
      damageByResultId.set(String(result["result_id"]), String(result["damage_type"]));
    }
    if (event.name === MAIN_THREAD_HIT_TEST_RECORD) {
      mainThreadHitTestCount += 1;
    }
  }

  // A wheel turn or a touch move reaches the window before the update the browser makes from it,
  // which the browser sends only once the window has let the input through. The two share the
  // person's time stamp, so the earliest arrival among records stamped alike is the input's.
  const inputArrivalByStamp = new Map<number, number>();
  for (const { begin, end } of latencies) {
    const arrivedUs = arrivalWithin(stageTimesByKey, begin, end);
    if (begin.pid === rendererPid && arrivedUs !== undefined) {
      inputArrivalByStamp.set(
        begin.ts,
        Math.min(inputArrivalByStamp.get(begin.ts) ?? arrivedUs, arrivedUs),
      );
    }
  }

  // A frame the main thread finished late has two reports, one for the frame the compositor drew
  // on its own and one for the main thread's; each is its own submitted frame.
  const frames: SubmittedFrame[] = [];
  const frameByDisplayTraceId = new Map<string, SubmittedFrame>();
  for (const { begin, end } of pairSpans(events, "PipelineReporter")) {
    const report = recordOf(begin, "frame_reporter");
    const submittedUs = stageTimesByKey
      .get(spanKey(begin))
      ?.submittedUs.find((atUs) => atUs >= begin.ts && atUs <= end.ts);
    if (begin.pid !== rendererPid || report["display_trace_id"] === undefined) {
      continue;
    }
    if (submittedUs === undefined) {
      throw new Error("a frame report carries a display id and no submit");
    }
    const frame: SubmittedFrame = {
      submittedUs,
      presentedAtUs: PRESENTED_FRAME_STATES.has(String(report["state"])) ? end.ts : undefined,
    };
    frames.push(frame);
    frameByDisplayTraceId.set(String(report["display_trace_id"]), frame);
  }

  const undrawnUpdates: string[] = [];
  const inputToSubmits: InputToSubmit[] = [];
  const drawnPresentationsUs: number[] = [];
  let movingUpdateCount = 0;
  let stillUpdateCount = 0;
  for (const { begin } of latencies) {
    const latency = latencyOf(begin);
    const updateType = String(latency["event_type"]);
    if (begin.pid !== rendererPid || !SCROLL_UPDATE_TYPES.has(updateType)) {
      continue;
    }
    const resultId = recordOf(begin, "scroll_jank_v4")["result_id"];
    if (resultId === undefined || damageByResultId.get(String(resultId)) !== MOVING_DAMAGE_TYPE) {
      stillUpdateCount += 1;
      continue;
    }
    movingUpdateCount += 1;
    const inputArrivedUs = inputArrivalByStamp.get(begin.ts);
    const update = `${updateType} ${((begin.ts - firstScrollBegin.begin.ts) / 1000).toFixed(1)} ms in`;
    const drawingFrame = frameByDisplayTraceId.get(String(latency["display_trace_id"]));
    if (inputArrivedUs === undefined || drawingFrame?.presentedAtUs === undefined) {
      undrawnUpdates.push(update);
      continue;
    }
    const durationMs = (drawingFrame.submittedUs - inputArrivedUs) / 1000;
    inputToSubmits.push({ update, durationMs, refreshes: durationMs / refreshIntervalMs });
    drawnPresentationsUs.push(drawingFrame.presentedAtUs);
  }
  if (inputToSubmits.length === 0) {
    throw new Error("no scroll update in the trace moved the content");
  }

  const firstDrawnUs = Math.min(...drawnPresentationsUs);
  const lastDrawnUs = Math.max(...drawnPresentationsUs);
  const presentationsUs = [
    ...new Set(
      frames
        .map((frame) => frame.presentedAtUs)
        .filter(
          (atUs): atUs is number =>
            atUs !== undefined && atUs >= firstDrawnUs && atUs <= lastDrawnUs,
        ),
    ),
  ].sort((left, right) => left - right);
  // Presentation stamps land a few microseconds either side of a vsync, so each gap is counted in
  // the whole refreshes it spans.
  const presentedFrameGapsInRefreshes = presentationsUs
    .slice(1)
    .map((atUs, index) =>
      Math.round((atUs - (presentationsUs[index] ?? atUs)) / 1000 / refreshIntervalMs),
    );
  if (presentedFrameGapsInRefreshes.length === 0) {
    throw new Error("the gesture moved the content in a single presented frame");
  }
  return {
    refreshIntervalMs,
    presentedFrameGapsInRefreshes,
    movingUpdateCount,
    stillUpdateCount,
    undrawnUpdates,
    gestureCount: scrollBegins.filter((span) => span.begin.pid === rendererPid).length,
    mainThreadHitTestCount,
    slowestInputToSubmit: slowestOf(inputToSubmits),
  };
}

/** The longest of several waits by refreshes; throws on none, since a reading always has one. */
export function slowestOf(waits: readonly InputToSubmit[]): InputToSubmit {
  const [first, ...rest] = waits;
  if (first === undefined) {
    throw new Error("there is no wait to take the slowest of");
  }
  return rest.reduce(
    (slowest, candidate) => (candidate.refreshes > slowest.refreshes ? candidate : slowest),
    first,
  );
}

/** When the input or update a latency record follows reached the window, if the trace has it. */
function arrivalWithin(
  stageTimesByKey: ReadonlyMap<string, StageTimes>,
  begin: TraceEvent,
  end: TraceEvent,
): number | undefined {
  return stageTimesByKey
    .get(spanKey(begin))
    ?.arrivedUs.find((atUs) => atUs >= begin.ts && atUs <= end.ts);
}

/** Pairs each named async record's start with its end, by process and async id. */
function pairSpans(events: readonly TraceEvent[], name: string): readonly TraceSpan[] {
  const openByKey = new Map<string, TraceEvent>();
  const spans: TraceSpan[] = [];
  const named = events
    .filter((event) => event.name === name)
    .sort((left, right) => left.ts - right.ts);
  for (const event of named) {
    if (event.ph === "b") {
      openByKey.set(spanKey(event), event);
      continue;
    }
    const begin = openByKey.get(spanKey(event));
    if (event.ph === "e" && begin !== undefined) {
      openByKey.delete(spanKey(event));
      spans.push({ begin, end: event });
    }
  }
  return spans;
}

function spanKey(event: TraceEvent): string {
  return `${String(event.pid)}:${event.id2?.local ?? event.id ?? ""}`;
}

/** One named record in an event's arguments, or an empty one where the event carries none. */
function recordOf(event: TraceEvent, member: string): Record<string, unknown> {
  return (event.args?.[member] as Record<string, unknown> | undefined) ?? {};
}

function latencyOf(event: TraceEvent): Record<string, unknown> {
  return recordOf(event, "event_latency");
}
