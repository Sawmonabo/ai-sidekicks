// Everything the transcript says above its rows: the find field. It derives nothing: each value
// is a reading the feed already holds, so a count computed here would be a second answer to
// `useTranscriptFind.ts`.

import { FindBox } from "../../find/components/FindBox.js";
import { type TranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";

/** The find state the header draws its field and counts from. */
export interface TranscriptFeedHeaderProps {
  /** The field, its walk and its close. */
  readonly findAndJump: TranscriptFindAndJump;
}

/** The find field, while it is open. */
export function TranscriptFeedHeader(props: TranscriptFeedHeaderProps): React.JSX.Element | null {
  const { find } = props.findAndJump;
  return find.isOpen ? (
    <FindBox
      query={find.query}
      result={find.result}
      areRowsShown={props.findAndJump.areRowsShown}
      currentMatchIndex={find.currentMatchIndex}
      openRequestCount={find.openRequestCount}
      onQueryChange={find.setQuery}
      onStep={props.findAndJump.onStep}
      onClose={props.findAndJump.onClose}
    />
  ) : null;
}
