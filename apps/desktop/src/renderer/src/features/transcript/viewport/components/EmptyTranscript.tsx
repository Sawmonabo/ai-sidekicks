// What an empty transcript window draws: one line saying the transcript is empty.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";

/** The window with nothing in it. */
export function EmptyTranscript(): React.JSX.Element {
  return (
    <Nothing kind="empty" placement="block" title="No messages yet. Say what you are after." />
  );
}
