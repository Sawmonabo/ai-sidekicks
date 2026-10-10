// `transcript.bodyRead` through the real method registry over a scratch log: a body too large to
// ride its row comes back whole, a row with none reads as absent, and an id or a session the
// daemon does not hold is refused, each its own way.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES } from "@ai-sidekicks/contracts/transcript/limits";
import { TRANSCRIPT_BODY_READ_METHOD } from "@ai-sidekicks/contracts/transcript/methods";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { registerTranscriptBodyRead } from "../../ipc/handlers/transcript-methods.js";
import { MethodRegistryImpl, RegistryDispatchError } from "../../ipc/registry.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { insertStoredEvent } from "../../session/__fixtures__/stored-event.js";
import { TranscriptBodyReader } from "../body.js";

const SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9a01" as SessionId;
const UNKNOWN_SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9aff" as SessionId;
const dispatchContext: HandlerContext = { transportId: 1 };

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
});

// One assistant message at `sequence`, with `body` stored beside it, or none.
async function seedMessage(sequence: number, body: string | null): Promise<void> {
  await insertStoredEvent(
    scratch.writer,
    {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      occurredAt: "2026-10-09T12:00:00.000Z",
      monotonicNs: BigInt(sequence),
      category: "assistant_output",
      type: "assistant.message",
      actor: null,
      payload: body === null ? {} : { contentType: "text/plain", contentLength: body.length },
      correlationId: null,
      causationId: null,
      version: "1.0",
    },
    body,
  );
}

describe("transcript.bodyRead — a row's whole body", () => {
  it("reads a large body back whole, a row with none as absent, and refuses what it lacks", async () => {
    // Over the inline bound, so its row carries only the size and this read is the way to it.
    const largeBody = `${"x".repeat(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES * 4)}\nend`;
    await seedMessage(0, largeBody);
    await seedMessage(1, null);
    const registry = new MethodRegistryImpl();
    registerTranscriptBodyRead(registry, {
      transcriptBodies: new TranscriptBodyReader(scratch.reader, () => undefined),
    });
    const bodyRead = (sessionId: SessionId, rowId: string): Promise<unknown> =>
      registry.dispatch(TRANSCRIPT_BODY_READ_METHOD, { sessionId, rowId }, dispatchContext);

    await expect(bodyRead(SESSION_ID, "event-0")).resolves.toStrictEqual({
      status: "available",
      body: largeBody,
      contentLength: largeBody.length,
    });
    await expect(bodyRead(SESSION_ID, "event-1")).resolves.toStrictEqual({
      status: "unavailable",
      reason: "absent",
    });

    const unknownRow = await captureRejection(bodyRead(SESSION_ID, "event-9"));
    expect(unknownRow).toBeInstanceOf(RegistryDispatchError);
    if (unknownRow instanceof RegistryDispatchError) {
      expect(unknownRow.registryCode).toBe("invalid_params");
      expect(unknownRow.issues?.[0]).toMatchObject({ path: ["rowId"] });
    }
    // The row exists, in another session: a row is read only in the session that holds it.
    await expect(bodyRead(UNKNOWN_SESSION_ID, "event-0")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});
