// One row of the keyboard map: what runs, on what keys, in what scope, and the two
// controls that change it.
//
// Its own module rather than a second component inside the page for the reason
// `apps/desktop/AGENTS.md` states in terms — one component per `.tsx` — and because
// the two jobs really are separate: the page composes rows, decides what to announce,
// and owns the acts; this draws one row and reads one keystroke. Every decision it
// makes about that keystroke comes back from `readChordFromEvent`, so the recorder's
// grammar is tested as a pure function rather than through a DOM.

import { useState, type ReactNode } from "react";

import type { ConsoleRefusal } from "../../../core/index.js";
import { ChordHint, InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
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
 * What a reset control promises, in words, for one row.
 *
 * Exported because the page's reset-ALL control makes the same promise over a set and
 * must make it in the same words: two spellings of "back to none" is two answers to
 * one question, and only one of them can be the one a person reads twice.
 */
export function describeShippedChord(shippedChord: string | undefined): string {
  return shippedChord === undefined ? "no chord" : shippedChord;
}

/**
 * One row: what runs, on what keys, in what scope, and how to change it.
 *
 * Both controls carry the command's own name in their accessible label, the way
 * `collaboration/members/MembershipActionsMenu.tsx` names the membership its row acts on. A
 * list of rows whose buttons are all called "Rebind" is a list somebody reading it
 * through a screen reader cannot navigate; the visible word stays inside the label,
 * so the spoken name still contains the one a person would say out loud.
 */
export function KeybindingRowBody(props: KeybindingRowBodyProps): ReactNode {
  const { row, recording } = props;
  // The keys held so far, for as long as this recorder is armed. Local because it is
  // a fact about ONE press in ONE row's control and nothing above the row can act on
  // it — and cleared by the page's own `recording` flag rather than by a second
  // lifecycle here: when the row stops recording there are no keys held, whichever
  // way the recording ended.
  const [heldModifiers, setHeldModifiers] = useState<readonly string[]>([]);
  const heldChord = heldModifiers.join("+");
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
          onClick={() => {
            setHeldModifiers([]);
            props.onStartRecording();
          }}
          onBlur={() => {
            if (recording) {
              setHeldModifiers([]);
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
            if (read.outcome === "incomplete") {
              // A chord on its way, drawn rather than swallowed: the keys are held
              // right now and the row says which, so a person can see the console
              // received `⌘` before they press the key that completes it.
              setHeldModifiers(read.heldModifiers);
              return;
            }
            setHeldModifiers([]);
            props.onRecorded(read);
          }}
        >
          {recording ? "Press a chord" : "Rebind"}
        </button>
        {row.overridden ? (
          <button
            type="button"
            className="meridian-keymap__reset"
            aria-label={`Reset ${row.title} to ${describeShippedChord(row.shippedChord)}, the chord the console ships`}
            onClick={props.onReset}
          >
            {row.shippedChord === undefined ? (
              "Reset to no chord"
            ) : (
              <>
                Reset to <ChordHint chord={row.shippedChord} />
              </>
            )}
          </button>
        ) : null}
        {recording ? (
          <span className="meridian-keymap__recording-hint">
            {heldChord === "" ? (
              "Nothing held yet. Escape leaves it alone; Backspace clears it."
            ) : (
              <>
                Holding <ChordHint chord={heldChord} /> — the chord is not complete until a
                non-modifier key lands. Escape leaves it alone; Backspace clears it.
              </>
            )}
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
