// The cast bar's "+N" fold.
//
// Its own module for the one-component rule, and the absent-not-disabled rule is the
// whole of what it decides: a button when somebody can open the members section and a
// plain count when nobody can.

import { Chip } from "../../primitives/index.js";

export interface FoldedMembersProps {
  readonly count: number;
  readonly onShowMembers?: () => void;
}

/**
 * The "+N" fold.
 *
 * A button when somebody can open the members section and a plain count when nobody
 * can — the absent-not-disabled rule again. Rendered through `Chip` in mono, because
 * the number is derived rather than wire-verbatim and the primitive is what carries
 * that distinction.
 */
export function FoldedMembers(props: FoldedMembersProps): React.JSX.Element {
  const label = `+${String(props.count)}`;
  if (props.onShowMembers === undefined) {
    return (
      <span className="meridian-cast-bar__fold">
        <Chip label={label} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="meridian-cast-bar__fold"
      onClick={props.onShowMembers}
      aria-label={`Show the other ${String(props.count)} participants`}
    >
      <Chip label={label} />
    </button>
  );
}
