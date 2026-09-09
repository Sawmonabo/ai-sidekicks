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
//
// AND IT IS `aria-disabled` RATHER THAN `disabled`, WHICH IS THE WHOLE DIFFERENCE
// BETWEEN A REASON A PERSON CAN REACH AND ONE THEY CANNOT. A `disabled` button leaves
// the tab order, so a keyboard reaches past it and a screen reader is never taken to
// it; the sentence that closed it was in `title`, which is hover-only and announced by
// nothing. `aria-disabled` keeps the button focusable and announced as unavailable, and
// the strip renders the sentence as text — the shape `palette/overlay/PaletteResultList.tsx`
// settled on for this same fact one round later. One condition, one treatment, whichever
// surface a person meets it on.
//
// THE PRESS IS THEREFORE GUARDED HERE, because `aria-disabled` stops nothing on its own.
// Not every control's press reaches the call door: steer and rollback open a local
// composer and put no call, so a press that fell through would open a composer whose
// confirm cannot be sent. The guard is not a second eligibility answer — it honours the
// prop it was handed rather than deriving one.

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
   * The strip renders the sentence once, as text, and names the element holding it in
   * {@link reasonElementId} — so a person who focuses this button is told it is
   * unavailable and told why, rather than being handed a tooltip nothing announces.
   */
  readonly disabledReason: string | undefined;
  /**
   * The element carrying the sentence above, where one is being rendered.
   *
   * The strip owns it rather than this button, because the six controls are closed by
   * ONE condition and six copies of one sentence would be six announcements of a single
   * outage. Absent while nothing closes the control.
   */
  readonly reasonElementId?: string | undefined;
  readonly onPress: () => void;
}): React.JSX.Element {
  const presentation = RUN_CONTROL_PRESENTATION[props.control];
  const isClosed = props.disabledReason !== undefined;
  return (
    <button
      type="button"
      className={`meridian-run-controls__action meridian-run-controls__action--${props.control}`}
      aria-busy={props.isBusy}
      aria-disabled={isClosed}
      aria-describedby={isClosed ? props.reasonElementId : undefined}
      onClick={() => {
        if (isClosed) {
          return;
        }
        props.onPress();
      }}
    >
      <Glyph name={presentation.glyph} size={GLYPH_SIZE_ROW} />
      {presentation.label}
    </button>
  );
}
