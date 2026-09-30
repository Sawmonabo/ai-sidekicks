// The window's own account of what it is not showing. `window-notices.ts` owns the kinds and
// their words; this owns the mount: one block `Nothing` per notice, in the caller's order, with
// no wrapper and no live region, since the console has one announcer and these are settled facts.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { buildWindowNoticeTexts, type WindowAbsence } from "../../window-notices.js";

/** What a window says about itself: the ways it is partial, and what it holds. */
export interface WindowNoticesProps {
  /** Every way this window is less than what it is a window onto; zero counts are dropped. */
  readonly absences: readonly WindowAbsence[];
  /** What the window holds, as a lowercase plural noun phrase: "entries", "rows". */
  readonly subject: string;
}

/** What this window is not, said out loud. Renders nothing when it is the whole of it. */
export function WindowNotices(props: WindowNoticesProps): React.JSX.Element | null {
  const notices = buildWindowNoticeTexts(props.absences, props.subject);
  if (notices.length === 0) {
    return null;
  }
  return (
    <>
      {notices.map((notice) => (
        <Nothing
          key={notice.title}
          kind={notice.kind}
          placement="block"
          title={notice.title}
          {...(notice.detail === undefined ? {} : { detail: notice.detail })}
        />
      ))}
    </>
  );
}
