// What an empty transcript window draws.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { EMPTY_TRANSCRIPT_WORDS } from "../empty-transcript-words.js";

/** The window with nothing in it, in the console's own shape for an absence. */
export function EmptyTranscript(): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="block"
      title={EMPTY_TRANSCRIPT_WORDS.title}
      detail={EMPTY_TRANSCRIPT_WORDS.detail}
    />
  );
}
