// The session directory's provider port over a real database: a resume a driver started on its
// own is recorded, so the daemon's next restart of the session resumes the conversation that
// resume opened, and the one it left is recorded for the purge; a restart resumes in the mode the
// session was last moved to.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { readLeftConversations } from "../../../provider/left-conversations.js";
import { sessionModeChangeStatement } from "../../console-state.js";
import { RuntimeBindingStore } from "../../../provider/runtime-binding-store.js";
import { openSessionLog, type SessionLog } from "../__fixtures__/event-log.js";
import { SessionDirectoryProviderPort } from "../provider-port.js";

const SESSION_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0a01" as SessionId;
const RUN_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0b01";

let log: SessionLog;

beforeEach(async () => {
  log = await openSessionLog();
});

afterEach(async () => {
  await log.scratch.close();
});

// A port as one daemon start builds it; the git read is never reached by a restart or a relaunch.
function openPort(): SessionDirectoryProviderPort {
  return new SessionDirectoryProviderPort({
    reader: log.scratch.reader,
    runtimeBindings: new RuntimeBindingStore(log.scratch),
    git: () => Promise.reject(new Error("no git call is expected")),
    settingsFile: { read: () => Promise.reject(new Error("no settings read is expected")) },
    projectRecords: {
      readEnvironmentRowsOfSession: () => {
        throw new Error("no project read is expected");
      },
    },
    writeServiceLog: log.writeServiceLog,
  });
}

describe("a resume the driver started on its own", () => {
  it("is what the next daemon's restart resumes, the conversation it left recorded", async () => {
    await log.createSession(SESSION_ID, "chat");
    await log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await new RuntimeBindingStore(log.scratch).create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      resumeHandle: "conversation-before",
      spawnConfig: { providerAccountId: "account-1" },
    });

    openPort().onSessionRelaunched(SESSION_ID, {
      status: "resumed",
      bindingId: "binding-relaunched",
      sessionPosition: 3,
      resumeHandle: "conversation-after",
    });

    const restarted = openPort();
    await vi.waitFor(() => {
      expect(restarted.resolveRestartTarget(SESSION_ID)?.params.resumeHandle).toBe(
        "conversation-after",
      );
    });
    expect(restarted.resolveRestartTarget(SESSION_ID)).toMatchObject({
      driverName: "claude",
      params: { sessionId: SESSION_ID, model: "claude-sonnet-5", providerAccountId: "account-1" },
    });
    expect(readLeftConversations(log.scratch.reader, SESSION_ID)).toMatchObject([
      {
        driverName: "claude",
        providerAccountId: "account-1",
        conversationId: "conversation-before",
      },
    ]);
    expect(log.serviceLogLines).toEqual([]);
  });
});

describe("a restart of a session left in Plan", () => {
  it("resumes in Plan", async () => {
    await log.createSession(SESSION_ID, "chat");
    await log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await new RuntimeBindingStore(log.scratch).create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      resumeHandle: "conversation",
      spawnConfig: {},
    });
    // What `session.modeUpdate` commits once the provider took the mode.
    await log.scratch.writer.write([
      sessionModeChangeStatement(SESSION_ID, "plan", "2026-10-09T12:00:00.000Z"),
    ]);

    expect(openPort().resolveRestartTarget(SESSION_ID)?.params.mode).toBe("plan");
  });
});
