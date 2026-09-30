// A lane that failed a transition: what it costs, what it stops costing, and what gets it back.
// `ManualClock` is the instrument because the claims are about what is armed and spent per
// frame, which `pendingCount` checks.

import { afterEach, describe, expect, it, vi } from "vitest";

import { UNREPRESENTABLE_VALUE_TEXT } from "@renderer/lib/wire-errors.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REVEAL_FRAME_CHARACTER_BUDGET } from "../frame/frame-caps.js";
import { AnimationFrameCoordinator } from "../animation-frame-coordinator.js";
import { revealProse as prose } from "./reveal.test-support.js";
import { RevealEngine } from "./reveal-engine.js";
import { RopeSmoother } from "./rope-smoother.js";
import type { RevealDiagnostic } from "./reveal-model.js";

/** One engine on the test's own clock, as the sibling suite builds one. */
function engineOn(clock: ManualClock): RevealEngine {
  // Every drain is submitted to the frame coordinator's second phase, so `clock.runFrame()` runs
  // the coordinator's frame and the coordinator runs the drain.
  return new RevealEngine({ frameCoordinator: new AnimationFrameCoordinator({ clock }) });
}

describe("the reveal engine — a lane whose advance throws an unrenderable value", () => {
  /**
   * A failure value nothing can be assumed about. `Object.create(null)` has no `toString`,
   * `valueOf` or `Symbol.toPrimitive`, so ToPrimitive throws; the reporting expression runs
   * inside the `catch`, so a throwing stringifier there would leave the handler by exception.
   */
  function unrenderableFailure(): object {
    return Object.create(null) as object;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("quarantines that lane, advances the others, and re-arms the frame", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const diagnostics: RevealDiagnostic[] = [];
    engine.subscribeToDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    vi.spyOn(RopeSmoother.prototype, "advance").mockImplementationOnce(() => {
      throw unrenderableFailure();
    });

    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(400) });
    engine.ingest({
      laneId: "lane-2",
      mode: "direct",
      text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 3),
    });

    // A bare `String(...)` throws on the value above, out of the frame loop and past the re-arm
    // below; this case fails at `runFrame` under that code.
    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    // The quarantine is scoped to the lane that threw.
    expect(engine.publishedText("lane-1")).toBe("");
    expect(engine.publishedText("lane-2").length).toBeGreaterThan(0);
    // The frame is still armed, because lane 2 still has characters left; a throw escaping past
    // `#armFrame()` would have lost it.
    expect(clock.pendingCount).toBe(1);
    expect(engine.state).not.toBe("settled");
    // The failure is reported, naming the lane, rather than swallowed.
    const reported = diagnostics.filter((diagnostic) => diagnostic.kind === "transition-failed");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.laneId).toBe(`lane-1: ${UNREPRESENTABLE_VALUE_TEXT}`);
  });
});

describe("the reveal engine — what a quarantined lane costs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A lane the engine has given up on, over a source three frames long. */
  function engineWithAQuarantinedLane(clock: ManualClock): RevealEngine {
    const engine = engineOn(clock);
    vi.spyOn(RopeSmoother.prototype, "advance").mockImplementationOnce(() => {
      throw new Error("the rope refused a backtrack");
    });
    engine.ingest({
      laneId: "lane-1",
      mode: "direct",
      text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 3),
    });
    clock.runFrame();
    return engine;
  }

  it("releases the tail it will never reveal, rather than holding it for the run", () => {
    const clock = new ManualClock();
    const engine = engineWithAQuarantinedLane(clock);

    // Three frames' worth of source arrived and none of it will ever be walked, so
    // holding it is holding memory against a promise the engine has stopped keeping.
    expect(engine.laneState("lane-1")?.pendingCharacterCount).toBe(0);
    expect(engine.laneState("lane-1")?.isSettled).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it("takes no further speculative delta, so a producer that keeps streaming costs nothing", () => {
    const clock = new ManualClock();
    const engine = engineWithAQuarantinedLane(clock);

    // The producer knows nothing about the quarantine: a long output keeps arriving, and no delta
    // may grow a rope that no frame would walk.
    for (let burst = 0; burst < 20; burst += 1) {
      engine.ingest({
        laneId: "lane-1",
        mode: "direct",
        text: prose(REVEAL_FRAME_CHARACTER_BUDGET),
      });
    }

    expect(engine.laneState("lane-1")?.pendingCharacterCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
  });

  it("an authoritative commit lifts the quarantine, and the lane streams again", () => {
    // The one way out: without it, releasing the tail would turn a recoverable lane into a dead
    // one, which is worse than the leak.
    const clock = new ManualClock();
    const engine = engineWithAQuarantinedLane(clock);

    engine.ingest({
      laneId: "lane-1",
      mode: "authoritative",
      text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 2),
    });

    expect(clock.pendingCount).toBe(1);
    clock.runFrame();
    expect(engine.publishedText("lane-1").length).toBeGreaterThan(0);
    expect(engine.state).toBe("streaming");
  });
});
