// Plan-008 §Phase 1 §T-008b-1-3: shape declarations + SSE wire-frame
// constants for the `session.subscribe` SSE substrate. Implementation lives
// in session-subscribe-sse.factory.ts; this file is the externally-visible
// surface (deps interface + constants).
//
// The factory produces a tRPC `subscription` procedure. tRPC v11's shared
// HTTP resolver (`resolveResponse.ts`) detects subscription procedures
// invoked through `fetchRequestHandler` and emits a `text/event-stream`
// `Response` natively — no separate SSE adapter is required. Wire-frame
// shaping (heartbeat cadence, ping enablement, `Last-Event-ID` resumption)
// is controlled by the producer options described below; the procedure body
// itself yields `tracked(cursor, event)` envelopes that tRPC turns into
// SSE frames with `id: <cursor>` + `data: <serialized event>`.
//
// SSE wire frame ratified per
// docs/architecture/contracts/api-payload-contracts.md §SSE Wire Frame
// (Tier 1 Ratified, lines 268-283): Content-Type text/event-stream; one
// EventEnvelope per `data:` line as single-line JSON; `id:` carries
// EventCursor; `retry: 5000`; heartbeat every 15s; tRPC fetch adapter
// handles SSE natively per BL-104.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-3,
//       docs/plans/008-control-plane-relay-and-session-join.md §CP-008-3,
//       docs/architecture/contracts/api-payload-contracts.md §SSE Wire Frame.

import type { EventCursor, SessionEvent, SessionId } from "@ai-sidekicks/contracts";
import type { TrackedEnvelope } from "@trpc/server";

/**
 * Heartbeat cadence in milliseconds — emitted as SSE `: ping` comment frames
 * by tRPC's `sseStreamProducer` when `ping.enabled === true`. 15 s matches
 * the Plan-008 conservative inline value (per the plan §Phase 1 wire-frame
 * bullet) and is short enough to keep most intermediary proxies (Cloudflare
 * 100 s default, AWS ALB 60 s default) from idling the stream closed.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Initial-frame `retry:` hint sent to the EventSource client. 5 s gives
 * intermediary infrastructure time to recover before the client dials back
 * in; tRPC's stream consumer respects this on reconnect. Ratified per
 * api-payload-contracts.md §SSE Wire Frame (Tier 1 Ratified, line 277).
 */
export const SSE_RETRY_HINT_MS = 5_000;

/**
 * Per-call event source. Phase 1 tests inject a synthetic provider that
 * yields a finite sequence of `tracked(cursor, event)` envelopes; Tier 5
 * wires the Plan-006 event log (sequenced via `EventCursor`).
 *
 * Returns an `AsyncIterable` so the procedure body can `yield*` directly
 * without buffering — backpressure is naturally bounded by the SSE
 * producer's buffer.
 *
 * `signal` is forwarded so the provider can short-circuit cleanly when the
 * client disconnects (ergonomically the same `AbortSignal` tRPC threads
 * through the subscription closure).
 */
export type SessionEventStreamProvider = (params: {
  readonly sessionId: SessionId;
  readonly afterCursor: EventCursor | undefined;
  readonly signal: AbortSignal;
}) => AsyncIterable<TrackedEnvelope<SessionEvent>>;
