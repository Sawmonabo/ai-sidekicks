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
// `errorFormatter` extension (Plan-001 AC8): the formatter projects typed
// exceptions thrown inside procedure handlers onto a stable
// `shape.data.aisError = { code, message, details }` envelope so downstream
// SDK consumers (Plan-005) can branch on the canonical Spec-001 wire code.
// Today the formatter has one branch (`ResourceLimitExceededException`);
// Plan-002+ typed exceptions reuse the same hook by adding an `instanceof`
// branch per error type. If 3+ branches accumulate, refactor the thrown
// classes into an `AisWireException` base class so the formatter matches a
// single `instanceof` per `error-contracts.md` §Future Shape.
//
// Refs: docs/decisions/014-trpc-control-plane-api.md, Spec-001 §Limit Enforcement

import { initTRPC, type TRPCRootObject, type TRPCRuntimeConfigOptions } from "@trpc/server";

import type { ResourceLimitExceededDetails } from "@ai-sidekicks/contracts";

import { ResourceLimitExceededException } from "./errors.js";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./session-subscribe-sse.js";

export interface SessionRouterContext {
  /** Stable per-request identifier; stamped at host fetch entry. */
  readonly requestId: string;
}

// Wire-projected envelope appended to `shape.data` when a procedure throws
// a typed control-plane exception. The Spec-001 envelope shape is
// stable — keep the shape mirrored here verbatim so a `tsc` diff catches
// upstream contract drift at PR review.
export interface SessionRouterAisError {
  readonly code: string;
  readonly message: string;
  readonly details: ResourceLimitExceededDetails;
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
    if (cause instanceof ResourceLimitExceededException) {
      const aisError: SessionRouterAisError = {
        code: cause.code,
        message: cause.message,
        details: cause.details,
      };
      return {
        ...shape,
        data: { ...shape.data, aisError },
      };
    }
    return shape;
  },
});
