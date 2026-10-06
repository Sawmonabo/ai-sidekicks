// A user's message body: the row's own summary. `user.message` has no payload variant, so the
// summary is all a `TranscriptEventRow` carries; it is never captioned as if it were the message.

import type { HydratedRowProps } from "../hydrated-props.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** Props for `UserBody`. */
export interface UserBodyProps {
  readonly row: HydratedRowProps["row"];
  readonly footnotes: HydratedRowProps["footnotes"];
}

/**
 * The user's summary through the same markdown pipeline as an assistant body, since a user types
 * markdown. Passed complete: a projected summary is not a stream. An empty summary draws nothing.
 */
export function UserBody(props: UserBodyProps): React.JSX.Element | null {
  if (props.row.summary === "") {
    return null;
  }
  return (
    <StreamingMarkdown
      publishedText={props.row.summary}
      sourceId={props.row.id}
      footnotes={props.footnotes}
      isComplete
      offersCodeCopy={false}
    />
  );
}
