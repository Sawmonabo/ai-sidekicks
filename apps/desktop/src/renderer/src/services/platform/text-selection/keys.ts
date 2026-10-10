// The shape of one operating system's selection keys: the shift-presses that move the focus end of
// a selection in read-only text, as its own text bindings move it, how much of the page a page
// step leaves in view, the press that selects everything, and the presses that take a read-only
// view to its start or its end. Each system's table is a module of its own.

/** How far one shift-press moves the focus end. */
export type SelectionGranularity =
  | "character"
  | "word"
  | "line"
  | "paragraph"
  | "lineboundary"
  | "documentboundary"
  | "page";

/** One operating system's selection keys. */
export interface SelectionKeys {
  /** Each key's granularity under each held modifier; an absent one is unbound. */
  readonly bindings: Readonly<
    Record<string, Partial<Readonly<Record<HeldModifier, SelectionGranularity>>>>
  >;
  /**
   * How much of the page the browser's page step leaves in view, in CSS pixels, or `Infinity`
   * where only its share of the page bounds the step.
   */
  readonly pageOverlapPx: number;
  /** The presses that select everything in what has focus. */
  readonly selectAll: readonly KeyChord[];
  /** The presses that take a read-only view to its start, and those that take it to its end. */
  readonly jumps: Readonly<Record<"start" | "end", readonly KeyChord[]>>;
}

/** One key pressed with exactly one named modifier held, or none, and never Shift. */
export interface KeyChord {
  /** The key's `KeyboardEvent.key`, a letter in lower case. */
  readonly key: string;
  readonly modifier: HeldModifier;
}

/** Whether `event` is the press `chord` names: its key, with its modifier and no other held. */
export function isChordPress(event: KeyboardEvent, chord: KeyChord): boolean {
  const held = (["alt", "ctrl", "meta"] as const).filter((modifier) => event[`${modifier}Key`]);
  return (
    !event.shiftKey &&
    event.key.toLowerCase() === chord.key.toLowerCase() &&
    (chord.modifier === "none"
      ? held.length === 0
      : held.length === 1 && held[0] === chord.modifier)
  );
}

/** The modifier held beside Shift, or alone: none, or one named modifier. */
type HeldModifier = "none" | "alt" | "ctrl" | "meta";
