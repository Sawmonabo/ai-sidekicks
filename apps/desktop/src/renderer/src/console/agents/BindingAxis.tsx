import { WireFigure } from "../primitives/index.js";

/**
 * One axis of the effective binding.
 *
 * An absent axis is not blank and is not a fault: each absence MEANS something
 * specific, and the card says which. An axis the reply did not carry at all — the
 * roster read today answers identity and lifecycle and no binding — says that
 * instead, because "the provider's default" would be a claim nobody made.
 */
export function BindingAxis(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly absenceMeaning?: string;
}): React.JSX.Element {
  return (
    <span className="meridian-agent-card__axis">
      <span className="meridian-agent-card__axis-label">{props.label}</span>{" "}
      {props.value === undefined ? (
        <span className="meridian-agent-card__axis-absent">
          {props.absenceMeaning ?? "not reported"}
        </span>
      ) : (
        <WireFigure value={props.value} />
      )}
    </span>
  );
}
