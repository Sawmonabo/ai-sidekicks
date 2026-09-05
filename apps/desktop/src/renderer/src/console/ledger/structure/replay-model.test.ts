// The replay engine, driven entirely on the frozen clock.
//
// Nothing here waits on wall time, and that is the point rather than a
// convenience: `ManualClock.pendingCount` is the instrument the idle-CPU budget's
// "no timer fires" claim is actually checked with, so every arming and every
// cancellation below is counted rather than assumed.
//
// `replay-model.ts`'s four rules each get a case and a negative control: no wire method, no
// scrub past the loaded window, no claimed stream granularity, and one armed
// timeout at a time.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { ReplayEngine, type ReplayPosition, type ReplayRow } from "./replay-model.js";
import { rollbackBoundaryRow, runRow } from "./timeline-rows.test-support.js";
import { LedgerSeamIndex } from "./seams.js";

/** Three turns, ten seconds apart, so the window spans twenty thousand milliseconds. */
const REPLAY_ROWS: readonly ReplayRow[] = [
  { rowId: "r1", occurredAt: "2026-01-01T09:00:00.000Z" },
  { rowId: "r2", occurredAt: "2026-01-01T09:00:10.000Z" },
  { rowId: "r3", occurredAt: "2026-01-01T09:00:20.000Z" },
];

const WINDOW_SPAN_MS = 20_000;
/** One frame at 1×, from `REPLAY_FRAME_INTERVAL_MS`. Advanced, never waited on. */
const ONE_FRAME_MS = 50;

function engineOver(
  clock: ManualClock,
  rows: readonly ReplayRow[] = REPLAY_ROWS,
  granularity?: "turn" | "stream",
): ReplayEngine {
  return new ReplayEngine(
    granularity === undefined ? { clock, rows } : { clock, rows, granularity },
  );
}

describe("replay — what the control reads before anything is pressed", () => {
  it("starts idle at the head of the loaded window", () => {
    const position = engineOver(new ManualClock()).position();
    expect(position.state).toBe("idle");
    expect(position.speed).toBe(1);
    expect(position.elapsedMs).toBe(0);
    expect(position.spanMs).toBe(WINDOW_SPAN_MS);
    expect(position.revealedRowIds).toStrictEqual(["r1"]);
    expect(position.positionIso).toBe("2026-01-01T09:00:00.000Z");
  });

  it("claims turn granularity by default, because the deltas between turns were never persisted", () => {
    expect(engineOver(new ManualClock()).position().granularity).toBe("turn");
  });

  it("negative control: a fixture scenario replaying its own deltas gets the finer claim", () => {
    // Without this the default above would be indistinguishable from the only
    // value the engine can produce, and the label would prove nothing.
    expect(engineOver(new ManualClock(), REPLAY_ROWS, "stream").position().granularity).toBe(
      "stream",
    );
  });

  it("orders playback by the instant a row occurred, never by the log's own order", () => {
    const engine = engineOver(new ManualClock(), [
      { rowId: "late-sequence-early-clock", occurredAt: "2026-01-01T09:00:00.000Z" },
      { rowId: "early-sequence-late-clock", occurredAt: "2026-01-01T09:00:30.000Z" },
    ]);
    engine.scrubTo(30_000);
    expect(engine.position().revealedRowIds).toStrictEqual([
      "late-sequence-early-clock",
      "early-sequence-late-clock",
    ]);
  });
});

describe("replay — one armed timeout at a time, on the injected clock", () => {
  it("arms exactly one frame while playing", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    expect(clock.pendingCount).toBe(0);
    engine.play();
    expect(clock.pendingCount).toBe(1);
    expect(engine.isArmed).toBe(true);
  });

  it("negative control: an idle engine arms nothing at all", () => {
    // Which is what makes the count above evidence rather than coincidence — the
    // budget's claim is that nothing ticks unless something is playing.
    const clock = new ManualClock();
    engineOver(clock);
    expect(clock.pendingCount).toBe(0);
  });

  it("advances by one frame times the speed, and re-arms exactly once", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    clock.advance(ONE_FRAME_MS);
    expect(engine.position().elapsedMs).toBe(ONE_FRAME_MS);
    expect(clock.pendingCount).toBe(1);

    engine.setSpeed(32);
    clock.advance(ONE_FRAME_MS);
    expect(engine.position().elapsedMs).toBe(ONE_FRAME_MS + ONE_FRAME_MS * 32);
    expect(clock.pendingCount).toBe(1);
  });

  it("drops the armed frame when paused rather than letting it fire", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    engine.pause();
    expect(clock.pendingCount).toBe(0);
    expect(engine.position().state).toBe("paused");

    clock.advance(ONE_FRAME_MS * 10);
    expect(engine.position().elapsedMs).toBe(0);
  });

  it("stops arming at the tail", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    clock.advance(WINDOW_SPAN_MS * 2);
    expect(engine.position().state).toBe("at-tail");
    expect(clock.pendingCount).toBe(0);
    expect(engine.position().revealedRowIds).toStrictEqual(["r1", "r2", "r3"]);
  });

  it("restarts from the head when played again from the tail", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    clock.advance(WINDOW_SPAN_MS * 2);
    engine.play();
    expect(engine.position().elapsedMs).toBe(0);
    expect(engine.position().state).toBe("playing");
  });

  it("is terminal once disposed", () => {
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    engine.dispose();
    expect(clock.pendingCount).toBe(0);

    engine.play();
    expect(clock.pendingCount).toBe(0);
    expect(engine.isArmed).toBe(false);
  });

  it("negative control: an undisposed engine does re-arm on play", () => {
    // Otherwise the case above would pass over an engine that never armed at all.
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    engine.pause();
    engine.play();
    expect(clock.pendingCount).toBe(1);
  });

  it("reports every position change to its caller", () => {
    const clock = new ManualClock();
    const seen: ReplayPosition[] = [];
    const engine = new ReplayEngine({
      clock,
      rows: REPLAY_ROWS,
      onPositionChange: (position) => seen.push(position),
    });
    engine.play();
    clock.advance(ONE_FRAME_MS);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]?.elapsedMs).toBe(ONE_FRAME_MS);
  });
});

describe("replay — the scrub never leaves the loaded window", () => {
  it("clamps past the tail to the tail", () => {
    const engine = engineOver(new ManualClock());
    engine.scrubTo(WINDOW_SPAN_MS * 1000);
    expect(engine.position().elapsedMs).toBe(WINDOW_SPAN_MS);
  });

  it("clamps before the head to the head", () => {
    const engine = engineOver(new ManualClock());
    engine.scrubTo(-500_000);
    expect(engine.position().elapsedMs).toBe(0);
  });

  it("negative control: a position inside the window is taken exactly", () => {
    // Which is what shows the two clamps are bounds rather than a value the
    // engine always overwrites.
    const engine = engineOver(new ManualClock());
    engine.scrubTo(10_000);
    expect(engine.position().elapsedMs).toBe(10_000);
    expect(engine.position().revealedRowIds).toStrictEqual(["r1", "r2"]);
  });

  it("replays from a row in the window", () => {
    const engine = engineOver(new ManualClock());
    expect(engine.replayFrom("r2")).toBe(true);
    expect(engine.position().elapsedMs).toBe(10_000);
  });

  it("negative control: a row outside the window is refused, and moves nothing", () => {
    const engine = engineOver(new ManualClock());
    engine.scrubTo(10_000);
    expect(engine.replayFrom("a-row-this-window-does-not-hold")).toBe(false);
    expect(engine.position().elapsedMs).toBe(10_000);
  });

  it("reveals the loaded rows and never one row more", () => {
    // The first rule in observable terms: replay reads the window it was handed.
    // A replay that reached past it would have to produce a row id from
    // somewhere, and playing to the tail is where that would show.
    const clock = new ManualClock();
    const engine = engineOver(clock);
    engine.play();
    clock.advance(WINDOW_SPAN_MS * 2);
    expect(engine.position().revealedRowIds).toStrictEqual(REPLAY_ROWS.map((row) => row.rowId));
  });
});

describe("replay — jump to the next seam", () => {
  /** Seams derived by the one classifier, never hand-written here. */
  const seams = new LedgerSeamIndex().seams([
    runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
    runRow({ id: "r2", sequence: 2, type: "run.paused", runId: "run-a", position: 2 }),
    rollbackBoundaryRow({ id: "r3", sequence: 3, runId: "run-a", position: 3, targetPosition: 1 }),
  ]);

  it("moves to the nearest seam after the current position", () => {
    const engine = engineOver(new ManualClock());
    expect(engine.jumpToNextSeam(seams)?.rowId).toBe("r2");
    expect(engine.position().elapsedMs).toBe(10_000);
    expect(engine.jumpToNextSeam(seams)?.rowId).toBe("r3");
    expect(engine.position().elapsedMs).toBe(WINDOW_SPAN_MS);
  });

  it("takes the chronologically nearest seam, not the first the log recorded", () => {
    // The daemon can admit rows out of wall-clock order, and `seams()` sorts
    // nothing. Taking the first in log order jumps PAST the nearer seam — and
    // because the jump scrubs, that seam is then behind the position for good.
    const outOfClockOrder = new ReplayEngine({
      clock: new ManualClock(),
      rows: [
        { rowId: "r1", occurredAt: "2026-01-01T09:00:00.000Z" },
        { rowId: "r2", occurredAt: "2026-01-01T09:00:20.000Z" },
        { rowId: "r3", occurredAt: "2026-01-01T09:00:10.000Z" },
      ],
    });
    expect(outOfClockOrder.jumpToNextSeam(seams)?.rowId).toBe("r3");
    expect(outOfClockOrder.position().elapsedMs).toBe(10_000);
    // And the seam log order would have taken first is still ahead, so a second
    // press reaches it rather than finding it stranded behind the position.
    expect(outOfClockOrder.jumpToNextSeam(seams)?.rowId).toBe("r2");
    expect(outOfClockOrder.position().elapsedMs).toBe(WINDOW_SPAN_MS);
  });

  it("keeps the log's order between seams that share an instant", () => {
    // The comparison is strict for this: two seams at one instant are not a
    // question the clock can answer, so the log answers it.
    const sharedInstant = new ReplayEngine({
      clock: new ManualClock(),
      rows: [
        { rowId: "r1", occurredAt: "2026-01-01T09:00:00.000Z" },
        { rowId: "r2", occurredAt: "2026-01-01T09:00:10.000Z" },
        { rowId: "r3", occurredAt: "2026-01-01T09:00:10.000Z" },
      ],
    });
    expect(sharedInstant.jumpToNextSeam(seams)?.rowId).toBe("r2");
  });

  it("negative control: a monotonic window jumps in exactly the order it always did", () => {
    // Which is what shows the selection is a nearest-first walk rather than some
    // other order that happens to differ from the log's.
    const engine = engineOver(new ManualClock());
    expect(engine.jumpToNextSeam(seams)?.rowId).toBe("r2");
    expect(engine.jumpToNextSeam(seams)?.rowId).toBe("r3");
    expect(engine.jumpToNextSeam(seams)).toBeUndefined();
  });

  it("negative control: past the last seam there is nowhere to jump, and nothing moves", () => {
    const engine = engineOver(new ManualClock());
    engine.scrubTo(WINDOW_SPAN_MS);
    expect(engine.jumpToNextSeam(seams)).toBeUndefined();
    expect(engine.position().elapsedMs).toBe(WINDOW_SPAN_MS);
  });

  it("negative control: a seam naming a row outside the window is skipped, not guessed at", () => {
    const outsideSeams = new LedgerSeamIndex().seams([
      runRow({
        id: "not-in-the-replay-window",
        sequence: 1,
        type: "run.paused",
        runId: "run-b",
        position: 1,
      }),
    ]);
    const engine = engineOver(new ManualClock());
    expect(engine.jumpToNextSeam(outsideSeams)).toBeUndefined();
    expect(engine.position().elapsedMs).toBe(0);
  });
});
