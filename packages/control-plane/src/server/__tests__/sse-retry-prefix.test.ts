// Plan-008 §Phase 1: SSE `retry:` field wire-frame contract.
//
// Asserts the wire frame ratified at
// docs/architecture/contracts/api-payload-contracts.md §SSE Wire Frame
// (Tier 1 Ratified, line 295): `retry: 5000` MUST appear before any
// `event: connected` / `data:` / `id:` line so reconnecting EventSource
// clients honor the documented 5-second backoff. tRPC v11's
// `sseStreamProducer` does not emit `retry:` natively — the substrate at
// `sse-retry-prefix.ts` injects it via TransformStream.
//
// Refs: docs/architecture/contracts/api-payload-contracts.md §SSE Wire Frame,
//       docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       packages/control-plane/src/server/sse-retry-prefix.ts.

import {
  type EventCursor,
  type EventEnvelopeVersion,
  type SessionEvent,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { tracked } from "@trpc/server";
import { describe, expect, it } from "vitest";

import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../host.js";
import {
  SSE_RETRY_HINT_MS,
  type SessionEventStreamProvider,
} from "../../sessions/session-subscribe-sse.js";
import { prefixSseRetry } from "../sse-retry-prefix.js";
import { makeRefusalAssertingDeps } from "./_helpers.js";

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d200" as SessionId;
const MARKER_CURSOR: EventCursor = "marker-retry" as EventCursor;

function makeSessionCreatedEvent(): SessionEvent {
  return {
    type: "session.created",
    category: "session_lifecycle",
    id: "evt-retry-marker",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-04-30T12:00:00.000Z",
    actor: null,
    version: "1.0" as EventEnvelopeVersion,
    payload: {
      sessionId: SESSION_ID,
      config: { topic: "retry-prefix-test" },
      metadata: {},
    },
  };
}

function buildSubscribeRequest(): Request {
  const input = JSON.stringify({ sessionId: SESSION_ID });
  return new Request(
    `https://control-plane.test/trpc/session.subscribe?input=${encodeURIComponent(input)}`,
    { method: "GET" },
  );
}

// One-shot provider: yields a single tracked envelope, then suspends until
// the AbortSignal fires so the response stream remains open while we read
// the leading bytes.
function makeOneShotProvider(): SessionEventStreamProvider {
  return async function* (params) {
    yield tracked(MARKER_CURSOR, makeSessionCreatedEvent());
    if (params.signal.aborted) return;
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

// Read the first N bytes of the response body as decoded text, then cancel.
// We intentionally read a small slice — enough to capture the `retry:` field
// + tRPC's first `connected` frame, but small enough to not block on the
// suspended provider after the marker frame.
async function readLeadingBytes(response: Response, byteLimit: number): Promise<string> {
  if (response.body === null) throw new Error("response.body is null");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  try {
    while (accumulated.length < byteLimit) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return accumulated;
}

describe("§SSE Wire Frame line 295: retry hint precedes the first event", () => {
  it("emits `retry: <SSE_RETRY_HINT_MS>` before the connected frame", async () => {
    const handler = buildControlPlaneFetchHandler({
      ...makeRefusalAssertingDeps(),
      eventStreamProvider: makeOneShotProvider(),
    });

    const response = await handler(buildSubscribeRequest(), PASSING_ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const leading = await readLeadingBytes(response, 256);
    const retryLine = `retry: ${SSE_RETRY_HINT_MS}\n`;
    expect(leading.startsWith(retryLine)).toBe(true);

    // The retry line MUST appear before the first `event:` field — the
    // EventSource parses fields in order until the next `\n\n` boundary,
    // so a retry-after-event line would never apply to the first frame's
    // reconnection scheduling.
    const retryIdx = leading.indexOf("retry:");
    const eventIdx = leading.indexOf("event:");
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeGreaterThan(retryIdx);
  });
});

describe("§SSE Wire Frame: non-SSE responses pass through unmodified", () => {
  it("does not inject `retry:` into a 503 gate-refusal body", async () => {
    const handler = buildControlPlaneFetchHandler({
      ...makeRefusalAssertingDeps(),
      eventStreamProvider: makeOneShotProvider(),
    });

    const refusalEnv: ControlPlaneEnv = {
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "0",
      ENVIRONMENT: "development",
    };
    const response = await handler(buildSubscribeRequest(), refusalEnv);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await response.text();
    expect(body).not.toContain("retry:");
  });
});

// ---------------------------------------------------------------------------
// prefixSseRetry unit tests
//
// The integration tests above verify the wiring; these unit tests verify
// the wrapper's structural invariants directly against synthetic streams.
// We exercise the multi-chunk path (`enqueue` called many times) to lock
// in the no-duplicate guarantee — `retry:` MUST originate solely from the
// wrapper's `start()` callback, not be re-emitted on each `transform()`
// invocation. A regression that moved the enqueue into `transform()`
// would surface here as N copies of the retry prefix.
// ---------------------------------------------------------------------------

function makeSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drainBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("prefixSseRetry unit", () => {
  it("emits the retry prefix exactly once across a multi-chunk SSE body", async () => {
    const upstream = makeSseResponse([
      "event: connected\n",
      'data: {"foo":1}\n',
      "\n",
      'id: evt-1\ndata: {"bar":2}\n\n',
      'id: evt-2\ndata: {"baz":3}\n\n',
    ]);
    const wrapped = prefixSseRetry(upstream);
    const text = await drainBody(wrapped);

    const retryMatches = text.match(/^retry:/gm) ?? [];
    expect(retryMatches.length).toBe(1);
    expect(text.startsWith(`retry: ${SSE_RETRY_HINT_MS}\n`)).toBe(true);
  });

  it("preserves the wrapped status, statusText, and headers", () => {
    const upstream = new Response(null, {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
    const wrapped = prefixSseRetry(upstream);

    expect(wrapped.status).toBe(200);
    expect(wrapped.statusText).toBe("OK");
    expect(wrapped.headers.get("Content-Type")).toBe("text/event-stream");
    expect(wrapped.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(wrapped.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("returns the response unchanged when Content-Type is not text/event-stream", async () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const wrapped = prefixSseRetry(upstream);
    expect(wrapped).toBe(upstream);
    expect(await wrapped.text()).toBe('{"ok":true}');
  });

  it("returns the response unchanged when body is null", () => {
    const upstream = new Response(null, {
      status: 204,
      headers: { "Content-Type": "text/event-stream" },
    });
    const wrapped = prefixSseRetry(upstream);
    expect(wrapped).toBe(upstream);
  });
});
