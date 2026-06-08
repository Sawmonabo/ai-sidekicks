// Plan-003 §Phase 3 §T3.8: createRuntimeNodeRouter factory.
//
// Composes the 4 runtime-node procedures (runtimenode.attach /
// runtimenode.heartbeat / runtimenode.capabilityupdate / runtimenode.detach)
// nested under the `runtimenode` namespace so the on-wire JSON-RPC method names
// match the canonical strings ratified by api-payload-contracts.md §Plan-003.
// All four are mutations (each one WRITES). Each procedure closes over the
// constructor-injected `attachService` / `heartbeatService` and is pure
// transport wiring: input schema -> backing service method -> output schema,
// plus the catch-arms that map the two services' typed exceptions to the
// canonical HTTP 409 / tRPC `CONFLICT` per error-contracts.md §Runtime Node.
//
// SIBLING MERGE: this router is built on the SAME shared `t` builder as the
// session router (`../sessions/trpc.js`), NOT a fresh `initTRPC` instance — so
// the two already-namespaced routers (`session:` / `runtimenode:`) share ONE
// context type AND the shared `errorFormatter`. host.ts merges them via
// `t.mergeRouters(createSessionRouter(deps), createRuntimeNodeRouter(deps))`.
// The typed exceptions are preserved on each `TRPCError.cause`; the shared
// `errorFormatter` (T3.4) projects every `AisWireException` subclass onto
// `shape.data.aisError` via a single base `instanceof` — this factory only sets
// `cause`, it adds NO formatter logic of its own.
//
// ROUTE-THROUGH-SERVICES: this factory routes through the injected services
// ONLY — it imports no `pg` / `Pool` / `Client` / `Querier` (the services own
// all SQL). This is the same §I-008-3 #2 "route through the service wrapper"
// discipline the session factory follows; here it holds BY CONSTRUCTION, since
// the factory has no querier to misuse.
//
// Refs: docs/plans/003-runtime-node-attach.md §T3.8, Spec-003
//       line 52 (the control plane coordinates discovery/presence; execution
//       stays local), ADR-014 (tRPC control-plane API), CP-003-2 (transport
//       wiring is a thin sibling router, no standalone service assertion).

import {
  TRPCError,
  type TRPCBuiltRouter,
  type TRPCDecorateCreateRouterOptions,
  type TRPCDefaultErrorShape,
  type TRPCMutationProcedure,
} from "@trpc/server";
import {
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeAttachResponseSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeDetachRequestSchema,
  RuntimeNodeDetachResponseSchema,
  RuntimeNodeHeartbeatRequestSchema,
  RuntimeNodeHeartbeatResponseSchema,
  type RuntimeNodeAttachRequest,
  type RuntimeNodeAttachResponse,
  type RuntimeNodeCapabilityUpdateRequest,
  type RuntimeNodeCapabilityUpdateResponse,
  type RuntimeNodeDetachRequest,
  type RuntimeNodeHeartbeatRequest,
} from "@ai-sidekicks/contracts";

import { t, type SessionRouterContext } from "../sessions/trpc.js";
import { AttachService } from "./attach-service.js";
import {
  RuntimeNodeAttachConflictException,
  RuntimeNodeAttachRevokedException,
  RuntimeNodeCapabilityUpdateConflictException,
  VersionFloorExceededException,
} from "./errors.js";
import { HeartbeatService } from "./heartbeat-service.js";

// Runtime-node router deps — the two concrete (nominal, private-`#querier`)
// backing service classes the procedures close over (mirrors
// `SessionRouterDeps.directoryService: SessionDirectoryService`). Depending on
// the concrete classes — not a structural interface — is deliberate: each class
// has a private field, so TypeScript treats it nominally, and the host's
// production placeholder must construct the real class (a structural stub can't
// satisfy the type). `attachService` backs attach / capabilityupdate / detach;
// `heartbeatService` backs heartbeat.
export interface RuntimeNodeRouterDeps {
  readonly attachService: AttachService;
  readonly heartbeatService: HeartbeatService;
}

// Each procedure carries its concrete request/output type from
// `@ai-sidekicks/contracts` (interface schemas are `z.ZodType<T>` with no
// transforms, so `inferParser['in']` resolves identically to the interface).
// The hand-written router type is required by `--isolatedDeclarations`
// (tsconfig.base.json) — without it tsc cannot emit a stable `.d.ts` for
// `createRuntimeNodeRouter` — and mirrors `SessionRouter`
// (session-router.factory.ts). `ctx` is the SHARED `SessionRouterContext` (the
// sibling shares the context type). heartbeat / detach output `null` (their
// wire responses are `z.null()`, with no response-type alias in contracts).
export type RuntimeNodeRouter = TRPCBuiltRouter<
  {
    ctx: SessionRouterContext;
    meta: object;
    errorShape: TRPCDefaultErrorShape;
    transformer: false;
  },
  TRPCDecorateCreateRouterOptions<{
    runtimenode: {
      attach: TRPCMutationProcedure<{
        input: RuntimeNodeAttachRequest;
        output: RuntimeNodeAttachResponse;
        meta: object;
      }>;
      heartbeat: TRPCMutationProcedure<{
        input: RuntimeNodeHeartbeatRequest;
        output: null;
        meta: object;
      }>;
      capabilityupdate: TRPCMutationProcedure<{
        input: RuntimeNodeCapabilityUpdateRequest;
        output: RuntimeNodeCapabilityUpdateResponse;
        meta: object;
      }>;
      detach: TRPCMutationProcedure<{
        input: RuntimeNodeDetachRequest;
        output: null;
        meta: object;
      }>;
    };
  }>
>;

export function createRuntimeNodeRouter(deps: RuntimeNodeRouterDeps): RuntimeNodeRouter {
  const runtimeNodeProcedure = t.procedure;

  return t.router({
    runtimenode: t.router({
      attach: runtimeNodeProcedure
        .input(RuntimeNodeAttachRequestSchema)
        .output(RuntimeNodeAttachResponseSchema)
        .mutation(async ({ input }) => {
          // Both attach refusals map to HTTP 409 / tRPC `CONFLICT`
          // (error-contracts.md §Runtime Node). Preserve the typed exception on
          // `cause` so the shared `errorFormatter` projects it onto
          // `shape.data.aisError` via the `AisWireException` base — this arm adds
          // NO formatter logic. Any other throw (e.g. a raw FK violation)
          // rethrows unchanged.
          try {
            return await deps.attachService.attach(input);
          } catch (err) {
            if (
              err instanceof RuntimeNodeAttachConflictException ||
              err instanceof RuntimeNodeAttachRevokedException
            ) {
              throw new TRPCError({ code: "CONFLICT", message: err.message, cause: err });
            }
            throw err;
          }
        }),

      heartbeat: runtimeNodeProcedure
        .input(RuntimeNodeHeartbeatRequestSchema)
        .output(RuntimeNodeHeartbeatResponseSchema)
        .mutation(async ({ input }) => {
          // `ingest` returns `void`; map it to the wire `null`
          // (`RuntimeNodeHeartbeatResponseSchema = z.null()`). No catch-arm:
          // `ingest` throws nothing typed — only a boundary `ZodError`, which
          // the `.input()` parse precludes from ever reaching the body.
          await deps.heartbeatService.ingest(input);
          return null;
        }),

      capabilityupdate: runtimeNodeProcedure
        .input(RuntimeNodeCapabilityUpdateRequestSchema)
        .output(RuntimeNodeCapabilityUpdateResponseSchema)
        .mutation(async ({ input }) => {
          // Two refusal families on this procedure both map to HTTP 409 / tRPC
          // `CONFLICT` (error-contracts.md §Runtime Node + §Version):
          //   - RuntimeNodeCapabilityUpdateConflictException — no active
          //     attachment, or the I-003-2 registering->online guard;
          //   - VersionFloorExceededException — the below-floor read-only node's
          //     write-refusal (the typed `VERSION_FLOOR_EXCEEDED`, I-003-1 /
          //     ADR-018 §Decision #4 / Spec-003 line 123).
          // Preserve the typed exception on `cause` so the shared
          // `errorFormatter` projects it onto `shape.data.aisError` via the
          // `AisWireException` base; any other throw rethrows unchanged.
          try {
            return await deps.attachService.updateCapabilities(input);
          } catch (err) {
            if (
              err instanceof RuntimeNodeCapabilityUpdateConflictException ||
              err instanceof VersionFloorExceededException
            ) {
              throw new TRPCError({ code: "CONFLICT", message: err.message, cause: err });
            }
            throw err;
          }
        }),

      detach: runtimeNodeProcedure
        .input(RuntimeNodeDetachRequestSchema)
        .output(RuntimeNodeDetachResponseSchema)
        .mutation(async ({ input }) =>
          // `detach` already returns `null` (`RuntimeNodeDetachResponseSchema =
          // z.null()`). No catch-arm: detach is a clean idempotent no-op and
          // throws nothing typed.
          deps.attachService.detach(input),
        ),
    }),
  });
}
