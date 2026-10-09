// The session changes over a real database: a mark set twice, even at once, appends one event; a
// closed session is never reactivated, a session still provisioning takes no archive, close or
// reactivation, and one being purged takes no change; and a close ends the provider leg only of a
// session a driver ran, refusing one whose driver this daemon has not registered, and closes one
// whose history holds a row that is not JSON.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { breakStoredEvent } from "../../events/session/__fixtures__/log-faults.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { ProviderDriver } from "../../provider/driver/contract.js";
import { SessionChanges } from "../changes.js";
import { SessionService } from "../service.js";
import {
  openSessionChangesHarness,
  type SessionChangesHarness,
} from "../__fixtures__/changes-harness.js";

const SESSION_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0a01" as SessionId;
const OTHER_SESSION_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0a02" as SessionId;
const RUN_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0b01";

let harness: SessionChangesHarness;

beforeEach(async () => {
  harness = await openSessionChangesHarness();
  await harness.log.createSession(SESSION_ID, "chat");
});

afterEach(async () => {
  await harness.log.scratch.close();
});

function countOf(type: string, sessionId: SessionId = SESSION_ID): number {
  return harness.eventTypes(sessionId).filter((stored) => stored === type).length;
}

describe("a mark", () => {
  it("appends one event for two mutes sent at once and none for a third", async () => {
    // Both read the session unmuted before either commits; the second one's guard sees the first.
    await Promise.all([harness.changes.mute(SESSION_ID), harness.changes.mute(SESSION_ID)]);
    await harness.changes.mute(SESSION_ID);

    expect(countOf("session.muted")).toBe(1);
    expect(
      new SessionService(harness.log.scratch.reader).readSession({ sessionId: SESSION_ID }),
    ).toMatchObject({ session: { muted: true } });
  });
});

describe("reactivate", () => {
  it("returns an archived session, leaves an active one as it is, and refuses a closed one", async () => {
    await harness.changes.reactivate(SESSION_ID);
    expect(countOf("session.reactivated")).toBe(0);

    await harness.changes.archive(SESSION_ID);
    await harness.changes.reactivate(SESSION_ID);
    expect(countOf("session.reactivated")).toBe(1);

    await harness.changes.close(SESSION_ID);
    const refusal = harness.changes.reactivate(SESSION_ID);
    await expect(refusal).rejects.toBeInstanceOf(DaemonDomainError);
    await expect(refusal).rejects.toMatchObject({ code: "session.already_closed" });
    expect(countOf("session.reactivated")).toBe(1);
  });
});

describe("a session's state", () => {
  it("takes no archive, close or reactivation for a session still provisioning", async () => {
    await harness.log.append(OTHER_SESSION_ID, "session.created", "session_lifecycle", {
      sessionId: OTHER_SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0c01",
        name: "Claude Code",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-10-06T12:00:00.000Z",
      },
    });

    await expect(harness.changes.archive(OTHER_SESSION_ID)).rejects.toMatchObject({
      code: "session.change_refused",
      detail: { sessionId: OTHER_SESSION_ID, state: "provisioning" },
    });
    await expect(harness.changes.close(OTHER_SESSION_ID)).rejects.toMatchObject({
      code: "session.change_refused",
      detail: { sessionId: OTHER_SESSION_ID, state: "provisioning" },
    });
    await harness.changes.reactivate(OTHER_SESSION_ID);

    expect(harness.eventTypes(OTHER_SESSION_ID)).toStrictEqual(["session.created"]);
  });

  it("refuses every change to a session being purged, and names nothing", async () => {
    await harness.log.scratch.writer.write([
      {
        sql: "UPDATE sessions SET state = 'purge_requested' WHERE id = ?",
        bindings: [SESSION_ID],
        expectedRowCount: 1,
      },
    ]);
    const typesBefore = harness.eventTypes(SESSION_ID);
    const changes = [
      () => harness.changes.rename({ sessionId: SESSION_ID, name: "Renamed" }),
      () => harness.changes.archive(SESSION_ID),
      () => harness.changes.reactivate(SESSION_ID),
      () => harness.changes.close(SESSION_ID),
      () => harness.changes.pin(SESSION_ID),
      () => harness.changes.mute(SESSION_ID),
    ];

    for (const change of changes) {
      await expect(change()).rejects.toMatchObject({ code: "session.change_refused" });
    }
    await expect(harness.changes.nameUnnamed(SESSION_ID, "Auto title")).resolves.toBe(false);
    expect(harness.eventTypes(SESSION_ID)).toStrictEqual(typesBefore);
  });
});

describe("close", () => {
  it("asks the driver to close only a session one of whose runs it bound", async () => {
    await harness.log.createSession(OTHER_SESSION_ID, "chat");
    await harness.log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await harness.runtimeBindings.create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    await harness.changes.close(SESSION_ID);
    await harness.changes.close(OTHER_SESSION_ID);

    expect(harness.closedByDriver).toEqual([SESSION_ID]);
    expect(countOf("session.closed")).toBe(1);
    expect(countOf("session.closed", OTHER_SESSION_ID)).toBe(1);
    // A closed session stays readable.
    expect(
      new SessionService(harness.log.scratch.reader).readSession({ sessionId: SESSION_ID }),
    ).toMatchObject({ session: { state: "closed" } });
  });

  it("refuses a session a driver this daemon has not registered ran, and leaves it open", async () => {
    await harness.log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await harness.runtimeBindings.create({
      runId: RUN_ID,
      driverName: "codex",
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    await expect(harness.changes.close(SESSION_ID)).rejects.toMatchObject({
      code: "driver.unavailable",
      detail: { driverId: "codex" },
    });
    expect(countOf("session.closed")).toBe(0);
    expect(harness.closedByDriver).toEqual([]);
    expect(
      new SessionService(harness.log.scratch.reader).readSession({ sessionId: SESSION_ID }),
    ).toMatchObject({ session: { state: "active" } });
  });
  it("closes a session one of whose run rows is not JSON", async () => {
    await harness.log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    // The session's created and activated events sit at 0 and 1.
    await breakStoredEvent(harness.log.scratch.writer, SESSION_ID, 2);

    await harness.changes.close(SESSION_ID);

    expect(countOf("session.closed")).toBe(1);
  });

  it("refuses a close a purge overtook while the provider leg was ending", async () => {
    await harness.log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await harness.runtimeBindings.create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      spawnConfig: {},
    });
    const purgingDriver = {
      closeSession: async () => {
        await harness.log.scratch.writer.write([
          {
            sql: "UPDATE sessions SET state = 'purge_requested' WHERE id = ?",
            bindings: [SESSION_ID],
            expectedRowCount: 1,
          },
        ]);
      },
    } as unknown as ProviderDriver;
    const changes = new SessionChanges({
      reader: harness.log.scratch.reader,
      events: harness.log.eventLog,
      providers: { lookup: () => purgingDriver },
      runtimeBindings: harness.runtimeBindings,
    });

    await expect(changes.close(SESSION_ID)).rejects.toMatchObject({
      code: "session.change_refused",
      detail: { state: "purge_requested" },
    });
    expect(countOf("session.closed")).toBe(0);
  });
});
