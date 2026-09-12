// The part of the session header that needs an open store.
//
// Its own module for the one-component rule, and it was already its own component for
// a reason the rule agrees with: a hook cannot run conditionally, so folding this into
// the header would mean either subscribing to a store that may be `undefined` or
// rendering the session's identity only after the session opened.

import { useMemo } from "react";

import { SessionHeaderSpend } from "./SessionHeaderSpend.js";
import { type SessionHeaderSpendReading } from "./model/session-header-readings.js";
import { type SessionHeaderReadState } from "./model/session-header-read-projection.js";
import { deriveSessionHeader } from "./model/session-header-model.js";
import { useSessionStore, type SessionStore } from "../../store/index.js";

export interface SessionHeaderBodyProps {
  readonly sessionStore: SessionStore;
  /**
   * The accountant's figure, put by the header above.
   *
   * Handed down rather than read here, because the read is keyed on the SESSION and
   * this component is mounted only once the session's store has opened — putting it
   * here would tie a question about the session to the arrival of its store, and a
   * header whose store never opened would never ask.
   */
  readonly spend: SessionHeaderReadState<SessionHeaderSpendReading>;
  /**
   * Whether the header's own health verdict says a component needs somebody.
   *
   * A boolean rather than the verdict itself, for two reasons that point the same way:
   * this component renders none of the reading — the mark above it does — and the
   * value joins the memo the model is derived under, where a fresh object every render
   * would rebuild the header on every frame.
   */
  readonly isNodeHealthUnwell: boolean;
}

/** What is still outstanding, and the session's committed spend. */
export function SessionHeaderBody(props: SessionHeaderBodyProps): React.JSX.Element {
  const degradedCause = useSessionStore(props.sessionStore, (state) => state.degradedCause);
  // The register is not on the committed state, so its reading is taken from the store
  // and the SUBSCRIPTION is to the revision — which is exact rather than approximate:
  // every act that advances the ledger (a base state, an admitted batch, a recovered
  // backward page) commits a state and bumps this, and no act bumps it without having
  // offered the register its rows first. A mirror on the state would be a second copy
  // of a value whose whole point is that it outlives what the state holds.
  const projectionRevision = useSessionStore(props.sessionStore, (state) => state.revision);

  // Derived under `useMemo` rather than inside the selector: a selector that BUILT
  // a value would defeat zustand's `Object.is` comparison and re-render the header
  // every frame, which is the one thing `store/session/session-hooks.ts` asks callers
  // not to do.
  const model = useMemo(
    () =>
      deriveSessionHeader({
        outstandingAsks: props.sessionStore.outstandingAskLedger,
        isDegraded: degradedCause !== undefined,
        isNodeUnwell: props.isNodeHealthUnwell,
      }),
    [projectionRevision, props.sessionStore, degradedCause, props.isNodeHealthUnwell],
  );

  return (
    <span className="meridian-session-header__all-clear">
      {/* One slot, four answers, and the third is why it is not a boolean: a window
          that opened partway through its log has requests the console was never sent,
          so "Nothing needs you." would be a claim about rows it never read. The
          unread arm names the ledger's own "Load earlier" control rather than minting
          a second one — this strip has no paging of its own and should not grow one
          to explain a gap the ledger already closes. */}
      {model.standing === "all-clear" ? (
        <span className="meridian-session-header__all-clear-line">Nothing needs you.</span>
      ) : null}
      {model.standing === "earlier-unread" ? (
        <span className="meridian-session-header__all-clear-line">
          Requests from before this window are not counted here. Load earlier in the ledger to
          include them.
        </span>
      ) : null}
      {/* The fourth answer says WHO is waiting: the register's own count, and only
          where there is one. `attention` is also reached by a degraded projection and
          by an unwell node, and neither is an ask — those are reported by the banner
          above and by the health mark beside this line. */}
      {model.outstandingAskCount === 0 ? null : (
        <span className="meridian-session-header__all-clear-line">
          {outstandingAskLine(model.outstandingAskCount)}
        </span>
      )}
      {/* The figure the accountant settled, or the honest absence where it did not
          answer. `SessionHeaderSpend.tsx` owns both arms; nothing is summed on either. */}
      <SessionHeaderSpend spend={props.spend} />
    </span>
  );
}

/**
 * How the outstanding count reads.
 *
 * The exact negation of the all-clear line, because the two answer one question: while
 * "Nothing needs you." is absent, this is what says how much.
 */
function outstandingAskLine(outstandingAskCount: number): string {
  return outstandingAskCount === 1
    ? "1 request is waiting on you."
    : `${String(outstandingAskCount)} requests are waiting on you.`;
}
