// `session.read` through the method registry: a known session answers with its held draft, and
// an unknown one reads as `session.not_found` on the wire.

import { describe, expect, it, vi } from "vitest";

import type { SessionReadRequest } from "@ai-sidekicks/contracts/session/methods";
import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { SessionReadResponseSchema } from "@ai-sidekicks/contracts/session/methods";

import { mapJsonRpcError } from "../../../jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { SessionNotFoundError } from "../../../session-errors.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import type { SessionLogRead } from "../../../../session/service.js";

import { registerSessionRead, type SessionReadDeps } from "../read.js";

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const UNKNOWN_SESSION_ID = "aabbccdd-eeff-4011-8022-334455667788" as SessionId;
const HELD_DRAFT = "Half a thought about the retry loop";
/** A draft store holding no draft for any session. */
const NO_DRAFTS: SessionReadDeps["draftStore"] = { read: () => "" };

/**
 * The session log's side of a `session.read` answer: every snapshot member but the draft, which
 * the handler adds from the draft store.
 *
 * `transcriptCursors.acknowledged` is omitted on purpose: an absent optional key catches a default
 * of `undefined` that would fail `.strict()` parsing.
 */
function buildSessionLogRead(): SessionLogRead {
  return {
    session: {
      id: TEST_SESSION_ID,
      state: "active",
      shape: "chat",
      muted: false,
      pendingWorkingFolder: null,
      createdAt: "2026-01-22T19:14:35.000Z",
      updatedAt: "2026-01-22T19:14:35.000Z",
      tags: [],
    },
    transcriptCursors: {
      earliest: encodeEventCursor(START_OF_LOG_POSITION),
      latest: encodeEventCursor(42),
    },
    liveRuns: [],
  };
}

describe("session.read", () => {
  it("dispatches a known sessionId to readSession and answers with the held draft", async () => {
    const registry = new MethodRegistryImpl();
    const logRead = buildSessionLogRead();
    const mockReadSession = vi.fn<(req: SessionReadRequest) => Promise<SessionLogRead>>(
      async () => logRead,
    );
    const deps: SessionReadDeps = {
      readSession: mockReadSession,
      draftStore: { read: (sessionId) => (sessionId === TEST_SESSION_ID ? HELD_DRAFT : "") },
    };
    registerSessionRead(registry, deps);

    const directCtx: HandlerContext = {};
    const result = await registry.dispatch(
      "session.read",
      { sessionId: TEST_SESSION_ID },
      directCtx,
    );

    expect(mockReadSession).toHaveBeenCalledTimes(1);
    expect(mockReadSession).toHaveBeenCalledWith({ sessionId: TEST_SESSION_ID });

    // The log's read, with the draft the store holds for that session.
    expect(result).toStrictEqual({
      ...logRead,
      session: { ...logRead.session, draft: HELD_DRAFT },
    });

    // The answer also passes the wire schema.
    const parsed = SessionReadResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it(
    "maps an unknown sessionId throw to -32602 + data.type session.not_found via " +
      "SessionNotFoundError",
    async () => {
      // `SessionReadDeps.readSession` must throw `SessionNotFoundError` (not a plain `Error`) for
      // an unknown id, so `mapJsonRpcError` produces this envelope instead of the `-32603`
      // catch-all.
      const registry = new MethodRegistryImpl();
      const mockReadSession = vi.fn<(req: SessionReadRequest) => Promise<SessionLogRead>>(
        async () => {
          throw new SessionNotFoundError("session not found", {
            sessionId: UNKNOWN_SESSION_ID,
          });
        },
      );
      const deps: SessionReadDeps = { readSession: mockReadSession, draftStore: NO_DRAFTS };
      registerSessionRead(registry, deps);

      // `dispatch()` does not wrap handler throws (only `method_not_found`, `invalid_params` and
      // `invalid_result` become `RegistryDispatchError`), and the gateway passes the raw throw to
      // `mapJsonRpcError`.
      const ctx: HandlerContext = {};
      const caught = await captureRejection(
        registry.dispatch("session.read", { sessionId: UNKNOWN_SESSION_ID }, ctx),
      );
      expect(caught).toBeInstanceOf(SessionNotFoundError);

      const envelope = mapJsonRpcError(caught, 7);

      expect(envelope.id).toBe(7);
      expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.error.data).toBeDefined();
      const data = envelope.error.data;
      if (data === undefined)
        throw new Error("unreachable — envelope.error.data was asserted above");
      expect(data.type).toBe("session.not_found");
      // The throw site's `fields` projects through to `data.fields`, with `sessionId` intact.
      const fields = data.fields;
      if (fields === undefined) throw new Error("unreachable — fields was passed at throw site");
      // Bracket access: `noPropertyAccessFromIndexSignature` forbids dot access on a record.
      expect(fields["sessionId"]).toBe(UNKNOWN_SESSION_ID);
      // The throw came from the deps layer, not from somewhere else in the registry.
      expect(mockReadSession).toHaveBeenCalledTimes(1);
    },
  );
});
