// The window's own account of what it is not showing.
//
// The model beside it (`window-notices.ts`) owns the kinds and their words; this owns
// the mount. Each notice renders as the `Nothing` its kind names, in block form because
// it stands in for rows that are not there, and they stack in the caller's order. No
// wrapper and no live region: the console has one announcer, and these are settled
// facts about a window rather than a read landing under somebody's eyes.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { windowAbsenceNotices, type WindowAbsence } from "../../window-notices.js";

export interface WindowAbsencesProps {
  /**
   * Every way this window is less than the thing it is a window onto.
   *
   * The set rather than one, because a window that dropped older rows AND was told of
   * a sequence it never received is short twice over, and a person's move differs for
   * each. Counted absences at zero are dropped by the model, so a caller hands over
   * what it derived without filtering first.
   */
  readonly absences: readonly WindowAbsence[];
  /** What the window holds, as a lowercase plural noun phrase: "entries", "rows". */
  readonly subject: string;
}

/** What this window is not, said out loud. Renders nothing when it is the whole of it. */
export function WindowAbsences(props: WindowAbsencesProps): React.JSX.Element | null {
  const notices = windowAbsenceNotices(props.absences, props.subject);
  if (notices.length === 0) {
    return null;
  }
  return (
    <>
      {notices.map((notice) => (
        <Nothing
          key={notice.title}
          kind={notice.kind}
          placement="surface"
          title={notice.title}
          {...(notice.detail === undefined ? {} : { detail: notice.detail })}
        />
      ))}
    </>
  );
}
