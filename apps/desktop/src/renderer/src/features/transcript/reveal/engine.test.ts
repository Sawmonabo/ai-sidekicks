// Four lanes streaming at once, on a clock that only moves when told to. `ManualClock` is the
// instrument: the budget claim is "nothing is armed when nothing is streaming", which
// `pendingCount` checks. A lane that failed a transition is covered by
// `engine.quarantine.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { REVEAL_CATCH_UP_MULTIPLIER, REVEAL_FRAME_CHARACTER_BUDGET } from "./caps.js";
import { AnimationFrameScheduler } from "../animation-frame-scheduler.js";
import { revealProse as prose } from "./prose.test-support.js";
import { RevealEngine } from "./engine.js";
import type { RevealDiagnostic, RevealFrame } from "./model.js";

function engineOn(clock: ManualClock): RevealEngine {
  // Every drain is submitted to the frame scheduler's second phase, so `clock.runFrame()` runs
  // the scheduler's frame and the scheduler runs the drain.
  return new RevealEngine({ frameScheduler: new AnimationFrameScheduler({ clock }) });
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
    // The budget is spent as a UTF-16 code-unit count, so an emoji-dense lane puts a frame
    // boundary inside a character. The gate cannot catch a lone surrogate (it is not one of its
    // volatile characters), so the engine must.
    const clock = new ManualClock();
    const engine = engineOn(clock);
    const grinningFace = "😀";
    const leadUnit = grinningFace.slice(0, 1);
    // One leading letter, so the frame's even code-unit budget lands inside a pair
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
    // Rebased on what the two sources agree on, not on the published length, which would swap
    // "started at noon" for "failed to start, " in one frame with no budget spent.
    expect(engine.publishedText("lane-1")).toBe("The run ");
    expect(diagnostics[0]?.detail).toContain("8 characters both sources agree on");
    expect(diagnostics[0]?.detail).toContain("15 characters were retracted");
    // The rest of the rewritten source arrives through the ordinary frame budget.
    clock.runFrame();
    expect(engine.publishedText("lane-1")).toBe(rewritten);
  });

  it("keeps the agreed prefix when the rewrite is SHORTER than what was published", () => {
    // Clamping to `min(publishedLength, sourceLength)` would truncate the visible text here.
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
    // length would have looked correct and shown different characters.
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
