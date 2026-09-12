// createSessionRouter factory.
//
// Composes the CRUD procedures (session.create / session.read) plus the
// streaming session.subscribe, nested under the `session` namespace so the
// on-wire JSON-RPC method names match the canonical strings. Each procedure
// closes over the constructor-injected `directoryService` and uses the deps
// callbacks for principal resolution + id generation.
//
// Direct `pg` / `Pool` / `Client` imports here are forbidden by the ESLint
// `no-restricted-imports` rule layered in eslint.config.mjs and asserted by the
// AST-introspection test.

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
  SessionReadRequestSchema,
  SessionReadResponseSchema,
  type SessionCreateRequest,
  type SessionCreateResponse,
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

      subscribe: createSessionSubscribeSse(deps),
    }),
  });
}
