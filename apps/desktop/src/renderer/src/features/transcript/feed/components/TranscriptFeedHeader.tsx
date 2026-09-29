// Everything the transcript says above its rows: the find field and the two counts of
// matches a person can still act on.
//
// ITS OWN MODULE BECAUSE IT IS ONE SUBJECT — what the find walk can reach, and what the
// window left out of it — while the feed beside it is about arrangement.
//
// IT DERIVES NOTHING. Every value below is a reading the feed already holds: this
// module decides only which of them reach a screen and in what order. A count
// computed here would be a second answer to a question `useVisibleTranscriptWindow.ts`
// already answers, and the two would agree until one of them shipped.

import { FindBox } from "../../find/components/FindBox.js";
import { PartialRead } from "@renderer/console/primitives/index.js";
import { matchWalkReading } from "../../find/find-readings.js";
import { type TranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";

/** The find state the header draws its field and counts from. */
export interface TranscriptFeedHeaderProps {
  /** The field, its walk and its close. */
  readonly findAndJump: TranscriptFindAndJump;
}

/** The find field and the counts of matches the window could not reach. */
export function TranscriptFeedHeader(props: TranscriptFeedHeaderProps): React.JSX.Element {
  const { find } = props.findAndJump;
  return (
    <>
      {find.isOpen ? (
        <FindBox
          query={find.query}
          result={find.result}
          currentMatchIndex={find.currentMatchIndex}
          openRequestCount={find.openRequestCount}
          onQueryChange={find.setQuery}
          onStep={props.findAndJump.onStep}
          onClose={props.findAndJump.onClose}
        />
      ) : null}
      {/* Two mounts and two subjects, because the two cuts are two facts with two
          exits: nothing brings a pruned row back, and opening a run group header brings
          the folded ones. One mount carrying both states would say the same sentence
          twice over a subject nobody could act on. */}
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.beyondWindowMatchCount)]}
        subject="this window"
      />
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.foldedAwayMatchCount)]}
        subject="the run groups this transcript has folded"
      />
    </>
  );
}
