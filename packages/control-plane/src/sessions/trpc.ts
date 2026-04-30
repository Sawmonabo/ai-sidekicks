// tRPC v11 builder for the control-plane session surface.
//
// One `t` builder is shared across the router CRUD procedures (session-router
// factory) and the SSE subscription procedure (session-subscribe-sse factory)
// so they share a context type. Splitting them across files without a shared
// builder produces incompatible procedure types that can't compose into a
// single router.
//
// The `sse.ping` config below is read at request resolution time by tRPC's
// shared HTTP resolver (`resolveResponse.ts` line 491 → `sseStreamProducer`)
// and wires the heartbeat cadence onto every SSE Response — there's no
// per-procedure hook for ping config in tRPC v11, so the root-config slot is
// the canonical wire-up site.
//
// The explicit `TRPCRootObject<...>` annotation on `t` is required by
// `--isolatedDeclarations` (tsconfig.base.json). The TRPCBuilder<TContext,
// TMeta>.create() method returns TRPCRootObject<TContext, TMeta, TOptions>
// per @trpc/server v11's source — TOptions falls back to the constraint
// default when create() is called without arguments.
//
// Refs: docs/decisions/014-trpc-control-plane-api.md

import { initTRPC, type TRPCRootObject, type TRPCRuntimeConfigOptions } from "@trpc/server";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./session-subscribe-sse.js";

export interface SessionRouterContext {
  /** Stable per-request identifier; stamped at host fetch entry. */
  readonly requestId: string;
}

export const t: TRPCRootObject<
  SessionRouterContext,
  object,
  TRPCRuntimeConfigOptions<SessionRouterContext, object>
> = initTRPC.context<SessionRouterContext>().create({
  sse: {
    ping: {
      enabled: true,
      intervalMs: SSE_HEARTBEAT_INTERVAL_MS,
    },
  },
});
