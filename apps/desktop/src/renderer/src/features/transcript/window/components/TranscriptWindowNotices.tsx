import { WindowNotices } from "../../components/WindowNotices/WindowNotices.js";

/**
 * The rows the cap took from this window, said at the top of the history that is
 * loaded until the control that loads earlier history stands there.
 */
export function TranscriptWindowNotices(
  props: TranscriptWindowNoticesProps,
): React.JSX.Element | null {
  return (
    <WindowNotices
      absences={[{ kind: "dropped", count: props.droppedRowCount }]}
      subject="entries"
    />
  );
}

interface TranscriptWindowNoticesProps {
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
}
