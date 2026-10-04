// How many lanes a script has streaming at once, read from the script itself.
//
// `frame-time-p95-four-lanes` bounds the renderer "while four agent lanes stream concurrently
// into the transcript", so its gate must establish that its sampled window contained four
// concurrent streaming lanes. A constant `4` in the harness would keep passing over a scenario
// that had stopped streaming, so the frame-time harness reads this one definition of
// "streaming".
//
// A run is streaming at a point in the script when both hold:
//   - its latest `run_lifecycle` transition put it in `running`, and
//   - at least one more `assistant_output` or `tool_activity` beat comes before it leaves
//     that state.
// The second condition is the load-bearing one: a run in `running` with nothing left to say is
// a lane the transcript draws and does not animate, and counting it would let four idle runs
// satisfy a budget about four streaming ones.
//
// Categories are read from the census (`SESSION_EVENT_CATEGORY_BY_TYPE`) rather than a
// `kind.startsWith("run.")` test: the census is the wire's own answer, a prefix test a guess.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event";
import type { SessionEventType } from "@ai-sidekicks/contracts/event-registry";
import type { ScenarioBeat } from "../../fixtures/scenario.js";

/**
 * The most lanes this script has streaming at one time, within the given beat range.
 *
 * `fromIndex` / `toIndex` are delivered-beat counts, as the endurance sampler reports at the
 * edges of its window; over the whole script pass `0` and `beats.length`. The range is
 * half-open and the peak is taken over the points inside it: a lane that opened before
 * `fromIndex` and is still mid-turn counts.
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

/**
 * One unbroken span of one run being `running`, and what it said inside it.
 *
 * Spans rather than a per-beat state map, since a run can enter and leave `running` several
 * times (the concurrent-streaming approval does) and one span's output says nothing about the
 * next span.
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

/** The census category of this beat's type, or `undefined` for a type it has no entry for. */
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
        // A non-state run row (`run.rolled_back` and its siblings) reports no transition, so it
        // neither opens nor closes a span.
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
