// The sessions destination's absence, chosen by what the directory read DID rather
// than by the row count.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and because the three arms are the surface's real content when there is
// nothing to list: the one decision that matters — which kind of nothing this is —
// was buried inside a ternary about array length, in a file whose other job is the
// list, the heading, and the start control.
//
// A refused directory with no session open is `not-checked`: the console did not ask
// the daemon, and must not report "there are none" for a question it never put. A
// SERVED directory with no rows is `empty`, because that question was put and
// answered. A read still in flight is `not-loaded`. Collapsing any two of the three
// is the conflation `Spec-023 §Console Design (Meridian)` rule 8 exists to prevent.

import { type ReactNode } from "react";

import { Nothing } from "../primitives/index.js";
import { type SessionDirectoryState } from "./session-directory.js";

interface SessionsAbsenceProps {
  readonly directory: SessionDirectoryState;
  readonly action: ReactNode;
}

export function SessionsAbsence(props: SessionsAbsenceProps): React.JSX.Element {
  if (props.directory.status === "reading") {
    // No action on this arm, and the primitive is why: a read in flight renders as
    // a skeleton, which carries no title, no detail and no control — "a control
    // offered beside one is a control offered against nothing". Passing one here
    // would not render it, which is worse than not passing it, because the code
    // would read as though the control were on screen.
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the sessions on this node." />
    );
  }
  if (props.directory.status === "served") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="There are no sessions on this node yet."
        detail="The node answered, and it has none. Starting one is the way to have the first."
        action={props.action}
      />
    );
  }
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="No session is open in this window."
      detail={`The console shows the sessions this window has opened; it has not asked the daemon for the rest. ${props.directory.refusal.detail}`}
      action={props.action}
    />
  );
}
