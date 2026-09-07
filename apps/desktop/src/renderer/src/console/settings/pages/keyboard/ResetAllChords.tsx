// The reset-all control, and the defaults it restores — named one by one.
//
// `Spec-023 §Console Design (Meridian)` §Keyboard: "A per-row reset and a reset-all,
// both showing the default they restore to." The per-row half can say it on the
// control itself, because one row restores to one chord. This half cannot: a single
// button restores N rows to N different chords, and a label reading "reset all" makes
// a promise a person has no way to check before pressing it.
//
// SO THE LIST IS THE PROMISE, AND THE BUTTON IS BESIDE IT. Every changed row is
// listed with the chord that comes back — the console's SHIPPED chord, never the
// effective one, which is the shipped table with these very overrides already
// composed onto it and would therefore answer with the override being removed. A
// command the console ships no chord for restores to none, and the row says that in
// the same words the per-row control uses, through `describeShippedChord`.
//
// ITS OWN MODULE because the page it came out of was within a few lines of the
// package's 400-line rule, and because this is one subject: what a bulk act will do,
// stated before it is done.

import type { ReactNode } from "react";

import { ChordHint, Nothing, WireFigure, formatCount } from "../../../primitives/index.js";
import { describeShippedChord } from "./KeybindingRowBody.js";
import type { KeybindingRow } from "./keybinding-map.js";

export interface ResetAllChordsProps {
  /** Every row whose chord is a person's rather than the console's. */
  readonly changedRows: readonly KeybindingRow[];
  readonly onResetAll: () => void;
}

/**
 * The bulk reset: what it would restore, then the control that restores it.
 *
 * Renders the "nothing to reset" absence itself rather than leaving the page to
 * choose between two shapes: the two arms are one question — is anything changed —
 * and answering it in two places is how they come to disagree.
 */
export function ResetAllChords(props: ResetAllChordsProps): ReactNode {
  if (props.changedRows.length === 0) {
    return (
      <Nothing kind="empty" placement="inline" title="Every chord is the one the console ships." />
    );
  }
  return (
    <div className="meridian-keymap__reset-all-block">
      <ul className="meridian-keymap__reset-all-list">
        {props.changedRows.map((row) => (
          <li key={row.commandId} className="meridian-keymap__reset-all-entry">
            <span className="meridian-keymap__reset-all-title">{row.title}</span>
            <WireFigure value={row.commandId} />
            <span className="meridian-keymap__reset-all-target">
              {row.shippedChord === undefined ? (
                "back to no chord"
              ) : (
                <>
                  back to <ChordHint chord={row.shippedChord} />
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="meridian-keymap__reset-all"
        aria-label={`Reset ${formatCount(props.changedRows.length)} changed chords to the ones the console ships: ${props.changedRows
          .map((row) => `${row.title} to ${describeShippedChord(row.shippedChord)}`)
          .join("; ")}`}
        onClick={props.onResetAll}
      >
        Reset all {formatCount(props.changedRows.length)} changed{" "}
        {props.changedRows.length === 1 ? "chord" : "chords"}
      </button>
    </div>
  );
}
