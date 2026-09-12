// Why the axis change this window submitted did not happen, said on the chip.
//
// THE ONE OUTCOME A MUTATION SURFACE MAY NOT HAVE is silence, and this refusal reached
// exactly one surface: `ProviderSwitch`'s own `refusal` prop, inside a portalled popover
// with no `keepMounted`. base-ui unmounts that popup on an outside click or Escape, so a
// user who pressed Apply and clicked back into the message line to keep typing
// met a chip showing the pre-switch binding, no failure, and no code — while the daemon
// had refused. The chip is where the act's answer has to survive, because the chip is
// what is still on screen.
//
// A DIFFERENT FACT FROM THE FAILED SETTLEMENT BESIDE IT. `failedSwitchOf` is the
// daemon's answer that the switch failed; this is the call not landing at all — a
// transport failure, a permission refusal, or the latch's own arm. Both are rendered
// and neither stands in for the other.
//
// TWO ARMS, BECAUSE AN UNBUILT WIRE IS NOT AN ERROR. `growth-port.ts` says a live
// bridge refusing an unregistered wire renders as the "not checked" kind of nothing,
// and the axis popover is offered on the strength of the port carrying a METHOD rather
// than of the wire being registered — so that refusal is reachable here on every live
// build and would otherwise wear an alert glyph for a wire nobody has landed.
//
// AND THE REMEDY IS TEXT. Rule 4: a refusal says what refused, why, and what to do
// next, and the third of those is this console's own sentence rather than the daemon's.

import { isUnbuiltWireRefusal } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { Chip, InlineRefusal, Nothing } from "../../../console/primitives/index.js";

/** What is absent, worded once so both arms say the same thing did not happen. */
const AXIS_CHANGE_NOT_APPLIED = "Axis change not applied";

export interface AxisSwitchRefusalProps {
  /** The reason the latch settled the round with. Never absent on this arm. */
  readonly refusal: ConsoleRefusal;
}

/** The refusal the axis mutation settled with, beside the chip that was acting. */
export function AxisSwitchRefusal(props: AxisSwitchRefusalProps): React.JSX.Element {
  const { refusal } = props;
  if (isUnbuiltWireRefusal(refusal)) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title={AXIS_CHANGE_NOT_APPLIED}
        detail={refusal.detail}
      />
    );
  }
  return (
    <span className="meridian-composer__axis-refusal">
      {/* Two elements and not one, for the reason the failed-switch pair beside them
          are two: the first is this console's own sentence about what happened, and
          the second is the reason the wire gave, verbatim. */}
      <Chip tone="failure" glyph="alert" label={AXIS_CHANGE_NOT_APPLIED} />
      <InlineRefusal code={refusal.code} detail={refusal.detail} />
      <span className="meridian-composer__axis-remedy">
        This agent&apos;s binding did not move. Open the axis control and submit again.
      </span>
    </span>
  );
}
