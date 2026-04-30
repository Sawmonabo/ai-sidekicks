// Plan-008 §Phase 1 §T-008b-1-T7 + §T-008b-1-T8: SSE wire contracts for the
// `session.subscribe` procedure, verified end-to-end via `fetchRequestHandler`
// (the same call path Cloudflare Workers invoke at runtime per BL-104 / ADR-014).
//
// Why fetchRequestHandler and NOT `t.createCallerFactory`:
//   * The in-process caller bypasses tRPC's HTTP substrate, including the
//     `Last-Event-ID` → `lastEventId` injection at
//     `@trpc/server` v11 unstable-core-do-not-import/http/contentType.ts
//     lines 151-168. T8's resumption contract IS that injection, so the
//     in-process caller would never exercise the code path under test.
//   * Same applies to T7: the SSE producer (`sseStreamProducer`) only
//     materializes through the HTTP resolver path. The in-process caller
//     returns the raw AsyncIterable verbatim, with no SSE framing.
//
// Provider trust model: only `eventStreamProvider` is reachable from the
// `session.subscribe` factory body. We spread `makeRefusalAssertingDeps()`
// (every other dep throws) and override only `eventStreamProvider`, so any
// regression that introduces a new dep call from the SSE path crashes with
// a clear diagnostic.
//
// Synchronization: async generators are lazy — the provider's body runs only
// when the producer pulls from it, AFTER the producer's `connected` frame is
// drained. To get a deterministic "the provider ran" signal, the recording
// provider yields one MARKER tracked envelope as its first action. Reading
// the connected frame + the marker frame guarantees the provider's first
// lines (recording the call params) have already executed.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T7,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T8,
//       docs/plans/008-control-plane-relay-and-session-join.md §I-008-1.

import {
  type EventCursor,
  type EventEnvelopeVersion,
  type SessionEvent,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { tracked } from "@trpc/server";
import { describe, expect, it } from "vitest";

import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../../server/host.js";
import { makeRefusalAssertingDeps } from "../../server/__tests__/_helpers.js";
import type { SessionEventStreamProvider } from "../session-subscribe-sse.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d100" as SessionId;
const CURSOR_HEADER: EventCursor = "cursor-from-header" as EventCursor;
const CURSOR_BODY: EventCursor = "cursor-from-body" as EventCursor;
const MARKER_CURSOR: EventCursor = "marker-sync-cursor" as EventCursor;

// A schema-valid SessionCreated event for the marker tracked envelope.
// Real-shaped (not synthetic `{}`) so a future tightening that adds output
// validation upstream still passes; literal values keep the SSE frame's
// `data` field byte-deterministic for assertions.
function makeSessionCreatedEvent(): SessionEvent {
  return {
    type: "session.created",
    category: "session_lifecycle",
    id: "evt-marker-1",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-04-30T12:00:00.000Z",
    actor: null,
    version: "1.0" as EventEnvelopeVersion,
    payload: {
      sessionId: SESSION_ID,
      config: { topic: "wire-test" },
      metadata: {},
    },
  };
}

// Build a GET `/trpc/session.subscribe` request. tRPC v11's GET-input format
// is `?input=<JSON.stringify(input)>` URL-encoded — confirmed in
// @trpc/server v11 contentType.ts lines 100-106. No content-type header is
// required: GET falls through to the JSON handler at contentType.ts:302-305.
function buildSubscribeRequest(opts: {
  readonly sessionId: SessionId;
  readonly afterCursor?: EventCursor;
  readonly lastEventIdHeader?: string;
  readonly signal?: AbortSignal;
}): Request {
  const inputBody: Record<string, string> = { sessionId: opts.sessionId };
  if (opts.afterCursor !== undefined) inputBody["afterCursor"] = opts.afterCursor;
  const url = `https://control-plane.test/trpc/session.subscribe?input=${encodeURIComponent(
    JSON.stringify(inputBody),
  )}`;
  const headers = new Headers();
  if (opts.lastEventIdHeader !== undefined) {
    headers.set("Last-Event-ID", opts.lastEventIdHeader);
  }
  // Conditional spread keeps `signal` off the init object when undefined —
  // RequestInit.signal is `AbortSignal | null` (no `undefined`) under
  // exactOptionalPropertyTypes.
  const init: RequestInit = {
    method: "GET",
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  return new Request(url, init);
}

// SSE frames are delimited by `\n\n` per the WHATWG event-stream grammar.
// Each frame is a series of `field: value\n` lines (or `: comment\n`). We
// accumulate decoded chunks from the streaming Response body, split on the
// frame delimiter, and parse each frame into its named fields. Returning
// frames as objects (rather than re-yielding raw text) lets the caller
// assert on `event` / `data` / `id` directly — matching the shape
// `sseStreamProducer` writes (sse.ts lines 178-198).
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
    // Per SSE spec, a single space after the colon is stripped.
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (key === "event") fields.event = value;
    else if (key === "data") fields.data = value;
    else if (key === "id") fields.id = value;
  }
  return fields;
}

async function readSseFrames(response: Response, count: number): Promise<readonly SseFrame[]> {
  if (response.body === null) throw new Error("response.body is null");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx !== -1 && frames.length < count) {
        const frameText = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        frames.push(parseSseFrame(frameText));
        sepIdx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Releasing AND cancelling — releaseLock alone leaves the underlying
    // stream in pull-pending state. cancel() propagates closure to the
    // producer side so abort hooks fire.
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

interface RecordedCall {
  sessionId: SessionId | undefined;
  afterCursor: EventCursor | undefined;
  signal: AbortSignal | undefined;
}

// Recording provider — captures the call params on its first activation,
// then yields ONE marker envelope to give the test a deterministic
// "provider has run" wire signal. After yielding, suspends until the
// AbortSignal fires so the procedure body doesn't exit prematurely while
// the test is still asserting.
function makeRecordingProvider(): {
  provider: SessionEventStreamProvider;
  recorded: RecordedCall;
} {
  const recorded: RecordedCall = {
    sessionId: undefined,
    afterCursor: undefined,
    signal: undefined,
  };
  const provider: SessionEventStreamProvider = async function* (params) {
    recorded.sessionId = params.sessionId;
    recorded.afterCursor = params.afterCursor;
    recorded.signal = params.signal;
    yield tracked(MARKER_CURSOR, makeSessionCreatedEvent());
    if (params.signal.aborted) return;
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return { provider, recorded };
}

// ---------------------------------------------------------------------------
// T-008b-1-T7: SSE connection lifecycle
// ---------------------------------------------------------------------------

describe("T7 / I-008-3 #1 + §T-008b-1-T7: SSE connection lifecycle", () => {
  it("returns text/event-stream with connected + tracked frames carrying id+data", async () => {
    const { provider, recorded } = makeRecordingProvider();
    const handler = buildControlPlaneFetchHandler({
      ...makeRefusalAssertingDeps(),
      eventStreamProvider: provider,
    });

    const response = await handler(buildSubscribeRequest({ sessionId: SESSION_ID }), PASSING_ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const [connectedFrame, markerFrame] = await readSseFrames(response, 2);

    // tRPC's sseStreamProducer always yields a `connected` event first
    // (sse.ts:107-110). Its data is JSON.stringify(clientOpts); we don't
    // pass any so it's the empty object literal.
    expect(connectedFrame?.event).toBe("connected");
    expect(connectedFrame?.data).toBe("{}");

    // Tracked envelope → frame with `id: <cursor>` + `data: <serialized event>`
    // (sse.ts:138-144). The id IS the EventCursor we passed to `tracked()`.
    expect(markerFrame?.id).toBe(MARKER_CURSOR);
    expect(markerFrame?.data).toBeDefined();
    const decodedEvent = JSON.parse(markerFrame!.data!) as SessionEvent;
    expect(decodedEvent.type).toBe("session.created");
    expect(decodedEvent.id).toBe("evt-marker-1");

    // Provider was reached with the canonical params — the directoryService
    // and other deps were never touched (the refusal-asserting fixture would
    // have thrown if they were).
    expect(recorded.sessionId).toBe(SESSION_ID);
  });

  it("propagates request abort to the provider's signal", async () => {
    const { provider, recorded } = makeRecordingProvider();
    const handler = buildControlPlaneFetchHandler({
      ...makeRefusalAssertingDeps(),
      eventStreamProvider: provider,
    });

    const ctrl = new AbortController();
    const response = await handler(
      buildSubscribeRequest({ sessionId: SESSION_ID, signal: ctrl.signal }),
      PASSING_ENV,
    );

    // Read connected + marker so the provider has captured the signal.
    await readSseFrames(response, 2);
    expect(recorded.signal).toBeDefined();
    expect(recorded.signal!.aborted).toBe(false);

    ctrl.abort();
    // `signal.aborted` flips synchronously in `AbortController.abort()`; we
    // don't need to flush microtasks for the assertion below. The provider's
    // `addEventListener("abort", ...)` callback to resume its await-promise
    // is what fires asynchronously — but that's the cleanup-path concern
    // covered indirectly by the absence of test timeout.
    expect(recorded.signal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-008b-1-T8: Last-Event-ID resumption + body-cursor precedence
// ---------------------------------------------------------------------------

interface CursorRow {
  readonly label: string;
  readonly afterCursorBody?: EventCursor;
  readonly lastEventIdHeader?: string;
  readonly expected: EventCursor | undefined;
}

// The 5 rows discriminate the substrate's three injection sources:
//   * `Last-Event-ID` header (tRPC v11 contentType.ts:153 — first lookup)
//   * `?lastEventId` query param (lookup #2)
//   * `?Last-Event-Id` query param (lookup #3)
// Combined with body `afterCursor`, plus the truthiness gate at line 157
// (`if (lastEventId)` — empty string skips). We test the header path
// (most operationally relevant — that's what EventSource sets natively)
// + the precedence rule + the truthiness skip. The two query-param paths
// are documented in the comment above but aren't separately rowed because
// they share the same injection branch as the header.
const CURSOR_ROWS: readonly CursorRow[] = [
  {
    label: "no header, no body cursor → undefined",
    expected: undefined,
  },
  {
    label: "Last-Event-ID header alone → header value",
    lastEventIdHeader: CURSOR_HEADER,
    expected: CURSOR_HEADER,
  },
  {
    label: "body afterCursor alone → body value",
    afterCursorBody: CURSOR_BODY,
    expected: CURSOR_BODY,
  },
  {
    label: "header AND body → header wins (precedence rule)",
    afterCursorBody: CURSOR_BODY,
    lastEventIdHeader: CURSOR_HEADER,
    expected: CURSOR_HEADER,
  },
  {
    label: "empty Last-Event-ID header → truthiness gate skips → falls back to body",
    afterCursorBody: CURSOR_BODY,
    lastEventIdHeader: "",
    expected: CURSOR_BODY,
  },
];

describe("T8 / §T-008b-1-T8: Last-Event-ID cursor resumption resolves to provider.afterCursor", () => {
  for (const row of CURSOR_ROWS) {
    it(row.label, async () => {
      const { provider, recorded } = makeRecordingProvider();
      const handler = buildControlPlaneFetchHandler({
        ...makeRefusalAssertingDeps(),
        eventStreamProvider: provider,
      });

      const ctrl = new AbortController();
      // Conditional spread — exactOptionalPropertyTypes forbids passing
      // `undefined` for properties typed with `?:`. Each row may omit
      // `afterCursorBody` or `lastEventIdHeader`; honor optionality literally.
      const response = await handler(
        buildSubscribeRequest({
          sessionId: SESSION_ID,
          ...(row.afterCursorBody !== undefined ? { afterCursor: row.afterCursorBody } : {}),
          ...(row.lastEventIdHeader !== undefined
            ? { lastEventIdHeader: row.lastEventIdHeader }
            : {}),
          signal: ctrl.signal,
        }),
        PASSING_ENV,
      );

      // Drain connected + marker. By the time the marker frame is read, the
      // provider has executed line 1 (recording the resolved cursor).
      await readSseFrames(response, 2);

      expect(recorded.afterCursor).toBe(row.expected);

      // Tear down so the test doesn't hang on the provider's abort-await.
      ctrl.abort();
    });
  }
});
