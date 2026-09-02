// How many lanes a script has streaming at once, read from the script itself.
//
// WHY THIS IS A MODULE AND NOT A NUMBER IN A TEST. `budgets.json`'s
// `frame-time-p95-four-lanes` bounds the renderer "while four agent lanes stream
// concurrently into the ledger". A gate for that row has to establish that its
// sampled window contained four concurrent streaming lanes, and the only thing that
// can establish it is the script the window played. A constant `4` written into the
// harness would go on passing over a scenario that had stopped streaming, which is
// exactly the failure the row exists to catch — and is exactly what the row's first
// enforced revision did, against a scenario with no assistant beat in it at all.
//
// It sits beside the scenarios rather than in the endurance tier because two callers
// need it: that tier's frame-time harness, and the unit test that holds the flagship
// script to its own claim. A copy in each would be two definitions of "streaming"
// that drift, and the drift would be silent — both copies would still return a
// number.
//
// WHAT "STREAMING" MEANS HERE, STATED SO IT CANNOT BE WIDENED BY ACCIDENT
//
// A run is streaming at a point in the script when BOTH are true:
//
//   • its latest `run_lifecycle` transition put it in `running`, and
//   • it has at least one more `assistant_output` or `tool_activity` beat still to
//     come before it leaves that state.
//
// The second conjunct is the load-bearing one. A run sitting in `running` with
// nothing left to say is a lane the ledger draws and does not animate, and counting
// it would let a script of four idle runs satisfy a budget about four streaming
// ones. So the definition is "mid-turn with output still ahead of it", which is the
// state the frame cost being measured actually belongs to.
//
// The families are read from the census (`SESSION_EVENT_CATEGORY_BY_TYPE`) rather
// than from a `kind.startsWith("run.")` test, for the reason `wire-truth.ts` gives:
// the census is the wire's own answer to which family a type is in, and a prefix
// test is this module's guess at it.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

import type { ScenarioBeat } from "../scenario.js";

/**
 * One unbroken span of one run being `running`, and what it said inside it.
 *
 * Spans rather than a per-beat state map: a run can enter and leave `running`
 * several times in one script — the flagship's approval does exactly that — and the
 * output beats of one span say nothing about whether the NEXT span is streaming.
 */
interface RunningSpan {
  readonly runId: string;
  /** Index of the `run.running` beat that opened the span. */
  readonly startIndex: number;
  /** Index of the transition that closed it, or the script length if it never did. */
  endIndex: number;
  /** Indices of this span's own output beats, ascending. */
  readonly outputIndices: number[];
}

/** The run this beat is about, or `undefined` where the payload names none. */
function readRunId(beat: ScenarioBeat): string | undefined {
  const runId = beat.event.payload?.["runId"];
  return typeof runId === "string" ? runId : undefined;
}

/** The state this beat moves a run into, or `undefined` where it is not a transition. */
function readNewState(beat: ScenarioBeat): string | undefined {
  const newState = beat.event.payload?.["newState"];
  return typeof newState === "string" ? newState : undefined;
}

/** Which family the census puts this beat's type in, or `undefined` for a type it has no entry for. */
function categoryOf(beat: ScenarioBeat): string | undefined {
  return SESSION_EVENT_CATEGORY_BY_TYPE.get(beat.event.kind as SessionEventType);
}

/** Every `running` span in the script, in the order they opened. */
function collectRunningSpans(beats: readonly ScenarioBeat[]): readonly RunningSpan[] {
  const spans: RunningSpan[] = [];
  const openSpanByRunId = new Map<string, RunningSpan>();
  for (const [beatIndex, beat] of beats.entries()) {
    const runId = readRunId(beat);
    if (runId === undefined) {
      continue;
    }
    const category = categoryOf(beat);
    if (category === "run_lifecycle") {
      const newState = readNewState(beat);
      if (newState === undefined) {
        // A forward, non-state run row (`run.rolled_back` and its siblings). It
        // reports no transition, so it neither opens nor closes a span.
        continue;
      }
      const openSpan = openSpanByRunId.get(runId);
      if (openSpan !== undefined) {
        openSpan.endIndex = beatIndex;
        openSpanByRunId.delete(runId);
      }
      if (newState === "running") {
        const span: RunningSpan = {
          runId,
          startIndex: beatIndex,
          endIndex: beats.length,
          outputIndices: [],
        };
        spans.push(span);
        openSpanByRunId.set(runId, span);
      }
      continue;
    }
    if (category === "assistant_output" || category === "tool_activity") {
      openSpanByRunId.get(runId)?.outputIndices.push(beatIndex);
    }
  }
  return spans;
}

/** Whether this span still has output ahead of the given point. */
function isStreamingAt(span: RunningSpan, beatIndex: number): boolean {
  return (
    span.startIndex <= beatIndex &&
    beatIndex < span.endIndex &&
    span.outputIndices.some((outputIndex) => outputIndex > beatIndex)
  );
}

/**
 * The most lanes this script has streaming at one time, within the given beat range.
 *
 * `fromIndex` / `toIndex` are delivered-beat counts — the two numbers the endurance
 * tier's sampler reports at the edges of its window — so a caller measuring a window
 * asks about exactly the beats that window contained. Over the whole script, pass
 * `0` and `beats.length`.
 *
 * The range is half-open, and the peak is taken over the points INSIDE it: a lane
 * that opened before `fromIndex` and is still mid-turn counts, because it is
 * streaming through the window whether or not it started there.
 */
export function peakConcurrentStreamingRuns(
  beats: readonly ScenarioBeat[],
  fromIndex: number,
  toIndex: number,
): number {
  const spans = collectRunningSpans(beats);
  const firstIndex = Math.max(0, fromIndex);
  const lastIndex = Math.min(beats.length, toIndex);
  let peak = 0;
  for (let beatIndex = firstIndex; beatIndex < lastIndex; beatIndex += 1) {
    let concurrent = 0;
    for (const span of spans) {
      if (isStreamingAt(span, beatIndex)) {
        concurrent += 1;
      }
    }
    peak = Math.max(peak, concurrent);
  }
  return peak;
}
