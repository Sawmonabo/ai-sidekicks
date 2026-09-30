// Four lanes streaming at once, on a clock that only moves when told to. `ManualClock` is the
// instrument: the budget claim is "nothing is armed when nothing is streaming", which
// `pendingCount` checks. A lane that failed a transition is covered by
// `reveal-engine.quarantine.test.ts`.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REVEAL_FRAME_CHARACTER_BUDGET } from "../frame/frame-caps.js";
import { developmentPerformanceMeters } from "@renderer/lib/performance-meters/performance-meters.js";
import { REVEAL_CATCH_UP_MULTIPLIER } from "../viewport/viewport-constants.js";
import { AnimationFrameCoordinator } from "../animation-frame-coordinator.js";
import { revealProse as prose } from "./reveal.test-support.js";
import { RevealEngine } from "./reveal-engine.js";
import type { RevealDiagnostic, RevealFrame } from "./reveal-model.js";

function engineOn(clock: ManualClock): RevealEngine {
  // Every drain is submitted to the frame coordinator's second phase, so `clock.runFrame()` runs
  // the coordinator's frame and the coordinator runs the drain.
  return new RevealEngine({ frameCoordinator: new AnimationFrameCoordinator({ clock }) });
}

describe("the reveal engine — the frame budget", () => {
  beforeEach(() => {
    developmentPerformanceMeters?.reset();
  });

  it("records what each drain revealed, keyed so two engines are two series", () => {
    const clock = new ManualClock();
    const frameCoordinator = new AnimationFrameCoordinator({ clock });
    const first = new RevealEngine({ frameCoordinator });
    const second = new RevealEngine({ frameCoordinator });
    expect(
      developmentPerformanceMeters,
      "this project is not compiling the fixture define",
    ).not.toBe(null);

    first.ingest({ laneId: "lane-a", mode: "direct", text: prose(40) });
    second.ingest({ laneId: "lane-b", mode: "direct", text: prose(40) });
    clock.runFrame();

    const drains =
      developmentPerformanceMeters?.readings().filter((entry) => entry.kind === "reveal-drain") ??
      [];
    // TWO series, not one: both engines drained inside the same coordinator frame, and
    // a producer keying by anything the two share would fold their samples together.
    expect(drains).toHaveLength(2);
    expect(new Set(drains.map((entry) => entry.seriesKey)).size).toBe(2);
    for (const drain of drains) {
      expect(drain.latest).toBeGreaterThan(0);
    }
  });

  it("keys a drain by its coordinator too, so two feeds are two series", () => {
    // The task key alone cannot carry this: the ordinal restarts at 1 inside every
    // coordinator, and there is one coordinator per feed, so both engines below hold
    // the identical `transcript-reveal-drain#1` and their drains folded into one series.
    const clock = new ManualClock();
    const firstFeed = new AnimationFrameCoordinator({ clock });
    const secondFeed = new AnimationFrameCoordinator({ clock });
    const first = new RevealEngine({ frameCoordinator: firstFeed });
    const second = new RevealEngine({ frameCoordinator: secondFeed });

    first.ingest({ laneId: "lane-a", mode: "direct", text: prose(40) });
    second.ingest({ laneId: "lane-b", mode: "direct", text: prose(40) });
    clock.runFrame();

    const drains =
      developmentPerformanceMeters?.readings().filter((entry) => entry.kind === "reveal-drain") ??
      [];
    expect(drains).toHaveLength(2);
    expect(new Set(drains.map((entry) => entry.seriesKey)).size).toBe(2);
  });

  it("has its drain series retired when the coordinator that keyed it is disposed", () => {
    // The engine's key is composed from the coordinator's identity, so the coordinator's dispose
    // closes it. Left open, a feed's drain series would outlive the feed.
    const clock = new ManualClock();
    const frameCoordinator = new AnimationFrameCoordinator({ clock });
    const engine = new RevealEngine({ frameCoordinator });

    engine.ingest({ laneId: "lane-a", mode: "direct", text: prose(40) });
    clock.runFrame();
    expect(
      developmentPerformanceMeters?.readings().filter((entry) => entry.kind === "reveal-drain"),
    ).toHaveLength(1);

    frameCoordinator.dispose();

    expect(
      developmentPerformanceMeters?.readings().filter((entry) => entry.kind === "reveal-drain"),
    ).toStrictEqual([]);
    // And the coordinator's own reading goes with it, so nothing is left holding the
    // bound for a feed that has been torn down.
    expect(developmentPerformanceMeters?.seriesCount).toBe(0);
  });

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
    // Catching up is a fact about an allocation: this lane took another lane's unspent share
    // this frame. Once the short lane settles there is nobody to take from, so the mark clears.
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
    // Prose with no markdown publishes the whole frame budget, so the 478 above is the gate
    // withholding rather than the engine running short.
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
