// The `timeline.*` method strings against the real daemon `MethodRegistry`, and the
// `timeline.bodyRead` handler. A regex check on the names would not prove the deployed registry
// accepts them, so every assertion goes through `MethodRegistryImpl` and the dispatch rows go
// through the descriptors' real schemas.

import { describe, expect, it, vi } from "vitest";

import type {
  EventCursor,
  EventEnvelope,
  ChildRunExpandResponse,
  Handler,
  HandlerContext,
  ReasoningSurfaceReadResponse,
  RunId,
  SessionId,
  TimelineReadRequest,
  TimelineReadResponse,
  TimelineRow,
} from "@ai-sidekicks/contracts";
import {
  EventEnvelopeVersionSchema,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_NAMES,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_BODY_READ_METHOD,
  TIMELINE_PATCH_READ_METHOD,
  TIMELINE_SEARCH_METHOD,
} from "@ai-sidekicks/contracts";

// Imported through the barrel, the surface callers bind timeline methods from.
import { registerTimelineMethod } from "../handlers/index.js";
import { SessionContentReader, type StoredEventContentRow } from "../../events/content-read.js";
import { SessionContentKeyUnavailableError } from "../../events/session-content-key-store.js";
import { registerTimelineBodyRead } from "../handlers/timeline-methods.js";
import { SessionNotFoundError } from "../session-errors.js";
import {
  isCanonicalMethodName,
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";

const TRANSPORT_ID = 7;
const dispatchContext: HandlerContext = { transportId: TRANSPORT_ID };

const SESSION_ID: SessionId = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f" as SessionId;
/** A second session, the one a cross-scope reply leaks rows from. */
const OTHER_SESSION_ID: SessionId = "abcdef01-2345-4678-89ab-cdef01234567" as SessionId;
/** A second run, the one a cross-scope expansion answers about. */
const OTHER_RUN_ID: RunId = "99999999-8888-4777-8666-555555555555" as RunId;
const RUN_ID: RunId = "11111111-2222-4333-8444-555555555555" as RunId;
const PARENT_RUN_ID: RunId = "33333333-4444-4555-8666-777777777777" as RunId;

const readResponse: TimelineReadResponse = { entries: [], hasMore: false };
const reasoningResponse: ReasoningSurfaceReadResponse = { availability: "unavailable" };
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

/** Binds every timeline method to a stub handler that resolves a valid response. */
const registerAllTimelineMethods = (registry: MethodRegistryImpl): void => {
  registerTimelineMethod(registry, {
    method: TIMELINE_READ_METHOD,
    handler: async () => readResponse,
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_REASONING_SURFACE_READ_METHOD,
    handler: async () => reasoningResponse,
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
    handler: async () => childRunExpandResponse,
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_BODY_READ_METHOD,
    handler: async () => ({ status: "unavailable", reason: "absent" }),
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_PATCH_READ_METHOD,
    handler: async () => ({ files: [] }),
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_SEARCH_METHOD,
    handler: async () => ({ matchCount: 0, hits: [], hasMore: false }),
  });
};

describe("timeline method-name registration", () => {
  it("every timeline method string passes the deployed registry's gate", () => {
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(isCanonicalMethodName(method)).toBe(true);
    }
    // Control: the predicate rejects malformed siblings, so the passes above are meaningful.
    expect(isCanonicalMethodName("Timeline.read")).toBe(false);
    expect(isCanonicalMethodName("timeline.")).toBe(false);
  });

  it("every method registers on a real MethodRegistryImpl and then resolves", () => {
    const registry = new MethodRegistryImpl();
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(registry.has(method)).toBe(false);
    }
    registerAllTimelineMethods(registry);
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(registry.has(method)).toBe(true);
      // Every timeline operation is a read, so the version-mismatch gate lets it through.
      expect(registry.isMutating(method)).toBe(false);
    }
  });

  it("an unregistered `timeline.*` sibling still resolves to method_not_found", () => {
    // Registering the methods does not open the rest of the namespace.
    const registry = new MethodRegistryImpl();
    registerAllTimelineMethods(registry);
    expect(registry.has("timeline.write")).toBe(false);
    expect(registry.isMutating("timeline.write")).toBeUndefined();
  });

  it("registering a timeline method twice throws at register-time", () => {
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      handler: async () => readResponse,
    });
    expect(() => {
      registerTimelineMethod(registry, {
        method: TIMELINE_READ_METHOD,
        handler: async () => readResponse,
      });
    }).toThrow(RegistryRegistrationError);
  });

  it("the descriptor's request schema gates dispatch, handler never runs", async () => {
    const registry = new MethodRegistryImpl();
    const handler = vi.fn<Handler<TimelineReadRequest, TimelineReadResponse>>(
      async () => readResponse,
    );
    registerTimelineMethod(registry, { method: TIMELINE_READ_METHOD, handler });

    // Over the read window's cap; the descriptor's schema enforces it, not the handler.
    let caught: unknown = null;
    try {
      await registry.dispatch(
        TIMELINE_READ_METHOD,
        { sessionId: SESSION_ID, limit: 100_000 },
        dispatchContext,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
    }
    expect(handler).not.toHaveBeenCalled();

    // Control: valid params dispatch, so the refusal above came from the payload.
    const result = await registry.dispatch(
      TIMELINE_READ_METHOD,
      { sessionId: SESSION_ID },
      dispatchContext,
    );
    expect(result).toStrictEqual(readResponse);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("each method dispatches to ITS OWN operation, not a sibling's", async () => {
    // Each name carries its own schemas, so one operation's request shape is refused by another.
    const registry = new MethodRegistryImpl();
    registerAllTimelineMethods(registry);

    await expect(
      registry.dispatch(TIMELINE_REASONING_SURFACE_READ_METHOD, { runId: RUN_ID }, dispatchContext),
    ).resolves.toStrictEqual(reasoningResponse);

    // `sessionId`, `beforeCursor` and `limit` are not members of the expansion's strict shape.
    let caught: unknown = null;
    try {
      await registry.dispatch(
        TIMELINE_CHILD_RUN_EXPAND_METHOD,
        { runId: RUN_ID, sessionId: SESSION_ID, beforeCursor: "seq-1", limit: 10 },
        dispatchContext,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
    }
  });

  it("a handler resolving another operation's response is caught as invalid_result", async () => {
    // The descriptor's response schema validates the resolved value, so a handler wired to the
    // wrong operation fails at dispatch instead of putting a wrong shape on the wire.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      // The cast stands in for a handler wired to the wrong operation, which the types reject.
      handler: (async () => reasoningResponse) as unknown as Handler<
        TimelineReadRequest,
        TimelineReadResponse
      >,
    });
    let caught: unknown = null;
    try {
      await registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
    }
  });

  it("the registered schemas are the CANONICAL objects, by reference", () => {
    // The binder takes schemas from `TIMELINE_METHOD_DESCRIPTORS`. Identity, not deep equality,
    // proves each registered pair is the canonical object and not a look-alike.
    const recorded = new Map<string, { params: unknown; result: unknown }>();
    const recordingRegistry = {
      register: (method: string, paramsSchema: unknown, resultSchema: unknown): void => {
        recorded.set(method, { params: paramsSchema, result: resultSchema });
      },
      dispatch: async (): Promise<unknown> => undefined,
      has: (): boolean => false,
      isMutating: (): boolean | undefined => undefined,
    } as unknown as MethodRegistryImpl;

    registerAllTimelineMethods(recordingRegistry);

    expect(recorded.size).toBe(TIMELINE_METHOD_NAMES.length);
    for (const method of TIMELINE_METHOD_NAMES) {
      const canonical = TIMELINE_METHOD_DESCRIPTORS[method];
      expect(recorded.get(method)?.params).toBe(canonical.requestSchema);
      expect(recorded.get(method)?.result).toBe(canonical.responseSchema);
    }
  });

  it("no two operations share a schema object — the identity check can discriminate", () => {
    // Control for the identity test above: if two operations shared a schema instance, it could
    // pass while a method was paired with a sibling's schema.
    const requestSchemas = TIMELINE_METHOD_NAMES.map(
      (method) => TIMELINE_METHOD_DESCRIPTORS[method].requestSchema,
    );
    const responseSchemas = TIMELINE_METHOD_NAMES.map(
      (method) => TIMELINE_METHOD_DESCRIPTORS[method].responseSchema,
    );
    expect(new Set(requestSchemas).size).toBe(TIMELINE_METHOD_NAMES.length);
    expect(new Set(responseSchemas).size).toBe(TIMELINE_METHOD_NAMES.length);
  });

  it("a handler bound to a sibling operation does not compile", () => {
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      // @ts-expect-error a reasoning-surface handler cannot bind to childRunExpand:
      // the handler's types are derived from `method` through the contract map.
      handler: async () => reasoningResponse,
    });
    expect(registry.has(TIMELINE_CHILD_RUN_EXPAND_METHOD)).toBe(true);
  });

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

  it("a read page over the caller's own limit is refused, and at the limit resolves", async () => {
    // The response schema bounds `entries` only at the global ceiling; the caller's limit is on
    // the request, which the schema never sees.
    const threeRowPage = {
      entries: [timelineRow, timelineRow, timelineRow],
      hasMore: false,
    } satisfies TimelineReadResponse;
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      handler: async () => threeRowPage,
    });

    let caught: unknown = null;
    try {
      await registry.dispatch(
        TIMELINE_READ_METHOD,
        { sessionId: SESSION_ID, limit: 2 },
        dispatchContext,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      // The member, not an index: the page size is the defect, not one entry.
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries"] });
    }

    // Control: at the requested limit the same page resolves...
    await expect(
      registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID, limit: 3 }, dispatchContext),
    ).resolves.toStrictEqual(threeRowPage);
    // ...and so does a request with no limit, which falls back to the default ceiling.
    await expect(
      registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual(threeRowPage);
  });

  it("an expansion over the default page ceiling is refused, and at the ceiling resolves", async () => {
    // `ChildRunExpandRequest` has no limit, so its ceiling is the default constant. The response
    // schema bounds this member at the same number, so a path-only assertion would pass without
    // the correlation check; the test asserts the ceiling message only that check emits.
    const pageOfSize = (size: number): ChildRunExpandResponse => ({
      ...childRunExpandResponse,
      entries: Array.from({ length: size }, () => timelineRow),
    });
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      handler: async () => pageOfSize(TIMELINE_READ_LIMIT_MAX + 1),
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
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries"] });
      expect(
        caught.issues?.some(
          (issue) =>
            typeof (issue as { message?: unknown }).message === "string" &&
            (issue as { message: string }).message.includes(
              `against a ceiling of ${String(TIMELINE_READ_LIMIT_MAX)}`,
            ),
        ),
      ).toBe(true);
    }

    // Control: exactly at the ceiling resolves.
    const atCeilingRegistry = new MethodRegistryImpl();
    const atCeiling = pageOfSize(TIMELINE_READ_LIMIT_MAX);
    registerTimelineMethod(atCeilingRegistry, {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      handler: async () => atCeiling,
    });
    await expect(
      atCeilingRegistry.dispatch(
        TIMELINE_CHILD_RUN_EXPAND_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(atCeiling);
  });

  it("a malformed read entry reaches invalid_result, not a bare TypeError", async () => {
    // The correlation check runs before the response schema, so it sees unvalidated values. A
    // page holding `null` must not throw a bare `TypeError` with no issue paths; a shape the check
    // cannot read is left to the response schema to report.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      // The cast stands in for a projection defect, which the types reject.
      handler: (async () => ({
        entries: [null],
        hasMore: false,
      })) as unknown as Handler<TimelineReadRequest, TimelineReadResponse>,
    });

    let caught: unknown = null;
    try {
      await registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext);
    } catch (error) {
      caught = error;
    }
    // A `TypeError` would also fail the dispatch, but in a shape the client cannot read.
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      // The schema's issue paths locate the offending element.
      expect(caught.issues?.length ?? 0).toBeGreaterThan(0);
    }

    // Control: a readable cross-session page is still refused by the correlation check.
    const foreignRegistry = new MethodRegistryImpl();
    registerTimelineMethod(foreignRegistry, {
      method: TIMELINE_READ_METHOD,
      handler: async () => ({
        entries: [{ ...timelineRow, sessionId: OTHER_SESSION_ID }],
        hasMore: false,
      }),
    });
    await expect(
      foreignRegistry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).rejects.toMatchObject({ registryCode: "invalid_result" });
  });

  it("an empty reasoning surface on a FIRST read is refused; on a continuation it resolves", async () => {
    // An `available` surface with no entries renders as a surface that exists and shows nothing.
    // That is a defect on a first read but correct for a continuation already at the end, and the
    // response schema cannot tell them apart without the request.
    const emptyAvailable: ReasoningSurfaceReadResponse = {
      availability: "available",
      reasoningEntries: [],
      hasMore: false,
    };
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_REASONING_SURFACE_READ_METHOD,
      handler: async () => emptyAvailable,
    });

    let caught: unknown = null;
    try {
      await registry.dispatch(
        TIMELINE_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["reasoningEntries"] });
    }

    // Control: the same reply is correct when the request carried a cursor.
    await expect(
      registry.dispatch(
        TIMELINE_REASONING_SURFACE_READ_METHOD,
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
    registerTimelineMethod(servedRegistry, {
      method: TIMELINE_REASONING_SURFACE_READ_METHOD,
      handler: async () => servedSurface,
    });
    await expect(
      servedRegistry.dispatch(
        TIMELINE_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(servedSurface);
  });
});

describe("timeline.bodyRead", () => {
  const storedEnvelope: EventEnvelope = {
    id: "evt-output",
    sessionId: SESSION_ID,
    sequence: 3,
    occurredAt: "2026-09-01T00:00:00.000Z",
    category: "tool_activity",
    type: "tool.result",
    actor: "agent-1",
    payload: { sessionId: SESSION_ID, runId: RUN_ID, toolName: "Bash" },
    version: EventEnvelopeVersionSchema.parse("1.0"),
  };
  const storedRow = (retentionClass: string | null): StoredEventContentRow => ({
    envelope: storedEnvelope,
    contentPayload: null,
    retentionClass,
  });
  const contentReader = new SessionContentReader({
    keyReader: {
      read: (sessionId) =>
        Promise.reject(
          new SessionContentKeyUnavailableError("wrapped_key_missing", sessionId, "no key"),
        ),
    },
  });

  const registryReading = (
    readStoredEventRow: (
      sessionId: SessionId,
      eventId: string,
    ) => Promise<StoredEventContentRow | undefined>,
    reader: Pick<SessionContentReader, "hydrate"> = contentReader,
  ): MethodRegistryImpl => {
    const registry = new MethodRegistryImpl();
    registerTimelineBodyRead(registry, { readStoredEventRow, contentReader: reader });
    return registry;
  };

  const dispatchBodyRead = (registry: MethodRegistryImpl, rowId = "evt-output"): Promise<unknown> =>
    registry.dispatch(TIMELINE_BODY_READ_METHOD, { sessionId: SESSION_ID, rowId }, dispatchContext);

  it("answers with the row's opened body", async () => {
    const readStoredEventRow = vi.fn(async () => storedRow(null));
    const registry = registryReading(readStoredEventRow, {
      hydrate: async (row) => ({
        event: row.envelope,
        content: { status: "available", body: "done\n", contentLength: 5 },
      }),
    });
    await expect(dispatchBodyRead(registry)).resolves.toStrictEqual({
      status: "available",
      body: "done\n",
      contentLength: 5,
    });
    expect(readStoredEventRow).toHaveBeenCalledWith(SESSION_ID, "evt-output");
  });

  it("answers why a body cannot be read", async () => {
    const registry = registryReading(async () => storedRow(null));
    await expect(dispatchBodyRead(registry)).resolves.toStrictEqual({
      status: "unavailable",
      reason: "absent",
    });
  });

  it("refuses a row the session does not hold, on the rowId path", async () => {
    const registry = registryReading(async () => undefined);
    const refusal = await dispatchBodyRead(registry, "evt-missing").catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(RegistryDispatchError);
    expect((refusal as RegistryDispatchError).registryCode).toBe("invalid_params");
    expect((refusal as RegistryDispatchError).issues?.[0]).toMatchObject({ path: ["rowId"] });
  });

  it("lets an unknown session surface as session.not_found", async () => {
    const registry = registryReading(async () => {
      throw new SessionNotFoundError("no such session");
    });
    await expect(dispatchBodyRead(registry)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("never puts a purged body on the wire", async () => {
    const registry = registryReading(async () => storedRow("audit_stub"));
    const refusal = await dispatchBodyRead(registry).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RegistryDispatchError);
    expect((refusal as RegistryDispatchError).registryCode).toBe("invalid_result");
  });
});

describe("timeline.search", () => {
  it("a page over the caller's own limit is refused, and at the limit resolves", async () => {
    const hit = {
      rowId: "evt-1",
      cursor: "seq-1" as EventCursor,
      snippet: "a parser",
      matchRanges: [{ offset: 2, length: 6 }],
    };
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_SEARCH_METHOD,
      handler: async () => ({ matchCount: 3, hits: [hit, hit, hit], hasMore: false }),
    });
    const refusal = await registry
      .dispatch(
        TIMELINE_SEARCH_METHOD,
        { sessionId: SESSION_ID, query: "parser", limit: 2 },
        dispatchContext,
      )
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RegistryDispatchError);
    expect((refusal as RegistryDispatchError).registryCode).toBe("invalid_result");
    expect((refusal as RegistryDispatchError).issues?.[0]).toMatchObject({ path: ["hits"] });
    await expect(
      registry.dispatch(
        TIMELINE_SEARCH_METHOD,
        { sessionId: SESSION_ID, query: "parser", limit: 3 },
        dispatchContext,
      ),
    ).resolves.toMatchObject({ matchCount: 3 });
  });
});
