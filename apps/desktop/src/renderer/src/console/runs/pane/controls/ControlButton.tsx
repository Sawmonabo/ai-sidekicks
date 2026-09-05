// One run control, as a button.
//
// Split from `RunControls.tsx`, which decides WHICH controls a run is offered and
// what pressing one dispatches, while this owns what one of them looks like.
//
// THE PRESENTATION TABLE IS HERE BECAUSE THE BUTTON IS. Glyph, label, and tone are
// the button's business and nothing above reads them; keeping the table beside its
// only reader is what stops a control being added to one and not the other.
//
// AND IT IS NEVER A SECOND ELIGIBILITY ANSWER. Whether a control may be pressed at
// all is settled above and arrives as a prop; this renders the disabled state it is
// handed and derives none of its own.

import { Glyph, type GlyphName } from "../../../primitives/index.js";
import { type RunControl } from "./run-control-dispatch.js";

/** What each control is called on screen, and the mark it wears. Total over the six. */
const CONTROL_PRESENTATION: Readonly<Record<RunControl, { label: string; glyph: GlyphName }>> = {
  pause: { label: "Pause", glyph: "pause" },
  resume: { label: "Resume", glyph: "play" },
  steer: { label: "Steer", glyph: "pencil" },
  interrupt: { label: "Stop", glyph: "stop" },
  cancel: { label: "Cancel", glyph: "close" },
  rollback: { label: "Rewind", glyph: "external" },
};

/** One control. Named, focusable, and busy while its dispatch is in flight. */
/**
 * The glyph size every run control draws at, including the overflow button the
 * group itself renders — one number, so the row cannot end up with two heights.
 */
export const CONTROL_GLYPH_SIZE = 12;

export function ControlButton(props: {
  readonly control: RunControl;
  readonly isBusy: boolean;
  readonly onPress: () => void;
}): React.JSX.Element {
  const presentation = CONTROL_PRESENTATION[props.control];
  return (
    <button
      type="button"
      className={`meridian-run-controls__action meridian-run-controls__action--${props.control}`}
      aria-busy={props.isBusy}
      onClick={props.onPress}
    >
      <Glyph name={presentation.glyph} size={CONTROL_GLYPH_SIZE} />
      {presentation.label}
    </button>
  );
}
