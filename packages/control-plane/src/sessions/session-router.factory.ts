// Plan-008 §Phase 1 §T-008b-1-2: createSessionRouter factory.
//
// Composes 3 CRUD procedures (session.create / session.read / session.join)
// nested under the `session` namespace so the on-wire JSON-RPC method names
// match the canonical strings ratified by api-payload-contracts.md §Plan-008.
// Each procedure closes over the constructor-injected `directoryService`
// (per §I-008-3 #1) and uses the deps callbacks for Tier-1-stub principal
// resolution + UUID generation. Tier 5 replaces the callbacks with PASETO-
// derived auth + UUID v7 generation per BL-069.
//
// Direct `pg` / `Pool` / `Client` imports here are forbidden by the ESLint
// `no-restricted-imports` rule layered in eslint.config.mjs (per §T-008b-1-4)
// and asserted by the AST-introspection test (per §T-008b-1-T11).
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-3 #1,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-2,
//       docs/architecture/contracts/api-payload-contracts.md §Tier 1 (Plan-008).

import {
  TRPCError,
  type TRPCBuiltRouter,
  type TRPCDecorateCreateRouterOptions,
  type TRPCDefaultErrorShape,
  type TRPCMutationProcedure,
  type TRPCQueryProcedure,
} from "@trpc/server";
import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionJoinRequestSchema,
  SessionJoinResponseSchema,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
  type SessionCreateRequest,
  type SessionCreateResponse,
  type SessionJoinRequest,
  type SessionJoinResponse,
  type SessionReadRequest,
  type SessionReadResponse,
} from "@ai-sidekicks/contracts";
import type { SessionRouterDeps } from "./session-router.js";
import {
  createSessionSubscribeSse,
  type SessionSubscribeProcedure,
} from "./session-subscribe-sse.factory.js";
import { t, type SessionRouterContext } from "./trpc.js";

// Each procedure carries its concrete request type from `@ai-sidekicks/contracts`
// (interface schemas are `z.ZodType<T>` with no transforms, so `inferParser['in']`
// resolves identically to the interface). The TDef supplied to TRPCMutationProcedure
// /TRPCQueryProcedure here is a CONCRETE type argument — its only constraint is
// `BuiltProcedureDef`, whose `input` field is bounded by `unknown` (the upper bound).
// Concrete types satisfy that bound; clients/tests still get their typing via
// `inferRouterInputs<typeof router>` and `inferRouterOutputs<typeof router>`.
export type SessionRouter = TRPCBuiltRouter<
  {
    ctx: SessionRouterContext;
    meta: object;
    errorShape: TRPCDefaultErrorShape;
    transformer: false;
  },
  TRPCDecorateCreateRouterOptions<{
    session: {
      create: TRPCMutationProcedure<{
        input: SessionCreateRequest;
        output: SessionCreateResponse;
        meta: object;
      }>;
      read: TRPCQueryProcedure<{
        input: SessionReadRequest;
        output: SessionReadResponse;
        meta: object;
      }>;
      join: TRPCMutationProcedure<{
        input: SessionJoinRequest;
        output: SessionJoinResponse;
        meta: object;
      }>;
      subscribe: SessionSubscribeProcedure;
    };
  }>
>;

export function createSessionRouter(deps: SessionRouterDeps): SessionRouter {
  const sessionProcedure = t.procedure;

  return t.router({
    session: t.router({
      create: sessionProcedure
        .input(SessionCreateRequestSchema)
        .output(SessionCreateResponseSchema)
        .mutation(async ({ input, ctx }) =>
          deps.directoryService.createSession({
            sessionId: deps.generateSessionId(),
            ownerParticipantId: deps.resolveCurrentParticipantId(ctx),
            config: input.config,
            metadata: input.metadata,
          }),
        ),

      read: sessionProcedure
        .input(SessionReadRequestSchema)
        .output(SessionReadResponseSchema)
        .query(async ({ input }) => {
          const result = await deps.directoryService.readSession(input.sessionId);
          if (result === null) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `session ${input.sessionId} not found`,
            });
          }
          return result;
        }),

      join: sessionProcedure
        .input(SessionJoinRequestSchema)
        .output(SessionJoinResponseSchema)
        .mutation(async ({ input, ctx }) => {
          const resolved = deps.resolveIdentityHandle(input.identityHandle);
          if (resolved === null) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message:
                "auth.not_authorized: identity resolution deferred to Tier 5 (Plan-018 + Plan-002)",
            });
          }
          const current = deps.resolveCurrentParticipantId(ctx);
          if (resolved !== current) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "auth.not_authorized: non-self joins deferred to Tier 5 invite/presence",
            });
          }
          const result = await deps.directoryService.joinSession({
            sessionId: input.sessionId,
            participantId: resolved,
          });
          if (result === null) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `session ${input.sessionId} not found`,
            });
          }
          return result;
        }),

      subscribe: createSessionSubscribeSse(deps),
    }),
  });
}
