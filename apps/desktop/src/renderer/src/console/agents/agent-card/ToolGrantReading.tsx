import { type ToolGrantWeight } from "./tool-grant.js";

/** Total over the weight set: a third weight fails to compile before it renders. */
const WEIGHT_CLASS_NAMES: Readonly<Record<ToolGrantWeight, string>> = {
  absent: "meridian-agent-card__axis-absent",
  derived: "meridian-agent-card__axis-derived",
};

/**
 * One tool-grant reading, at the weight its position carries.
 *
 * Its own component because the card states a grant in two places — the governance
 * line and the echo's Tools row — and the mapping from weight to class is the half
 * they share. Written twice, one of them would eventually mute a restriction
 * somebody chose or give an absence the weight of a decision, and the card's whole
 * rule is that those two never read alike.
 */
export function ToolGrantReading(props: {
  readonly weight: ToolGrantWeight;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <span className={WEIGHT_CLASS_NAMES[props.weight]}>{props.children}</span>;
}
