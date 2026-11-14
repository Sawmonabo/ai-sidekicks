// The sessions destination's empty state, chosen by what the directory read did rather than by
// the row count. `rows/session-directory-rows.ts` owns `sessionListNothingKindFor`, so the
// merge and this component agree. A served directory with no rows is `empty`; a read still
// in flight is `not-loaded`, and the two must not be conflated.

import { type ReactNode } from "react";

import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";

/**
 * What stands in for an empty list: a read in flight, a failed read, or a served list with no rows.
 */
export function SessionListNothing(props: SessionListNothingProps): React.JSX.Element {
  const { directory } = props;
  if (directory.status === "reading") {
    // No action here: a `not-loaded` Nothing renders as a skeleton and cannot show a control.
    return <Nothing kind="not-loaded" placement="block" title="Loading…" />;
  }
  if (directory.status === "failed") {
    // A first read that failed with no row drawn: no refresh, so it names the list and no cause.
    return (
      <Nothing
        kind="error"
        placement="block"
        title="Couldn't load sessions"
        action={<TryAgainButton onPress={props.onReadAgain} />}
      />
    );
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
  /** Reads the list again after a failed first read. */
  readonly onReadAgain: () => void;
}
