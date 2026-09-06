// The sessions destination's absence, chosen by what the directory read DID rather
// than by the row count.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and because the four arms are the surface's real content when there is
// nothing to list: the one decision that matters — which kind of nothing this is —
// was buried inside a ternary about array length, in a file whose other job is the
// list, the heading, and the start control.
//
// The decision that is not visible in the state is not made here.
// `rows/session-directory-rows.ts` owns `sessionsAbsenceKindFor`, so the merge and the
// absence agree by construction rather than by two switches written to match. The two
// states that map to exactly one kind are read off the state, which is what makes the
// refusal they do not carry unreachable instead of optional; the refused state, which
// carries two kinds, asks the selector.
//
// A directory refused for an UNBUILT WIRE and no session open is `not-checked`: the
// console did not ask the daemon, and must not report "there are none" for a question
// it never put. A directory whose read FAILED is a different fact again and gets the
// `error` kind with the daemon's own code and sentence — this arm used to be folded
// into `not-checked` beside a line saying the console had not asked, so a closed
// bridge channel read as an idle console that had chosen not to look. A SERVED
// directory with no rows is `empty`, because that question was put and answered. A
// read still in flight is `not-loaded`. Collapsing any two of the four is the
// conflation `Spec-023 §Console Design (Meridian)` rule 8 exists to prevent, and
// which of the two refusals this is is `isUnbuiltWireRefusal`'s to say rather than
// this surface's — one reading, beside the code it is about.

import { type ReactNode } from "react";

import type { SessionDirectoryState } from "../seats/index.js";
import { Nothing } from "../primitives/index.js";
import { sessionsAbsenceKindFor } from "./rows/session-directory-rows.js";

interface SessionsAbsenceProps {
  readonly directory: SessionDirectoryState;
  readonly action: ReactNode;
}

export function SessionsAbsence(props: SessionsAbsenceProps): React.JSX.Element {
  const { directory } = props;
  if (directory.status === "reading") {
    // No action on this arm, and the primitive is why: a read in flight renders as
    // a skeleton, which carries no title, no detail and no control — "a control
    // offered beside one is a control offered against nothing". Passing one here
    // would not render it, which is worse than not passing it, because the code
    // would read as though the control were on screen.
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the sessions on this node." />
    );
  }
  if (directory.status === "served") {
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
  // The refused state is the one that carries TWO kinds, and it is the only arm that
  // asks the selector — the other two states each map to exactly one kind, and reading
  // them off the state directly is what makes the refusal they do not carry
  // unreachable rather than optional. Which refusal THIS is stays the selector's
  // answer, so the console has one reading of a refusal and not two.
  const { refusal } = directory;
  if (sessionsAbsenceKindFor(directory) === "error") {
    // The read was put and it FAILED. The title is the daemon's code and the detail
    // its message, both verbatim: rule 9 fixes what reaches the screen from a refusal
    // at exactly those two, and `Nothing`'s `error` kind is the shape that carries
    // them where an absence stands in for the surface.
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={refusal.code}
        detail={refusal.detail}
        action={props.action}
      />
    );
  }
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="This console is not holding any sessions."
      detail={`The console lists the sessions this window has opened; the node's own directory answered nothing here. ${refusal.detail}`.trim()}
      action={props.action}
    />
  );
}
