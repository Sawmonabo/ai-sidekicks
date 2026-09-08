// The reasoning row's surface, and the read that fills it, in the one component that
// draws one.
//
// ITS OWN COMPONENT FOR `FixtureShellAskRow.tsx`' REASON, applied to the other read
// the shell used to arm on every row. `useReasoningSurfaceRead` holds a reading and a
// press handler; a row that is not a reasoning row has nothing to read and no control
// to press, and until this existed it built both anyway — the rules of hooks bind a
// component and not a tree, so the read moves into the component that renders it and
// the ordinary row stops paying for it.
//
// THE ELEMENT IS COMPOSED BY THE MOUNT AND HANDED TO THE CARD, unchanged: `MessageCard`
// decides layout and the surface that performed the read decides what a row is allowed
// to show, which is why the reasoning body arrives as a node rather than as a flag.

import { REASONING_SURFACE_SLOT, ReasoningSurface } from "../bodies/index.js";
import { useReasoningSurfaceRead } from "./shell-row-reads.js";
import type { RunId } from "@ai-sidekicks/contracts";

export interface FixtureShellReasoningSurfaceProps {
  /** The run this row's reasoning belongs to, or `undefined` where none is attributed. */
  readonly runId: RunId | undefined;
  /** Text the reveal engine is publishing for this row right now, while it streams. */
  readonly liveText: string | undefined;
}

/** One reasoning row's four-arm availability surface, over its own read. */
export function FixtureShellReasoningSurface(
  props: FixtureShellReasoningSurfaceProps,
): React.JSX.Element {
  const reasoningRead = useReasoningSurfaceRead(props.runId);
  return (
    <ReasoningSurface
      slot={{ contract: REASONING_SURFACE_SLOT, body: undefined }}
      runId={props.runId}
      liveText={props.liveText}
      reading={reasoningRead.reading}
      onExpand={reasoningRead.expand}
    />
  );
}
