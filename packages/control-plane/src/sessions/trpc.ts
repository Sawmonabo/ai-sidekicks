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
// `errorFormatter` extension: the formatter projects typed exceptions thrown
// inside procedure handlers onto a stable
// `shape.data.aisError = { code, message, details? }` envelope so downstream
// SDK consumers can branch on the canonical wire code. The formatter matches a
// SINGLE `instanceof AisWireException` (`../ais-wire-exception.ts`) — the
// cross-domain base — so EVERY subclass projects uniformly: today the
// runtime-node-domain refusals (`../runtime-nodes/errors.ts` — the attach /
// revoked / capability-update conflicts + the version-floor write-refusal).
// A detail-carrying subclass emits `{code, message, details}`; a
// code+message-only subclass (`details === undefined`) emits `{code, message}`.
// New typed exceptions join by extending `AisWireException` — no formatter
// change needed (the base `instanceof` already matches them).

import { initTRPC, type TRPCRootObject, type TRPCRuntimeConfigOptions } from "@trpc/server";

import { AisWireException } from "../ais-wire-exception.js";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./session-subscribe-sse.js";

export interface SessionRouterContext {
  /** Stable per-request identifier; stamped at host fetch entry. */
  readonly requestId: string;
}

// Wire-projected envelope appended to `shape.data` when a procedure throws
// a typed control-plane exception (any `AisWireException` subclass). Every
// control-plane exception is code+message-only — the runtime-node refusals and
// the version-floor write-refusal — so the envelope carries those two members
// and nothing else. An exception that later needs structured details adds the
// member here and on the base class together.
export interface SessionRouterAisError {
  readonly code: string;
  readonly message: string;
}

// `errorFormatter` mutates the inferred `Options` type slot. The explicit
// `TRPCRootObject<...>` annotation is required by `--isolatedDeclarations`
// (tsconfig.base.json) — without it tsc cannot emit a stable `.d.ts` for
// `t`. We let TypeScript infer the `Options` slot by passing
// `ReturnType<...>` so the formatter's effect on the wire-error shape
// surfaces in the downstream router's procedure types without
// hand-mirroring the @trpc/server internal generic.
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
  errorFormatter({ shape, error }) {
    const cause: unknown = error.cause;
    if (cause instanceof AisWireException) {
      const aisError: SessionRouterAisError = { code: cause.code, message: cause.message };
      return {
        ...shape,
        data: { ...shape.data, aisError },
      };
    }
    return shape;
  },
});
