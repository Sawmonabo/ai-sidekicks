// One run control, as a button.
//
// Split from `RunControls.tsx`, which decides WHICH controls a run is offered and
// what pressing one dispatches, while this owns what one of them looks like.
//
// THE PRESENTATION TABLE IS A SIBLING, BECAUSE IT STOPPED HAVING ONE READER. It
// lived here while the button was the only thing that named a control; the palette
// contributes the same six acts, so the phrases moved to
// `control-presentation.ts` where both read one table and a control cannot be
// added to one and not the other.
//
// AND IT IS NEVER A SECOND ELIGIBILITY ANSWER. Whether a control may be pressed at
// all is settled above and arrives as a prop; this renders the disabled state it is
// handed and derives none of its own.

import { Glyph } from "../../../primitives/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { RUN_CONTROL_PRESENTATION } from "./control-presentation.js";
import { type RunControl } from "./run-control-dispatch.js";

/** One control. Named, focusable, and busy while its dispatch is in flight. */
export function ControlButton(props: {
  readonly control: RunControl;
  readonly isBusy: boolean;
  readonly onPress: () => void;
}): React.JSX.Element {
  const presentation = RUN_CONTROL_PRESENTATION[props.control];
  return (
    <button
      type="button"
      className={`meridian-run-controls__action meridian-run-controls__action--${props.control}`}
      aria-busy={props.isBusy}
      onClick={props.onPress}
    >
      <Glyph name={presentation.glyph} size={GLYPH_SIZE_ROW} />
      {presentation.label}
    </button>
  );
}
