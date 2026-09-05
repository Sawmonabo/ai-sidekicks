import { useId } from "react";
import { Glyph } from "../../primitives/index.js";
import type { CheckoutConflict } from "./checkout-conflict.js";
import { GATE_GLYPH_SIZE } from "./proposal-gate-chrome.js";

/**
 * The blocking choice.
 *
 * The daemon's reason renders verbatim and its options are the only ways forward
 * offered — the console resolves nothing automatically and adds no option of its own,
 * which is why the buttons are built from the list rather than from a union here.
 */
export function CheckoutConflictChoice(props: {
  readonly conflict: CheckoutConflict;
  readonly onResolve: ((optionId: string) => void) | undefined;
}): React.JSX.Element {
  const legendId = useId();
  return (
    <div
      className="meridian-proposal-gate__conflict"
      role="group"
      aria-labelledby={legendId}
      aria-live="polite"
    >
      <p className="meridian-proposal-gate__conflict-reason" id={legendId}>
        <Glyph name="alert" size={GATE_GLYPH_SIZE} />
        {props.conflict.reason}
      </p>
      <div className="meridian-proposal-gate__conflict-options">
        {props.conflict.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className="meridian-proposal-gate__act"
            onClick={() => props.onResolve?.(option.optionId)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
