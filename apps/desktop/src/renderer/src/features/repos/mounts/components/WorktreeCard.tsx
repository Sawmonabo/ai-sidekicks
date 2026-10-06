// One worktree row of `repo.worktreeStatusRead`. Every column is the wire's own string; only
// the age is derived, and its exact stamp rides the element's `title`. Secondary facts sit in a
// native `<details>`, which keeps no per-row state. There is no retire control: its confirm
// needs an inspection preview this card is not given and must not fabricate.

import "./execution-root-cards.css";

import { useId } from "react";

import type { WorktreeStatusRecord } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatRelativeTime } from "#renderer/lib/wire/figures.js";
import { WORKTREE_STATE_TONES } from "../execution-roots/model.js";
import {
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_SUMMARY_COLUMNS,
  worktreeColumnCell,
  type WorktreeSummaryColumnKey,
} from "../execution-roots/columns.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/** A worktree status record, plus the instant the section read at. */
export interface WorktreeCardProps {
  readonly record: WorktreeStatusRecord;
  /** The instant the section read at; the age moves when the section re-reads, never on a timer. */
  readonly nowMilliseconds: number;
}

/** One worktree: branch, state, root, age, and a provenance disclosure. */
export function WorktreeCard(props: WorktreeCardProps): React.JSX.Element {
  const { record, nowMilliseconds } = props;
  const headingId = useId();

  return (
    <article className="meridian-root-card" aria-labelledby={headingId}>
      <header className="meridian-root-card__head">
        <Glyph name="worktree" size={GLYPH_SIZE_CHROME} />
        {/* The branch is the card's name, mono and verbatim: a daemon-derived ordinal suffix is
            shown as sent. */}
        <h4 className="meridian-root-card__title" id={headingId}>
          <WireFigure value={record.branchName} />
        </h4>
        <Chip
          tone={WORKTREE_STATE_TONES[record.state]}
          label={record.state}
          mono
          glyph={record.state === "failed" ? "alert" : "dot"}
        />
      </header>

      <dl className="meridian-root-card__summary">
        {WORKTREE_SUMMARY_COLUMNS.map((column) => (
          <div className="meridian-root-card__pair" key={column}>
            <dt>{WORKTREE_COLUMN_LABELS[column]}</dt>
            {summaryCell(record, column, nowMilliseconds)}
          </div>
        ))}
      </dl>

      <details className="meridian-root-card__detail">
        <summary className="meridian-root-card__detail-summary">Provenance</summary>
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
                    // A real producer state, not a gap: the model's copy says which one.
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

/** One summary row's value: the root verbatim, or the age read relatively. */
function summaryCell(
  record: WorktreeStatusRecord,
  column: WorktreeSummaryColumnKey,
  nowMilliseconds: number,
): React.JSX.Element {
  switch (column) {
    case "fsRoot":
      return (
        <dd className="meridian-root-card__path" title={record.fsRoot}>
          <WireFigure value={record.fsRoot} />
        </dd>
      );
    case "createdAt":
      // `title` carries the exact stamp beside the derived reading.
      return (
        <dd title={record.createdAt}>
          <DerivedFigure text={formatRelativeTime(record.createdAt, nowMilliseconds)} />
        </dd>
      );
  }
}
