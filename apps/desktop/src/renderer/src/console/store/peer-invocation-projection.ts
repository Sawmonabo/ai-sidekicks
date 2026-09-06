// Whether one session's projection reports the peer-invocation grant, and the
// subscription that follows it.
//
// WHY IT LIVES IN THIS FAMILY RATHER THAN BESIDE ITS FIRST SURFACE. The fold reads
// a member off the SESSION partition of the projection — this family's own row type,
// this family's own subscription path — and it now has two readers in two different
// view families: the agent console draws the control the grant belongs to, and the
// ledger's empty window says why a session where the grant is off holds no handoff
// rows. View families are siblings and one may not import another, so a reader that
// stayed in the first family would have forced the second to write the fold again —
// and a fold written twice is a fold that drifts, in the direction that matters:
// one copy answering `false` for an absent member presents an enabled session as
// safe.
//
// WHAT DOES NOT LIVE HERE. The RE-READ — the scheduler, the bridge call, the refusal
// it renders — stays with the control that offers it. This family sits below
// `bridge/` and may not reach a port at all, so the read that refreshes the
// projection belongs to a family that can, and what is hoisted is only the reading.

import { useMemo } from "react";

import { type ConsoleEntity } from "./entities.js";
import { useSessionPartition } from "./hooks.js";
import { type SessionStore } from "./session-store.js";

/**
 * Whether one session's projection reports the peer-invocation grant.
 *
 * `undefined` for BOTH an absent member and a member of the wrong type, which is
 * the honest fold: neither says the grant is off, and rendering `false` for either
 * would present an enabled session as safe.
 */
export function peerInvocationEnabledIn(
  sessionPartition: Readonly<Record<string, ConsoleEntity>>,
  sessionId: string,
): boolean | undefined {
  const projected = sessionPartition[sessionId]?.body?.["peerInvocationEnabled"];
  return typeof projected === "boolean" ? projected : undefined;
}

/**
 * One reading of the grant, and the projected row it was read from.
 *
 * The row travels beside the value because a surface holding a local settlement
 * has to know when the projection MOVED, and the value alone cannot say: a grant
 * that goes off and back on again reads identical at both ends, and a re-read that
 * answers the same way is still the daemon speaking more recently than any reply
 * this pane is remembering. The row is compared by identity and never read — the
 * store replaces it on every mutation of the session partition and on every
 * initialising read, which is exactly the set of moments that supersede a reply.
 */
export interface PeerInvocationProjection {
  readonly enabled: boolean | undefined;
  readonly source: ConsoleEntity | undefined;
}

/** What a mount with no store to subscribe to reads. Nothing was projected. */
export const NOTHING_PROJECTED: PeerInvocationProjection = {
  enabled: undefined,
  source: undefined,
};

/** One session's projected peer-invocation grant, as a subscription. */
export function usePeerInvocationProjection(sessionStore: SessionStore): PeerInvocationProjection {
  const sessionPartition = useSessionPartition(sessionStore, "session");
  const { sessionId } = sessionStore;
  return useMemo(
    () => ({
      enabled: peerInvocationEnabledIn(sessionPartition, sessionId),
      source: sessionPartition[sessionId],
    }),
    [sessionPartition, sessionId],
  );
}
