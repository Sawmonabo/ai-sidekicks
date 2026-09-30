import { type ToolAllowlistWeight } from "../tool-allowlist.js";

/** Total over the weight set: a third weight fails to compile before it renders. */
const WEIGHT_CLASS_NAMES: Readonly<Record<ToolAllowlistWeight, string>> = {
  absent: "meridian-agent-card__axis-absent",
  derived: "meridian-agent-card__axis-derived",
};

/**
 * One tool-grant reading, at the weight its position carries. Shared by the grant line and the
 * echo's Tools row so an absence never reads like a restriction somebody chose.
 */
export function ToolAllowlistReading(props: {
  readonly weight: ToolAllowlistWeight;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <span className={WEIGHT_CLASS_NAMES[props.weight]}>{props.children}</span>;
}
