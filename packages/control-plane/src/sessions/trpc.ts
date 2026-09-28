// tRPC v11 builder for the control-plane HTTP surface.
//
// One `t` builder is shared by every router the host mounts so they share a
// context type; routers built from separate `initTRPC` calls produce
// incompatible procedure types that cannot compose into one router.
//
// The explicit `TRPCRootObject<...>` annotation on `t` is required by
// `--isolatedDeclarations` (tsconfig.base.json).

import { initTRPC, type TRPCRootObject, type TRPCRuntimeConfigOptions } from "@trpc/server";

/** The per-request context every control-plane procedure receives. */
export interface SessionRouterContext {
  /** Stable per-request identifier; stamped at host fetch entry. */
  readonly requestId: string;
}

/** The shared tRPC builder every control-plane router is built on. */
export const t: TRPCRootObject<
  SessionRouterContext,
  object,
  TRPCRuntimeConfigOptions<SessionRouterContext, object>
> = initTRPC.context<SessionRouterContext>().create();
