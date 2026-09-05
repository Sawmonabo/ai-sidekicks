// The window's own account of what it is not showing.
//
// The model beside it (`window-absence.ts`) owns the four kinds and their sentences;
// this owns nothing but the mount. There is no box, no wrapper and no class of its
// own: each absence renders as the rule 8 absence its kind names, through the one
// primitive that draws them, and the absences stack in the order the caller derived
// them. A wrapper would have been a shape with no behaviour, and a live region on it
// would have been the second speaker `LiveAnnouncerProvider` forbids — these are
// settled facts about a window, not a read landing under somebody's eyes.
//
// `placement="surface"` on all four: each absence stands in for rows that are not
// there, which is the block form. The inline badge carries its second line as a
// tooltip only, and every sentence here has one that matters.

import { Nothing } from "./Nothing.js";
import { windowAbsenceNotices, type WindowAbsence } from "./window-absence.js";

export interface WindowAbsencesProps {
  /**
   * Every way this window is less than the thing it is a window onto.
   *
   * The set rather than one, because a window that dropped older rows AND is holding
   * later ones behind a replay is short twice over, and a person's move differs for
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
          detail={notice.detail}
        />
      ))}
    </>
  );
}
