// Which participant this window is, for the one terminal decision that needs it.
//
// WHY THE LEASE CANNOT DO WITHOUT IT. `lease-model.ts` tells `held-by-you` from
// `held-by-another` by comparing the wire's holder against the viewer, and the pane
// used to hand that fold a hard-coded `undefined`. Every take therefore classified
// as somebody else's: the participant the daemon had just granted the lease to kept
// being offered "Claim the shell", had no way to release it, and watched the
// emulator stay read-only. The fold was right and its input was a placeholder.
//
// THE READ IS THE PORT'S. `bridge/growth-operations.ts`'s `callerParticipantRead` is
// the console's one answer to "which entry in this session's roster is this window",
// and the row deliberately carries no role — the roster already holds every member's
// role, and a second copy on this reply would be two sources of truth for it. This
// module takes the identifier and nothing else.
//
// WHY THIS IS NOT `store/hooks.ts`'s `useCallerMembershipRole`. That hook answers a
// ROLE: it chains the same read to a roster lookup, and it takes the read as an
// injected function because `store/` sits BELOW `bridge/` on the console's DAG and
// may not reach a port at all. The terminal pane is a view family and may, so the
// bridge is taken directly and no adapter is invented for it — and what this surface
// gates on is the identity itself rather than a role, so folding a roster lookup in
// would be reading a partition to answer a question it is not about.
//
// SETTLED IDENTITIES BELONG TO THE INPUTS THAT PRODUCED THEM, which is that hook's
// rule and holds here for its reason. A pane handed a different bridge or a
// different session gets a different answer, and the previous one must not stand in
// the interval before the replacement lands: comparing the stamp during render is
// what makes the reading revert to `not-loaded` on the pass that first sees the new
// inputs, rather than reporting the old window's participant against the new
// session's log.

import { useEffect, useState } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { refusalFromRejection, type ConsoleRefusal } from "../core/index.js";

/**
 * Who this window is, or why the console cannot say.
 *
 * Three arms rather than `string | undefined`, because a surface gating a control on
 * the viewer's identity has three genuinely different situations and only one of
 * them is an answer. Collapsing the other two would offer the claim control on an
 * identity nothing established — which is the same failure as the hard-coded viewer,
 * reached from the other side.
 */
export type TerminalViewerIdentity =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly participantId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The state before the read lands, as one frozen value.
 *
 * A fresh literal per render would change identity on every pass, and the pane keys
 * a `useMemo` on this — so the lease fold would re-run for a reading that had not
 * moved.
 */
const NOT_LOADED_VIEWER_IDENTITY: TerminalViewerIdentity = { status: "not-loaded" };

/**
 * The subsystem name a rejection raised by this read carries.
 *
 * `core/refusal.ts` is the console's one normalizer, and `origin` is what lets a
 * refusal surfacing on the lease line still name where it was raised.
 */
const VIEWER_IDENTITY_REFUSAL_ORIGIN = "terminal-viewer-identity";

/**
 * What a rejection carrying no code of its own says instead.
 *
 * The port ANSWERS a refusal, so a rejection means the bridge itself never got
 * there. Naming the next move beats reporting a transport's message about a channel
 * a person cannot see.
 */
const VIEWER_IDENTITY_REJECTION_FALLBACK = {
  code: "terminal-viewer-identity-unreachable",
  detail:
    "The console asked which participant this window is and the bridge never answered. Reopening this pane asks again.",
} as const;

/**
 * Read which participant this window is, once per bridge-and-session pair.
 *
 * The refusal the port answers with is carried through untouched — it is already a
 * `ConsoleRefusal`, and it names the wire that is missing — so the surface renders
 * the wire's own sentence rather than one this module wrote.
 */
export function useTerminalViewerIdentity(
  bridge: ConsoleBridge,
  sessionId: string,
): TerminalViewerIdentity {
  const [reading, setReading] = useState<ViewerIdentityReading | undefined>(undefined);

  useEffect(() => {
    let isAbandoned = false;
    void bridge.growth
      .callerParticipantRead({ sessionId })
      .then((outcome) => {
        if (isAbandoned) {
          return;
        }
        setReading({
          bridge,
          sessionId,
          identity:
            outcome.status === "served"
              ? { status: "read", participantId: outcome.value.participantId }
              : { status: "refused", refusal: outcome },
        });
      })
      .catch((failure: unknown) => {
        if (isAbandoned) {
          return;
        }
        setReading({
          bridge,
          sessionId,
          identity: {
            status: "refused",
            refusal: refusalFromRejection(
              VIEWER_IDENTITY_REFUSAL_ORIGIN,
              failure,
              VIEWER_IDENTITY_REJECTION_FALLBACK,
            ),
          },
        });
      });
    return () => {
      // The pane closed, or an input changed, before the read landed. Settling
      // afterwards would publish a stale window's participant into a fresh one.
      isAbandoned = true;
    };
  }, [bridge, sessionId]);

  return reading !== undefined && reading.bridge === bridge && reading.sessionId === sessionId
    ? reading.identity
    : NOT_LOADED_VIEWER_IDENTITY;
}

/** A settled identity together with the inputs it was read against. */
interface ViewerIdentityReading {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly identity: TerminalViewerIdentity;
}
