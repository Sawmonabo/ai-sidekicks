// What an empty transcript window draws.

import { Nothing } from "@renderer/console/primitives/index.js";
import { EMPTY_TRANSCRIPT_WORDS } from "../empty-transcript-words.js";

/** The window with nothing in it, in the console's own shape for an absence. */
export function EmptyTranscript(): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title={EMPTY_TRANSCRIPT_WORDS.title}
      detail={EMPTY_TRANSCRIPT_WORDS.detail}
    />
  );
}
