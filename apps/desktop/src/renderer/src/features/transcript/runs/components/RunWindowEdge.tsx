// The line at an edge of a long run's window, counting the run's calls beyond it, which opens the
// next stretch that way when pressed.

import "./RunWindowEdge.css";

import { formatCount } from "#renderer/lib/wire/figures.js";
import { type RunWindowEdge as RunWindowEdgeName } from "../call-window.js";
import { type RunGroup } from "../groups.js";

/** The props of one edge line of a run group's window. */
export interface RunWindowEdgeProps {
  readonly runGroup: RunGroup;
  readonly edge: RunWindowEdgeName;
  /** The run's calls beyond this edge, outside the window. */
  readonly count: number;
  /** Open the next stretch beyond `edge`. */
  readonly onOpen: (runGroup: RunGroup, edge: RunWindowEdgeName) => void;
}

/** `· · · 312 earlier`, or `· · · 84 later`: one edge of a long run's window, as a button. */
export function RunWindowEdge(props: RunWindowEdgeProps): React.JSX.Element {
  const { runGroup, edge } = props;
  return (
    <button
      type="button"
      className="meridian-run-window-edge"
      onClick={() => {
        props.onOpen(runGroup, edge);
      }}
    >
      {/* The dots mark the gap; the count and the edge are the button's name, in the line's ink. */}
      <span aria-hidden="true">· · ·</span>{" "}
      <span>
        {formatCount(props.count)} {edge}
      </span>
    </button>
  );
}
