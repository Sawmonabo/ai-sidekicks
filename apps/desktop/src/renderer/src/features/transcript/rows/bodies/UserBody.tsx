// A user's message body: the row's own summary, or the named absence of one. `user.message` has
// no payload variant yet, so the summary is all a `TimelineRow` carries; it is never captioned as
// if it were the message.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import type { HydratedRowProps } from "../hydrated-row-props.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** Props for `UserBody`. */
export interface UserBodyProps {
  readonly row: HydratedRowProps["row"];
  readonly footnotes: HydratedRowProps["footnotes"];
}

/**
 * The user's summary through the same markdown pipeline as an assistant body, since a user types
 * markdown. Passed complete: a projected summary is not a stream.
 */
export function UserBody(props: UserBodyProps): React.JSX.Element {
  if (props.row.summary === "") {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="This message has no summary."
        detail="Only a message's summary reaches the transcript, and this one is empty."
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
