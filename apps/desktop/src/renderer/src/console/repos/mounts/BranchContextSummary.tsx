// The branch context, on the run that owns it.
//
// `branch-context-model.ts` puts a branch context on EVERY writable
// coding run — `branch`, `worktree`, or `ephemeral clone` — so this summary is not a
// part of the proposal, it is what the proposal is prepared against. Its own file for
// that reason: the gate's `prepared` and `hosting-unavailable` arms both mount it, and
// a run header with no proposal yet still shows base and head.
//
// EVERY VALUE IS THE WIRE'S, IN MONO. Base and head are branch names the daemon
// resolved, and a renderer that normalised, shortened, or suffixed either would be
// showing a branch the host does not have. Nothing here computes a name, and
// `branch-context-model.ts`'s prohibition on inferring base or head from a pane, a tab,
// or a focused view is
// structural rather than remembered: the context is the only prop.

import { DerivedFigure, Nothing, WireFigure } from "../../primitives/index.js";
import {
  branchContextAssociationReading,
  type BranchContextReading,
} from "./branch-context-model.js";

/**
 * The four named values and the association.
 *
 * Every one of them is a wire string in mono: base and head are branch names the
 * daemon resolved, and a renderer that normalised or shortened either would be showing
 * a branch the host does not have.
 */
export interface BranchContextSummaryProps {
  readonly context: BranchContextReading;
}

export function BranchContextSummary(props: BranchContextSummaryProps): React.JSX.Element {
  const association = branchContextAssociationReading(props.context);
  return (
    <dl className="meridian-proposal-gate__context">
      <div className="meridian-proposal-gate__pair">
        <dt>Base</dt>
        <dd>
          <WireFigure value={props.context.baseBranch} />
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>Head</dt>
        <dd>
          <WireFigure value={props.context.headBranch} />
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>Upstream</dt>
        <dd>
          {props.context.upstreamRef === undefined ? (
            <Nothing kind="empty" placement="inline" title="No upstream set." />
          ) : (
            <WireFigure value={props.context.upstreamRef} />
          )}
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>{association.label}</dt>
        <dd>
          {association.boundId === undefined ? (
            // `in-place` binds no separate root, and a `worktree`-mode context whose
            // id did not arrive is a hole the type says cannot exist. Both say what
            // they are rather than rendering an empty cell.
            <DerivedFigure text={association.meaning} />
          ) : (
            <WireFigure value={association.boundId} title={association.meaning} />
          )}
        </dd>
      </div>
    </dl>
  );
}
