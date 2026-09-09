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
//
// THE DISABLED STATE AND ITS REASON ARE ONE PROP RATHER THAN TWO, and that is the
// point of the shape. A `disabled` boolean beside an optional `disabledReason` is two
// values that can disagree, and the way they disagree in practice is a control that is
// closed and says nothing — which is the one outcome the console's own rule forbids:
// a person looking at a dead button has to be able to read why. So presence IS the
// disabled state, and a caller cannot close this control without supplying the
// sentence that closed it.

import { Glyph } from "../../../primitives/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { RUN_CONTROL_PRESENTATION } from "./control-presentation.js";
import { type RunControl } from "./run-control-dispatch.js";

/** One control. Named, focusable, and busy while its dispatch is in flight. */
export function ControlButton(props: {
  readonly control: RunControl;
  readonly isBusy: boolean;
  /**
   * Why this control cannot be pressed, or `undefined` where it can be.
   *
   * Rendered as the button's own tooltip, which is where the invite ledger's revoke
   * control already puts a block's sentence — one affordance for one fact rather than
   * a second treatment invented per family.
   */
  readonly disabledReason: string | undefined;
  readonly onPress: () => void;
}): React.JSX.Element {
  const presentation = RUN_CONTROL_PRESENTATION[props.control];
  return (
    <button
      type="button"
      className={`meridian-run-controls__action meridian-run-controls__action--${props.control}`}
      aria-busy={props.isBusy}
      disabled={props.disabledReason !== undefined}
      title={props.disabledReason}
      onClick={props.onPress}
    >
      <Glyph name={presentation.glyph} size={GLYPH_SIZE_ROW} />
      {presentation.label}
    </button>
  );
}
