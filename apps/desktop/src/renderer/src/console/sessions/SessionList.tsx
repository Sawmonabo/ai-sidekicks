// The all-sessions list: one row per session, in two tiers.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list. What the rows may and
// may not claim is the whole of this file's difficulty, and four rules carry it:
//
//   • **No invented name.** `SessionSnapshot` has `config` and `metadata` bags and
//     no name column, so a session renders by its identifier and its participants.
//     The identifier is a wire figure and wears the mono provenance signature; a
//     console-composed title beside it would be prose paraphrasing a figure.
//   • **State verbatim.** The chip carries the wire's own string in mono. The
//     console classifies it exactly once — to know whether the row is an audit stub
//     — and never re-words it.
//   • **No control without a verb.** Rename, archive, close, and reactivate are on
//     the growth slate and are therefore not drawn. Drawing them disabled would be
//     the same capability claim with a tooltip on it.
//   • **Attention is read, never counted.** The severity on a row comes from the
//     attention projection. A row the projection did not mention shows nothing,
//     which is not the same as showing "clear".
//
// THE TIER CONTROL IS THE ROW CONTEXT MENU THE DESIGN NAMES, carrying pin,
// move-to-other-tier, and unpin. With exactly two tiers and the back tier as the
// default those three acts have two outcomes — "unpin" and "move to the back tier"
// are one move — so the menu offers the one move that would change something and
// states where the row currently SITS beside it. That second line is why the single
// toggle it replaced was not enough: its label was the only evidence of which tier a
// row was in, and the evidence disappeared with the pointer.
//
// NO VIRTUALIZATION, AND THAT IS THE BOUND RATHER THAN A GAP. The front tier holds
// what a person pinned and the back tier folds past
// `SESSION_BACK_TIER_VISIBLE_CAP` into a disclosure, so the number of mounted rows
// is bounded by a constant no matter how many sessions the console holds. Rows are
// memoised on top of that, so a change to one row's attention re-renders one row.

import { useMemo } from "react";

import { formatCount } from "../primitives/index.js";
import { SESSION_BACK_TIER_VISIBLE_CAP } from "../core/index.js";
import { foldIntoTiers, type SessionListRow, type SessionPinTier } from "./rows/session-rows.js";
import type { SessionPinMap } from "./rows/session-pins.js";
import { SessionRowGroup } from "./SessionRowGroup.js";

export interface SessionListProps {
  readonly rows: readonly SessionListRow[];
  readonly tierBySessionId: SessionPinMap;
  /** Open a session. Renderer-local navigation. */
  readonly onOpen: (sessionId: string) => void;
  /** Move one session between the two tiers. */
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}

export function SessionList(props: SessionListProps): React.JSX.Element {
  const { rows, tierBySessionId } = props;
  // Derivation under `useMemo`, never in the render body's own statements: the
  // fold sorts two arrays, and a list re-rendered by a neighbour's attention change
  // should not pay for it again.
  const tiers = useMemo(() => foldIntoTiers(rows, tierBySessionId), [rows, tierBySessionId]);
  const visibleBack = tiers.back.slice(0, SESSION_BACK_TIER_VISIBLE_CAP);
  const foldedBack = tiers.back.slice(SESSION_BACK_TIER_VISIBLE_CAP);

  return (
    <div className="meridian-session-list">
      {tiers.front.length === 0 ? null : (
        <SessionRowGroup
          label="Pinned to the front"
          rows={tiers.front}
          onOpen={props.onOpen}
          onSetTier={props.onSetTier}
        />
      )}
      {/* The divider is drawn only when there is something on both sides of it: a
          rule under an empty tier is furniture standing in for a boundary that is
          not there. */}
      {tiers.front.length === 0 || tiers.back.length === 0 ? null : (
        <hr className="meridian-session-list__divider" />
      )}
      {tiers.back.length === 0 ? null : (
        <SessionRowGroup
          label="Everything else"
          rows={visibleBack}
          onOpen={props.onOpen}
          onSetTier={props.onSetTier}
        />
      )}
      {foldedBack.length === 0 ? null : (
        <details className="meridian-session-list__fold">
          <summary className="meridian-session-list__fold-summary">
            {`${formatCount(foldedBack.length)} more`}
          </summary>
          <SessionRowGroup
            label="Folded"
            rows={foldedBack}
            onOpen={props.onOpen}
            onSetTier={props.onSetTier}
          />
        </details>
      )}
    </div>
  );
}
