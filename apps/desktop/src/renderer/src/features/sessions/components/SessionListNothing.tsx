// The sessions destination's absence, chosen by what the directory read DID rather
// than by the row count.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and because the two arms are the screen's real content when there is
// nothing to list: the one decision that matters — which kind of nothing this is —
// was buried inside a ternary about array length, in a file whose other job is the
// list, the heading, and the start control.
//
// `rows/session-directory-rows.ts` owns `sessionListNothingKindFor`, so the merge and
// the absence agree by construction rather than by two switches written to match. A
// SERVED directory with no rows is `empty`, because that question was put and
// answered. A read still in flight is `not-loaded`. Collapsing the two is the
// conflation the console's five-kinds-of-nothing rule exists to prevent.

import { type ReactNode } from "react";

import type { SessionDirectoryState } from "@renderer/console/seats/index.js";
import { Nothing } from "@renderer/console/primitives/index.js";

/** What stands in for an empty list: a read still in flight, or a node that answered with none. */
export function SessionListNothing(props: SessionListNothingProps): React.JSX.Element {
  const { directory } = props;
  if (directory.status === "reading") {
    // No action on this arm, and the primitive is why: a read in flight renders as
    // a skeleton, which carries no title, no detail and no control — "a control
    // offered beside one is a control offered against nothing". Passing one here
    // would not render it, which is worse than not passing it, because the code
    // would read as though the control were on screen.
    return (
      <Nothing kind="not-loaded" placement="block" title="Reading the sessions on this node." />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title="There are no sessions on this node yet."
      detail="The node answered, and it has none. Starting one is the way to have the first."
      action={props.action}
    />
  );
}

interface SessionListNothingProps {
  readonly directory: SessionDirectoryState;
  readonly action: ReactNode;
}
