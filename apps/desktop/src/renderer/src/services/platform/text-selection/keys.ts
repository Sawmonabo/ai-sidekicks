// The shape of one operating system's selection keys: the shift-presses that move the focus end of
// a selection in read-only text, as its own text bindings move it, and how much of the page a page
// step leaves in view. Each system's table is a module of its own.

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
}

/** The modifier held beside Shift: none, or one named modifier. */
type HeldModifier = "none" | "alt" | "ctrl" | "meta";
