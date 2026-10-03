// What the session header draws while the session is opening: a placeholder of fixed height, so
// the header does not change height and move everything below it when the store opens. The
// placeholder is `aria-hidden` because it is a shape, not an answer; the `Nothing` beside it
// tells a screen reader once, in words, that the header is loading.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";

/** The header's opening state: a placeholder that holds its height, and the words for it. */
export function SessionHeaderSkeleton(): React.JSX.Element {
  return (
    <>
      <span className="meridian-session-header__placeholder" aria-hidden="true" />
      <Nothing kind="not-loaded" title="Loading…" />
    </>
  );
}
