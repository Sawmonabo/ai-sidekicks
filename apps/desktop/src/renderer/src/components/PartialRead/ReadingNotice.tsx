// One notice, in the shape its instruction names. It decides which primitive a reading's cause
// reaches the screen through (the not-loaded absence, or the refusal); `PartialRead` decides that
// a view owes one notice per reading.
//
// It branches on the shape once and never re-reads the state. It creates no live region: `Nothing`
// and `InlineRefusal` own theirs, and a view speaks the sentence with `useAnnounceOncePerSentence`.

import "./PartialRead.css";

import { Nothing } from "../Nothing/Nothing.js";
import { DerivedFigure } from "../DerivedFigure/DerivedFigure.js";
import { InlineRefusal } from "../Refusal/InlineRefusal.js";
import type { PartialReadNotice } from "#renderer/lib/partial-read.js";

/** Props for `ReadingNotice`. */
export interface ReadingNoticeProps {
  readonly notice: PartialReadNotice;
}

/** Renders one notice, or nothing for the `none` shape. */
export function ReadingNotice(props: ReadingNoticeProps): React.JSX.Element | null {
  const { notice } = props;
  if (notice.shape === "none") {
    return null;
  }
  if (notice.shape === "reading") {
    // Inline: the read is in flight beside rows already on screen.
    return <Nothing kind="not-loaded" placement="inline" title={notice.title} />;
  }
  return (
    <div className="meridian-partial-read">
      <p className="meridian-partial-read__copy">
        <DerivedFigure text={notice.figure} /> {notice.copy}
      </p>
      {notice.refusal === undefined ? null : (
        <InlineRefusal code={notice.refusal.code} detail={notice.refusal.detail} />
      )}
    </div>
  );
}
