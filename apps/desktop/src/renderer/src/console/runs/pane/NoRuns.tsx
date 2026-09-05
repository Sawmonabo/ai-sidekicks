// What the runs pane says when the read came back with no runs.
//
// Split from `RunsPane.tsx` so the pane's one job — mounting the body against a
// session — is not read through three absence cases.
//
// AN EMPTY LIST AND AN UNREAD LIST ARE DIFFERENT SENTENCES. `hasRead` is what
// separates them, and the refusal that closed the stream is carried rather than
// paraphrased, because "no runs" over a stream nobody could open is a claim this
// surface has no standing to make.

import type { ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";

/**
 * Two different absences, told apart by whether the read that says WHICH RUNS EXIST
 * has completed — and, ahead of both, the refusal that says the stream was never
 * opened.
 *
 * Reached only when the seating produced no row at all, which is now the exact
 * condition under which the session knows of no run and the stream has projected
 * none. `empty` is the arm once the snapshot has landed, and `not-loaded` the arm
 * before it: a session whose snapshot names runs seats rows for them and never
 * arrives here, which is what retires the skeleton that used to outlive every
 * terminal pre-existing run.
 */
export function NoRuns(props: {
  readonly hasRead: boolean;
  readonly openRefusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  if (props.openRefusal !== undefined) {
    return <InlineRefusal code={props.openRefusal.code} detail={props.openRefusal.detail} />;
  }
  if (!props.hasRead) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the runs in this session." />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No run has started in this session yet."
      detail="Send a message to an agent and its run appears here with its status, its queue, and every intervention raised against it."
    />
  );
}
