// Which window this is, for the one terminal decision that needs it.
//
// WHY THE LEASE CANNOT DO WITHOUT IT. `lease-model.ts` tells `held-by-you` from
// `held-by-another` by comparing the wire's holder against this window, and the pane
// used to hand that fold a hard-coded `undefined`. Every take therefore classified as
// somewhere else's: the window the daemon had just granted the lease to kept being
// offered "Claim the shell", had no way to release it, and watched the emulator stay
// read-only. The fold was right and its input was a placeholder.
//
// THE READ IS THE PORT'S. `bridge/growth-operations/identity.ts`'s
// `callerUserRead` is the console's one answer to "which identity is this
// window", and this module takes that identifier and nothing else.
//
// SETTLED IDENTITIES BELONG TO THE INPUTS THAT PRODUCED THEM. A pane handed a
// different bridge or a different session gets a different answer, and the previous one
// must not stand in the interval before the replacement lands — so the reading is held
// for its `(bridge, sessionId)` subject by the console's one holder, which reverts it
// to `not-loaded` on the pass that first sees the new inputs rather than reporting the
// old window's identity against the new session's log.

import { useEffect } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection, type ConsoleRefusal } from "../../core/index.js";
import { useSubjectScopedState } from "../../store/index.js";

/**
 * Which window this is, or why the console cannot say.
 *
 * Three arms rather than `string | undefined`, because a surface gating a control on
 * this window's identity has three genuinely different situations and only one of them
 * is an answer. Collapsing the other two would offer the claim control on an identity
 * nothing established — which is the same failure as the hard-coded device, reached
 * from the other side.
 */
export type TerminalViewerIdentity =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly userId: string }
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
    "The console asked which user this window is and the bridge never answered. Reopening this pane asks again.",
} as const;

/**
 * Read which identity this window carries, once per bridge-and-session pair.
 *
 * The refusal the port answers with is carried through untouched — it is already a
 * `ConsoleRefusal`, and it names the wire that is missing — so the surface renders
 * the wire's own sentence rather than one this module wrote.
 */
export function useTerminalViewerIdentity(
  bridge: ConsoleBridge,
  sessionId: string,
): TerminalViewerIdentity {
  const { value: identity, publish } = useSubjectScopedState<TerminalViewerIdentity>(
    bridge,
    sessionId,
    () => NOT_LOADED_VIEWER_IDENTITY,
  );

  useEffect(() => {
    let isAbandoned = false;
    void bridge.growth
      .callerUserRead({ sessionId })
      .then((outcome) => {
        if (isAbandoned) {
          return;
        }
        publish(
          outcome.status === "served"
            ? { status: "read", userId: outcome.value.userId }
            : { status: "refused", refusal: outcome },
        );
      })
      .catch((failure: unknown) => {
        if (isAbandoned) {
          return;
        }
        publish({
          status: "refused",
          refusal: normalizeWireRejection(
            VIEWER_IDENTITY_REFUSAL_ORIGIN,
            failure,
            VIEWER_IDENTITY_REJECTION_FALLBACK,
          ),
        });
      });
    return () => {
      // The pane closed, or an input changed, before the read landed. Settling
      // afterwards would publish a stale window's user into a fresh one.
      isAbandoned = true;
    };
  }, [bridge, publish, sessionId]);

  return identity;
}
