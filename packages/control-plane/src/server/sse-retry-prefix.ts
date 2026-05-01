// Plan-008 §Phase 1: SSE `retry:` field injector for the
// `session.subscribe` response.
//
// tRPC v11's `sseStreamProducer` (the substrate at
// `@trpc/server/dist/resolveResponse-*.mjs`) emits `event:` / `data:` /
// `id:` / `:` (comment) lines via its TransformStream — but no `retry:`
// field. `SSEStreamProducerOptions` has no `retry` slot, and the
// `client.reconnectAfterInactivityMs` option is sent as JSON inside the
// first `connected` event payload (consumed by tRPC's own
// `sseStreamConsumer`, ignored by native `EventSource`).
//
// The wire frame ratified at
// `docs/architecture/contracts/api-payload-contracts.md` §SSE Wire Frame
// (Tier 1 Ratified, line 295) requires `retry: 5000` so reconnecting
// `EventSource` clients honor the documented backoff under transient
// disconnects. This module bridges the gap without forking tRPC: a
// TransformStream prepends `retry: <ms>\n` ahead of tRPC's first chunk.
// Per the WHATWG SSE grammar, fields concatenate into the same event
// until a blank line — so the retry value rides on tRPC's `connected`
// frame and dispatches as one parse: `retry=5000, event=connected,
// data=<config>`. No frame-count change, no test-helper churn.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       docs/architecture/contracts/api-payload-contracts.md §SSE Wire Frame.

import { SSE_RETRY_HINT_MS } from "../sessions/session-subscribe-sse.js";

const SSE_CONTENT_TYPE_PREFIX = "text/event-stream";
const RETRY_PREFIX_BYTES: Uint8Array = new TextEncoder().encode(`retry: ${SSE_RETRY_HINT_MS}\n`);

/**
 * Wrap an SSE `Response` so the body begins with `retry: <ms>\n`.
 * No-op for non-SSE responses (CRUD JSON, gate refusals) and for
 * responses with a null body. Preserves status/statusText/headers
 * verbatim — only the body stream is transformed.
 */
export function prefixSseRetry(response: Response): Response {
  // Per RFC 9110 §8.3, media-type type/subtype tokens are case-insensitive —
  // an upstream that emits `Text/Event-Stream` is RFC-valid SSE. The Fetch
  // API normalizes header *names* to lowercase but passes *values* through
  // verbatim, so `Headers.get("Content-Type")` returns the upstream bytes as
  // set. Lowercase the value before the prefix check.
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(SSE_CONTENT_TYPE_PREFIX)) return response;
  if (response.body === null) return response;

  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(RETRY_PREFIX_BYTES);
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
