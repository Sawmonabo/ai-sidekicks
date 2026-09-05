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
// THE TIER CONTROL IS ONE BUTTON, NOT A MENU. The design names a row context menu
// carrying pin, move-to-other-tier, and unpin. With exactly two tiers and the back
// tier as the default, those three acts have two outcomes: a row is in the front
// tier or it is not, and "unpin" and "move to the back tier" are the same act. So
// the row carries a single toggle labelled by what pressing it will do, revealed on
// hover and on `:focus-within` so a keyboard reaches it, and no menu is drawn to
// hold one live item and one no-op.
//
// NO VIRTUALIZATION, AND THAT IS THE BOUND RATHER THAN A GAP. The front tier holds
// what a person pinned and the back tier folds past
// `SESSION_BACK_TIER_VISIBLE_CAP` into a disclosure, so the number of mounted rows
// is bounded by a constant no matter how many sessions the console holds. Rows are
// memoised on top of that, so a change to one row's attention re-renders one row.

import { memo, useMemo } from "react";

import { Chip, Nothing, WireFigure, formatCount, formatDateTime } from "../primitives/index.js";
import { SESSION_BACK_TIER_VISIBLE_CAP } from "../core/index.js";
import {
  foldIntoTiers,
  isAuditStubSession,
  type PlacedSessionRow,
  type SessionListRow,
  type SessionPinTier,
} from "./rows/session-rows.js";
import type { SessionPinMap } from "./rows/session-pins.js";

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

function SessionRowGroup(props: {
  readonly label: string;
  readonly rows: readonly PlacedSessionRow[];
  readonly onOpen: (sessionId: string) => void;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}): React.JSX.Element {
  return (
    <ul className="meridian-session-list__rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.sessionId}>
          <SessionRow row={row} onOpen={props.onOpen} onSetTier={props.onSetTier} />
        </li>
      ))}
    </ul>
  );
}

interface SessionRowProps {
  readonly row: PlacedSessionRow;
  readonly onOpen: (sessionId: string) => void;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}

/**
 * One row.
 *
 * Memoised, so a projection read that changes one session's attention re-renders
 * that row and not its neighbours. The comparison is the default shallow one and
 * that is sufficient here: `rows` is rebuilt from the store's own references, and
 * both callbacks are stable for the life of the surface.
 */
const SessionRow = memo(function SessionRow(props: SessionRowProps): React.JSX.Element {
  const { row } = props;
  const isAuditStub = isAuditStubSession(row.state);
  return (
    <div
      className={`meridian-session-row${isAuditStub ? " meridian-session-row--audit-stub" : ""}`}
    >
      <div className="meridian-session-row__identity">
        {isAuditStub ? (
          <span className="meridian-session-row__name">
            <WireFigure value={row.sessionId} />
          </span>
        ) : (
          <button
            type="button"
            className="meridian-session-row__name meridian-session-row__name--open"
            onClick={() => {
              props.onOpen(row.sessionId);
            }}
          >
            <WireFigure value={row.sessionId} />
          </button>
        )}
        <SessionRowFacts row={row} />
      </div>
      {/* An audit stub gets no controls at all. It is a retention record rather
          than work, and the retention read-out is another surface's. */}
      {isAuditStub ? null : (
        <TierToggle sessionId={row.sessionId} tier={row.tier} onSetTier={props.onSetTier} />
      )}
    </div>
  );
});

/**
 * A row's facts, including the instant it was last touched.
 *
 * THAT INSTANT CARRIES ITS DAY. The list groups by tier and by nothing else — it
 * has no day divider and cannot grow one, since the tiers are what a person pinned
 * — so a clock-only reading made a session touched an hour ago and one touched last
 * week at the same minute the same eight characters, and the sort order was the only
 * thing left saying which was which. `formatDateTime` exists for exactly the surface
 * that has no other carrier of the day, and says so in its own words.
 */
function SessionRowFacts(props: { readonly row: PlacedSessionRow }): React.JSX.Element {
  const { row } = props;
  return (
    <div className="meridian-session-row__facts">
      {row.state === undefined ? (
        <Nothing
          kind="not-checked"
          title="No state"
          detail="The wire named none for this session."
        />
      ) : (
        <Chip label={row.state} mono />
      )}
      {row.attentionSeverity === undefined ? null : (
        <Chip
          tone={row.attentionSeverity === "actionable" ? "attention" : "neutral"}
          label={row.attentionSeverity === "actionable" ? "Needs you" : "Something happened"}
        />
      )}
      {row.touchedAtIso === undefined ? null : (
        <WireFigure value={formatDateTime(row.touchedAtIso)} title={row.touchedAtIso} />
      )}
      {row.participantIds.length === 0 ? null : (
        <span className="meridian-session-row__participants">
          {row.participantIds.map((participantId) => (
            <WireFigure key={participantId} value={participantId} />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The tier control.
 *
 * Labelled by the act rather than by the state, so a screen reader hears what
 * pressing it does. Revealed on hover and on `:focus-within` (see the stylesheet)
 * and never removed from the tab order while hidden, because a control a pointer
 * can reach and a keyboard cannot is not a control.
 */
function TierToggle(props: {
  readonly sessionId: string;
  readonly tier: SessionPinTier;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}): React.JSX.Element {
  const isPinnedToFront = props.tier === "front";
  const label = isPinnedToFront ? "Move to the back tier" : "Pin to the front tier";
  return (
    <button
      type="button"
      className="meridian-session-row__tier"
      aria-label={label}
      title={label}
      onClick={() => {
        props.onSetTier(props.sessionId, isPinnedToFront ? "back" : "front");
      }}
    >
      {isPinnedToFront ? "Unpin" : "Pin"}
    </button>
  );
}
