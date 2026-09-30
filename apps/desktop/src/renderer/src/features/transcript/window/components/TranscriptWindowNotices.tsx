import { WindowNotices } from "../../components/WindowNotices/WindowNotices.js";

/** Says at the top of the loaded history how many rows the window cap dropped. */
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
  readonly droppedRowCount: number;
}
