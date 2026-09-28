// `createEventAnchorRouter` factory.
//
// One procedure, `eventanchor.upload`: the daemon's write path for the
// integrity witness. Nested under the `eventanchor` namespace so the on-wire
// method name matches the directory it lives in, spelled as one lowercase word.
// It is deliberately NOT `event.*`: that namespace belongs to the daemon-side
// JSON-RPC surface, a different transport carrying different methods, and
// colliding on it would make method names ambiguous across the two registries.
//
// A MUTATION, not a query: it writes. There is no read counterpart: the control
// plane stores anchors so an audit reader can verify a log it obtains from the
// daemon, and that read path has no consumer yet.
//
// Built on the shared `t` builder (`../sessions/trpc.js`), not a fresh
// `initTRPC`, so the router carries the host's context type.
//
// This factory imports no `pg` / `Pool` / `Client` / `Querier`; the injected
// `EventLogAnchorStore` owns all SQL.
//
// ----------------------------------------------------------------------------
// At the transport boundary
// ----------------------------------------------------------------------------
//
// `.input(AnchorPayloadSchema)` is the same `.strict()` seven-member schema the
// daemon signs against, so a request body carrying `payload`, `events`, or
// `pii_payload` is REFUSED with a `BAD_REQUEST` before any handler code runs —
// it is not accepted-then-stripped. That refusal is the wire-level half of the
// metadata-only invariant; the store re-parses the same schema as the
// storage-level half, because a boundary invariant asserted at exactly one layer
// stops being asserted the moment someone adds a second caller.
//

import {
  type TRPCBuiltRouter,
  type TRPCDecorateCreateRouterOptions,
  type TRPCDefaultErrorShape,
  type TRPCMutationProcedure,
} from "@trpc/server";
import {
  AnchorPayloadSchema,
  EventAnchorUploadResponseSchema,
  type AnchorPayload,
  type EventAnchorUploadResponse,
} from "@ai-sidekicks/contracts";

import { t, type SessionRouterContext } from "../sessions/trpc.js";
import type { EventLogAnchorStore } from "./anchor-store.js";

/**
 * Event-anchor router deps: the concrete anchor store the procedure closes over.
 *
 * Depending on the concrete class rather than a structural interface is
 * deliberate: the class has a private field, so TypeScript treats it nominally
 * and the production placeholder must construct the REAL class with a throwing
 * `Querier`; a structural stub cannot satisfy the type without an
 * `as unknown as` double-cast that would mask future drift.
 *
 * This procedure carries no user-identity check: that check needs token
 * verification, which is not built yet (the daemon side of the same seam is the
 * `DaemonCredentialProvider`, which refuses every mint). Until then the host's
 * dual gate intercepts all production traffic.
 */
export interface EventAnchorRouterDeps {
  readonly anchorStore: EventLogAnchorStore;
}

/**
 * The router type, written by hand because `--isolatedDeclarations` cannot emit
 * a stable `.d.ts` for `createEventAnchorRouter` without it.
 */
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
        input: AnchorPayload;
        output: EventAnchorUploadResponse;
        meta: object;
      }>;
    };
  }>
>;

/** Builds the `eventanchor` router over the injected anchor store. */
export function createEventAnchorRouter(deps: EventAnchorRouterDeps): EventAnchorRouter {
  const eventAnchorProcedure = t.procedure;

  return t.router({
    eventanchor: t.router({
      upload: eventAnchorProcedure
        .input(AnchorPayloadSchema)
        .output(EventAnchorUploadResponseSchema)
        .mutation(({ input }) => deps.anchorStore.upload(input)),
    }),
  });
}
