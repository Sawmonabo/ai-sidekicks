// Everything the transcript says above its rows: the find field and the count of matches folded
// run groups hold. It derives nothing: each value is a reading the feed already holds, so a count
// computed here would be a second answer to `useTranscriptFind.ts`.

import { FindBox } from "../../find/components/FindBox.js";
import { PartialRead } from "#renderer/components/PartialRead/PartialRead.js";
import { matchWalkReading } from "../../find/readings.js";
import { type TranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";

/** The find state the header draws its field and counts from. */
export interface TranscriptFeedHeaderProps {
  /** The field, its walk and its close. */
  readonly findAndJump: TranscriptFindAndJump;
}

/** The find field and the count of matches the folded run groups hold. */
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
      {/* Opening a run group header brings the folded matches into the walk. */}
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.foldedAwayMatchCount)]}
        subject="the run groups this transcript has folded"
      />
    </>
  );
}
