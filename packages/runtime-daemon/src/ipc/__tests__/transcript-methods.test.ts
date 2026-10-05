// Transcript methods through the real method registry: a reply about another session or run, a page
// over the caller's window or an empty first reasoning read is refused before it reaches the wire.

import { describe, expect, it } from "vitest";

import type {
  ChildRunExpandResponse,
  ReasoningSurfaceReadResponse,
  TranscriptReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type { RunId } from "@ai-sidekicks/contracts/provider-driver";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import {
  TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
  TRANSCRIPT_READ_METHOD,
  TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
} from "@ai-sidekicks/contracts/transcript/methods";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/operations";

// Imported through the barrel, the surface callers bind transcript methods from.
import { registerTranscriptMethod } from "../handlers/index.js";
import { MethodRegistryImpl, RegistryDispatchError } from "../registry.js";
import { captureRejection } from "../../__fixtures__/capture-failure.js";

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

const transcriptEventRow: TranscriptEventRow = {
  kind: "general",
  id: "evt-1",
  sessionId: SESSION_ID,
  sequence: 1,
  cursor: "cursor-1" as EventCursor,
  category: "session_lifecycle",
  type: "session.created",
  summary: "session created",
  timestamp: "2026-09-01T00:00:00.000Z",
  payload: {},
};

describe("transcript replies are scoped to the request", () => {
  it("a read answering with ANOTHER session's rows is refused as an internal error", async () => {
    // Rows that are each a valid `TranscriptEventRow` from another session pass every schema check,
    // because the response schema never sees the request.
    const registry = new MethodRegistryImpl();
    const foreignRow: TranscriptEventRow = { ...transcriptEventRow, sessionId: OTHER_SESSION_ID };
    registerTranscriptMethod(registry, {
      method: TRANSCRIPT_READ_METHOD,
      handler: async () => ({ entries: [foreignRow], hasMore: false }),
    });

    const caught = await captureRejection(
      registry.dispatch(TRANSCRIPT_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    );
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      // `invalid_result` (maps to `-32603`), not `invalid_params`: the fault is the daemon's.
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries", 0, "sessionId"] });
    }

    // Control: the same handler shape answering about the requested session resolves.
    const scopedRegistry = new MethodRegistryImpl();
    registerTranscriptMethod(scopedRegistry, {
      method: TRANSCRIPT_READ_METHOD,
      handler: async () => ({ entries: [transcriptEventRow], hasMore: false }),
    });
    await expect(
      scopedRegistry.dispatch(TRANSCRIPT_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual({ entries: [transcriptEventRow], hasMore: false });
  });

  it("an expansion answering about ANOTHER run is refused as an internal error", async () => {
    // The response schema pins entries to the run the response names, so an expansion of the
    // wrong run is self-consistent; only the request knows which run was asked for.
    const registry = new MethodRegistryImpl();
    registerTranscriptMethod(registry, {
      method: TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
      handler: async () => ({ ...childRunExpandResponse, runId: OTHER_RUN_ID }),
    });

    const caught = await captureRejection(
      registry.dispatch(TRANSCRIPT_CHILD_RUN_EXPAND_METHOD, { runId: RUN_ID }, dispatchContext),
    );
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["runId"] });
    }

    // Control: the expansion of the requested run resolves.
    const scopedRegistry = new MethodRegistryImpl();
    registerTranscriptMethod(scopedRegistry, {
      method: TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
      handler: async () => childRunExpandResponse,
    });
    await expect(
      scopedRegistry.dispatch(
        TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(childRunExpandResponse);
  });

  it("a read page over the caller's own limit is refused, and at the limit resolves", async () => {
    // The response schema bounds `entries` only at the global ceiling; the caller's limit is on
    // the request, which the schema never sees.
    const threeRowPage = {
      entries: [transcriptEventRow, transcriptEventRow, transcriptEventRow],
      hasMore: false,
    } satisfies TranscriptReadResponse;
    const registry = new MethodRegistryImpl();
    registerTranscriptMethod(registry, {
      method: TRANSCRIPT_READ_METHOD,
      handler: async () => threeRowPage,
    });

    const caught = await captureRejection(
      registry.dispatch(
        TRANSCRIPT_READ_METHOD,
        { sessionId: SESSION_ID, limit: 2 },
        dispatchContext,
      ),
    );
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      // The member, not an index: the page size is the defect, not one entry.
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries"] });
    }

    // Control: at the requested limit the same page resolves...
    await expect(
      registry.dispatch(
        TRANSCRIPT_READ_METHOD,
        { sessionId: SESSION_ID, limit: 3 },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(threeRowPage);
    // ...and so does a request with no limit, which falls back to the default ceiling.
    await expect(
      registry.dispatch(TRANSCRIPT_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual(threeRowPage);
  });

  it("an expansion past the default page ceiling is refused, one at it resolves", async () => {
    // `ChildRunExpandRequest` has no limit, so its ceiling is the default constant. The response
    // schema bounds this member at the same number, so a path-only assertion would pass without
    // the correlation check; the test asserts the ceiling message only that check emits.
    const pageOfSize = (size: number): ChildRunExpandResponse => ({
      ...childRunExpandResponse,
      entries: Array.from({ length: size }, () => transcriptEventRow),
    });
    const registry = new MethodRegistryImpl();
    registerTranscriptMethod(registry, {
      method: TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
      handler: async () => pageOfSize(TRANSCRIPT_READ_LIMIT_MAX + 1),
    });

    const caught = await captureRejection(
      registry.dispatch(TRANSCRIPT_CHILD_RUN_EXPAND_METHOD, { runId: RUN_ID }, dispatchContext),
    );
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries"] });
      expect(
        caught.issues?.some(
          (issue) =>
            typeof (issue as { message?: unknown }).message === "string" &&
            (issue as { message: string }).message.includes(
              `against a ceiling of ${String(TRANSCRIPT_READ_LIMIT_MAX)}`,
            ),
        ),
      ).toBe(true);
    }

    // Control: exactly at the ceiling resolves.
    const atCeilingRegistry = new MethodRegistryImpl();
    const atCeiling = pageOfSize(TRANSCRIPT_READ_LIMIT_MAX);
    registerTranscriptMethod(atCeilingRegistry, {
      method: TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
      handler: async () => atCeiling,
    });
    await expect(
      atCeilingRegistry.dispatch(
        TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(atCeiling);
  });

  it("an empty reasoning surface is refused on a FIRST read, not on a continuation", async () => {
    // An `available` surface with no entries renders as a surface that exists and shows nothing.
    // That is a defect on a first read but correct for a continuation already at the end, and the
    // response schema cannot tell them apart without the request.
    const emptyAvailable: ReasoningSurfaceReadResponse = {
      availability: "available",
      reasoningEntries: [],
      hasMore: false,
    };
    const registry = new MethodRegistryImpl();
    registerTranscriptMethod(registry, {
      method: TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
      handler: async () => emptyAvailable,
    });

    const caught = await captureRejection(
      registry.dispatch(
        TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    );
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["reasoningEntries"] });
    }

    // Control: the same reply is correct when the request carried a cursor.
    await expect(
      registry.dispatch(
        TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID, afterCursor: "seq-42" },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(emptyAvailable);

    // Control: a first read with entries resolves.
    const servedRegistry = new MethodRegistryImpl();
    const servedSurface: ReasoningSurfaceReadResponse = {
      availability: "available",
      reasoningEntries: [
        { sequence: 1, content: "normalized reasoning", timestamp: "2026-09-01T00:00:00.000Z" },
      ],
      hasMore: false,
    };
    registerTranscriptMethod(servedRegistry, {
      method: TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
      handler: async () => servedSurface,
    });
    await expect(
      servedRegistry.dispatch(
        TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(servedSurface);
  });
});
