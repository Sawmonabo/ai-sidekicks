// A participant's message body — the row's own summary, and the sentence for none.
//
// Its own module for the one-component rule, and the honest limit it states is worth
// its own file: `user.message` is a registered event type with no payload variant, so
// a participant's words are sealed in the per-participant encrypted column and the
// summary is the whole of what a timeline row carries. This renders what exists and
// never captions the summary as if it were the message.

import { Nothing } from "../../../primitives/index.js";
import type { LedgerCardProps } from "../card-props.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

export interface ParticipantBodyProps {
  readonly row: LedgerCardProps["row"];
  readonly footnotes: LedgerCardProps["footnotes"];
}

/**
 * The participant's summary, or the named absence of one.
 *
 * The summary is rendered through the same markdown pipeline an assistant body takes,
 * for one reason: a participant types markdown, and rendering their backticks as
 * backticks in one row and as code in the next would make the log inconsistent about
 * what a message IS. It is passed complete, because a projected summary is not a
 * stream — there is no tail to hold volatile.
 */
export function ParticipantBody(props: ParticipantBodyProps): React.JSX.Element {
  if (props.row.summary === "") {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="This message has no summary."
        detail="The participant's own words are not carried on a timeline row."
      />
    );
  }
  return (
    <StreamingMarkdown
      publishedText={props.row.summary}
      sourceId={props.row.id}
      footnotes={props.footnotes}
      isComplete
    />
  );
}
