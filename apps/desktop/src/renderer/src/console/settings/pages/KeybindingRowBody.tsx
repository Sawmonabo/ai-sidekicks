// One row of the keyboard map: what runs, on what keys, in what scope, and the two
// controls that change it.
//
// Its own module rather than a second component inside the page for the reason
// `apps/desktop/AGENTS.md` states in terms — one component per `.tsx` — and because
// the two jobs really are separate: the page composes rows, decides what to announce,
// and owns the acts; this draws one row and reads one keystroke. Every decision it
// makes about that keystroke comes back from `readChordFromEvent`, so the recorder's
// grammar is tested as a pure function rather than through a DOM.

import type { ReactNode } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import { ChordHint, InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import {
  readChordFromEvent,
  type CompletedChordRecording,
  type KeybindingRow,
} from "./keybinding-map.js";

export interface KeybindingRowBodyProps {
  readonly row: KeybindingRow;
  readonly recording: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onStartRecording: () => void;
  readonly onRecorded: (recording: CompletedChordRecording) => void;
  readonly onReset: () => void;
}

/**
 * One row: what runs, on what keys, in what scope, and how to change it.
 *
 * Both controls carry the command's own name in their accessible label, the way
 * `collaboration/MembershipActionsMenu.tsx` names the membership its row acts on. A
 * list of rows whose buttons are all called "Rebind" is a list somebody reading it
 * through a screen reader cannot navigate; the visible word stays inside the label,
 * so the spoken name still contains the one a person would say out loud.
 */
export function KeybindingRowBody(props: KeybindingRowBodyProps): ReactNode {
  const { row, recording } = props;
  return (
    <>
      <div className="meridian-keymap__head">
        <span className="meridian-keymap__title">{row.title}</span>
        {row.chord === undefined ? (
          <Nothing kind="empty" placement="inline" title="No chord" />
        ) : (
          <ChordHint chord={row.chord} />
        )}
      </div>
      <div className="meridian-keymap__meta">
        <WireFigure value={row.commandId} />
        <span className="meridian-keymap__scope">
          {row.whenExpression === undefined
            ? "Live everywhere in this window"
            : `Live when ${row.whenExpression}`}
        </span>
      </div>
      <div className="meridian-keymap__controls">
        <button
          type="button"
          className="meridian-keymap__record"
          aria-pressed={recording}
          aria-label={recording ? `Press a chord for ${row.title}` : `Rebind ${row.title}`}
          onClick={props.onStartRecording}
          onBlur={() => {
            if (recording) {
              props.onRecorded({ outcome: "cancelled" });
            }
          }}
          onKeyDown={(event) => {
            if (!recording) {
              return;
            }
            // The press belongs to the recorder and nothing else — not to the
            // button's own Space/Enter activation, not to anything listening above.
            event.preventDefault();
            event.stopPropagation();
            const read = readChordFromEvent(event.nativeEvent);
            if (read.outcome !== "incomplete") {
              props.onRecorded(read);
            }
          }}
        >
          {recording ? "Press a chord" : "Rebind"}
        </button>
        {row.overridden ? (
          <button
            type="button"
            className="meridian-keymap__reset"
            aria-label={`Reset ${row.title} to the chord the console ships`}
            onClick={props.onReset}
          >
            Reset
          </button>
        ) : null}
        {recording ? (
          <span className="meridian-keymap__recording-hint">
            Escape leaves it alone; Backspace clears it.
          </span>
        ) : null}
      </div>
      {row.unavailableReason === undefined ? null : (
        <p className="meridian-keymap__unavailable">{row.unavailableReason}</p>
      )}
      {props.refusal === undefined ? null : (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      )}
    </>
  );
}
