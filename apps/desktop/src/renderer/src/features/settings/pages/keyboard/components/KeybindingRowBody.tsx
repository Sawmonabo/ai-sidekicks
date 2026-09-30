// One row of the keyboard map: what runs, on what keys, in what scope, and the two controls
// that change it. The page composes rows, announces and owns the acts; this draws one row and
// reads one keystroke, and `readChordFromEvent` decides the recorder's grammar as a pure
// function.

import { useState, type ReactNode } from "react";

import type { Refusal } from "@renderer/lib/refusal.js";
import { ChordHint } from "@renderer/components/ChordHint/ChordHint.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import {
  readChordFromEvent,
  readHeldModifiersFromEvent,
  type CompletedChordRecording,
  type KeybindingRow,
} from "../keybinding-map.js";

/** Props for {@link KeybindingRowBody}. */
export interface KeybindingRowBodyProps {
  readonly row: KeybindingRow;
  readonly recording: boolean;
  readonly refusal: Refusal | undefined;
  readonly onStartRecording: () => void;
  readonly onRecorded: (recording: CompletedChordRecording) => void;
  readonly onReset: () => void;
}

/**
 * What a reset control promises, in words, for one row.
 *
 * Exported so the reset-all control makes the same promise in the same words.
 */
export function describeShippedChord(shippedChord: string | undefined): string {
  return shippedChord === undefined ? "no chord" : shippedChord;
}

/**
 * One row: what runs, on what keys, in what scope, and how to change it.
 *
 * Both controls carry the command's name in their accessible label, since a list of buttons all
 * called "Rebind" cannot be navigated by screen reader; the visible word stays inside it.
 */
export function KeybindingRowBody(props: KeybindingRowBodyProps): ReactNode {
  const { row, recording } = props;
  // The keys held while this recorder is armed. Local because it concerns one press in one
  // row; cleared by the page's `recording` flag, since no keys are held once recording stops.
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
          className="meridian-keymap__record meridian-action-button"
          aria-pressed={recording}
          aria-label={recording ? `Press a chord for ${row.title}` : `Rebind ${row.title}`}
          onClick={() => {
            setHeldModifiers([]);
            props.onStartRecording();
          }}
          onBlur={() => {
            if (recording) {
              setHeldModifiers([]);
              props.onRecorded({ outcome: "canceled" });
            }
          }}
          onKeyDown={(event) => {
            if (!recording) {
              return;
            }
            // The press belongs to the recorder, not to the button's Space/Enter activation or
            // anything listening above.
            event.preventDefault();
            event.stopPropagation();
            const read = readChordFromEvent(event.nativeEvent);
            if (read.outcome === "incomplete") {
              // A chord in progress is drawn, so a person sees the console received `⌘` before
              // the completing key.
              setHeldModifiers(read.heldModifiers);
              return;
            }
            setHeldModifiers([]);
            props.onRecorded(read);
          }}
          onKeyUp={(event) => {
            if (!recording) {
              return;
            }
            // A release corrects the hint, or it would say "Holding ⇧" after the key is up.
            // Recomputed rather than cleared, since releasing ⇧ on the way to ⌥⇧J leaves ⌥
            // held, and read through the same function as the chord so both name modifiers alike.
            event.preventDefault();
            event.stopPropagation();
            setHeldModifiers(readHeldModifiersFromEvent(event.nativeEvent));
          }}
        >
          {recording ? "Press a chord" : "Rebind"}
        </button>
        {row.overridden ? (
          <button
            type="button"
            className="meridian-keymap__reset meridian-action-button"
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
