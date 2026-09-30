// Timeline reads through the real method registry: a reply about another session or run is
// refused before it reaches the wire.

import { describe, expect, it } from "vitest";

import type {
  ChildRunExpandResponse,
  HandlerContext,
  RunId,
  SessionId,
  TimelineRow,
} from "@ai-sidekicks/contracts";
import { TIMELINE_CHILD_RUN_EXPAND_METHOD, TIMELINE_READ_METHOD } from "@ai-sidekicks/contracts";

// Imported through the barrel, the surface callers bind timeline methods from.
import { registerTimelineMethod } from "../handlers/index.js";
import { MethodRegistryImpl, RegistryDispatchError } from "../registry.js";

const TRANSPORT_ID = 7;
const dispatchContext: HandlerContext = { transportId: TRANSPORT_ID };

const SESSION_ID: SessionId = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f" as SessionId;
/** A second session, the one a cross-scope reply leaks rows from. */
const OTHER_SESSION_ID: SessionId = "abcdef01-2345-4678-89ab-cdef01234567" as SessionId;
/** A second run, the one a cross-scope expansion answers about. */
const OTHER_RUN_ID: RunId = "99999999-8888-4777-8666-555555555555" as RunId;
const RUN_ID: RunId = "11111111-2222-4333-8444-555555555555" as RunId;
const PARENT_RUN_ID: RunId = "33333333-4444-4555-8666-777777777777" as RunId;

const childRunExpandResponse: ChildRunExpandResponse = {
  runId: RUN_ID,
  parentRunId: PARENT_RUN_ID,
  state: "completed",
  entries: [],
  hasMore: false,
};

const timelineRow: TimelineRow = {
  kind: "general",
  id: "evt-1",
  sessionId: SESSION_ID,
  sequence: 1,
  category: "session_lifecycle",
  type: "session.created",
  summary: "session created",
  timestamp: "2026-09-01T00:00:00.000Z",
  payload: {},
};

describe("timeline replies are scoped to the request", () => {
  it("a read answering with ANOTHER session's rows is refused as an internal error", async () => {
    // Rows that are each a valid `TimelineRow` from another session pass every schema check,
    // because the response schema never sees the request.
    const registry = new MethodRegistryImpl();
    const foreignRow: TimelineRow = { ...timelineRow, sessionId: OTHER_SESSION_ID };
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      handler: async () => ({ entries: [foreignRow], hasMore: false }),
    });

    let caught: unknown = null;
    try {
      await registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      // `invalid_result` (maps to `-32603`), not `invalid_params`: the fault is the daemon's.
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries", 0, "sessionId"] });
    }

    // Control: the same handler shape answering about the requested session resolves.
    const scopedRegistry = new MethodRegistryImpl();
    registerTimelineMethod(scopedRegistry, {
      method: TIMELINE_READ_METHOD,
      handler: async () => ({ entries: [timelineRow], hasMore: false }),
    });
    await expect(
      scopedRegistry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual({ entries: [timelineRow], hasMore: false });
  });

  it("an expansion answering about ANOTHER run is refused as an internal error", async () => {
    // The response schema pins entries to the run the response names, so an expansion of the
    // wrong run is self-consistent; only the request knows which run was asked for.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      handler: async () => ({ ...childRunExpandResponse, runId: OTHER_RUN_ID }),
    });

    let caught: unknown = null;
    try {
      await registry.dispatch(TIMELINE_CHILD_RUN_EXPAND_METHOD, { runId: RUN_ID }, dispatchContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["runId"] });
    }

    // Control: the expansion of the requested run resolves.
    const scopedRegistry = new MethodRegistryImpl();
    registerTimelineMethod(scopedRegistry, {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      handler: async () => childRunExpandResponse,
    });
    await expect(
      scopedRegistry.dispatch(TIMELINE_CHILD_RUN_EXPAND_METHOD, { runId: RUN_ID }, dispatchContext),
    ).resolves.toStrictEqual(childRunExpandResponse);
  });
});
