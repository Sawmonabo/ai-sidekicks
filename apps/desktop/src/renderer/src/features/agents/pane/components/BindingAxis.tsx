import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";

/** One axis of the effective binding, with the meaning of its unset state. */
export function BindingAxis(props: BindingAxisProps): React.JSX.Element {
  return (
    <span className="meridian-agent-card__axis">
      <span className="meridian-agent-card__axis-label">{props.label}</span> {axisReading(props)}
    </span>
  );
}

/**
 * One axis of the effective binding.
 *
 * An axis the binding always carries takes its value alone. An axis the binding may
 * leave unset is not blank and is not a fault: each unset state MEANS something
 * specific, so the caller must say which.
 */
type BindingAxisProps =
  | { readonly label: string; readonly value: string }
  | {
      readonly label: string;
      readonly value: string | null | undefined;
      readonly absenceMeaning: string;
    };

/** The value in mono, or what its unset state means. */
function axisReading(props: BindingAxisProps): React.JSX.Element {
  if (!("absenceMeaning" in props)) {
    return <WireFigure value={props.value} />;
  }
  return props.value === null || props.value === undefined ? (
    <span className="meridian-agent-card__axis-absent">{props.absenceMeaning}</span>
  ) : (
    <WireFigure value={props.value} />
  );
}
