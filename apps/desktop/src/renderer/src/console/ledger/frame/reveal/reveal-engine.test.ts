// Four lanes streaming at once, on a clock that only moves when told to.
//
// `ManualClock` is the instrument, not a convenience: the budget claim the engine
// makes is "nothing is armed when nothing is streaming", and `pendingCount` is the
// only way to check that rather than assert it. Every case that ends settled ends
// with that count at zero.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lossyStringify,
  UNREPRESENTABLE_VALUE_TEXT,
} from "../../../../../../shared/wire-errors.js";
import { ManualClock } from "../../../core/index.js";
import { REVEAL_CATCH_UP_MULTIPLIER, REVEAL_FRAME_CHARACTER_BUDGET } from "../frame-bounds.js";
import { revealProse as prose } from "./reveal.test-support.js";
import { RevealEngine } from "./reveal-engine.js";
import { RopeSmoother } from "../scroll/rope-smoother.js";
import type { RevealDiagnostic, RevealFrame } from "./reveal-vocabulary.js";

function engineOn(clock: ManualClock): RevealEngine {
  return new RevealEngine({ clock });
}

describe("the reveal engine — the frame budget", () => {
  it("arms nothing until there is work, and nothing again once settled", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    expect(engine.state).toBe("idle");
    expect(clock.pendingCount).toBe(0);

    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(40) });
    expect(clock.pendingCount).toBe(1);

    clock.runFrame();
    expect(engine.state).toBe("settled");
    expect(engine.publishedText("lane-1")).toHaveLength(40);
    // The claim the idle-CPU budget rests on: a settled engine has no timer at all.
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: an engine with work left DOES keep a frame armed", () => {
    // Without this, the zero above would pass over an engine that never armed
    // anything and simply did nothing.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({
      laneId: "lane-1",
      mode: "direct",
      text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 3),
    });
    clock.runFrame();
    expect(engine.state).toBe("streaming");
    expect(clock.pendingCount).toBe(1);
  });

  it("spends at most one frame's budget per frame", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const frames: RevealFrame[] = [];
    engine.subscribe((frame) => frames.push(frame));
    engine.ingest({
      laneId: "lane-1",
      mode: "direct",
      text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 4),
    });
    clock.runFrame();
    expect(frames[0]?.charactersRevealed).toBeLessThanOrEqual(REVEAL_FRAME_CHARACTER_BUDGET);
    expect(frames[0]?.charactersRevealed).toBeGreaterThan(0);
  });
});

describe("the reveal engine — four lanes", () => {
  it("advances every lane on every frame, so none starves", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const laneIds = ["lane-1", "lane-2", "lane-3", "lane-4"];
    for (const laneId of laneIds) {
      engine.ingest({ laneId, mode: "direct", text: prose(REVEAL_FRAME_CHARACTER_BUDGET * 2) });
    }
    clock.runFrame();
    const lengths = laneIds.map((laneId) => engine.publishedText(laneId).length);
    expect(lengths.every((length) => length > 0)).toBe(true);
    // Every lane got its fair share and no lane got the whole frame.
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
  });

  it("raises a behind lane's rate without letting it jump", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({ laneId: "fast", mode: "direct", text: prose(10) });
    engine.ingest({ laneId: "behind", mode: "direct", text: prose(100_000) });
    clock.runFrame();

    const fairShare = Math.floor(REVEAL_FRAME_CHARACTER_BUDGET / 2);
    const behind = engine.publishedText("behind").length;
    expect(behind).toBeGreaterThan(fairShare);
    expect(behind).toBeLessThanOrEqual(fairShare * REVEAL_CATCH_UP_MULTIPLIER);
    expect(engine.laneState("behind")?.isCatchingUp).toBe(true);
    expect(engine.state).toBe("catching-up");
  });

  it("clears the catch-up mark once the lane it was behind has finished", () => {
    // Catching up is a fact about an ALLOCATION, not a badge a lane keeps: it means
    // this lane took another lane's unspent share this frame. Once the short lane
    // has settled there is nobody to take a share from, so the mark clears even
    // though the long lane still has as much text left as it did a frame ago.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({ laneId: "fast", mode: "direct", text: prose(10) });
    engine.ingest({ laneId: "behind", mode: "direct", text: prose(100_000) });
    clock.runFrame();
    expect(engine.laneState("behind")?.isCatchingUp).toBe(true);

    clock.runFrame();
    expect(engine.laneState("behind")?.isCatchingUp).toBe(false);
    expect(engine.laneState("behind")?.isSettled).toBe(false);
  });

  it("retires a lane whose run ended, so a finished turn stops costing memory", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(40) });
    clock.runFrame();
    engine.retireLane("lane-1");
    expect(engine.laneState("lane-1")).toBeUndefined();
    expect(engine.lanes()).toStrictEqual([]);
    expect(engine.state).toBe("idle");
  });
});

describe("the reveal engine — the visible text never regresses", () => {
  it("only ever grows a lane's published text across a whole stream", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const lengths: number[] = [];
    engine.subscribe((frame) => {
      for (const lane of frame.lanes) {
        lengths.push(lane.publishedText.length);
      }
    });
    for (let chunk = 0; chunk < 12; chunk += 1) {
      engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(200) });
      clock.runFrame();
    }
    const regressions = lengths.filter(
      (length, index) => index > 0 && length < (lengths[index - 1] ?? 0),
    );
    expect(regressions).toStrictEqual([]);
    expect(engine.publishedText("lane-1")).toHaveLength(2400);
  });

  it("never leaves a published prefix ending on half a character", () => {
    // The budget is spent as a UTF-16 code-unit count, so an emoji-dense lane is
    // where a frame boundary falls inside a character. Reading the lead half alone
    // would put a replacement glyph on screen for one frame — a flicker the reveal
    // gate cannot catch, because a lone surrogate is not one of its volatile
    // characters.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const grinningFace = "😀";
    const leadUnit = grinningFace.slice(0, 1);
    // One leading letter, so the frame's even code-unit budget lands INSIDE a pair
    // rather than tidily between two of them.
    const emojiLane = `a${grinningFace.repeat(REVEAL_FRAME_CHARACTER_BUDGET)}`;
    engine.ingest({ laneId: "lane-1", mode: "direct", text: emojiLane });
    while (!(engine.laneState("lane-1")?.isSettled ?? true)) {
      clock.runFrame();
      const published = engine.publishedText("lane-1");
      expect(published.endsWith(leadUnit)).toBe(false);
      expect(emojiLane.startsWith(published)).toBe(true);
    }
    expect(engine.publishedText("lane-1")).toBe(emojiLane);
  });

  it("appends an authoritative commit that extends what it holds", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({ laneId: "lane-1", mode: "direct", text: "The run " });
    clock.runFrame();
    engine.ingest({ laneId: "lane-1", mode: "authoritative", text: "The run started" });
    clock.runFrame();
    expect(engine.publishedText("lane-1")).toBe("The run started");
  });

  it("reports a source that changed out of band, and keeps the agreed prefix", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const diagnostics: RevealDiagnostic[] = [];
    engine.subscribeToDiagnostics((diagnostic) => diagnostics.push(diagnostic));

    engine.ingest({ laneId: "lane-1", mode: "direct", text: "The run started at noon" });
    clock.runFrame();

    const rewritten = "The run failed to start, and was retried";
    engine.ingest({ laneId: "lane-1", mode: "authoritative", text: rewritten });
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toStrictEqual([
      "out-of-band-source-change",
    ]);
    // Re-based on what the two sources agree on, not on how much had been
    // published: holding the LENGTH would have swapped "started at noon" for
    // "failed to start, " in one frame with no budget spent.
    expect(engine.publishedText("lane-1")).toBe("The run ");
    expect(diagnostics[0]?.detail).toContain("8 characters both sources agree on");
    expect(diagnostics[0]?.detail).toContain("15 characters were retracted");
    // The rest of the rewritten source arrives through the ordinary frame budget.
    clock.runFrame();
    expect(engine.publishedText("lane-1")).toBe(rewritten);
  });

  it("keeps the agreed prefix when the rewrite is SHORTER than what was published", () => {
    // Clamping to `min(publishedLength, sourceLength)` truncated the visible text
    // here — the one case the published-text contract says cannot happen silently.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const diagnostics: RevealDiagnostic[] = [];
    engine.subscribeToDiagnostics((diagnostic) => diagnostics.push(diagnostic));

    engine.ingest({ laneId: "lane-1", mode: "direct", text: "The run started at noon" });
    clock.runFrame();

    engine.ingest({ laneId: "lane-1", mode: "authoritative", text: "The run failed" });
    expect(engine.publishedText("lane-1")).toBe("The run ");
    expect(diagnostics[0]?.detail).toContain("8 characters both sources agree on");
    expect(diagnostics[0]?.detail).toContain("15 characters were retracted");
    clock.runFrame();
    expect(engine.publishedText("lane-1")).toBe("The run failed");
  });

  it("re-reveals a divergent rewrite through the frame budget instead of swapping it", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const sharedCharacterCount = 40;
    const original = prose(REVEAL_FRAME_CHARACTER_BUDGET * 3);
    engine.ingest({ laneId: "lane-1", mode: "direct", text: original });
    clock.runFrame();
    expect(engine.publishedText("lane-1").length).toBeGreaterThan(sharedCharacterCount);

    // Same length, diverging at character 40: the case where holding the published
    // LENGTH would have looked correct and shown different characters.
    const rewritten =
      prose(sharedCharacterCount) + prose(original.length - sharedCharacterCount).toUpperCase();
    expect(rewritten).toHaveLength(original.length);
    engine.ingest({ laneId: "lane-1", mode: "authoritative", text: rewritten });
    expect(engine.publishedText("lane-1")).toBe(prose(sharedCharacterCount));

    clock.runFrame();
    const afterOneFrame = engine.publishedText("lane-1");
    expect(afterOneFrame.length).toBeGreaterThan(sharedCharacterCount);
    expect(afterOneFrame.length).toBeLessThanOrEqual(
      sharedCharacterCount + REVEAL_FRAME_CHARACTER_BUDGET,
    );
    expect(rewritten.startsWith(afterOneFrame)).toBe(true);
  });

  it("negative control: a commit that DOES extend raises no diagnostic", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const diagnostics: RevealDiagnostic[] = [];
    engine.subscribeToDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    engine.ingest({ laneId: "lane-1", mode: "direct", text: "The run " });
    engine.ingest({ laneId: "lane-1", mode: "authoritative", text: "The run started" });
    expect(diagnostics).toStrictEqual([]);
  });

  it("withholds a tail that would mount an incomplete construct", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    // The emphasis run lands exactly under this frame's ceiling, so publishing it
    // would put `**` on screen as either half-open emphasis or markers that vanish.
    const withOpenEmphasis = `${prose(477)} **${prose(100)}`;
    engine.ingest({ laneId: "lane-1", mode: "direct", text: withOpenEmphasis });
    clock.runFrame();
    const published = engine.publishedText("lane-1");
    expect(published).toHaveLength(478);
    expect(published.endsWith("*")).toBe(false);
  });

  it("negative control: the same lane WOULD have reached the budget without the gate", () => {
    // Prose with no markdown in it publishes the whole frame budget, so the 478
    // above is the gate withholding rather than the engine running short.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(580) });
    clock.runFrame();
    expect(engine.publishedText("lane-1")).toHaveLength(REVEAL_FRAME_CHARACTER_BUDGET);
  });
});

describe("the reveal engine — teardown", () => {
  it("disposes terminally: no armed frame, and nothing reaches a subscriber", () => {
    const clock = new ManualClock();
    const engine = engineOn(clock);
    let frameCount = 0;
    engine.subscribe(() => {
      frameCount += 1;
    });
    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(4000) });
    engine.dispose();
    expect(clock.pendingCount).toBe(0);
    engine.ingest({ laneId: "lane-1", mode: "direct", text: prose(40) });
    clock.runFrame();
    expect(frameCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
  });
});

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
