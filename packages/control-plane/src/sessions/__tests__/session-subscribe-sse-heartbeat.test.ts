// Plan-008 §Phase 1 §T-008b-1-T9: SSE heartbeat cadence verification —
// the wire emits `event: ping` frames at the configured interval whenever
// the source iterable is silent. End-to-end via `fetchRequestHandler`, same
// substrate as T7/T8.
//
// This test lives in its OWN file because it module-mocks
// `SSE_HEARTBEAT_INTERVAL_MS` to a short value (50ms) so the test can
// observe multiple pings in real time without 15-second waits. `vi.mock`
// is module-scoped — co-locating with T7/T8 would shorten heartbeat for
// those tests too and risk flakiness from racing pings against assertions.
//
// Why module-mock and not vitest fake timers:
//   * `withPing` (in @trpc/server v11 stream/utils/withPing.ts) uses
//     native setTimeout via `timerResource`. Fake-timer interleaving with
//     async streaming reads is fragile — each `reader.read()` await is a
//     microtask boundary that fake-timers can't trivially advance through
//     without manual flushing.
//   * Module-mock is the canonical tRPC pattern: `t.create({sse:{ping:
//     {intervalMs: <const>}}})` reads the constant at import time. Swap
//     the constant pre-import, get a fast cadence, real clock — same
//     wire-frame production path the production deployment exercises.
//
// Substrate refs:
//   * sse.ts:123 — `if (ping.enabled && intervalMs > 0) iterable = withPing(...)`.
//   * withPing.ts:23-40 — yields PING_SYM whenever `pingIntervalMs` elapses
//     between source values.
//   * sse.ts:133-135 — PING_SYM → `{event: "ping", data: ""}` SSE frame.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T9,
//       packages/control-plane/src/sessions/trpc.ts (sse.ping wiring).

import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports below at runtime. The factory uses
// `importOriginal` so the rest of the module's exports (constants, types)
// pass through untouched — only the heartbeat interval is overridden.
vi.mock("../session-subscribe-sse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-subscribe-sse.js")>();
  return {
    ...actual,
    SSE_HEARTBEAT_INTERVAL_MS: 50,
  };
});

import { type SessionId } from "@ai-sidekicks/contracts";

import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../../server/host.js";
import { makeRefusalAssertingDeps } from "../../server/__tests__/_helpers.js";
import type { SessionEventStreamProvider } from "../session-subscribe-sse.js";

const PASSING_ENV: ControlPlaneEnv = {
  CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
  ENVIRONMENT: "development",
};

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000000d101" as SessionId;

// Quiescent provider — yields nothing, just awaits abort. With no values
// from the source, withPing fires PING_SYM every `pingIntervalMs`. The
// `require-yield` rule fires on any `function*` that has no yield statement;
// here that's exactly the test fixture's purpose, so the rule is disabled
// for the body. (Adding a never-reached yield to silence the rule would
// be functionally identical on the wire but communicates the wrong intent.)
function makeQuiescentProvider(): SessionEventStreamProvider {
  // eslint-disable-next-line require-yield
  return async function* (params) {
    if (params.signal.aborted) return;
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

describe("T9 / §T-008b-1-T9: SSE heartbeat cadence emits `event: ping` frames during source silence", () => {
  it("emits >= 2 ping frames within ~5x interval against a quiescent source", async () => {
    const handler = buildControlPlaneFetchHandler({
      ...makeRefusalAssertingDeps(),
      eventStreamProvider: makeQuiescentProvider(),
    });
    const ctrl = new AbortController();
    const response = await handler(
      new Request(
        `https://control-plane.test/trpc/session.subscribe?input=${encodeURIComponent(
          JSON.stringify({ sessionId: SESSION_ID }),
        )}`,
        { method: "GET", signal: ctrl.signal },
      ),
      PASSING_ENV,
    );

    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);

    if (response.body === null) throw new Error("response.body is null");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const eventNames: string[] = [];
    let buffer = "";
    // Read window: 5x the mocked 50ms interval. Conservative — gives the
    // first ping ~50ms slack and still expects multiple cycles. CI clock
    // jitter would have to exceed 200ms for the assertion below (>= 2) to
    // miss the second ping.
    const READ_WINDOW_MS = 250;
    const deadline = Date.now() + READ_WINDOW_MS;

    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const readPromise = reader.read();
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining),
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result === null || result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let sepIdx = buffer.indexOf("\n\n");
        while (sepIdx !== -1) {
          const frameText = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          for (const line of frameText.split("\n")) {
            if (line.startsWith("event:")) {
              eventNames.push(line.slice("event:".length).trim());
            }
          }
          sepIdx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    }

    // First emission is always the `connected` event (sse.ts:107-110).
    expect(eventNames[0]).toBe("connected");
    // Then ping frames at the configured cadence — the quiescent source
    // never yields a tracked envelope, so every subsequent emission must
    // be a ping. Asserting >= 2 sets a low floor that survives modest
    // clock jitter while still proving the cadence wiring is live.
    const pingCount = eventNames.filter((n) => n === "ping").length;
    expect(pingCount).toBeGreaterThanOrEqual(2);
    // Defensive: there should be no `serialized-error` frames — a thrown
    // exception inside the producer would surface as one. (sse.ts:155-173.)
    expect(eventNames).not.toContain("serialized-error");
  });
});
