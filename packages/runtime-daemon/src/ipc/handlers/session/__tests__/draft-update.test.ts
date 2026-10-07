// `session.draftUpdate` through the daemon's method registry, over a real database:
// a draft is held, replaced, cleared by an empty draft, and refused for a session the
// daemon has no record of; `session.read` answers the draft that is held.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../../database/__fixtures__/scratch.js";
import { SessionDraftStore } from "../../../../session/draft-store.js";
import { insertStoredEvent } from "../../../../session/__fixtures__/stored-event.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { SessionNotFoundError } from "../../../session-errors.js";
import { registerSessionDraftUpdate } from "../draft-update.js";
import { registerSessionRead, type SessionLogRead } from "../read.js";

const SESSION_ID = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";
const UNKNOWN_SESSION_ID = "0190f5a2-7c1e-7a3b-8d4e-000000000000";
const STORED_AT = "2026-09-29T18:00:00.000Z";

/** The session log's side of the read, which this suite does not exercise. */
const LOG_READ = {
  session: {
    id: SESSION_ID,
    state: "active",
    shape: "chat",
    muted: false,
    pendingWorkingFolder: null,
    createdAt: "2026-09-29T17:00:00.000Z",
    updatedAt: "2026-09-29T17:00:00.000Z",
    tags: [] as string[],
  },
  transcriptCursors: {
    earliest: encodeEventCursor(START_OF_LOG_POSITION),
    latest: encodeEventCursor(0),
  },
} as SessionLogRead;

let scratch: ScratchDatabase;
let registry: MethodRegistryImpl;

function heldDraft(): { text: string; updated_at: string } | undefined {
  return scratch.reader
    .prepare("SELECT text, updated_at FROM session_drafts WHERE session_id = ?")
    .get(SESSION_ID) as { text: string; updated_at: string } | undefined;
}

beforeEach(async () => {
  scratch = await openScratchDatabase();
  await insertStoredEvent(scratch.writer, {
    id: "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-09-29T17:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    payload: { sessionId: SESSION_ID },
    correlationId: null,
    causationId: null,
    version: "1.0",
  });
  registry = new MethodRegistryImpl();
  const draftStore = new SessionDraftStore(scratch, () => new Date(STORED_AT));
  registerSessionDraftUpdate(registry, draftStore);
  registerSessionRead(registry, { readSession: async () => LOG_READ, draftStore });
});

afterEach(async () => {
  await scratch.close();
});

describe("session.draftUpdate", () => {
  it("holds the draft and answers when it was stored", async () => {
    const result = await registry.dispatch(
      "session.draftUpdate",
      { sessionId: SESSION_ID, text: "Fix the flaky login test" },
      {},
    );

    expect(result).toStrictEqual({ sessionId: SESSION_ID, updatedAt: STORED_AT });
    expect(heldDraft()).toStrictEqual({ text: "Fix the flaky login test", updated_at: STORED_AT });
  });

  it("replaces the held draft with the newer one", async () => {
    await registry.dispatch("session.draftUpdate", { sessionId: SESSION_ID, text: "Fix" }, {});
    await registry.dispatch(
      "session.draftUpdate",
      { sessionId: SESSION_ID, text: "Fix the login test" },
      {},
    );

    expect(heldDraft()?.text).toBe("Fix the login test");
  });

  it("clears the draft when the text is empty", async () => {
    await registry.dispatch("session.draftUpdate", { sessionId: SESSION_ID, text: "Fix" }, {});
    await registry.dispatch("session.draftUpdate", { sessionId: SESSION_ID, text: "" }, {});

    expect(heldDraft()).toBeUndefined();
  });

  it("refuses a session the daemon has no record of, and holds nothing for it", async () => {
    await expect(
      registry.dispatch("session.draftUpdate", { sessionId: UNKNOWN_SESSION_ID, text: "Fix" }, {}),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    const heldForUnknown = scratch.reader
      .prepare("SELECT 1 FROM session_drafts WHERE session_id = ?")
      .get(UNKNOWN_SESSION_ID);
    expect(heldForUnknown).toBeUndefined();
  });
});

describe("the held draft on session.read", () => {
  async function readDraft(): Promise<unknown> {
    const answer = (await registry.dispatch("session.read", { sessionId: SESSION_ID }, {})) as {
      session: { draft: unknown };
    };
    return answer.session.draft;
  }

  it("answers the draft the daemon holds, and the empty string once Send clears it", async () => {
    await registry.dispatch(
      "session.draftUpdate",
      { sessionId: SESSION_ID, text: "Fix the flaky login test" },
      {},
    );
    expect(await readDraft()).toBe("Fix the flaky login test");

    await registry.dispatch("session.draftUpdate", { sessionId: SESSION_ID, text: "" }, {});
    expect(await readDraft()).toBe("");
  });
});
