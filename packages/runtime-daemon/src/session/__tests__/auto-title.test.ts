// The session's self-naming over a real database: after its first completed exchange an unnamed
// session takes the first words of its first message, a name the person writes while the title is
// on its way is the one the session keeps, a session whose exchange completed before the start is
// named at the start unless the person cleared its name, and a stop waits for a title on its way.

import { setImmediate as nextEventLoopTurn } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { SessionAutoTitle } from "../auto-title.js";
import { SessionChanges } from "../changes.js";
import {
  openSessionChangesHarness,
  type SessionChangesHarness,
} from "../__fixtures__/changes-harness.js";

const SESSION_ID = "0190fa20-3c4d-7e5f-8a6b-7c8d9e0f1a01" as SessionId;
const CLEARED_SESSION_ID = "0190fa20-3c4d-7e5f-8a6b-7c8d9e0f1a02" as SessionId;
const RUN_ID = "0190fa20-3c4d-7e5f-8a6b-7c8d9e0f1b01";
const CLEARED_RUN_ID = "0190fa20-3c4d-7e5f-8a6b-7c8d9e0f1b02";
const FIRST_MESSAGE = "  Fix the login redirect after a session expires on the settings page";
const PERSON_NAME = "Login redirect";

let harness: SessionChangesHarness;
let stopTitling: (() => Promise<void>) | undefined;

beforeEach(async () => {
  harness = await openSessionChangesHarness();
  await harness.log.createSession(SESSION_ID, "chat");
});

afterEach(async () => {
  await stopTitling?.();
  await harness.log.scratch.close();
});

// Starts the self-naming with `changes`, and answers each title write as it is made.
function startTitling(changes: Pick<SessionChanges, "nameUnnamed">): Promise<boolean>[] {
  const titleWrites: Promise<boolean>[] = [];
  const autoTitle = new SessionAutoTitle({
    reader: harness.log.scratch.reader,
    events: harness.log.eventLog,
    changes: {
      nameUnnamed: (sessionId, name) => {
        const write = changes.nameUnnamed(sessionId, name);
        titleWrites.push(write);
        return write;
      },
    },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  stopTitling = autoTitle.start();
  return titleWrites;
}

async function completeFirstExchange(
  sessionId: SessionId = SESSION_ID,
  runId: string = RUN_ID,
): Promise<void> {
  await harness.log.append(sessionId, "user.message", "interactive_request", {
    sessionId,
    actor: "person",
    message: FIRST_MESSAGE,
  });
  await harness.log.append(sessionId, "run.starting", "run_lifecycle", {
    sessionId,
    runId,
    runVersion: 1,
    previousState: "queued",
    newState: "starting",
  });
  await harness.log.append(sessionId, "run.completed", "run_lifecycle", {
    sessionId,
    runId,
    runVersion: 2,
    previousState: "starting",
    newState: "completed",
    completionKind: "turn",
  });
}

function sessionName(sessionId: SessionId = SESSION_ID): string | null {
  return (
    harness.log.scratch.reader.prepare("SELECT name FROM sessions WHERE id = ?").get(sessionId) as {
      name: string | null;
    }
  ).name;
}

describe("SessionAutoTitle", () => {
  it("names an unnamed session with the first words of its first message", async () => {
    const titleWrites = startTitling(harness.changes);

    await completeFirstExchange();
    await vi.waitFor(() => expect(titleWrites).toHaveLength(1));

    await expect(titleWrites[0]).resolves.toBe(true);
    expect(sessionName()).toBe("Fix the login redirect after a session");
  });

  it("keeps the name the person writes while the title is on its way", async () => {
    // The person's rename lands between the title's read of the session and its write.
    let hasPersonRenamed = false;
    const racingChanges = new SessionChanges({
      reader: harness.log.scratch.reader,
      events: {
        append: async (envelope, options) => {
          if (!hasPersonRenamed) {
            hasPersonRenamed = true;
            await harness.changes.rename({ sessionId: SESSION_ID, name: PERSON_NAME });
          }
          return harness.log.eventLog.append(envelope, options);
        },
      },
      providers: { lookup: () => undefined },
      runtimeBindings: harness.runtimeBindings,
    });
    const titleWrites = startTitling(racingChanges);

    await completeFirstExchange();
    await vi.waitFor(() => expect(titleWrites).toHaveLength(1));

    await expect(titleWrites[0]).resolves.toBe(false);
    expect(sessionName()).toBe(PERSON_NAME);
    expect(
      harness.eventTypes(SESSION_ID).filter((type) => type === "session.renamed"),
    ).toHaveLength(1);
  });

  it("at start, names a session that completed earlier, unless the person cleared it", async () => {
    await harness.log.createSession(CLEARED_SESSION_ID, "chat");
    await completeFirstExchange();
    await completeFirstExchange(CLEARED_SESSION_ID, CLEARED_RUN_ID);
    await harness.changes.rename({ sessionId: CLEARED_SESSION_ID, name: PERSON_NAME });
    await harness.changes.rename({ sessionId: CLEARED_SESSION_ID, name: null });

    const titleWrites = startTitling(harness.changes);
    await vi.waitFor(() => expect(titleWrites).toHaveLength(1));

    await expect(titleWrites[0]).resolves.toBe(true);
    expect(sessionName()).toBe("Fix the login redirect after a session");
    expect(sessionName(CLEARED_SESSION_ID)).toBeNull();
  });

  it("stops only once the title on its way has been written", async () => {
    const write = Promise.withResolvers<boolean>();
    const titleWrites = startTitling({ nameUnnamed: () => write.promise });
    await completeFirstExchange();
    await vi.waitFor(() => expect(titleWrites).toHaveLength(1));

    const stopped = stopTitling!().then(() => "stopped" as const);
    // A stop that did not wait for the title would settle within the microtasks this turn runs.
    expect(await Promise.race([stopped, nextEventLoopTurn("held" as const)])).toBe("held");

    write.resolve(true);
    await expect(stopped).resolves.toBe("stopped");
  });
});
