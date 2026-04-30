// Plan-008 §Phase 1 §T-008b-1-2: shape declarations for the typed tRPC
// session router. Implementation lives in session-router.factory.ts; this
// file is the externally-visible surface (deps interface + helpers) so
// consumers don't have to reach through the factory file for types.
//
// Splitting types from impl keeps `--isolatedDeclarations` simple: only the
// factory file (one symbol) carries the explicit `TRPCBuiltRouter<...>`
// return type. Without this split, build* helpers would need their own
// explicit annotations and the linter's `input: unknown` auto-fix erases
// per-procedure input typing.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-2,
//       docs/architecture/contracts/api-payload-contracts.md §Tier 1 (Plan-008).

import type { ParticipantId, SessionId } from "@ai-sidekicks/contracts";
import type { SessionDirectoryService } from "./session-directory-service.js";
import type { SessionEventStreamProvider } from "./session-subscribe-sse.js";
import type { SessionRouterContext } from "./trpc.js";

/**
 * Constructor-injected dependencies for the session tRPC router.
 *
 * Per §I-008-3 enforcement #1, the directoryService is injected here once and
 * captured by every procedure closure — the procedures cannot reach a `Querier`
 * or `pg.Pool` directly. Tier 5 widens this dep object with PASETO-derived
 * auth + UUID v7 ID generation per BL-069; the Tier 1 callbacks below are
 * deliberate stubs whose names announce the deferral.
 */
export interface SessionRouterDeps {
  readonly directoryService: SessionDirectoryService;
  /**
   * Tier 1 stub principal resolver — returns the participantId to attribute
   * an action to. Tier 5 wires this to PASETO ctx-derived auth (Plan-018).
   */
  readonly resolveCurrentParticipantId: (ctx: SessionRouterContext) => ParticipantId;
  /**
   * Tier 1 stub session-id generator. Tier 5 canonicalizes to UUID v7 per BL-069.
   */
  readonly generateSessionId: () => SessionId;
  /**
   * Tier 1 stub identity resolver — maps an `identityHandle` wire string to a
   * `ParticipantId`. Returns `null` for unresolvable handles (which the join
   * procedure surfaces as `auth.not_authorized`). Tier 5 wires Plan-018's
   * identity service + Plan-002's invite-acceptance flow.
   */
  readonly resolveIdentityHandle: (handle: string) => ParticipantId | null;
  /**
   * Per-call event source for the `session.subscribe` SSE substrate. Phase 1
   * tests inject a synthetic provider; Tier 5 wires the Plan-006 event log.
   * See `session-subscribe-sse.ts` for the contract.
   */
  readonly eventStreamProvider: SessionEventStreamProvider;
}

export type { SessionRouterContext };
