// A person's message body: the whole message its row's `user.message` payload carries.

import { useMemo } from "react";

import { publishedTextOf } from "../../reveal/published-text.js";
import type { TranscriptCardProps } from "../card-props.js";
import { userMessageTextOf } from "../user-message.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** Props for `UserBody`. */
export interface UserBodyProps {
  readonly row: TranscriptCardProps["row"];
  readonly footnotes: TranscriptCardProps["footnotes"];
}

/**
 * The message through the same markdown pipeline as an assistant body, since a person types
 * markdown. Passed complete: a sent message is not a stream. A row holding no message draws none.
 */
export function UserBody(props: UserBodyProps): React.JSX.Element | null {
  const message = userMessageTextOf(props.row);
  // One handle per message, so the segmenter sees the same text across renders.
  const messageText = useMemo(
    () => (message === undefined ? undefined : publishedTextOf(message)),
    [message],
  );
  if (messageText === undefined) {
    return null;
  }
  return (
    <StreamingMarkdown
      publishedText={messageText}
      sourceId={props.row.id}
      footnotes={props.footnotes}
      isComplete
      offersBlockCopy={false}
    />
  );
}
