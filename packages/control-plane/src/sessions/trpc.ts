// One `t` builder is shared by every router the host mounts: routers built from separate
// `initTRPC` calls have incompatible procedure types and cannot compose into one router.
// The explicit `TRPCRootObject<...>` annotation on `t` is required by `isolatedDeclarations`.

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
