// Everything the transcript says above its rows: the find field and the two counts of matches a
// person can still act on. It derives nothing: each value is a reading the feed already holds, so
// a count computed here would be a second answer to `useVisibleTranscriptWindow.ts`.

import { FindBox } from "../../find/components/FindBox.js";
import { PartialRead } from "@renderer/components/PartialRead/PartialRead.js";
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
      {/* Two mounts, two exits: nothing brings a pruned row back, and opening a run group
          header brings the folded ones. */}
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
