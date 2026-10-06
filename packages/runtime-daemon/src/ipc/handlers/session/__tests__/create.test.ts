// `session.create` through the method registry: a request reaches the deps' `createSession` and
// its response comes back in the canonical shape.

import { describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts/session/directory";

import { MethodRegistryImpl } from "../../../registry.js";

import { registerSessionCreate, type SessionCreateDeps } from "../create.js";

// The fixtures use real RFC 9562 UUIDs: the registry parses the `session.create` result, so an
// invalid UUID would fail that parse for the wrong reason.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;

/** A `SessionCreateResponse` that passes `SessionCreateResponseSchema`. */
function buildSessionCreateResponse(): SessionCreateResponse {
  return {
    sessionId: TEST_SESSION_ID,
    shape: "chat",
    state: "provisioning",
  };
}

/** A well-formed `session.create` request: a chat led by a provider binding. */
const SESSION_CREATE_REQUEST: SessionCreateRequest = {
  clientIdempotencyKey: "0f2b4d5e-9999-4999-8999-999999999999",
  binding: { kind: "chat" },
  lead: {
    driverName: "claude",
    modelId: "claude-opus-4-5",
    providerAccountId: null,
    effort: "high",
  },
};

describe("session.create round-trip through MethodRegistry dispatch", () => {
  it(
    "dispatches `session.create` to the deps' " +
      "createSession; returns the canonical response shape",
    async () => {
      const registry = new MethodRegistryImpl();
      const expectedResponse = buildSessionCreateResponse();
      const mockCreateSession = vi.fn<
        (req: SessionCreateRequest) => Promise<SessionCreateResponse>
      >(async () => expectedResponse);
      const deps: SessionCreateDeps = { createSession: mockCreateSession };
      registerSessionCreate(registry, deps);

      const directCtx: HandlerContext = {};
      const result = await registry.dispatch("session.create", SESSION_CREATE_REQUEST, directCtx);

      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(SESSION_CREATE_REQUEST);
      // The registry re-parses the result against the schema but does not change it.
      expect(result).toStrictEqual(expectedResponse);
    },
  );
});
