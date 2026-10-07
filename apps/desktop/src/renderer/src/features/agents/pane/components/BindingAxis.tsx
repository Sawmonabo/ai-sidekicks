import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";

/** One axis of the effective binding, with the meaning of its unset state. */
export function BindingAxis(props: BindingAxisProps): React.JSX.Element {
  return (
    <span className="meridian-agent-card__axis">
      <span className="meridian-form__label">{props.label}</span> {axisReading(props)}
    </span>
  );
}

/**
 * One axis of the effective binding: a wire value, or plain words for one the screen names (a
 * provider's own name). An axis that may be unset is neither blank nor a fault: each unset state
 * means something specific, so the caller says which.
 */
type BindingAxisProps =
  | { readonly label: string; readonly words: string }
  | { readonly label: string; readonly value: string }
  | {
      readonly label: string;
      readonly value: string | null | undefined;
      readonly absenceMeaning: string;
    };

/** The words as they are, the value in mono, or what its unset state means. */
function axisReading(props: BindingAxisProps): React.JSX.Element | string {
  if ("words" in props) {
    return props.words;
  }
  if (!("absenceMeaning" in props)) {
    return <WireFigure value={props.value} />;
  }
  return props.value === null || props.value === undefined ? (
    <span className="meridian-agent-card__axis-absent">{props.absenceMeaning}</span>
  ) : (
    <WireFigure value={props.value} />
  );
}
