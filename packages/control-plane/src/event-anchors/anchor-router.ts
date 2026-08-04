// Plan-006 T3.3 — `createEventAnchorRouter` factory.
//
// One procedure, `eventanchor.upload`: the daemon's write path for the
// integrity witness. Nested under the `eventanchor` namespace so the on-wire
// method name matches the directory it lives in, spelled as one lowercase word
// to match the shipped `runtimenode` convention (`runtimenode.attach`, not
// `runtime-node.attach`). It is deliberately NOT `event.*` — that namespace
// belongs to the daemon-side JSON-RPC surface, which is a different transport
// carrying different methods, and colliding on it would make method names
// ambiguous across the two registries.
//
// A MUTATION, not a query: it writes. There is exactly one procedure here and
// no read counterpart — the control plane stores anchors so an AUDIT READER can
// verify a log it obtains from the daemon, and Phase 4 owns that read path.
// Shipping an unused read now would be an untested surface with no consumer.
//
// SIBLING MERGE: built on the SAME shared `t` builder as the session and
// runtime-node routers (`../sessions/trpc.js`), NOT a fresh `initTRPC` — so all
// three already-namespaced routers share ONE context type and the shared
// `errorFormatter`, and `host.ts` composes them flat via `t.mergeRouters`.
//
// ROUTE-THROUGH-SERVICES: this factory imports no `pg` / `Pool` / `Client` /
// `Querier`; the injected `EventLogAnchorStore` owns all SQL. Same §I-008-3 #2
// discipline the runtime-node factory follows, and here it holds by
// construction since the factory has no querier to misuse.
//
// ----------------------------------------------------------------------------
// I-006-3-02 at the transport boundary
// ----------------------------------------------------------------------------
//
// `.input(EventAnchorUploadRequestSchema)` is the same `.strict()`
// seven-member `AnchorPayload` schema the daemon signs against, so a request
// body carrying `payload`, `events`, or `pii_payload` is REFUSED with a
// `BAD_REQUEST` before any handler code runs — it is not accepted-then-stripped.
// That refusal is the wire-level half of the metadata-only invariant; the store
// re-parses the same schema as the storage-level half, because a boundary
// invariant asserted at exactly one layer stops being asserted the moment
// someone adds a second caller.
//
// Refs: Plan-006 T3.3, ADR-014 (tRPC control-plane API), ADR-017,
// `Plan-006 §Cross-Plan Obligations` CP-006-2 (the host mount).

import {
  TRPCError,
  type TRPCBuiltRouter,
  type TRPCDecorateCreateRouterOptions,
  type TRPCDefaultErrorShape,
  type TRPCMutationProcedure,
} from "@trpc/server";
import {
  EventAnchorUploadRequestSchema,
  EventAnchorUploadResponseSchema,
  type EventAnchorUploadRequest,
  type EventAnchorUploadResponse,
} from "@ai-sidekicks/contracts";

import { t, type SessionRouterContext } from "../sessions/trpc.js";
import { EventLogAnchorStore, UnknownAnchorSessionError } from "./anchor-store.js";

/**
 * Event-anchor router deps — the concrete (nominal, private-`#querier`) backing
 * store the procedure closes over, mirroring
 * `SessionRouterDeps.directoryService` and `RuntimeNodeRouterDeps.attachService`.
 *
 * Depending on the concrete class rather than a structural interface is
 * deliberate and load-bearing at the host: the class has a private field, so
 * TypeScript treats it nominally and the production placeholder must construct
 * the REAL class with a throwing `Querier` — a structural stub cannot satisfy
 * the type without an `as unknown as` double-cast that would mask future drift.
 *
 * AUTH POSTURE. This procedure carries no participant-identity check, and that
 * is a Tier-5 deferral with a specific shape rather than an oversight. The
 * caller is a DAEMON, not a participant: the authority it claims is
 * `(sessionId, nodeId)`, and verifying it means checking that the DPoP-bound
 * PASETO token presented by the caller belongs to the node the anchor is
 * attributed to. That check needs the token verification Plan-018 lands at
 * Tier 5 (the daemon side of the same seam is `CP-006-13`'s
 * `DaemonCredentialProvider`, which currently refuses every mint). Until then
 * the host's dual gate intercepts all production traffic, exactly as it does
 * for the session and runtime-node procedures.
 */
export interface EventAnchorRouterDeps {
  readonly anchorStore: EventLogAnchorStore;
}

// The hand-written router type is required by `--isolatedDeclarations`
// (tsconfig.base.json) — without it tsc cannot emit a stable `.d.ts` for
// `createEventAnchorRouter` — and mirrors `RuntimeNodeRouter`. `ctx` is the
// SHARED `SessionRouterContext`.
export type EventAnchorRouter = TRPCBuiltRouter<
  {
    ctx: SessionRouterContext;
    meta: object;
    errorShape: TRPCDefaultErrorShape;
    transformer: false;
  },
  TRPCDecorateCreateRouterOptions<{
    eventanchor: {
      upload: TRPCMutationProcedure<{
        input: EventAnchorUploadRequest;
        output: EventAnchorUploadResponse;
        meta: object;
      }>;
    };
  }>
>;

export function createEventAnchorRouter(deps: EventAnchorRouterDeps): EventAnchorRouter {
  const eventAnchorProcedure = t.procedure;

  return t.router({
    eventanchor: t.router({
      upload: eventAnchorProcedure
        .input(EventAnchorUploadRequestSchema)
        .output(EventAnchorUploadResponseSchema)
        .mutation(async ({ input }) => {
          try {
            return await deps.anchorStore.upload(input);
          } catch (err) {
            // An anchor naming an unknown session is a CLIENT fault, not a
            // server fault: the row cannot be written and retrying it verbatim
            // will never succeed, so the daemon needs a terminal answer rather
            // than the retriable 500 a raw FK violation would produce. Bare
            // `TRPCError` with no `aisError` envelope — the wire error codes are
            // a governed vocabulary and this condition has no catalogued row,
            // the same posture `session.join`'s self-check takes for its bare
            // `UNAUTHORIZED`.
            if (err instanceof UnknownAnchorSessionError) {
              throw new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
            }
            // Everything else rethrows unchanged. Notably a duplicate anchor is
            // NOT in this class: `ON CONFLICT DO NOTHING` absorbs it in the
            // store and returns `{ stored: false }`, which is a success arm.
            throw err;
          }
        }),
    }),
  });
}
