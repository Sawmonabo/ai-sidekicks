// The posture chip: the posture the run actually GOT.
//
// `Spec-023 §Console Design (Meridian)` §Posture chip states the constraint that
// shapes this whole component: "No wire member carries a posture request, so the
// chip says so". A requested posture would therefore be a value the console
// invented, and rendering one beside a stamped posture would make the two look like
// the same kind of fact. So this chip renders exactly one thing — the
// `executionPosture` stamped on `run.running` — and, when there is none, says what
// an absent posture means in the console's one sentence for it, which is that absence
// is not the same as an unrestricted run.
//
// `Spec-012 §Required Behavior` puts the posture decision at the daemon, and the
// shape is `ExecutionPosture` in `packages/contracts`. The renderer projects it and
// offers no mutation, which is why this component takes a model and no callbacks.

import {
  Chip,
  Nothing,
  POSTURE_ABSENT_DETAIL,
  formatCount,
} from "../../../console/primitives/index.js";
import type { PostureChipModel } from "./chip-models.js";

export interface PostureChipProps {
  readonly model: PostureChipModel;
}

export function PostureChip(props: PostureChipProps): React.JSX.Element {
  const posture = props.model.stamped;
  if (posture === undefined) {
    // The console's one sentence for an absent posture, taken from the family that
    // owns the copy rather than written again here. A second wording for one fact is
    // a wording that can be softened on one surface and not the other — and the
    // softer of the two said posture is set by policy, which reads as a reassurance
    // where the point is that absence is NOT `trusted`.
    return (
      <Nothing kind="not-checked" title="Posture not stamped" detail={POSTURE_ABSENT_DETAIL} />
    );
  }
  return (
    <div className="meridian-composer__posture" role="group" aria-label="Execution posture">
      <Chip glyph="workspace" mono label={posture.mode} />
      <Chip mono label={posture.networkAccess} />
      <Chip label={writableRootsLabel(posture.writableRoots.length)} />
    </div>
  );
}

/**
 * How many roots the run may write to.
 *
 * The COUNT and not the paths: a root is a filesystem path, the composer is a strip
 * of chrome, and a person who needs the list opens the run's posture card. The count
 * goes through the figure chokepoint like every other quantity, so it is grouped the
 * way the host's locale groups numbers rather than by a `toString` here.
 */
function writableRootsLabel(rootCount: number): string {
  return rootCount === 1 ? "1 writable root" : `${formatCount(rootCount)} writable roots`;
}
