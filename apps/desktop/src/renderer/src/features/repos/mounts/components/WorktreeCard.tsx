// One worktree row of `repo.worktreeStatusRead`. Every column is the wire's own string but the
// state, which reads as words, and the age, which is derived, with its machine-clock time as its
// hover label.
// Secondary facts sit in a native `<details>`, which keeps no per-row state. A worktree the person
// made carries no record, so its card is the branch and the folder alone. There is no retire
// control: its confirm needs an inspection preview this card is not given and must not fabricate.

import "./WorktreeCard.css";

import { useId } from "react";

import type { WorktreeStatusRecord } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatRelativeTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { WORKTREE_STATE_TONES } from "../execution-roots/state-tones.js";
import {
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
  WORKTREE_SUMMARY_COLUMNS,
  worktreeColumnCell,
  type AppMadeWorktree,
  type WorktreeSummaryColumnKey,
} from "../execution-roots/columns.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** A worktree status record, plus the instant the section read at. */
export interface WorktreeCardProps {
  readonly record: WorktreeStatusRecord;
  /** The instant the section read at; the age moves when the section re-reads, never on a timer. */
  readonly nowMilliseconds: number;
}

/**
 * One worktree: branch, state, root, age, and a provenance disclosure; one the person made shows
 * its branch and root alone.
 */
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
        {record.madeBy === "app" ? (
          <Chip
            tone={WORKTREE_STATE_TONES[record.state]}
            label={codeWords(record.state)}
            glyph={record.state === "failed" ? "alert" : "dot"}
          />
        ) : null}
      </header>

      {record.madeBy === "app" ? (
        <AppMadeWorktreeFacts record={record} nowMilliseconds={nowMilliseconds} />
      ) : (
        <dl className="meridian-root-card__summary">
          <div className="meridian-root-card__pair">
            <dt>{WORKTREE_COLUMN_LABELS.path}</dt>
            {rootCell(record.path)}
          </div>
        </dl>
      )}
    </article>
  );
}

/** The summary rows and the provenance disclosure of a worktree the app made. */
function AppMadeWorktreeFacts(props: {
  readonly record: AppMadeWorktree;
  readonly nowMilliseconds: number;
}): React.JSX.Element {
  const { record, nowMilliseconds } = props;
  const clockLocale = useClockLocale();
  return (
    <>
      <dl className="meridian-root-card__summary">
        {WORKTREE_SUMMARY_COLUMNS.map((column) => (
          <div className="meridian-root-card__pair" key={column}>
            <dt>{WORKTREE_COLUMN_LABELS[column]}</dt>
            {summaryCell(record, column, nowMilliseconds, clockLocale)}
          </div>
        ))}
      </dl>

      <details>
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
    </>
  );
}

/** One summary row's value: the root verbatim, or the age read relatively. */
function summaryCell(
  record: AppMadeWorktree,
  column: WorktreeSummaryColumnKey,
  nowMilliseconds: number,
  clockLocale: string,
): React.JSX.Element {
  switch (column) {
    case "path":
      return rootCell(record.path);
    case "createdAt":
      return (
        <dd>
          <WireFigure
            value={formatRelativeTime(record.createdAt, nowMilliseconds)}
            hoverLabel={formatZonedDateTime(record.createdAt, clockLocale)}
          />
        </dd>
      );
  }
}

/** The root row's value, verbatim, its whole path the hover label of the cell it truncates. */
function rootCell(path: string): React.JSX.Element {
  return (
    <HoverLabel text={path} textRole="visible-text">
      <dd className="meridian-root-card__path">
        <WireFigure value={path} />
      </dd>
    </HoverLabel>
  );
}
