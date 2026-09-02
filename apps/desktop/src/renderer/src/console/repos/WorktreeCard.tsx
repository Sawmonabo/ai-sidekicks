// One worktree row of `repo.worktreeStatusRead`, drawn.
//
// `Spec-023 §Console Design (Meridian)` §10.3 §Density: "Each list shows state,
// branch, root, and age. Provenance and cleanup columns collapse behind a row
// disclosure." That is the whole shape of this card, and the split is the design's
// rather than a layout convenience — provenance is what a retired row still has to
// prove, so it is one interaction away and never dropped.
//
// THE DISCLOSURE IS A NATIVE `<details>`. Keyboard reachable, labelled, and
// focus-visible without a line of code, and — the reason that matters more than the
// convenience — it holds no state. A card with its own open/closed `useState` would
// be per-row state beside the session store for a fact the platform already keeps,
// and a list of them would re-render on every toggle.
//
// EVERY COLUMN IS THE WIRE'S OWN STRING. Ten columns, and the card computes none of
// them: `worktree-model.ts` says why (no derived branch name, no derived checkout
// root, no snapshot refs in a branch column). The one reading the card DOES derive
// is the age, which is two instants the console holds put through
// `formatRelativeTime` — and the exact stamp rides the same element's `title`, so
// no formatted figure hides the value the daemon sent.
//
// WHAT THIS CARD DOES NOT OFFER, and why none of it is an omission:
//   • No retire control. The retire confirm is the strongest interaction on §10.3's
//     surface and it enumerates the candidate's branch, its uncommitted files, its
//     unmerged commits, and any inspection failure — a preview this card is not
//     given and must not fabricate. Preview is consent, so the control belongs to
//     the surface that can run the inspection.
//   • No force-retire, force-detach, or boundary-obstruction override. The design
//     names a force-override a possible future enhancement, deliberately not
//     scheduled.
//   • No branch switch. The daemon never checks out, creates, or switches a branch
//     inside a bound checkout; a mismatch is a typed refusal with no action on it.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatRelativeTime,
} from "../primitives/index.js";
import {
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_DISK_DISPOSITION_COPY,
  WORKTREE_STATE_PRESENTATION,
  worktreeColumnCell,
  worktreeDiskDisposition,
  type WorktreeStatusRecord,
} from "./worktree-model.js";

export interface WorktreeCardProps {
  readonly record: WorktreeStatusRecord;
  /**
   * The instant the surface read at.
   *
   * A prop rather than a clock this card reaches for, because §10.3 forbids polling
   * on this surface: the age moves when the surface re-reads and at no other time,
   * and a card that read the wall clock would move it on any unrelated re-render.
   */
  readonly nowMilliseconds: number;
}

const CARD_GLYPH_SIZE = 14;

export function WorktreeCard(props: WorktreeCardProps): React.JSX.Element {
  const { record, nowMilliseconds } = props;
  const headingId = useId();
  const statePresentation = WORKTREE_STATE_PRESENTATION[record.state];
  const disposition = worktreeDiskDisposition(record);

  return (
    <article className="meridian-root-card" aria-labelledby={headingId}>
      <header className="meridian-root-card__head">
        <Glyph name="worktree" size={CARD_GLYPH_SIZE} />
        {/*
          The branch is the card's name. Mono and verbatim, suffix included: a
          daemon-derived name that took an ordinal suffix is displayed as it was
          sent, and nothing here re-suffixes a participant's own.
        */}
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
          <dt>{WORKTREE_COLUMN_LABELS.fsRoot}</dt>
          <dd className="meridian-root-card__path" title={record.fsRoot}>
            <WireFigure value={record.fsRoot} />
          </dd>
        </div>
        <div className="meridian-root-card__pair">
          <dt>{WORKTREE_COLUMN_LABELS.createdAt}</dt>
          {/*
            `title` carries the exact stamp beside the console's own reading of it,
            which is the eight rules' requirement that no formatted figure hides the
            value the daemon sent.
          */}
          <dd title={record.createdAt}>
            <DerivedFigure text={formatRelativeTime(record.createdAt, nowMilliseconds)} />
          </dd>
        </div>
      </dl>

      {disposition === "live" ? null : (
        <p className="meridian-root-card__disposition">
          <Glyph name={disposition === "reclaimed" ? "check" : "clock"} size={CARD_GLYPH_SIZE} />
          {WORKTREE_DISK_DISPOSITION_COPY[disposition]}
        </p>
      )}

      <details className="meridian-root-card__detail">
        <summary className="meridian-root-card__detail-summary">Provenance and cleanup</summary>
        <dl className="meridian-root-card__detail-list">
          {WORKTREE_DETAIL_COLUMNS.map((column) => {
            const cell = worktreeColumnCell(record, column);
            return (
              <div className="meridian-root-card__pair" key={column}>
                <dt>{WORKTREE_COLUMN_LABELS[column]}</dt>
                <dd>
                  {cell.kind === "value" ? (
                    <WireFigure value={cell.value} />
                  ) : (
                    // A real producer state, not a gap: the model's copy says which
                    // one. `empty` is the absence kind for "the read succeeded and
                    // there is none", which is exactly what an omitted column is.
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
