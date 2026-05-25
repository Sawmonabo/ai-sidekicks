// `presence.read` JSON-RPC handler test suite — Plan-002 Phase 3 (T3.3).
//
// Spec coverage:
//   * Spec-002 §Interfaces And Contracts line 86 — `PresenceRead`
//     (JSON-RPC, local IPC): local clients read current presence state for
//     a session. This suite exercises the handler's registry-binding
//     boundary (round-trip through `MethodRegistry.dispatch`, correct
//     `mutating` flag, schema-validates-before-dispatch).
//   * Plan-002 §Phase 3 (CP-002-2) — `presence.*` namespace registered
//     under the Plan-007-partial wire substrate.
//
// Invariants verified (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-6 — duplicate `registerPresenceRead` throws
//     `RegistryRegistrationError("duplicate_method")` at register-time.
//   * I-007-7 — schema-validates-before-dispatch: a malformed `presence.read`
//     payload short-circuits at the registry's `safeParse(params)` step and
//     the handler closure is NEVER invoked (verified via spy call count).
//
// Test-fixture posture (mirrors session-handlers.test.ts lines 64-74):
//   The round-trip + mutating arms register against the REAL contract
//   schemas (`PresenceReadRequestSchema` / `PresenceReadResponseSchema`)
//   because the registry's `safeParse` machinery delegates to each schema's
//   native runtime `safeParse`. The runtime-daemon does NOT depend on zod;
//   the contract schemas already implement the duck-typed interface.

import { describe, expect, it, vi } from "vitest";

import type {
  HandlerContext,
  ParticipantId,
  PresenceReadRequest,
  PresenceReadResponse,
  SessionId,
} from "@ai-sidekicks/contracts";

import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";

import { registerPresenceRead, type PresenceReadDeps } from "../presence-read.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
//
// Static literal UUIDs chosen for human-readable failure output; their byte
// values are otherwise meaningless beyond passing the branded-UUID parse.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001" as ParticipantId;

/**
 * Build a canonical-shape `PresenceReadResponse` matching every required
 * field on `PresenceReadResponseSchema`. The mock `readPresence` returns
 * this verbatim so the registry's step-4 `safeParse(result)` succeeds and
 * the dispatched value reaches the test assertion intact.
 *
 * `lastSeen` is an RFC 3339 timestamp with an explicit offset — the schema
 * uses `z.iso.datetime({ offset: true })` per the presence.ts wire contract.
 */
function buildPresenceReadResponse(): PresenceReadResponse {
  return {
    participants: [
      {
        participantId: TEST_PARTICIPANT_ID,
        state: "online",
        lastSeen: "2026-01-22T19:14:35.000Z",
      },
    ],
  };
}

// ----------------------------------------------------------------------------
// Round-trip through MethodRegistry dispatch + mutating flag
// ----------------------------------------------------------------------------

describe("presence.read — round-trip through MethodRegistry dispatch", () => {
  it("dispatches `presence.read` to the deps' readPresence; returns the canonical response shape", async () => {
    const registry = new MethodRegistryImpl();
    const expectedResponse = buildPresenceReadResponse();
    const mockReadPresence = vi.fn<(req: PresenceReadRequest) => Promise<PresenceReadResponse>>(
      async () => expectedResponse,
    );
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    const directCtx: HandlerContext = {};
    const request: PresenceReadRequest = { sessionId: TEST_SESSION_ID };
    const result = await registry.dispatch("presence.read", request, directCtx);

    // The deps callback ran exactly once with the parsed params.
    expect(mockReadPresence).toHaveBeenCalledTimes(1);
    expect(mockReadPresence).toHaveBeenCalledWith({ sessionId: TEST_SESSION_ID });

    // The dispatched result equals the deps' return value verbatim (the
    // registry's step-4 `safeParse(result)` re-parses but does not mutate).
    expect(result).toStrictEqual(expectedResponse);
  });

  it("returns an empty roster `{participants: []}` unchanged (a session with no live presence is a valid projection, not an error)", async () => {
    const registry = new MethodRegistryImpl();
    const emptyRoster: PresenceReadResponse = { participants: [] };
    const mockReadPresence = vi.fn<(req: PresenceReadRequest) => Promise<PresenceReadResponse>>(
      async () => emptyRoster,
    );
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    const result = await registry.dispatch("presence.read", { sessionId: TEST_SESSION_ID }, {});
    expect(result).toStrictEqual(emptyRoster);
  });

  it("registers `presence.read` with mutating: false (read-only; pre-handshake gate lets it through)", () => {
    // Sanity check — the slice contract names mutating: false. The
    // negotiation gate predicate is `isMutating(method) === true`, so
    // flipping this flag would wrongly refuse `presence.read` in a
    // `done-incompatible` negotiation state.
    const registry = new MethodRegistryImpl();
    const deps: PresenceReadDeps = { readPresence: async () => buildPresenceReadResponse() };
    registerPresenceRead(registry, deps);
    expect(registry.isMutating("presence.read")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// I-007-7 — schema-validates-before-dispatch (handler NEVER runs on malformed)
// ----------------------------------------------------------------------------

describe("presence.read — I-007-7 schema-validates-before-dispatch", () => {
  it("malformed payload rejects with `RegistryDispatchError(invalid_params)`; handler is NEVER invoked", async () => {
    const registry = new MethodRegistryImpl();
    const mockReadPresence = vi.fn<(req: PresenceReadRequest) => Promise<PresenceReadResponse>>(
      async () => buildPresenceReadResponse(),
    );
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    // `PresenceReadRequestSchema` is `.strict()` with a required
    // `sessionId`; `{ bogus: true }` both omits `sessionId` AND carries an
    // unknown key the strict mode rejects, forcing the step-2 `safeParse`
    // failure path.
    let caught: unknown = null;
    try {
      await registry.dispatch("presence.read", { bogus: true }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
      expect(caught.issues).toBeDefined();
      expect((caught.issues ?? []).length).toBeGreaterThan(0);
    }

    // CRITICAL I-007-7 ASSERTION — the handler closure must NEVER have run.
    // A regression that moved the schema check after handler invocation
    // would fail this assertion.
    expect(mockReadPresence).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// I-007-6 — duplicate registration rejected at register-time
// ----------------------------------------------------------------------------

describe("presence.read — I-007-6 duplicate registration rejected at register-time", () => {
  it("calling registerPresenceRead twice on the same registry throws `RegistryRegistrationError(duplicate_method)`", () => {
    const registry = new MethodRegistryImpl();
    const deps: PresenceReadDeps = { readPresence: async () => buildPresenceReadResponse() };
    registerPresenceRead(registry, deps);

    let caught: unknown = null;
    try {
      registerPresenceRead(registry, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });
});
