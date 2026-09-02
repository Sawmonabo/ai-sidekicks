// Plan-013 T1.4 — the four `timeline.*` method strings against the REAL
// daemon `MethodRegistry`.
//
// Spec coverage:
//   * `Spec-013 §Interfaces And Contracts`; the canonical
//     `docs/architecture/contracts/api-payload-contracts.md` §"Timeline
//     Method-Name Registry (Tier 8, Plan-013 T1.4)" table.
//   * Plan-007 I-007-6 (duplicate rejected at register-time), I-007-7 (schema
//     validated before dispatch), I-007-9 (canonical method-name format).
//
// WHAT THIS FILE IS FOR. The Tier-8 audit's finding was that a timeline
// operation's SCHEMA NAME resolved while its METHOD STRING did not. Asserting
// the four names against `METHOD_NAME_FORMAT` alone would not close that — a
// regex says a name is well-formed, not that the deployed registry accepts it
// (BL-142 is the worked case: every camelCase-tailed V1 name matched the
// canonical regex in the doc and was rejected by the daemon's own drifted copy
// at boot). So every assertion here goes through `MethodRegistryImpl`, and the
// dispatch rows go through the descriptor's real schemas.

import { describe, expect, it, vi } from "vitest";

import type {
  ChildRunExpandResponse,
  Handler,
  HandlerContext,
  JsonRpcNotification,
  LocalSubscriptionProducer,
  ReasoningSurfaceReadResponse,
  RunId,
  SessionId,
  TimelineReadRequest,
  TimelineReadResponse,
  TimelineRow,
  TimelineSubscribeRequest,
} from "@ai-sidekicks/contracts";
import {
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_NAMES,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_SUBSCRIBE_METHOD,
} from "@ai-sidekicks/contracts";

// THROUGH THE BARREL, deliberately. `handlers/index.js` is the surface the
// bootstrap orchestrator wires from, and its own header states that
// convention. A test that reached past it into `timeline-methods.js` would
// pass while the bootstrap could still register only three of the four
// methods — which is exactly the gap that made `registerTimelineSubscription`
// reachable from nowhere but this file.
import {
  registerTimelineMethod,
  registerTimelineSubscription,
  TimelineSubscriptionScopeError,
} from "../handlers/index.js";
import {
  isCanonicalMethodName,
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";
import { StreamingPrimitive, StreamingValidationError } from "../streaming-primitive.js";

/**
 * Cross one `setImmediate` boundary — the check phase the subscribe-init
 * barrier flushes on.
 *
 * Awaiting a promise only drains microtasks, and the barrier deliberately
 * schedules past those (a microtask queued from the handler body drains ahead
 * of the dispatch resolution, so it cannot cross the response). A test that
 * asserted on `sentFrames` without this would be asserting on the pre-flush
 * state and calling it the post-flush one.
 */
const settleAckBarrier = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The `$/subscription/notify` params shape the streaming primitive writes. */
const notifiedRowIds = (frames: readonly JsonRpcNotification<unknown>[]): string[] =>
  frames.map((frame) => (frame.params as { value: TimelineRow }).value.id);

const TRANSPORT_ID = 7;
const dispatchContext: HandlerContext = { transportId: TRANSPORT_ID };

const SESSION_ID: SessionId = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f" as SessionId;
/** A second, unrelated session — the one a cross-scope reply leaks rows from. */
const OTHER_SESSION_ID: SessionId = "abcdef01-2345-4678-89ab-cdef01234567" as SessionId;
/** A second, unrelated run — the one a cross-scope expansion answers about. */
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

/**
 * A REAL `StreamingPrimitive` plus the frames it emitted.
 *
 * Deliberately not a hand-rolled producer double: the claim under test is that
 * an emission is validated against the descriptor's own schema before a frame
 * is written, and a double that re-implements that check would prove only that
 * the test can validate. This one records what the primitive actually wrote.
 */
const buildStreamingPrimitive = (): {
  streamingPrimitive: StreamingPrimitive;
  sentFrames: JsonRpcNotification<unknown>[];
} => {
  const sentFrames: JsonRpcNotification<unknown>[] = [];
  const streamingPrimitive = new StreamingPrimitive({
    send: (_transportId, frame) => {
      sentFrames.push(frame);
    },
    registry: new MethodRegistryImpl(),
  });
  return { streamingPrimitive, sentFrames };
};

/**
 * Bind all four methods with handlers that resolve a valid response for their
 * own operation. Deliberately NOT a production binder — the production
 * handlers arrive with the Phase-2/Phase-3 services; these exist so the
 * registration and dispatch paths can be exercised end to end.
 *
 * `timeline.subscribe` goes through its OWN binder, because it has to: the
 * query binder's `MethodName` excludes it.
 */
const registerAllTimelineMethods = (
  registry: MethodRegistryImpl,
  subscriptionOverrides?: Partial<{
    streamingPrimitive: StreamingPrimitive;
    attachProjection: (
      request: TimelineSubscribeRequest,
      producer: LocalSubscriptionProducer<TimelineRow>,
      context: HandlerContext,
    ) => void | Promise<void>;
  }>,
): void => {
  registerTimelineMethod(registry, {
    method: TIMELINE_READ_METHOD,
    handler: async () => readResponse,
  });
  registerTimelineSubscription(registry, {
    streamingPrimitive:
      subscriptionOverrides?.streamingPrimitive ?? buildStreamingPrimitive().streamingPrimitive,
    attachProjection: subscriptionOverrides?.attachProjection ?? ((): void => {}),
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_REASONING_SURFACE_READ_METHOD,
    handler: async () => reasoningResponse,
  });
  registerTimelineMethod(registry, {
    method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
    handler: async () => childRunExpandResponse,
  });
};

describe("timeline method-name registration (Plan-013 T1.4)", () => {
  it("every timeline method string passes the deployed registry's I-007-9 gate", () => {
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(isCanonicalMethodName(method)).toBe(true);
    }
    // Negative control on the same predicate: a PascalCase sibling of one of
    // these names is rejected, so the four passes above are the names and not
    // a checker that says yes to everything.
    expect(isCanonicalMethodName("Timeline.read")).toBe(false);
    expect(isCanonicalMethodName("timeline.")).toBe(false);
  });

  it("all four register on a real MethodRegistryImpl and then resolve", () => {
    const registry = new MethodRegistryImpl();
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(registry.has(method)).toBe(false);
    }
    registerAllTimelineMethods(registry);
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(registry.has(method)).toBe(true);
      // Every timeline operation is a read, so the version-mismatch gate lets
      // it through when the handshake reports incompatible.
      expect(registry.isMutating(method)).toBe(false);
    }
  });

  it("an unregistered `timeline.*` sibling still resolves to method_not_found", () => {
    // Namespace isolation: registering the four does not open the namespace.
    const registry = new MethodRegistryImpl();
    registerAllTimelineMethods(registry);
    expect(registry.has("timeline.write")).toBe(false);
    expect(registry.isMutating("timeline.write")).toBeUndefined();
  });

  it("I-007-6 — registering a timeline method twice throws at register-time", () => {
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

  it("I-007-7 — the descriptor's request schema gates dispatch, handler never runs", async () => {
    const registry = new MethodRegistryImpl();
    const handler = vi.fn<Handler<TimelineReadRequest, TimelineReadResponse>>(
      async () => readResponse,
    );
    registerTimelineMethod(registry, { method: TIMELINE_READ_METHOD, handler });

    // Over the read window's own cap — the bounded-window rule, enforced by the
    // schema the descriptor carries rather than by the handler.
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

    // Negative control: the same method dispatches when the params are valid,
    // so the refusal above is the payload and not a broken registration.
    const result = await registry.dispatch(
      TIMELINE_READ_METHOD,
      { sessionId: SESSION_ID },
      dispatchContext,
    );
    expect(result).toStrictEqual(readResponse);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("each method dispatches to ITS OWN operation, not a sibling's", async () => {
    // The binding claim: a `timeline.reasoningSurfaceRead` request shape is
    // refused by `timeline.childRunExpand` and vice versa, because each name
    // carries its own schemas from the one descriptor registry.
    const registry = new MethodRegistryImpl();
    registerAllTimelineMethods(registry);

    await expect(
      registry.dispatch(TIMELINE_REASONING_SURFACE_READ_METHOD, { runId: RUN_ID }, dispatchContext),
    ).resolves.toStrictEqual(reasoningResponse);

    const subscribeResult = await registry.dispatch(
      TIMELINE_SUBSCRIBE_METHOD,
      { sessionId: SESSION_ID },
      dispatchContext,
    );
    // The ack is the shared `{ subscriptionId }` floor, and the id is the one
    // the primitive minted rather than one this test supplied.
    expect(Object.keys(subscribeResult as object)).toStrictEqual(["subscriptionId"]);

    // A read-window request offered to the subscribe method: `beforeCursor` and
    // `limit` are not members of the subscribe shape, so `.strict()` refuses.
    let caught: unknown = null;
    try {
      await registry.dispatch(
        TIMELINE_SUBSCRIBE_METHOD,
        { sessionId: SESSION_ID, beforeCursor: "seq-1", limit: 10 },
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
    // The result half of the same binding claim: the descriptor's response
    // schema is what the registry validates the resolved value against, so a
    // handler wired to the wrong operation is a programmer error surfaced at
    // dispatch, never a wrong shape on the wire.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      // The cast is the point: it stands in for a handler wired to the wrong
      // operation. Without it the mistake is a compile error — which is the
      // binder's first line of defence — so the runtime backstop can only be
      // exercised by defeating the type check deliberately.
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
    // The binder resolves schemas from `TIMELINE_METHOD_DESCRIPTORS` instead of
    // accepting them, so there is no schema argument to get wrong. This asserts
    // the resolution actually happened: each registered pair must be the very
    // object the canonical registry holds, not merely a structurally similar
    // one. A deep-equality check would pass against a look-alike rebuilt from
    // the wrong operation's parts; identity cannot.
    //
    // `MethodRegistry` exposes no schema introspection — only register /
    // dispatch / has / isMutating — so this records what the binder PASSES
    // rather than reaching into the real registry's internals or widening a
    // Plan-007-owned interface to suit a test.
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
    // Negative control for the test above. If any two operations happened to
    // reuse one schema instance, an identity assertion could pass while the
    // binder had paired a method with a sibling's schema. All four request
    // schemas and all four response schemas must be pairwise distinct for the
    // identity check to mean what it claims.
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
      // the handler's types are derived from `method` through the contract map,
      // so the forgery the old descriptor-taking form allowed is now unsayable.
      handler: async () => reasoningResponse,
    });
    expect(registry.has(TIMELINE_CHILD_RUN_EXPAND_METHOD)).toBe(true);
  });

  it("the query binder cannot bind the subscription — a COMPILE-time barrier", () => {
    // The structural half of the emission guarantee. If `timeline.subscribe`
    // could be bound here, a handler would supply its own producer schema and
    // the descriptor's `emissionSchema` would go unread while the ack still
    // validated. Excluding it from `TimelineQueryMethodName` makes the
    // subscription binder the only route.
    //
    // The barrier is the TYPE, and this test says so rather than pretending
    // otherwise: the `@ts-expect-error` below is the assertion, enforced by CI
    // typecheck, and deleting the exclusion turns that suppression into an
    // unused-directive error. At RUNTIME the suppressed call still registers —
    // asserting a throw here would claim a defence the binder does not have,
    // and the registration below records the real behaviour.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      // @ts-expect-error `timeline.subscribe` is not a query method: it binds
      // through `registerTimelineSubscription`, which fixes the per-emission
      // schema from the canonical descriptor.
      method: TIMELINE_SUBSCRIBE_METHOD,
      handler: async () => readResponse,
    });
    expect(registry.has(TIMELINE_SUBSCRIBE_METHOD)).toBe(true);
  });

  it("the subscription's producer emits a TimelineRow and writes one notify frame", async () => {
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive, sentFrames } = buildStreamingPrimitive();
    let capturedProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
    registerTimelineSubscription(registry, {
      streamingPrimitive,
      attachProjection: (_request, producer) => {
        capturedProducer = producer;
      },
    });

    const ack = await registry.dispatch(
      TIMELINE_SUBSCRIBE_METHOD,
      { sessionId: SESSION_ID },
      dispatchContext,
    );
    expect(capturedProducer).not.toBeNull();
    const producer = capturedProducer as unknown as LocalSubscriptionProducer<TimelineRow>;
    expect((ack as { subscriptionId: string }).subscriptionId).toBe(producer.subscriptionId);

    producer.next(timelineRow);
    // The producer handed to a projection is gated by the subscribe-init
    // barrier, so an emission is never written in the caller's own turn. Here
    // the barrier has already been released by the successful dispatch, and
    // the frame lands one event-loop phase later.
    await settleAckBarrier();
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.method).toBe("$/subscription/notify");
  });

  it("rows emitted DURING setup are held until after the ack, and arrive in order", async () => {
    // I-007-10, and the reason the barrier lives in the binder rather than in
    // an obligation on the projection. A projection that replays synchronously
    // emits before the handler has returned, let alone before the gateway has
    // written `{ subscriptionId }`. A pre-ack notify frame is not an error the
    // client sees — the SDK registers the subscription only once the init
    // response settles, so an early frame hits the unknown-id silent-drop
    // branch and the rows simply vanish.
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive, sentFrames } = buildStreamingPrimitive();
    const replayedRows: TimelineRow[] = [
      { ...timelineRow, id: "evt-replay-1", sequence: 1 },
      { ...timelineRow, id: "evt-replay-2", sequence: 2 },
    ];
    registerTimelineSubscription(registry, {
      streamingPrimitive,
      attachProjection: (_request, producer) => {
        // Synchronous replay burst, inside the handler body.
        for (const row of replayedRows) {
          producer.next(row);
        }
        // The claim: not one of these reached the transport yet.
        expect(sentFrames).toHaveLength(0);
      },
    });

    const ack = await registry.dispatch(
      TIMELINE_SUBSCRIBE_METHOD,
      { sessionId: SESSION_ID },
      dispatchContext,
    );
    // Still nothing on the wire at the moment the ack is produced — this is
    // the assertion the old binder could not make.
    expect(sentFrames).toHaveLength(0);
    expect((ack as { subscriptionId: string }).subscriptionId).toBeTypeOf("string");

    await settleAckBarrier();
    expect(sentFrames).toHaveLength(2);
    expect(notifiedRowIds(sentFrames)).toEqual(["evt-replay-1", "evt-replay-2"]);
  });

  it("a wrong-shape emission is refused before any frame is written", async () => {
    // The claim the subscription binder exists for. The producer's schema is
    // the descriptor's `emissionSchema` and the handler never chose it, so a
    // projection that pushes a non-`TimelineRow` value is stopped at
    // `next(...)` — not accepted onto the wire under a passing ack.
    //
    // The refusal is no longer a synchronous throw into the projection, and
    // that is the barrier's doing rather than a weakening: the emission is
    // ordered past the ack, so by the time the schema rejects it the
    // projection's frame is long gone and there is nobody to throw to. The
    // barrier therefore takes the posture `session.subscribe` has always
    // taken on this path — cancel the subscription so no entry orphans, log a
    // prefixed tripwire, and keep the daemon alive. What does NOT change is
    // the guarantee under test: nothing reaches the wire.
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive, sentFrames } = buildStreamingPrimitive();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
    registerTimelineSubscription(registry, {
      streamingPrimitive,
      attachProjection: (_request, producer) => {
        capturedProducer = producer;
      },
    });

    try {
      await registry.dispatch(
        TIMELINE_SUBSCRIBE_METHOD,
        { sessionId: SESSION_ID },
        dispatchContext,
      );
      await settleAckBarrier();
      const producer = capturedProducer as unknown as LocalSubscriptionProducer<TimelineRow>;
      // The cast stands in for a Phase-2 projection wired to the wrong shape.
      // Without it this is a compile error, which is the binder's first line
      // of defence; the runtime backstop can only be exercised by defeating
      // the type check deliberately. The value below is the subscribe ACK —
      // the exact shape a handler that confused the two schemas would emit.
      producer.next({ subscriptionId: "not-a-row" } as unknown as TimelineRow);
      expect(sentFrames).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleErrorSpy.mock.calls[0]?.[0])).toContain(
        `[${TIMELINE_SUBSCRIBE_METHOD}]`,
      );
      // The value that was refused is what `StreamingValidationError` names —
      // asserting the class here keeps the test honest about WHY nothing was
      // written, rather than passing on any failure at all.
      expect(consoleErrorSpy.mock.calls[0]?.[1]).toBeInstanceOf(StreamingValidationError);

      // Negative control: a real row on a FRESH subscription does go out, so
      // the refusal above is the value and not a producer that rejects
      // everything. It must be a fresh one — the bad emission canceled this
      // subscription, and a canceled producer is a documented no-op.
      let secondProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
      const secondRegistry = new MethodRegistryImpl();
      registerTimelineSubscription(secondRegistry, {
        streamingPrimitive,
        attachProjection: (_request, producer) => {
          secondProducer = producer;
        },
      });
      await secondRegistry.dispatch(
        TIMELINE_SUBSCRIBE_METHOD,
        { sessionId: SESSION_ID },
        dispatchContext,
      );
      await settleAckBarrier();
      (secondProducer as unknown as LocalSubscriptionProducer<TimelineRow>).next(timelineRow);
      await settleAckBarrier();
      expect(sentFrames).toHaveLength(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("the handler barrel exposes BOTH binders, so a bootstrap can register all four", () => {
    // The query binder is typed to refuse `timeline.subscribe`, and the
    // subscription's per-emission schema is consumed nowhere but its own
    // binder. A barrel carrying only the first would let a bootstrap that
    // follows the declared convention register three of the four methods and
    // force a reach past the barrel for the fourth — the convention silently
    // broken by the surface meant to state it.
    expect(typeof registerTimelineMethod).toBe("function");
    expect(typeof registerTimelineSubscription).toBe("function");
    // Registering all four THROUGH the barrel imports above is the claim: if
    // either binder were missing from `handlers/index.ts` this file would not
    // have compiled.
    const registry = new MethodRegistryImpl();
    registerAllTimelineMethods(registry);
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(registry.has(method)).toBe(true);
    }
  });

  it("a read answering with ANOTHER session's rows is refused as an internal error", async () => {
    // The registry validates a result against the response schema and never
    // sees the parsed request, so a page of rows that are each a valid
    // `TimelineRow` from a different session passes every schema check and
    // reaches the client under its own request id. The caller cannot tell:
    // the reply is well-formed and correlated, it is simply about someone
    // else's session.
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
      // `invalid_result`, not `invalid_params`: the caller asked a well-formed
      // question and the daemon assembled an answer about another subject, so
      // this maps to `-32603` and blames the daemon.
      expect(caught.registryCode).toBe("invalid_result");
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries", 0, "sessionId"] });
    }

    // NEGATIVE CONTROL: the same handler shape answering about the REQUESTED
    // session resolves, so the refusal is the scope and not the wrapper
    // rejecting every page.
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
    // The response schema pins every entry to the run the RESPONSE names, so
    // an expansion of the wrong run is internally consistent and passes. The
    // one fact no schema can check is that the run it names is the run that
    // was asked for.
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

    // NEGATIVE CONTROL: the expansion of the requested run resolves.
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
    // The response schema bounds `entries` at the GLOBAL ceiling, which is the
    // only one it can know: the caller's number is on the REQUEST, which no
    // response schema sees. So a read for two rows answering with three parses
    // today, and a client sizing a viewport, a budget, or a render pass from
    // what it asked for is handed more with nothing on the reply saying so.
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
      // The member, not an index: the page's SIZE is the defect and no single
      // entry is responsible for it.
      expect(caught.issues?.[0]).toMatchObject({ path: ["entries"] });
    }

    // NEGATIVE CONTROL, both directions on the same page. At the requested
    // limit it resolves…
    await expect(
      registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID, limit: 3 }, dispatchContext),
    ).resolves.toStrictEqual(threeRowPage);
    // …and so does a request that named no limit at all, which falls back to
    // the default ceiling rather than to zero.
    await expect(
      registry.dispatch(TIMELINE_READ_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual(threeRowPage);
  });

  it("an expansion over the default page ceiling is refused, and at the ceiling resolves", async () => {
    // ChildRunExpandRequest declares no limit of its own, so its ceiling is the
    // default constant — the same rule, stated on both paged reads so neither
    // surface can drift, and already in place the day this request grows a
    // caller-supplied limit.
    //
    // WHICH REPORTER ANSWERS is the whole assertion here, and it has to be,
    // because today the response schema bounds this member at the same number:
    // a path-only assertion passes with the correlation check deleted, which
    // would make this test vacuous. So it asserts the message only THIS check
    // emits — the one that names the ceiling and where the ceiling came from.
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

    // NEGATIVE CONTROL: exactly at the ceiling resolves, so the refusal is the
    // overrun and not the size of the page.
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
    // The correlation check runs one step BEFORE the response schema, so it is
    // handed values that have not been validated yet. `Array.isArray` says
    // nothing about what is IN the array: a page holding `null` passed the
    // container guard and then threw a bare `TypeError` out of the comparison,
    // which escapes the dispatch promise as an unmapped internal failure with
    // no issue paths — destroying the very diagnostic the check exists beside.
    //
    // The rule is the one the check already applies to the container: a shape
    // it cannot read is the response schema's finding, reported one step later
    // with the real reason.
    const registry = new MethodRegistryImpl();
    registerTimelineMethod(registry, {
      method: TIMELINE_READ_METHOD,
      // The cast stands in for a projection defect. Without it the malformed
      // entry is a compile error, so the runtime backstop can only be reached
      // by defeating the type check deliberately.
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
    // NOT a TypeError — that is the whole assertion. A `TypeError` here would
    // still fail the dispatch, which is why the defect was invisible: it fails
    // in a shape the client cannot read.
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
      // …and the issue paths locate the offending element, which is what the
      // schema reports and the correlation check deliberately does not.
      expect(caught.issues?.length ?? 0).toBeGreaterThan(0);
    }

    // NEGATIVE CONTROL: a page whose entries ARE readable and cross-session is
    // still refused by the correlation check itself, so deferring on malformed
    // input did not disable the check for well-formed pages.
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
    // The one correlation rule that is not about the reply's subject. An
    // `available` surface with no entries renders as a surface that exists and
    // shows nothing — indistinguishable from `unavailable` while asserting the
    // opposite. That is a defect on a first read and the correct answer on a
    // continuation whose cursor already sat at the end, and the response schema
    // cannot tell them apart because the request is not in its scope.
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

    // NEGATIVE CONTROL, and the reason the floor lives here rather than in the
    // schema: the SAME reply is correct when the request carried a cursor.
    await expect(
      registry.dispatch(
        TIMELINE_REASONING_SURFACE_READ_METHOD,
        { runId: RUN_ID, afterCursor: "seq-42" },
        dispatchContext,
      ),
    ).resolves.toStrictEqual(emptyAvailable);

    // SECOND NEGATIVE CONTROL: a first read that actually has something to
    // serve resolves, so the refusal is the emptiness and not the first read.
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

  it("an emission from ANOTHER session never reaches the wire", async () => {
    // `TimelineRowSchema` accepts it — a row of a different session is a
    // perfectly valid row — so validation alone would forward another
    // session's history into this client's live view under a subscription id
    // it trusts. The gate is the request's own `sessionId`, and it takes the
    // wrong-shape posture: cancel, log a prefixed tripwire, write nothing.
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive, sentFrames } = buildStreamingPrimitive();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
    registerTimelineSubscription(registry, {
      streamingPrimitive,
      attachProjection: (_request, producer) => {
        capturedProducer = producer;
      },
    });

    try {
      await registry.dispatch(
        TIMELINE_SUBSCRIBE_METHOD,
        { sessionId: SESSION_ID },
        dispatchContext,
      );
      await settleAckBarrier();
      const producer = capturedProducer as unknown as LocalSubscriptionProducer<TimelineRow>;
      producer.next({ ...timelineRow, sessionId: OTHER_SESSION_ID });
      expect(sentFrames).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleErrorSpy.mock.calls[0]?.[0])).toContain(
        `[${TIMELINE_SUBSCRIBE_METHOD}]`,
      );
      // Naming the class keeps the test honest about WHY nothing was written:
      // a scope refusal, not a schema failure that happens to look the same.
      expect(consoleErrorSpy.mock.calls[0]?.[1]).toBeInstanceOf(TimelineSubscriptionScopeError);

      // NEGATIVE CONTROL on a FRESH subscription — the cross-session emission
      // canceled this one, and a canceled producer is a documented no-op, so
      // reusing it would prove nothing. The same row for the SUBSCRIBED
      // session does go out.
      let secondProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
      const secondRegistry = new MethodRegistryImpl();
      registerTimelineSubscription(secondRegistry, {
        streamingPrimitive,
        attachProjection: (_request, producer) => {
          secondProducer = producer;
        },
      });
      await secondRegistry.dispatch(
        TIMELINE_SUBSCRIBE_METHOD,
        { sessionId: SESSION_ID },
        dispatchContext,
      );
      await settleAckBarrier();
      (secondProducer as unknown as LocalSubscriptionProducer<TimelineRow>).next(timelineRow);
      await settleAckBarrier();
      expect(sentFrames).toHaveLength(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("subscribing without a transport identity is refused", async () => {
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive } = buildStreamingPrimitive();
    const attachProjection = vi.fn();
    registerTimelineSubscription(registry, { streamingPrimitive, attachProjection });

    // `dispatch` does not wrap a handler throw — the gateway's `mapJsonRpcError`
    // does, one layer up — so the raw error is what reaches this assertion.
    await expect(
      registry.dispatch(TIMELINE_SUBSCRIBE_METHOD, { sessionId: SESSION_ID }, {}),
    ).rejects.toThrow(/transport identity/);
    // Per-connection state was never allocated, so the projection was never
    // wired to a producer that would outlive the refusal.
    expect(attachProjection).not.toHaveBeenCalled();
  });

  it("a projection that throws leaves no subscription behind", async () => {
    const registry = new MethodRegistryImpl();
    const { streamingPrimitive, sentFrames } = buildStreamingPrimitive();
    let capturedProducer: LocalSubscriptionProducer<TimelineRow> | null = null;
    registerTimelineSubscription(registry, {
      streamingPrimitive,
      attachProjection: (_request, producer) => {
        capturedProducer = producer;
        throw new Error("session not found");
      },
    });

    // The projection's own error propagates unchanged, so a Phase-2 refusal
    // reaches `mapJsonRpcError` with its own identity rather than flattened
    // into a binder-invented one.
    await expect(
      registry.dispatch(TIMELINE_SUBSCRIBE_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).rejects.toThrow("session not found");

    // The allocated entry was drained: `next` on a cancelled producer is a
    // documented silent no-op, so nothing reaches the transport afterwards.
    const producer = capturedProducer as unknown as LocalSubscriptionProducer<TimelineRow>;
    producer.next(timelineRow);
    expect(sentFrames).toHaveLength(0);
  });
});
