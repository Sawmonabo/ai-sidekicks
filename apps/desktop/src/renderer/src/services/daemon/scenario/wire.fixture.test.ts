// The fixture's streams answer as the daemon's do. The whole-session stream is catch up, then
// follow, in frames within the contract's bound; the app's real subscriber names it, so every
// scenario tier reads the session through it. A machine notice stream hands its subscriber the
// notice a settled write pushes, and a scenario's shells are listed and open on their scrollback.
// The composer's draft stream opens on the empty draft, and its skill and command streams deliver
// no session event.
// Every case drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { validateSessionStreamFrame } from "@ai-sidekicks/contracts/session/methods";
import { validateTerminalOutputFrame, type TerminalId } from "@ai-sidekicks/contracts/terminal";

import {
  createFixture,
  lastScriptedBeatMs,
  subscribeToSessionStream,
} from "#test/helpers/fixture/bridge.js";
import type { Scenario, ScenarioBeat } from "#fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { TERMINAL_LEASE_SCENARIO } from "#fixtures/scenarios/terminal-lease.js";
import { FIXTURE_DEVICE_ID } from "#fixtures/data/this-device.js";
import {
  RUNNING_COMMAND_STREAM,
  SESSION_DRAFT_STREAM,
  SKILL_LIST_STREAM,
  TERMINAL_LIST_STREAM,
  TERMINAL_OUTPUT_STREAM,
} from "#shared/daemon/streams.js";

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
        kind: "agent.run.starting",
        occurredAt: "2026-01-01T14:20:00.500Z",
      },
    }));
    return { ...CONCURRENT_STREAMING_SCENARIO, id: "long-log-framing-probe", beats };
  }

  it("catches up on a log longer than one frame as several frames the contract admits", () => {
    const fixture = createFixture(scenarioWithLongLog());
    fixture.engine.advance(1);

    const received = subscribeToSessionStream(fixture);

    // More than one frame, each the registered shape carrying changes, never the far-behind mark,
    // and together the whole log in order.
    expect(received.frames.length).toBeGreaterThan(1);
    for (const frame of received.frames) {
      expect(validateSessionStreamFrame(frame)).toBe(true);
      expect(frame.kind).toBe("changes");
    }
    expect(received.events().map((envelope) => envelope.sequence)).toStrictEqual(
      Array.from({ length: LONG_LOG_BEAT_COUNT }, (_, index) => index + 1),
    );
  });
});

describe("fixture bridge — a machine notice stream carries what a write pushes", () => {
  it("hands an `mcp.subscribe` stream the notice a settled `mcp.server.enabled.update` pushes", async () => {
    const fixture = createFixture();
    const notices: unknown[] = [];
    fixture.bridge.daemon.subscribe("mcp.subscribe", {}, (notice) => {
      notices.push(notice);
    });

    const settled = fixture.bridge.daemon.call("mcp.server.enabled.update", {
      provider: "claude" as ProviderId,
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
        type: "mcp.server.config.changed",
      },
    ]);
  });
});

describe("fixture bridge — the composer's streams", () => {
  it("opens the draft stream on the empty draft and delivers no beat on the other two", () => {
    // Mutation: without the draft stream's row the draft subscriber hears nothing; routing a
    // composer stream through the event path hands it the scenario's beats.
    const fixture = createFixture();
    const sessionId = fixture.engine.scenario.sessionId as SessionId;
    const drafts: unknown[] = [];
    const skillLists: unknown[] = [];
    const commandSets: unknown[] = [];
    fixture.bridge.daemon.subscribe(SESSION_DRAFT_STREAM, { sessionId }, (payload) => {
      drafts.push(payload);
    });
    fixture.bridge.daemon.subscribe(SKILL_LIST_STREAM, {}, (payload) => {
      skillLists.push(payload);
    });
    fixture.bridge.daemon.subscribe(RUNNING_COMMAND_STREAM, { sessionId }, (payload) => {
      commandSets.push(payload);
    });

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(drafts).toStrictEqual([{ draft: { text: "", extras: {} }, revision: 0 }]);
    expect(skillLists).toStrictEqual([]);
    expect(commandSets).toStrictEqual([]);
  });
});

describe("fixture bridge — a scenario's shells", () => {
  it("lists the shell held as the newest lease beat says and opens it on its scrollback", () => {
    const fixture = createFixture(TERMINAL_LEASE_SCENARIO);
    const shell = TERMINAL_LEASE_SCENARIO.shells?.[0];
    const lists: unknown[] = [];
    const sessionId = TERMINAL_LEASE_SCENARIO.sessionId as SessionId;
    fixture.bridge.daemon.subscribe(TERMINAL_LIST_STREAM, { sessionId }, (list) => {
      lists.push(list);
    });
    fixture.engine.advance(lastScriptedBeatMs(TERMINAL_LEASE_SCENARIO) + 1);

    // Opened before any lease beat, then restated once for the batch that moved the lease.
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ terminals: [{ holder: null, leaseVersion: 0 }] });
    expect(lists.at(-1)).toStrictEqual({
      sessionId,
      terminals: [
        {
          terminalId: shell?.terminalId,
          title: shell?.title,
          status: { state: "running" },
          holder: { holderDeviceId: FIXTURE_DEVICE_ID },
          leaseVersion: 7,
        },
      ],
    });

    const opened: { frame: unknown; attachments: readonly Uint8Array[] }[] = [];
    const terminalId = shell?.terminalId as TerminalId;
    fixture.bridge.daemon.subscribe(
      TERMINAL_OUTPUT_STREAM,
      { sessionId, terminalId },
      (frame, attachments) => {
        opened.push({ frame, attachments });
      },
    );
    const [{ frame, attachments } = { frame: undefined, attachments: [] }] = opened;
    expect(validateTerminalOutputFrame.call({ attachments }, frame)).toBe(true);
    expect(new TextDecoder().decode(attachments[0])).toBe(shell?.scrollback);

    // A watcher that holds every byte of the window is sent nothing again.
    const reopened: unknown[] = [];
    fixture.bridge.daemon.subscribe(
      TERMINAL_OUTPUT_STREAM,
      { sessionId, terminalId, afterOffset: attachments[0]?.byteLength ?? 0 },
      (again) => {
        reopened.push(again);
      },
    );
    expect(reopened).toStrictEqual([]);
  });
});
