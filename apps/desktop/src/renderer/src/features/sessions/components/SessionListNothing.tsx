// The sessions destination's absence, chosen by what the directory read did rather than by
// the row count. `rows/session-directory-rows.ts` owns `sessionListNothingKindFor`, so the
// merge and this component agree. A served directory with no rows is `empty`; a read still
// in flight is `not-loaded`, and the two must not be conflated.

import { type ReactNode } from "react";

import type { SessionDirectoryState } from "@renderer/store/session-directory/session-directory.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";

/** What stands in for an empty list: a read in flight, a failed read, or a served list with no rows. */
export function SessionListNothing(props: SessionListNothingProps): React.JSX.Element {
  const { directory } = props;
  if (directory.status === "reading") {
    // No action here: a `not-loaded` Nothing renders as a skeleton and cannot show a control.
    return <Nothing kind="not-loaded" placement="block" title="Loading…" />;
  }
  if (directory.status === "failed") {
    // The list's own head says only that it could not be refreshed; the cause is in diagnostics.
    return <Nothing kind="error" placement="block" title="The list could not be refreshed." />;
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title="No sessions yet. Press New session to start with a chat or a project."
      action={props.action}
    />
  );
}

interface SessionListNothingProps {
  readonly directory: SessionDirectoryState;
  readonly action: ReactNode;
}
