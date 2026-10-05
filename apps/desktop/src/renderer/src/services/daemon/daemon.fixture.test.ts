// The fixture's streams answer as the daemon's do. The whole-session stream is catch up, then
// follow, in frames within the contract's bound; the app's real subscriber names it, so every
// scenario tier reads the session through it. A machine notice stream hands its subscriber the
// notice a settled write pushes. Every case drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts/event/envelope";
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { SessionStreamFrameSchema } from "@ai-sidekicks/contracts/session/session";

import {
  createFixture,
  lastScriptedBeatMs,
  subscribeToSessionStream,
} from "@test/helpers/fixture/bridge.js";
import type { Scenario, ScenarioBeat } from "@fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";

/** The `session.subscribe` frame as the contract registers it, over the tolerant envelope. */
const SESSION_FRAME_SCHEMA = SessionStreamFrameSchema(EventEnvelopeSchema);

/** Past the concurrent-streaming script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 100;

describe("fixture bridge — the whole-session stream is catch up, then follow", () => {
  /** Far enough in to have delivered part of the concurrent-streaming script and not all of it. */
  const MID_SCRIPT_MS = 100;

  it("hands a subscriber attaching mid-script the beats it missed, then tails", () => {
    const fixture = createFixture();

    fixture.engine.advance(MID_SCRIPT_MS);
    const elapsed = fixture.engine.progress.deliveredBeatCount;
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CONCURRENT_STREAMING_SCENARIO.beats.length);

    const received = subscribeToSessionStream(fixture);
    expect(received.events()).toHaveLength(elapsed);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // Contiguous from the first log position; a subscriber handed only the tail would read every
    // position it missed as a gap.
    expect(received.events().map((envelope) => envelope.sequence)).toStrictEqual(
      CONCURRENT_STREAMING_SCENARIO.beats.map((beat) => beat.event.sequence),
    );
  });
});

describe("fixture bridge — the whole-session stream arrives in frames", () => {
  /** One more beat than a frame carries, so a catch-up of them cannot fit in one. */
  const LONG_LOG_BEAT_COUNT = STREAM_FRAME_MAX_CHANGES + 1;

  /** The concurrent-streaming session, playing a log of registered beats all at time zero. */
  function scenarioWithLongLog(): Scenario {
    const beats: ScenarioBeat[] = Array.from({ length: LONG_LOG_BEAT_COUNT }, (_, index) => ({
      atMs: 0,
      event: {
        id: `019b79ee-0280-7ea1-8110-${String(index).padStart(12, "0")}`,
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        sequence: index + 1,
        cursor: `cursor-at-${String(index + 1)}`,
        kind: "run.starting",
        occurredAt: "2026-01-01T14:20:00.500Z",
      },
    }));
    return { ...CONCURRENT_STREAMING_SCENARIO, id: "long-log-framing-probe", beats };
  }

  it("catches up on a log longer than one frame as several frames the contract admits", () => {
    const fixture = createFixture(scenarioWithLongLog());
    fixture.engine.advance(1);

    const received = subscribeToSessionStream(fixture);

    // More than one frame, each the registered shape, and together the whole log in order.
    expect(received.frames.length).toBeGreaterThan(1);
    for (const frame of received.frames) {
      expect(SESSION_FRAME_SCHEMA.safeParse(frame).success).toBe(true);
      expect(frame.dropped).toBeUndefined();
    }
    expect(received.events().map((envelope) => envelope.sequence)).toStrictEqual(
      Array.from({ length: LONG_LOG_BEAT_COUNT }, (_, index) => index + 1),
    );
  });
});

describe("fixture bridge — a machine notice stream carries what a write pushes", () => {
  it("hands an `mcp.subscribe` stream the notice a settled `mcp.setEnabled` pushes", async () => {
    const fixture = createFixture();
    const notices: unknown[] = [];
    fixture.bridge.daemon.subscribe("mcp.subscribe", {}, (notice) => {
      notices.push(notice);
    });

    const settled = fixture.bridge.daemon.call("mcp.setEnabled", {
      provider: "claude",
      scope: "user",
      serverName: "filesystem",
      enabled: false,
      clientIdempotencyKey: "019b79ee-0280-7ea1-8110-000000000001",
    });
    // The scripted write answers after its latency.
    fixture.engine.advance(200);
    await settled;

    expect(notices).toStrictEqual([
      {
        provider: "claude",
        scope: "user",
        serverName: "filesystem",
        type: "mcp.server_config_changed",
      },
    ]);
  });
});
