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
  ReasoningSurfaceReadResponse,
  RunId,
  SessionId,
  SubscriptionId,
  TimelineReadRequest,
  TimelineReadResponse,
  TimelineSubscribeResponse,
} from "@ai-sidekicks/contracts";
import {
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_NAMES,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_SUBSCRIBE_METHOD,
} from "@ai-sidekicks/contracts";

import { registerTimelineMethod } from "../handlers/timeline-methods.js";
import {
  isCanonicalMethodName,
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";

const dispatchContext: HandlerContext = {};

const SESSION_ID: SessionId = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f" as SessionId;
const RUN_ID: RunId = "11111111-2222-4333-8444-555555555555" as RunId;
const PARENT_RUN_ID: RunId = "33333333-4444-4555-8666-777777777777" as RunId;
const SUBSCRIPTION_ID: SubscriptionId = "55555555-6666-4777-8888-999999999999" as SubscriptionId;

const readResponse: TimelineReadResponse = { entries: [], hasMore: false };
const subscribeResponse: TimelineSubscribeResponse = { subscriptionId: SUBSCRIPTION_ID };
const reasoningResponse: ReasoningSurfaceReadResponse = { availability: "unavailable" };
const childRunExpandResponse: ChildRunExpandResponse = {
  runId: RUN_ID,
  parentRunId: PARENT_RUN_ID,
  state: "completed",
  entries: [],
};

/**
 * Bind all four methods with handlers that resolve a valid response for their
 * own operation. Deliberately NOT a production binder — the production
 * handlers arrive with the Phase-2/Phase-3 services; these exist so the
 * registration and dispatch paths can be exercised end to end.
 */
const registerAllTimelineMethods = (registry: MethodRegistryImpl): void => {
  registerTimelineMethod(
    registry,
    TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD],
    async () => readResponse,
  );
  registerTimelineMethod(
    registry,
    TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD],
    async () => subscribeResponse,
  );
  registerTimelineMethod(
    registry,
    TIMELINE_METHOD_DESCRIPTORS[TIMELINE_REASONING_SURFACE_READ_METHOD],
    async () => reasoningResponse,
  );
  registerTimelineMethod(
    registry,
    TIMELINE_METHOD_DESCRIPTORS[TIMELINE_CHILD_RUN_EXPAND_METHOD],
    async () => childRunExpandResponse,
  );
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
    registerTimelineMethod(
      registry,
      TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD],
      async () => readResponse,
    );
    expect(() => {
      registerTimelineMethod(
        registry,
        TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD],
        async () => readResponse,
      );
    }).toThrow(RegistryRegistrationError);
  });

  it("I-007-7 — the descriptor's request schema gates dispatch, handler never runs", async () => {
    const registry = new MethodRegistryImpl();
    const handler = vi.fn<Handler<TimelineReadRequest, TimelineReadResponse>>(
      async () => readResponse,
    );
    registerTimelineMethod(registry, TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD], handler);

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

    await expect(
      registry.dispatch(TIMELINE_SUBSCRIBE_METHOD, { sessionId: SESSION_ID }, dispatchContext),
    ).resolves.toStrictEqual(subscribeResponse);

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
    registerTimelineMethod(
      registry,
      TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD],
      // The cast is the point: it stands in for a handler wired to the wrong
      // operation. Without it the mistake is a compile error — which is the
      // binder's first line of defence — so the runtime backstop can only be
      // exercised by defeating the type check deliberately.
      (async () => reasoningResponse) as unknown as Handler<
        TimelineReadRequest,
        TimelineReadResponse
      >,
    );
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
});
