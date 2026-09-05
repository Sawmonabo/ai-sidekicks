// One notice, in the shape its instruction names.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and the reason that rule holds here rather than being a formality: this is
// the component that decides which PRIMITIVE a reading's cause reaches the screen
// through — rule 8's absence for a read in flight, rule 9's refusal for a cause —
// and `PartialRead` beside it decides only that a surface owes one notice per
// reading it holds. Two decisions, two modules, and a family that later needs a
// notice without the set around it can mount this one.
//
// THE SHAPE IS THE INSTRUCTION AND THE STATE IS NOT. `partial-read.ts` maps six
// reading states onto four shapes, so this branches on the shape once and never
// re-reads the state: a component that switched on `kind` a second time would be a
// second place the console decides what a `stale` reading looks like.
//
// AND IT CREATES NO LIVE REGION. `LiveAnnouncerProvider` states the console's
// standing absolute — one announcer per window — and the two regions a notice can
// touch already have owners: the `reading` arm delegates to `Nothing`, which carries
// its own, and a prose arm nests `InlineRefusal`, which carries rule 9's. Where the
// SENTENCE itself has to be spoken, the surface calls `useReadingAnnouncement`.

import { Nothing } from "./Nothing.js";
import { DerivedFigure } from "./DerivedFigure.js";
import { InlineRefusal } from "./Refusal.js";
import type { PartialReadNotice } from "./partial-read.js";

export interface ReadingNoticeProps {
  readonly notice: PartialReadNotice;
}

/** One notice, in the shape its instruction names. */
export function ReadingNotice(props: ReadingNoticeProps): React.JSX.Element | null {
  const { notice } = props;
  if (notice.shape === "none") {
    return null;
  }
  if (notice.shape === "reading") {
    // Inline rather than a surface-shaped block: the read is in flight beside rows
    // that are already on screen, and a block would stand in for a surface that is
    // there.
    return <Nothing kind="not-loaded" placement="inline" title={notice.title} />;
  }
  return (
    <div className="meridian-partial-read">
      <p className="meridian-partial-read__copy">
        {notice.shape === "counted-sentence" ? (
          <>
            <DerivedFigure text={notice.figure} />{" "}
          </>
        ) : null}
        {notice.copy}
      </p>
      {notice.refusal === undefined ? null : (
        <InlineRefusal code={notice.refusal.code} detail={notice.refusal.detail} />
      )}
    </div>
  );
}
