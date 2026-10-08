// The window's own account of the rows it no longer holds: one block `Nothing` at the top of the
// loaded history, with no live region, since the app has one announcer and this is a settled fact.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatCount } from "#renderer/lib/wire/figures.js";

/** What the window cap took from this window. */
export interface TranscriptWindowNoticesProps {
  /** Rows the window cap dropped as the session grew. */
  readonly droppedRowCount: number;
}

/** Says at the top of the loaded history how many rows the window cap dropped, or nothing. */
export function TranscriptWindowNotices(
  props: TranscriptWindowNoticesProps,
): React.JSX.Element | null {
  if (props.droppedRowCount === 0) {
    return null;
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title="Older entries are no longer in this window."
      detail={[
        { derived: formatCount(props.droppedRowCount) },
        " left the window as the session grew.",
      ]}
    />
  );
}
