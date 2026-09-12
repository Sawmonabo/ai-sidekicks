// Shape declarations for the typed tRPC session router. Implementation lives
// in session-router.factory.ts; this file is the externally-visible surface
// (deps interface + helpers) so consumers don't have to reach through the
// factory file for types.
//
// Splitting types from impl keeps `--isolatedDeclarations` simple: only the
// factory file (one symbol) carries the explicit `TRPCBuiltRouter<...>`
// return type. Without this split, build* helpers would need their own
// explicit annotations and the linter's `input: unknown` auto-fix erases
// per-procedure input typing.

import type { UserId, SessionId } from "@ai-sidekicks/contracts";
import type { SessionDirectoryService } from "./session-directory-service.js";
import type { SessionEventStreamProvider } from "./session-subscribe-sse.js";
import type { SessionRouterContext } from "./trpc.js";

/**
 * Constructor-injected dependencies for the session tRPC router.
 *
 * The directoryService is injected here once and captured by every procedure
 * closure — the procedures cannot reach a `Querier` or `pg.Pool` directly.
 */
export interface SessionRouterDeps {
  readonly directoryService: SessionDirectoryService;
  /**
   * Stub principal resolver — returns the userId to attribute an action
   * to. Production wiring resolves this from the authenticated caller.
   */
  readonly resolveCurrentUserId: (ctx: SessionRouterContext) => UserId;
  /**
   * Stub session-id generator. Production wiring canonicalizes to UUID v7.
   */
  readonly generateSessionId: () => SessionId;
  /**
   * Per-call event source for the `session.subscribe` SSE substrate. Tests
   * inject a synthetic provider; production wiring supplies the event log.
   * See `session-subscribe-sse.ts` for the contract.
   */
  readonly eventStreamProvider: SessionEventStreamProvider;
}

export type { SessionRouterContext };
