// The session changes over a real database: a mark set twice, even at once, appends one event; a
// closed session is never reactivated; and a close ends the provider leg only of a session a
// driver ran.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import { SessionService } from "../service.js";
import { openSessionChangesHarness, type SessionChangesHarness } from "./changes.test-support.js";

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

describe("close", () => {
  it("asks the driver to close only a session one of whose runs it bound", async () => {
    await harness.log.createSession(OTHER_SESSION_ID, "chat");
    await harness.log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
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
});
