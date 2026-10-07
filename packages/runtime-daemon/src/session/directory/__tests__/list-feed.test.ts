// The live sessions list, fed by the real event log over a real database: a quiet running
// session is renewed on a fake clock, the chats count follows a chat's create and its convert,
// archived and closed sessions stay entries, a purge removes one even when the log loses its
// receipt, and a group's rename reaches every session in it.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_ACTIVITY_RENEW_INTERVAL_MS,
  SESSION_ACTIVITY_STALE_AFTER_MS,
  sessionActivityAsOf,
  type SessionListChange,
} from "@ai-sidekicks/contracts/session/directory";
import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  buildPurgeReceipt,
  crossEventLoopTurn,
  openSessionLog,
  type SessionLog,
} from "../__fixtures__/event-log.js";
import { SessionGroupService } from "../../groups/service.js";
import { SessionListFeed, type SessionListListener } from "../list-feed.js";

const CHAT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10" as SessionId;
const PROJECT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11" as SessionId;
const SECOND_CHAT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12" as SessionId;
const RUN = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8fa1";

let log: SessionLog;
let feed: SessionListFeed;

beforeEach(async () => {
  log = await openSessionLog();
  feed = new SessionListFeed({
    reader: log.scratch.reader,
    eventLog: log.eventLog,
    writeServiceLog: log.writeServiceLog,
  });
});

afterEach(async () => {
  feed.close();
  vi.useRealTimers();
  await log.scratch.close();
});

/** A listener that keeps every change and fails the test on a read failure. */
function recordingListener(): SessionListListener & { readonly changes: SessionListChange[] } {
  const changes: SessionListChange[] = [];
  return {
    changes,
    onChange: (change) => {
      changes.push(change);
    },
    onFailure: (error) => {
      throw error;
    },
  };
}

async function startRun(sessionId: SessionId): Promise<void> {
  await log.append(sessionId, "run.starting", "run_lifecycle", {
    sessionId,
    runId: RUN,
    runVersion: 1,
  });
  await crossEventLoopTurn();
}

describe("the sessions list renews a quiet running session", () => {
  it("publishes its entry again at each renewal while it runs, and stops once it ends", async () => {
    // The ack barrier and the feed's batching cross real `setImmediate` turns.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
    await log.createSession(CHAT, "chat");
    const listener = recordingListener();
    feed.open(listener);
    await startRun(CHAT);
    const started = listener.changes.at(-1);
    expect(started).toMatchObject({ kind: "upsert", entry: { activity: "running" } });
    listener.changes.length = 0;

    vi.advanceTimersByTime(SESSION_ACTIVITY_RENEW_INTERVAL_MS);
    vi.advanceTimersByTime(SESSION_ACTIVITY_RENEW_INTERVAL_MS);

    expect(listener.changes).toStrictEqual(
      [1, 2].map((renewal) => ({
        kind: "upsert",
        entry: {
          ...(started?.kind === "upsert" ? started.entry : {}),
          activityRenewedAt: new Date(
            Date.parse("2026-10-06T12:00:00.000Z") + renewal * SESSION_ACTIVITY_RENEW_INTERVAL_MS,
          ).toISOString(),
        },
        chatCount: 1,
      })),
    );
    // Renewed, a reader still believes it; the first reading alone would have aged to idle.
    const renewed = listener.changes.at(-1);
    if (renewed?.kind !== "upsert" || started?.kind !== "upsert") throw new Error("no upsert");
    const readAt = Date.now() + SESSION_ACTIVITY_STALE_AFTER_MS - 1;
    expect(sessionActivityAsOf(renewed.entry, readAt)).toBe("running");
    expect(sessionActivityAsOf(started.entry, readAt)).toBe("idle");

    await log.append(CHAT, "run.completed", "run_lifecycle", {
      sessionId: CHAT,
      runId: RUN,
      runVersion: 2,
      completionKind: "turn",
    });
    await crossEventLoopTurn();
    listener.changes.length = 0;
    vi.advanceTimersByTime(3 * SESSION_ACTIVITY_RENEW_INTERVAL_MS);
    expect(listener.changes).toStrictEqual([]);
  });

  it("runs its one timer only while a running session and an open list both exist", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await log.createSession(CHAT, "chat");
    await log.createSession(SECOND_CHAT, "chat");
    // The database writer keeps a timer of its own.
    const otherTimers = vi.getTimerCount();
    const opening = feed.open(recordingListener());
    expect(vi.getTimerCount()).toBe(otherTimers);

    await startRun(CHAT);
    await startRun(SECOND_CHAT);
    expect(vi.getTimerCount()).toBe(otherTimers + 1);

    opening.detach();
    expect(vi.getTimerCount()).toBe(otherTimers);
  });
});

describe("the sessions list counts the chats and keeps every session the log holds", () => {
  it("counts a chat from its create and stops counting it once it converts to a project", async () => {
    const listener = recordingListener();
    expect(feed.open(listener)).toMatchObject({ sessions: [], chatCount: 0 });

    await log.createSession(CHAT, "chat");
    await crossEventLoopTurn();
    expect(listener.changes.at(-1)).toMatchObject({
      kind: "upsert",
      entry: { sessionId: CHAT, shape: "chat", state: "active" },
      chatCount: 1,
    });

    const repoMountId = await log.bindToProject(CHAT);
    await log.append(CHAT, "session.converted", "session_lifecycle", {
      sessionId: CHAT,
      repoMountId,
      copiedCount: 2,
      skippedCount: 0,
    });
    await crossEventLoopTurn();

    expect(listener.changes.at(-1)).toMatchObject({
      kind: "upsert",
      entry: { sessionId: CHAT, shape: "project", repoMountId },
      chatCount: 0,
    });
  });

  it("keeps archived and closed sessions as entries, out of the chats count", async () => {
    const archivedChat = randomUUID() as SessionId;
    await log.createSession(CHAT, "chat");
    await log.createSession(archivedChat, "chat");
    await log.createSession(PROJECT, "project");
    const repoMountId = await log.bindToProject(PROJECT);
    const listener = recordingListener();
    expect(feed.open(listener).chatCount).toBe(2);

    await log.append(archivedChat, "session.archived", "session_lifecycle", {
      sessionId: archivedChat,
      previousState: "active",
      newState: "archived",
    });
    await log.append(PROJECT, "session.closed", "session_lifecycle", {
      sessionId: PROJECT,
      previousState: "active",
      newState: "closed",
    });
    await crossEventLoopTurn();

    expect(listener.changes).toMatchObject([
      { kind: "upsert", entry: { sessionId: archivedChat, state: "archived" }, chatCount: 1 },
      { kind: "upsert", entry: { sessionId: PROJECT, state: "closed", repoMountId }, chatCount: 1 },
    ]);
    const reopened = feed.open(recordingListener());
    expect(reopened.chatCount).toBe(1);
    expect(reopened.sessions.map((entry) => [entry.sessionId, entry.state]).sort()).toStrictEqual(
      [
        [CHAT, "active"],
        [archivedChat, "archived"],
        [PROJECT, "closed"],
      ].sort(),
    );
  });

  it("removes a purged session's entry when the purge's receipt commits", async () => {
    await log.createSession(CHAT, "chat");
    const listener = recordingListener();
    feed.open(listener);

    await log.purge(CHAT);
    await crossEventLoopTurn();

    expect(listener.changes).toStrictEqual([{ kind: "remove", sessionId: CHAT, chatCount: 0 }]);
    expect(feed.open(recordingListener()).sessions).toStrictEqual([]);
  });

  it("removes a purged session whose receipt the log loses", async () => {
    await log.createSession(CHAT, "chat");
    await log.createSession(SECOND_CHAT, "chat");
    const lossyLog = log.openLossyLog();
    const lossyFeed = new SessionListFeed({
      reader: log.scratch.reader,
      eventLog: lossyLog.eventLog,
      writeServiceLog: log.writeServiceLog,
    });
    const listener = recordingListener();
    lossyFeed.open(listener);

    await log.scratch.writer.write([
      { sql: "DELETE FROM sessions WHERE id = ?", bindings: [CHAT], expectedRowCount: 1 },
    ]);
    // The receipt after the lost one names a session the list never held.
    await lossyLog.appendLosing(
      buildPurgeReceipt(CHAT),
      buildPurgeReceipt(randomUUID() as SessionId),
    );
    await crossEventLoopTurn();

    expect(listener.changes).toStrictEqual([{ kind: "remove", sessionId: CHAT, chatCount: 1 }]);
    expect(log.serviceLogLines).toEqual([
      expect.stringContaining(`reading session ${DAEMON_SCOPE_SENTINEL_SESSION_ID}'s events`),
    ]);
    lossyFeed.close();
  });
});

describe("the sessions list names each session's group", () => {
  it("publishes every session of a renamed group again under the new name", async () => {
    const groups = new SessionGroupService({ writer: log.scratch.writer, listFeed: feed });
    const second = randomUUID() as SessionId;
    await log.createSession(PROJECT, "project");
    await log.createSession(second, "project");
    const repoMountId = await log.bindToProject(PROJECT);
    await log.bindToProject(second, repoMountId);
    const { groupId } = await groups.create({ sessionId: PROJECT, name: "auth work" });
    await groups.move({ sessionId: second, groupId });
    const listener = recordingListener();
    expect(
      feed.open(listener).sessions.map((entry) => entry.shape === "project" && entry.group),
    ).toStrictEqual([
      { groupId, name: "auth work" },
      { groupId, name: "auth work" },
    ]);

    await groups.rename({ groupId, name: "billing" });
    await crossEventLoopTurn();

    expect(
      listener.changes.map((change) =>
        change.kind === "upsert" && change.entry.shape === "project"
          ? [change.entry.sessionId, change.entry.group]
          : change.kind,
      ),
    ).toStrictEqual([
      [PROJECT, { groupId, name: "billing" }],
      [second, { groupId, name: "billing" }],
    ]);
  });
});
