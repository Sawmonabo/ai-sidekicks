// The `+` that opens another shell: at the tab strip's end, and under `No active terminal.` once
// the last tab is closed.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";

/** What pressing the `+` does. */
export interface OpenShellButtonProps {
  readonly onOpen: () => void;
}

/** The `+` that opens another shell for the session. */
export function OpenShellButton(props: OpenShellButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-terminal-pane__open-shell"
      aria-label="Open a shell"
      onClick={props.onOpen}
    >
      <Glyph name="plus" size={GLYPH_SIZE_ROW} />
    </button>
  );
}
