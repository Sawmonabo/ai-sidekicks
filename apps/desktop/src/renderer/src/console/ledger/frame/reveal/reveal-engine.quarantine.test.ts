// What a lane that failed a transition costs, and what it stops costing.
//
// SPLIT FROM `reveal-engine.test.ts`, which is about the budget, the four lanes, and
// the guarantee that visible text never regresses. Every case here is about the OTHER
// side of that guarantee — a lane whose smoother threw, what the engine does with it
// after, and what it takes to get it back — and the two subjects were one file over
// the size at which a file is doing two jobs.
//
// `ManualClock` is the instrument for the same reason it is there: the claims are
// about what is armed and what is spent per frame, and `pendingCount` is the only way
// to check that rather than assert it.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lossyStringify,
  UNREPRESENTABLE_VALUE_TEXT,
} from "../../../../../../shared/wire-errors.js";
import { ManualClock, REVEAL_FRAME_CHARACTER_BUDGET } from "../../../core/index.js";
import { revealProse as prose } from "./reveal.test-support.js";
import { RevealEngine } from "./reveal-engine.js";
import { RopeSmoother } from "../scroll/rope-smoother.js";
import type { RevealDiagnostic } from "./reveal-vocabulary.js";

/** One engine on the test's own clock, as the sibling suite builds one. */
function engineOn(clock: ManualClock): RevealEngine {
  return new RevealEngine({ clock });
}

describe("the reveal engine — a lane whose advance throws an unrenderable value", () => {
  /**
   * A failure value nothing can be assumed about.
   *
   * `Object.create(null)` carries no `toString`, no `valueOf`, and no
   * `Symbol.toPrimitive`, so ToPrimitive on it throws. That is not exotic: a lane's
   * smoother can be handed anything a producer threw, and the reporting expression
   * runs after the `catch` has been entered — so a stringifier that throws there
   * leaves the handler by exception.
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

    // THE NEGATIVE CONTROL ON THE OLD CODE, and it is this line: the reporting
    // expression used to be `String(...)`, which throws on the value above, out of
    // the frame loop and past the re-arm below. This case fails at `runFrame` on
    // that code and passes here.
    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    // The quarantine is scoped to the lane that threw.
    expect(engine.publishedText("lane-1")).toBe("");
    expect(engine.publishedText("lane-2").length).toBeGreaterThan(0);
    // And the frame is still armed, because lane 2 still has characters left —
    // which is the half the old code lost: the throw escaped past `#armFrame()`.
    expect(clock.pendingCount).toBe(1);
    expect(engine.state).not.toBe("settled");
    // The failure is REPORTED, naming the lane, rather than swallowed.
    const reported = diagnostics.filter((diagnostic) => diagnostic.kind === "transition-failed");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.laneId).toBe(`lane-1: ${UNREPRESENTABLE_VALUE_TEXT}`);
  });

  it("negative control: the value really does defeat a bare stringifier, and the total one renders it", () => {
    // Without this the case above would pass over a failure value any stringifier
    // could have handled, which is not the class the fix is for.
    const failure = unrenderableFailure();
    expect(() => String(failure)).toThrow();
    expect(lossyStringify(failure)).toBe(UNREPRESENTABLE_VALUE_TEXT);
  });

  it("negative control: an ordinary failure still reaches the diagnostic with its own words", () => {
    // The replacement must not have flattened every failure into one sentence.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const diagnostics: RevealDiagnostic[] = [];
    engine.subscribeToDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    vi.spyOn(RopeSmoother.prototype, "advance").mockImplementationOnce(() => {
      throw new Error("the rope refused a backtrack");
    });

    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(400) });
    clock.runFrame();

    expect(lossyStringify(new Error("the rope refused a backtrack"))).toContain(
      "the rope refused a backtrack",
    );
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toContain("transition-failed");
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

    // The producer knows nothing about the quarantine: a long tool output or a
    // multi-megabyte turn goes on arriving, every delta appended to a rope no frame
    // would ever walk, with memory growing monotonically for the life of the run.
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

  it("negative control: an UNquarantined lane accumulates every one of those deltas", () => {
    // Without this the two cases above would pass over an engine that had stopped
    // accepting deltas at all, which is the whole mechanism rather than the quarantine.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    for (let burst = 0; burst < 20; burst += 1) {
      engine.ingest({
        laneId: "lane-1",
        mode: "direct",
        text: prose(REVEAL_FRAME_CHARACTER_BUDGET),
      });
    }
    expect(engine.laneState("lane-1")?.pendingCharacterCount).toBe(
      REVEAL_FRAME_CHARACTER_BUDGET * 20,
    );
    expect(clock.pendingCount).toBe(1);
  });

  it("an authoritative commit lifts the quarantine, and the lane streams again", () => {
    // The one way out. Without it, releasing the tail would have turned a
    // recoverable lane into a dead one — which is a worse answer than the leak.
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
