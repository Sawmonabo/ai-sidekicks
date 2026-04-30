// Plan-008 §Phase 1 §T-008b-1-T12: client-sdk SSE round-trip integration test.
//
// Per plan body line 248, this is the "highest-value Phase 1 test" — it
// proves the F-008b-1-09 unblock contract: that Plan-001 Phase 5's
// `sessionClient.subscribe` can consume the Phase 1 control-plane SSE
// substrate without modification. The test stubs that future production
// surface (Plan-001 Phase 5 owns the `sessionClient` shipping form) and
// round-trips it against an in-process `buildControlPlaneFetchHandler`
// instance.
//
// **BLOCKED-ON-C6 posture (per plan body §T-008b-1-5 line 222):** the SSE
// wire-frame primitive (Content-Type, `data:` encoding, `id:`/`retry:`/
// `Last-Event-ID` semantics, heartbeat cadence, end-of-stream marker)
// awaits ratification in api-payload-contracts.md §Plan-008. Until then,
// this test asserts on the conservative inline shape from T-008b-1-3 +
// the tRPC v11.17.0 `sseStreamProducer` surface citations below. When C-6
// resolves and ratifies a different shape, three assertion classes update
// jointly: the four named-event branches in `sessionClientSubscribeStub`
// (connected/ping/return/serialized-error), the tracked-envelope frame
// shape (`{id, data}` / no `event:` field), and the per-event
// `event.id` round-trip spot-checks. The schema-validate-at-consumer
// posture (`SessionEventSchema.parse`) is load-bearing regardless of
// frame shape and stays as-is.
//
// The round-trip exercise:
//
//   1. Cold subscribe — issue GET `/trpc/session.subscribe` with NO
//      `Last-Event-ID` header. The fetch-adapter substrate skips its header
//      injection (the truthiness gate at @trpc/server v11
//      `unstable-core-do-not-import/http/contentType.ts:151-168` short-
//      circuits when no header is present). The factory's resolution
//      `input.lastEventId ?? input.afterCursor` is `undefined ?? undefined
//      = undefined`. The provider records `afterCursor === undefined` and
//      yields all 3 scripted events; the consumer receives them with their
//      cursors.
//
//   2. Resume subscribe — issue GET with `Last-Event-ID: <CURSOR_002>`.
//      The fetch-adapter substrate injects the header value into
//      `input.lastEventId` PRE-Zod-validation; the factory resolves
//      `input.lastEventId ?? input.afterCursor = CURSOR_002` and feeds it
//      to the provider's `afterCursor` slot. The provider records the
//      injected value and yields ONLY the events strictly after that
//      cursor; the consumer receives event[2] (a single tracked envelope)
//      and end-of-stream.
//
// What the assertions pin (and why):
//   * `recorded.afterCursor` — the wire-substrate's cursor injection AT
//     the seam between the HTTP/SSE transport and the abstract provider
//     contract. This is the integration boundary CP-008-1 is about.
//   * `events.map(eventId)` — the consumer-side cursor surface that
//     Plan-001 Phase 5's sessionClient will expose to its callers, used
//     for client-cached resumption on reconnect.
//   * Per-event `event.id` payload field — wire-format integrity through
//     the SSE producer's JSON.stringify + the consumer's JSON.parse +
//     `SessionEventSchema.parse`. Without this we'd have only structural
//     proof, not value-level proof.
//
// Posture choices documented for review-time:
//
//   * Path: `test/transport/...` (NOT `src/transport/__tests__/...`) per
//     plan body §T-008b-1-5 line 222. The deviation from the package's
//     `src/__tests__/` discovery glob is deliberate — it signals
//     "integration test crossing a workspace boundary" — distinct from
//     in-package unit tests under `src/transport/__tests__/`. The
//     vitest.config.ts and tsconfig.test.json have been extended to
//     discover this root.
//
//   * Cross-workspace dep: this file imports from
//     `@ai-sidekicks/control-plane`, declared as a workspace TEST-only
//     devDep in client-sdk's package.json. The package's
//     `files: ["dist"]` excludes this dep from the published surface;
//     it never ships, only exists for the integration harness.
//
//   * Stub-in-test: `sessionClient.subscribe` does NOT exist in
//     `client-sdk/src/**` yet — Plan-001 Phase 5 owns that production
//     surface. The function `sessionClientSubscribeStub` defined below
//     is a TEST DOUBLE for that surface; its shape
//     (`AsyncIterable<{eventId, event}>`) matches the documented Phase 5
//     contract; its body uses raw `fetch` + an SSE frame parser +
//     `SessionEventSchema.parse` so the test depends ONLY on contracts
//     schemas + the wire substrate. No HTTP/SSE consumer primitive is
//     added to `client-sdk/src/` as part of T12 — that's Phase 5's
//     scope. If/when Phase 5 lands a production primitive, it will
//     implement this same shape and pass this test without modification.
//     That round-trip-stability guarantee IS the F-008b-1-09 unblock
//     contract this test verifies.
//
//   * Refusal-asserting deps factory inlined here: `session.subscribe`
//     does NOT exercise the directoryService / participant / id-generator
//     / identity-resolver paths — those are the CRUD trio's domain.
//     Every non-subscribe field below throws so any future regression
//     (e.g., a refactor that wires those callbacks into the subscribe
//     path) surfaces as a loud test failure. Mirrors
//     `makeRefusalAssertingDeps` in control-plane's internal test
//     fixtures (`server/__tests__/_helpers.ts`) without taking a
//     coupling on the internal `__tests__/` path from a sibling
//     workspace.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-5,
//       §T-008b-1-T12, §F-008b-1-09, §CP-008-1, §I-008-3 #1.

import {
  type EventCursor,
  type EventEnvelopeVersion,
  type SessionEvent,
  SessionEventSchema,
  type SessionId,
} from "@ai-sidekicks/contracts";
import {
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type Querier,
  SessionDirectoryService,
  type SessionEventStreamProvider,
} from "@ai-sidekicks/control-plane";
import { tracked } from "@trpc/server";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d200" as SessionId;

const CURSOR_001: EventCursor = "evt-001-cursor" as EventCursor;
const CURSOR_002: EventCursor = "evt-002-cursor" as EventCursor;
const CURSOR_003: EventCursor = "evt-003-cursor" as EventCursor;

interface ScriptedRow {
  readonly cursor: EventCursor;
  readonly event: SessionEvent;
}

// `makeSessionCreatedEvent`: build a schema-valid `SessionCreated` event for
// each scripted row. Real-shaped (not synthetic `{}`) so the consumer-side
// `SessionEventSchema.parse` exercises real value-level validation; literal
// values keep the SSE frame's `data` field byte-deterministic for
// assertions. Mirrors the fixture in
// `control-plane/.../session-subscribe-sse.test.ts:66-82`, kept independent
// so the cross-workspace test doesn't take a coupling on the internal
// `__tests__/` directory.
function makeSessionCreatedEvent(id: string, sequence: number): SessionEvent {
  return {
    type: "session.created",
    category: "session_lifecycle",
    id,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-30T12:00:00.000Z",
    actor: null,
    version: "1.0" as EventEnvelopeVersion,
    payload: {
      sessionId: SESSION_ID,
      config: { topic: `wire-test-${id}` },
      metadata: {},
    },
  };
}

const SCRIPTED_EVENTS: readonly ScriptedRow[] = [
  { cursor: CURSOR_001, event: makeSessionCreatedEvent("evt-001", 0) },
  { cursor: CURSOR_002, event: makeSessionCreatedEvent("evt-002", 1) },
  { cursor: CURSOR_003, event: makeSessionCreatedEvent("evt-003", 2) },
];

// ---------------------------------------------------------------------------
// Test deps factory: subscribe-only, refusal-asserting elsewhere
// ---------------------------------------------------------------------------

const NEVER_REACHED = (symbol: string): Error =>
  new Error(
    `T12 integration: ${symbol} reached during a session.subscribe round-trip. ` +
      "The subscribe path must not consume CRUD-side dependencies (per CP-008-1).",
  );

const throwingQuerier: Querier = {
  query: () => {
    throw NEVER_REACHED("Querier.query");
  },
  exec: () => {
    throw NEVER_REACHED("Querier.exec");
  },
  transaction: () => {
    throw NEVER_REACHED("Querier.transaction");
  },
};

function makeIntegrationDeps(provider: SessionEventStreamProvider): ControlPlaneDeps {
  return {
    directoryService: new SessionDirectoryService(throwingQuerier),
    resolveCurrentParticipantId: () => {
      throw NEVER_REACHED("resolveCurrentParticipantId");
    },
    generateSessionId: () => {
      throw NEVER_REACHED("generateSessionId");
    },
    resolveIdentityHandle: () => {
      throw NEVER_REACHED("resolveIdentityHandle");
    },
    eventStreamProvider: provider,
  };
}

// ---------------------------------------------------------------------------
// Recording, script-driven event-stream provider
// ---------------------------------------------------------------------------

interface RecordedCall {
  afterCursor: EventCursor | undefined;
  callCount: number;
}

function makeRecordingProvider(): {
  provider: SessionEventStreamProvider;
  recorded: RecordedCall;
} {
  const recorded: RecordedCall = { afterCursor: undefined, callCount: 0 };
  const provider: SessionEventStreamProvider = async function* (params) {
    recorded.callCount += 1;
    recorded.afterCursor = params.afterCursor;
    let startIdx = 0;
    if (params.afterCursor !== undefined) {
      const matchedIdx = SCRIPTED_EVENTS.findIndex((r) => r.cursor === params.afterCursor);
      // findIndex returns -1 if no row matches; in that case startIdx stays 0
      // (yield from the top). The assertion side guards via
      // `recorded.afterCursor` so an unexpected cursor surfaces directly.
      startIdx = matchedIdx === -1 ? 0 : matchedIdx + 1;
    }
    for (let i = startIdx; i < SCRIPTED_EVENTS.length; i++) {
      if (params.signal.aborted) return;
      const row = SCRIPTED_EVENTS[i]!;
      yield tracked(row.cursor, row.event);
    }
    // Provider returns once the script is exhausted; tRPC's sseStreamProducer
    // closes the response stream as soon as the source iterable completes.
    // The consumer's reader will see `done: true` and exit its loop — that
    // natural end-of-stream signal IS the test's pacing mechanism.
  };
  return { provider, recorded };
}

// ---------------------------------------------------------------------------
// In-test stub: `sessionClient.subscribe`
// ---------------------------------------------------------------------------

interface SubscribeOpts {
  readonly sessionId: SessionId;
  readonly lastEventId?: EventCursor;
  readonly signal?: AbortSignal;
}

interface SubscribedEvent {
  readonly eventId: EventCursor;
  readonly event: SessionEvent;
}

interface SseFrame {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
}

function parseSseFrame(frameText: string): SseFrame {
  const fields: { event?: string; data?: string; id?: string } = {};
  for (const line of frameText.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx);
    // SSE spec: a single space immediately after the colon is stripped.
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (key === "event") fields.event = value;
    else if (key === "data") fields.data = value;
    else if (key === "id") fields.id = value;
  }
  return fields;
}

async function* sessionClientSubscribeStub(
  fetcher: (req: Request) => Promise<Response>,
  opts: SubscribeOpts,
): AsyncIterable<SubscribedEvent> {
  const url = `https://control-plane.test/trpc/session.subscribe?input=${encodeURIComponent(
    JSON.stringify({ sessionId: opts.sessionId }),
  )}`;
  const headers = new Headers();
  if (opts.lastEventId !== undefined) {
    headers.set("Last-Event-ID", opts.lastEventId);
  }
  // RequestInit.signal is `AbortSignal | null` (no `undefined`) under
  // exactOptionalPropertyTypes — conditional spread keeps it off the init
  // object when the caller didn't supply one.
  const init: RequestInit = {
    method: "GET",
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const response = await fetcher(new Request(url, init));
  if (response.status !== 200) {
    throw new Error(
      `subscribe stub: unexpected HTTP status ${String(response.status)} (expected 200)`,
    );
  }
  if (response.body === null) {
    throw new Error("subscribe stub: response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx !== -1) {
        const frameText = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const frame = parseSseFrame(frameText);
        sepIdx = buffer.indexOf("\n\n");

        // tRPC v11.17.0 `sseStreamProducer` emits four named sentinels —
        // citations point at the `unstable-core-do-not-import/stream/sse.ts`
        // source so a future tRPC patch that renames a sentinel surfaces
        // here as a citation mismatch (the same hygiene posture T7's
        // heartbeat test takes for `PING_SYM` / `PING_EVENT`):
        //   - sse.ts:72  `const CONNECTED_EVENT = 'connected'`
        //   - sse.ts:70  `const PING_EVENT = 'ping'`
        //   - sse.ts:73  `const RETURN_EVENT = 'return'`
        //   - sse.ts:71  `const SERIALIZED_ERROR_EVENT = 'serialized-error'`
        //
        // First-frame contract: `connected` always lands first
        // (sse.ts:107-110, the unconditional yield at the top of
        // `generator()` before the source iterable's loop). Skip.
        if (frame.event === "connected") continue;
        // Heartbeat ping frames carry empty data
        // (sse.ts:133-135 — `if (value === PING_SYM) yield {event: PING_EVENT, data: ''}`).
        // The plan-default config disables ping (this provider supplies no
        // `ping` opts) so this branch is defensive against a future
        // ping-on default; skip.
        if (frame.event === "ping") continue;
        // `event: return` is the producer's graceful end-of-stream marker
        // (sse.ts:152-159: `generatorWithErrorHandling()` emits
        // `{event: RETURN_EVENT, data: ''}` immediately after
        // `yield* generator()` completes successfully — vs the
        // `serialized-error` branch for a thrown completion at
        // sse.ts:160-173). The next `reader.read()` will see `done: true`;
        // skip the frame and let the outer loop drain naturally on close.
        if (frame.event === "return") continue;
        // `serialized-error` indicates a producer-side throw
        // (sse.ts:167-172 — `getTRPCErrorFromUnknown(cause)` then
        // `yield {event: SERIALIZED_ERROR_EVENT, data: <serialized>}`).
        // Surface loudly so the test (and a future production consumer)
        // doesn't silently consume a malformed stream.
        if (frame.event === "serialized-error") {
          throw new Error(
            `subscribe stub: producer surfaced serialized-error frame: ${frame.data ?? "<no data>"}`,
          );
        }
        // Any other named event shouldn't occur at the wire level for
        // tracked envelopes (which are the un-named-event default at
        // sse.ts:138-144) — surface rather than silently discard.
        if (frame.event !== undefined) {
          throw new Error(`subscribe stub: unexpected SSE event '${frame.event}'`);
        }
        // tRPC's tracked-envelope frame: NO `event:` field, with `id:` +
        // `data:` (sse.ts:138-144 — `isTrackedEnvelope(value) ?
        // {id: value[0], data: value[1]} : {data: value}`). The `id` IS the
        // EventCursor; `data` is the JSON-serialized SessionEvent.
        if (frame.id === undefined || frame.data === undefined) {
          throw new Error("subscribe stub: tracked frame missing id or data field");
        }
        // Schema-validate at the consumer boundary. If the producer ever
        // emits a malformed SessionEvent, this throws ZodError and
        // propagates out of the async generator — fail-fast on wire
        // corruption, the same posture sessionClient.subscribe will take in
        // production.
        const validated = SessionEventSchema.parse(JSON.parse(frame.data));
        yield {
          eventId: frame.id as EventCursor,
          event: validated,
        };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// T-008b-1-T12: SSE round-trip integration
// ---------------------------------------------------------------------------

describe("T12 / §T-008b-1-T12 / F-008b-1-09: SSE round-trip — sessionClient.subscribe stub against in-process control-plane handler", () => {
  it("cold subscribe (no Last-Event-ID): provider sees afterCursor=undefined; consumer receives all 3 scripted events with cursors", async () => {
    const { provider, recorded } = makeRecordingProvider();
    const handler = buildControlPlaneFetchHandler(makeIntegrationDeps(provider));
    const fetcher = (req: Request): Promise<Response> => handler(req, PASSING_ENV);

    const events = await drain(sessionClientSubscribeStub(fetcher, { sessionId: SESSION_ID }));

    expect(recorded.callCount).toBe(1);
    expect(recorded.afterCursor).toBeUndefined();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.eventId)).toEqual([CURSOR_001, CURSOR_002, CURSOR_003]);
    // Spot-check that each event's id payload field round-tripped through the
    // SSE wire (JSON.stringify on the producer side + JSON.parse +
    // SessionEventSchema.parse on the consumer side) intact.
    expect(events[0]?.event.id).toBe("evt-001");
    expect(events[1]?.event.id).toBe("evt-002");
    expect(events[2]?.event.id).toBe("evt-003");
  });

  it("resume subscribe (Last-Event-ID: cursor[1]): provider sees afterCursor=cursor[1]; consumer receives ONLY events after that cursor", async () => {
    const { provider, recorded } = makeRecordingProvider();
    const handler = buildControlPlaneFetchHandler(makeIntegrationDeps(provider));
    const fetcher = (req: Request): Promise<Response> => handler(req, PASSING_ENV);

    const events = await drain(
      sessionClientSubscribeStub(fetcher, {
        sessionId: SESSION_ID,
        lastEventId: CURSOR_002,
      }),
    );

    // The wire-substrate injection chain proved end-to-end here:
    //   client sets `Last-Event-ID: <CURSOR_002>` HTTP header
    //   → tRPC fetch-adapter (contentType.ts:151-168) reads header pre-Zod
    //   → injects into `input.lastEventId`
    //   → factory resolves `input.lastEventId ?? input.afterCursor` = CURSOR_002
    //   → provider's `params.afterCursor` = CURSOR_002.
    expect(recorded.callCount).toBe(1);
    expect(recorded.afterCursor).toBe(CURSOR_002);

    // Consumer-side: ONLY the post-CURSOR_002 event is yielded (the script's
    // index-after-match slice, scripted-events[2] = {CURSOR_003, evt-003}).
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe(CURSOR_003);
    expect(events[0]?.event.id).toBe("evt-003");
  });
});
