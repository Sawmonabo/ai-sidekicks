// One ephemeral-clone row of `repo.worktreeStatusRead`, drawn.
//
// A separate component from `WorktreeCard` rather than one card branching on a
// discriminant, because `RepoSection.tsx` draws two
// lists, side by side, with DIFFERENT columns, and the wire agrees: the two records
// share four column names out of ten and nine, one is mount-anchored while the
// other is workspace-anchored, and the clone record carries no `updatedAt` at all.
// A single card would be two cards behind an `if`, and the `if` would be the only
// thing standing between a clone row and a column it has no value for.
//
// WHAT THIS CARD ADDS that the worktree card has no equivalent of: the disposal
// countdown. This card puts `expiresAt` on the row rather than behind the disclosure,
// since disposal takes that clone's snapshot refs with it — the one fact on this
// surface that changes with nobody acting, which is exactly the fact that must not
// be one click away.
//
// AND THE COUNTDOWN GOES AWAY ONCE IT HAS NOTHING LEFT TO COUNT. `cleanedAt` is the
// sweep's own stamp, and a row carrying one is settled: its files are gone whatever
// the deadline said. So the reclaimed arm renders the stamp where the countdown was
// and states the disposition plainly, rather than reporting a swept clone with time
// left as awaiting disposal or hedging that a swept one's refs "may" be gone. Which
// arm a row is in is `cloneExpiryReading`'s, exactly as the two deadline arms are.
//
// THE COUNTDOWN NEVER TICKS. `nowMilliseconds` is a prop, the reading is a pure
// function of it, and `Spec-023 §Rules every console surface obeys`' "No interval
// polling" is therefore structural
// here: this file contains no timer and can contain none, because it owns no state
// to move.
//
// WHAT THIS CARD DOES NOT OFFER: no dispose control, for the retire control's
// reason on the worktree card — the dispose confirm is a consent surface that
// enumerates what disposal takes, and a card given no such preview must not stand
// in for one.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatRelativeTime,
} from "../../primitives/index.js";
import {
  CLONE_EXPIRY_COPY,
  CLONE_EXPIRY_TONE,
  EPHEMERAL_CLONE_COLUMN_LABELS,
  EPHEMERAL_CLONE_DETAIL_COLUMNS,
  EPHEMERAL_CLONE_STATE_PRESENTATION,
  cloneExpiryReading,
  ephemeralCloneColumnCell,
  type EphemeralCloneStatusRecord,
} from "./worktree-model.js";

export interface EphemeralCloneCardProps {
  readonly record: EphemeralCloneStatusRecord;
  /** The instant the surface read at. See `WorktreeCardProps` for why it is a prop. */
  readonly nowMilliseconds: number;
}

const CARD_GLYPH_SIZE = 14;

export function EphemeralCloneCard(props: EphemeralCloneCardProps): React.JSX.Element {
  const { record, nowMilliseconds } = props;
  const headingId = useId();
  const statePresentation = EPHEMERAL_CLONE_STATE_PRESENTATION[record.state];
  const expiry = cloneExpiryReading(record, nowMilliseconds);

  return (
    <article className="meridian-root-card" aria-labelledby={headingId}>
      <header className="meridian-root-card__head">
        <Glyph name="repo" size={CARD_GLYPH_SIZE} />
        <h4 className="meridian-root-card__title" id={headingId}>
          <WireFigure value={record.branchName} />
        </h4>
        <Chip
          tone={statePresentation.tone}
          label={record.state}
          mono
          glyph={record.state === "failed" ? "alert" : "dot"}
        />
      </header>

      <p className="meridian-root-card__meaning">{statePresentation.meaning}</p>

      <dl className="meridian-root-card__summary">
        <div className="meridian-root-card__pair">
          <dt>{EPHEMERAL_CLONE_COLUMN_LABELS.cloneRoot}</dt>
          <dd className="meridian-root-card__path" title={record.cloneRoot}>
            <WireFigure value={record.cloneRoot} />
          </dd>
        </div>
        <div className="meridian-root-card__pair">
          <dt>{EPHEMERAL_CLONE_COLUMN_LABELS.createdAt}</dt>
          <dd title={record.createdAt}>
            <DerivedFigure text={formatRelativeTime(record.createdAt, nowMilliseconds)} />
          </dd>
        </div>
        {/*
          THE STAMP DISPLACES THE COUNTDOWN RATHER THAN SITTING BESIDE IT. A reclaimed
          clone has no deadline left to count towards — the sweep already ran — and a
          row that showed both would be asking a reader to work out which of the two
          facts was the current one. Which pair renders is the disposal reading's, so
          the card decides nothing about it.
        */}
        {expiry === "reclaimed" && record.cleanedAt !== undefined ? (
          <div className="meridian-root-card__pair">
            <dt>{EPHEMERAL_CLONE_COLUMN_LABELS.cleanedAt}</dt>
            <dd title={record.cleanedAt}>
              <Chip
                tone={CLONE_EXPIRY_TONE[expiry]}
                glyph="dot"
                label={formatRelativeTime(record.cleanedAt, nowMilliseconds)}
              />
            </dd>
          </div>
        ) : (
          <div className="meridian-root-card__pair">
            <dt>{EPHEMERAL_CLONE_COLUMN_LABELS.expiresAt}</dt>
            <dd title={record.expiresAt}>
              <Chip
                tone={CLONE_EXPIRY_TONE[expiry]}
                glyph="clock"
                label={formatRelativeTime(record.expiresAt, nowMilliseconds)}
              />
            </dd>
          </div>
        )}
      </dl>

      <p className="meridian-root-card__disposition">{CLONE_EXPIRY_COPY[expiry]}</p>

      <details className="meridian-root-card__detail">
        <summary className="meridian-root-card__detail-summary">Provenance and cleanup</summary>
        <dl className="meridian-root-card__detail-list">
          {EPHEMERAL_CLONE_DETAIL_COLUMNS.map((column) => {
            const cell = ephemeralCloneColumnCell(record, column);
            return (
              <div className="meridian-root-card__pair" key={column}>
                <dt>{EPHEMERAL_CLONE_COLUMN_LABELS[column]}</dt>
                <dd>
                  {cell.kind === "value" ? (
                    <WireFigure value={cell.value} />
                  ) : (
                    <Nothing kind="empty" placement="inline" title={cell.copy} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    </article>
  );
}
