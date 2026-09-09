// Reveal monotonicity, in the engine that actually paints.
//
// `Spec-023 §Console Test Tiers` puts reveal monotonicity in the BROWSER tier, and
// the reason is the reason the tier exists: a DOM shim delivers the mutation records
// the shim was asked for, so a green run there says the shim agreed with itself. The
// claim under test is that a reader's eye keeps its place while a lane streams — a
// claim about what a layout engine put on screen between two frames — so it is
// driven here, through real Chromium, against a real `MutationObserver`.
//
// WHAT IS UNDER TEST IS THE SHIPPED PATH, END TO END: `useLedgerReveal` mints the
// real `RevealEngine`, `LedgerRowRevealProvider` publishes its channel, and the row
// body reads its own lane through `useLedgerRowReveal` — the same three modules a
// ledger row streams through. The only thing this file supplies is the probe body
// and the deltas, which is what a producer supplies in production too.
//
// AND THE RECORDER IS NOT THIS FILE'S. `test/console/visible-text-monotonicity.ts`
// owns the watcher, because any surface that reveals text incrementally wants the
// same one; a copy here would be the second implementation of a role.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";
import { VisibleTextMonotonicityRecorder } from "../visible-text-monotonicity.js";

import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import {
  LedgerRowRevealProvider,
  useLedgerFrameCoordinator,
  useLedgerReveal,
  useLedgerRowReveal,
} from "../../../src/renderer/src/console/ledger/frame/index.js";
import { revealProse } from "../../../src/renderer/src/console/ledger/frame/reveal/reveal.test-support.js";
import { REVEAL_FRAME_CHARACTER_BUDGET } from "../../../src/renderer/src/console/core/index.js";

const STREAMING_LANE_ID = "browser-tier-lane";

/** Enough frames that the budget cannot deliver the source in one of them. */
const REVEAL_FRAME_COUNT = 6;

/**
 * Somewhere a case can reach the binding the tree minted.
 *
 * The deltas are ingested from outside the tree, exactly as a driver's frames reach
 * a feed from outside React, so the case needs the same handle the feed holds.
 */
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
 * One row body over one lane, and nothing else.
 *
 * Deliberately not a `LedgerFeed`: the feed's window, cap, chapters and rail are
 * asserted at the unit tier over structural stand-ins, and mounting them here would
 * make a regression in any of them look like a reveal regression. What this file
 * needs from the tree is a text node a layout engine paints and an engine that
 * writes to it.
 */
function StreamingProbe(props: StreamingProbeProps): React.JSX.Element {
  // The coordinator is what orders every drain, and the feed mints one per mount from
  // its clock. This probe does the same rather than handing the hook a clock: the hook
  // stopped taking one when the frame coordinator landed, and a probe composing the
  // engine differently from its only production caller would be exercising a shape
  // nothing ships.
  const frameCoordinator = useLedgerFrameCoordinator(props.clock);
  const reveal = useLedgerReveal({ frameCoordinator });
  props.handle.ingest = (laneId: string, text: string) => {
    reveal.ingest({ laneId, mode: "direct", text });
  };
  return (
    <LedgerRowRevealProvider channel={reveal.channel}>
      <StreamingProbeBody laneId={props.laneId} />
    </LedgerRowRevealProvider>
  );
}

function StreamingProbeBody(props: { readonly laneId: string }): React.JSX.Element {
  const liveText = useLedgerRowReveal(props.laneId);
  return (
    <p data-testid="streaming-body" style={{ width: "320px", margin: 0 }}>
      {liveText ?? ""}
    </p>
  );
}

/**
 * Mount the probe, and hand back the subject, the clock, and the ingest door.
 *
 * `renderSettled` is the tier's one mount, so the console's own cleanup discipline
 * owns the unmount and no case here disposes a tree by hand.
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

    // One frame's budget per delta, so the engine has to hold a tail back and hand
    // it over across frames — a source that fitted in one frame would make the
    // whole claim vacuous, which is what `reveal.test-support.ts` sizes against.
    for (let frame = 0; frame < REVEAL_FRAME_COUNT; frame += 1) {
      streamOneFrame(clock, () => {
        ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
      });
      recorder.drain();
    }
    recorder.stop();

    // The negative control the clean result needs: zero regressions over zero
    // records is a recorder that was never attached to anything.
    expect(recorder.recordCount).toBeGreaterThan(0);
    expect(recorder.regressions).toStrictEqual([]);
    expect(recorder.visibleText.length).toBeGreaterThan(REVEAL_FRAME_CHARACTER_BUDGET);
  });

  it("is measured by a recorder that reports a regression when one happens", async () => {
    // The recorder's own negative control, driven against a subject that really
    // does go backwards. Without this the case above proves only that nothing was
    // being watched.
    const { clock, handle, subject } = await mountStreamingProbe();
    const ingest = handle.ingest;
    const recorder = new VisibleTextMonotonicityRecorder(subject);
    recorder.start();
    streamOneFrame(clock, () => {
      ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
    });
    recorder.drain();

    act(() => {
      subject.textContent = "";
    });
    recorder.drain();
    recorder.stop();

    expect(recorder.regressions.length).toBeGreaterThan(0);
    expect(recorder.regressions[0]?.after).toBe("");
  });

  it("grows the row's painted box monotonically while it reveals", async () => {
    // GEOMETRY, WHICH IS WHY IT IS HERE. `LedgerViewport.test.tsx` records that a
    // geometry-dependent ledger assertion "would pass vacuously" under happy-dom,
    // because every rect reads zero there. A box that never shrinks while text
    // arrives is the layout half of "no lane teleports", and only a layout engine
    // can answer it.
    const { clock, handle, subject } = await mountStreamingProbe();
    const ingest = handle.ingest;
    const heights: number[] = [subject.getBoundingClientRect().height];
    for (let frame = 0; frame < REVEAL_FRAME_COUNT; frame += 1) {
      streamOneFrame(clock, () => {
        ingest?.(STREAMING_LANE_ID, revealProse(REVEAL_FRAME_CHARACTER_BUDGET));
      });
      heights.push(subject.getBoundingClientRect().height);
    }

    // The control: a real layout engine gave the filled box a height at all, which
    // is exactly what the shim does not — every rect it reports is zero, so this
    // case would pass vacuously there and cannot. The FIRST reading is legitimately
    // zero: the paragraph is empty until the first delta lands.
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
