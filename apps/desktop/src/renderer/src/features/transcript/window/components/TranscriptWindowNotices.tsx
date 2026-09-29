import { WindowAbsences } from "@renderer/console/primitives/index.js";

/**
 * The two ways this window holds less than the session: rows the cap took, and
 * sequences that never arrived. Two notices because a person's next move differs.
 */
export function TranscriptWindowNotices(
  props: TranscriptWindowNoticesProps,
): React.JSX.Element | null {
  return (
    <WindowAbsences
      absences={[
        { kind: "dropped", count: props.droppedRowCount },
        ...(props.hasUnreceivedEntries ? ([{ kind: "never-received" }] as const) : []),
      ]}
      subject="entries"
    />
  );
}

interface TranscriptWindowNoticesProps {
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
}
