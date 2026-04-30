// Plan-008 §Phase 1 §T-008b-1-3: createSessionSubscribeSse factory.
//
// Builds the `session.subscribe` tRPC subscription procedure. The procedure
// body delegates to the constructor-injected `eventStreamProvider`
// (per §I-008-3 #1) so the procedure cannot reach a `Querier` or `pg.Pool`
// directly — the same enforcement boundary asserted for the CRUD trio in
// session-router.factory.ts.
//
// The async generator yields `TrackedEnvelope<SessionEvent>` values produced
// by `tracked(cursor, event)`. tRPC v11's shared HTTP resolver
// (`resolveResponse.ts`) converts the AsyncIterable into a streaming
// `text/event-stream` `Response` natively when invoked through
// `fetchRequestHandler` — see `node_modules/@trpc/server/.../sseStreamProducer`
// for the wire-frame implementation. Heartbeat/ping cadence is enabled via
// `responseMeta` in `host.ts` (one place to wire it for the whole app).
//
// Direct `pg` / `Pool` / `Client` imports here are forbidden by the ESLint
// `no-restricted-imports` rule layered in eslint.config.mjs (per §T-008b-1-4)
// and asserted by the AST-introspection test (per §T-008b-1-T11).
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-3,
//       docs/plans/008-control-plane-relay-and-session-join.md §CP-008-3,
//       docs/architecture/contracts/api-payload-contracts.md §Tier 1 (Plan-008).

import {
  SessionSubscribeRequestSchema,
  type SessionEvent,
  type SessionSubscribeRequest,
} from "@ai-sidekicks/contracts";
import type { TRPCSubscriptionProcedure } from "@trpc/server";
import type { SessionRouterDeps } from "./session-router.js";
import { t } from "./trpc.js";

/**
 * Consumer-facing tracked event shape for `session.subscribe`. Produced by
 * tRPC's `inferTrackedOutput` mapper when the procedure body yields
 * `TrackedEnvelope<SessionEvent>` envelopes (via `tracked(cursor, event)`).
 *
 * Inlined here rather than importing because `@trpc/server`'s public entry
 * re-exports only `TrackedEnvelope` (the producer-side type) — the
 * consumer-side `TrackedData` lives in tRPC's `unstable-core-do-not-import`
 * surface, and importing from there couples to internal-stability semantics.
 * The structural shape `{id, data}` is the documented client contract per
 * tRPC v11's `inferTrackedOutput` source (see @trpc/server v11
 * `unstable-core-do-not-import.d.mts` line 401-410, 424).
 */
export interface SessionSubscribeTracked {
  readonly id: string;
  readonly data: SessionEvent;
}

/**
 * Subscription procedure type — the slot consumed by the parent router's
 * `subscribe` key. Output is the consumer-facing `{id, data}` form (post-
 * `inferTrackedOutput` transformation of the `TrackedEnvelope` yielded by
 * the procedure body).
 */
export type SessionSubscribeProcedure = TRPCSubscriptionProcedure<{
  input: SessionSubscribeRequest;
  output: AsyncIterable<SessionSubscribeTracked>;
  meta: object;
}>;

/**
 * Reusable noop AbortSignal — supplied when the subscription is invoked via
 * a path that doesn't thread a real signal (e.g. direct caller). The provider
 * relies on a non-null signal to register cleanup hooks; constructing a
 * single never-aborts signal here avoids per-call allocation.
 */
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

export function createSessionSubscribeSse(deps: SessionRouterDeps): SessionSubscribeProcedure {
  return t.procedure.input(SessionSubscribeRequestSchema).subscription(async function* ({
    input,
    signal,
  }) {
    // The provider owns ordering + cursor semantics. The factory's only job
    // is to (a) parse + validate the wire input via Zod, (b) resolve the
    // dual-cursor precedence (header beats body — see
    // `SessionSubscribeRequest` doc in @ai-sidekicks/contracts for the
    // two-transport rationale), (c) thread the abort signal through,
    // (d) re-yield the tracked envelopes verbatim.
    // Tier 5 swaps the provider; this generator body is the stable surface.
    yield* deps.eventStreamProvider({
      sessionId: input.sessionId,
      afterCursor: input.lastEventId ?? input.afterCursor,
      signal: signal ?? NEVER_ABORTED_SIGNAL,
    });
  });
}
