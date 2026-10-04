// The reset-all control, and the defaults it restores named one by one.
//
// A per-row reset can show its default on the control because one row restores to one chord;
// one button restoring N rows to N chords cannot, so the list is the promise. Every changed
// row is listed with the shipped chord that comes back, never the effective one, which has
// these overrides composed onto it. A command with no shipped chord restores to none, in the
// words `describeShippedChord` gives the per-row control.

import type { ReactNode } from "react";

import { ChordHint } from "@renderer/components/ChordHint/ChordHint.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { describeShippedChord } from "./KeybindingRowBody.js";
import type { KeybindingRow } from "../keybinding-map.js";

/** Props for {@link ResetAllKeybindings}. */
export interface ResetAllKeybindingsProps {
  /** Every row whose chord is a person's rather than the app's. */
  readonly changedRows: readonly KeybindingRow[];
  readonly onResetAll: () => void;
}

/**
 * The bulk reset: what it would restore, then the control that restores it.
 *
 * Renders the "nothing to reset" empty state itself so "is anything changed" is answered in one
 * place.
 */
export function ResetAllKeybindings(props: ResetAllKeybindingsProps): ReactNode {
  if (props.changedRows.length === 0) {
    return (
      <Nothing kind="empty" placement="inline" title="Every chord is the one the app ships." />
    );
  }
  return (
    <div className="meridian-keymap__reset-all-block">
      <ul className="meridian-keymap__reset-all-list">
        {props.changedRows.map((row) => (
          <li key={row.commandId} className="meridian-keymap__reset-all-entry">
            <span className="meridian-keymap__reset-all-title">{row.title}</span>
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
        className="meridian-keymap__reset-all meridian-action-button"
        aria-label={
          `Reset ${formatCount(props.changedRows.length)} changed chords to the ones the app ` +
          `ships: ${props.changedRows
            .map((row) => `${row.title} to ${describeShippedChord(row.shippedChord)}`)
            .join("; ")}`
        }
        onClick={props.onResetAll}
      >
        Reset all {formatCount(props.changedRows.length)} changed{" "}
        {props.changedRows.length === 1 ? "chord" : "chords"}
      </button>
    </div>
  );
}
