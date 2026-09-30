// Reveal monotonicity, in the engine that actually paints. The claim is that a reader's eye
// keeps its place while a lane streams, which is about what a layout engine put on screen
// between two frames; a DOM shim delivers only the mutation records it was asked for, so it is
// driven through real Chromium against a real `MutationObserver`.
//
// The shipped path runs end to end: `useReveal` mints the `RevealEngine`, `RowRevealProvider`
// publishes its channel, and the row body reads its lane through `useRowReveal`. This file
// supplies only the probe body and the deltas, as a producer does. The recorder lives in
// `visible-text-monotonicity.ts` because any view that reveals text incrementally wants it.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";
import { VisibleTextMonotonicityRecorder } from "./visible-text-monotonicity.js";

import { ManualClock } from "@renderer/lib/clock.js";
import { RowRevealProvider } from "@renderer/features/transcript/reveal/components/RowRevealProvider.js";
import { useAnimationFrameCoordinator } from "@renderer/features/transcript/hooks/useAnimationFrameCoordinator.js";
import { useReveal } from "@renderer/features/transcript/reveal/hooks/useReveal.js";
import { useRowReveal } from "@renderer/features/transcript/reveal/hooks/useRowReveal.js";
import { revealProse } from "@renderer/features/transcript/reveal/reveal.test-support.js";
import { REVEAL_FRAME_CHARACTER_BUDGET } from "@renderer/features/transcript/frame/frame-caps.js";

const STREAMING_LANE_ID = "browser-tier-lane";

/** Enough frames that the budget cannot deliver the source in one of them. */
const REVEAL_FRAME_COUNT = 6;

/** Where a case reaches the binding the tree minted; deltas are ingested from outside React. */
interface RevealHandle {
  ingest?: (laneId: string, text: string) => void;
}

interface StreamingProbeProps {
  readonly clock: ManualClock;
  readonly handle: RevealHandle;
  /** The lane the body renders. A second lane proves the row reads only its own. */
  readonly laneId: string;
}

/**
 * One row body over one lane, and nothing else. It is not a `TranscriptFeed`, whose window, cap
 * and run groups are asserted at the unit tier and would make their regressions look like
 * reveal regressions here.
 */
function StreamingProbe(props: StreamingProbeProps): React.JSX.Element {
  // The coordinator orders every drain, and the feed mints one per mount from its clock; the
  // probe composes the engine the same way.
  const frameCoordinator = useAnimationFrameCoordinator(props.clock);
  const reveal = useReveal({ frameCoordinator });
  props.handle.ingest = (laneId: string, text: string) => {
    reveal.ingest({ laneId, mode: "direct", text });
  };
  return (
    <RowRevealProvider channel={reveal.channel}>
      <StreamingProbeBody laneId={props.laneId} />
    </RowRevealProvider>
  );
}

function StreamingProbeBody(props: { readonly laneId: string }): React.JSX.Element {
  const liveText = useRowReveal(props.laneId);
  return (
    <p data-testid="streaming-body" style={{ width: "320px", margin: 0 }}>
      {liveText ?? ""}
    </p>
  );
}

/**
 * Mount the probe, and hand back the subject, the clock, and the ingest handle. The unmount
 * belongs to `renderSettled`'s cleanup.
 */
async function mountStreamingProbe(laneId = STREAMING_LANE_ID): Promise<{
  readonly clock: ManualClock;
  readonly handle: RevealHandle;
  readonly subject: HTMLElement;
}> {
  const clock = new ManualClock();
  const handle: RevealHandle = {};
  const mount = await renderSettled(
    <StreamingProbe clock={clock} handle={handle} laneId={laneId} />,
  );
  const subject = mount.container.querySelector<HTMLElement>('[data-testid="streaming-body"]');
  if (subject === null) {
    throw new Error("the streaming probe did not mount its body");
  }
  return { clock, handle, subject };
}

/** Ingest one delta and run the frame it armed, inside one React commit. */
function streamOneFrame(clock: ManualClock, ingest: () => void): void {
  act(() => {
    ingest();
    while (clock.pendingFrameCount > 0) {
      clock.runFrame();
    }
  });
}

afterEach(() => {
  document.location.hash = "";
});

describe("the visible text of a streaming lane", () => {
  it("never regresses across the frames that reveal it", async () => {
    const { clock, handle, subject } = await mountStreamingProbe();
    const ingest = handle.ingest;
    expect(ingest).toBeDefined();
    const recorder = new VisibleTextMonotonicityRecorder(subject);
    recorder.start();

    // One frame's budget per delta, so the engine must hold a tail back and hand it over across
    // frames; a source that fitted in one frame would make the claim vacuous.
    for (let frame = 0; frame < REVEAL_FRAME_COUNT; frame += 1) {
      streamOneFrame(clock, () => {
        ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
      });
      recorder.drain();
    }
    recorder.stop();

    // Zero regressions over zero records would be a recorder attached to nothing.
    expect(recorder.recordCount).toBeGreaterThan(0);
    expect(recorder.regressions).toStrictEqual([]);
    expect(recorder.visibleText.length).toBeGreaterThan(REVEAL_FRAME_CHARACTER_BUDGET);
  });

  it("grows the row's painted box monotonically while it reveals", async () => {
    // Geometry is why this is here: every rect reads zero under happy-dom, so a box-size
    // assertion would pass vacuously. A box that never shrinks while text arrives is the
    // layout half of "no lane teleports".
    const { clock, handle, subject } = await mountStreamingProbe();
    const ingest = handle.ingest;
    const heights: number[] = [subject.getBoundingClientRect().height];
    for (let frame = 0; frame < REVEAL_FRAME_COUNT; frame += 1) {
      streamOneFrame(clock, () => {
        ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
      });
      heights.push(subject.getBoundingClientRect().height);
    }

    // The control: the filled box has a nonzero height at all. The first reading is
    // legitimately zero because the paragraph is empty until the first delta lands.
    expect(heights[heights.length - 1]).toBeGreaterThan(0);
    expect(heights[heights.length - 1]).toBeGreaterThan(heights[0] ?? 0);
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1] ?? 0);
    }
  });

  it("leaves a row reading another lane untouched by this one's frames", async () => {
    const { clock, handle, subject } = await mountStreamingProbe("some-other-lane");
    const ingest = handle.ingest;
    const recorder = new VisibleTextMonotonicityRecorder(subject);
    recorder.start();
    streamOneFrame(clock, () => {
      ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
    });
    recorder.drain();
    recorder.stop();

    expect(subject.textContent).toBe("");
    expect(recorder.regressions).toStrictEqual([]);
  });
});
