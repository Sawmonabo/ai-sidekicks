// The `+` that opens another shell: at the tab strip's end, and under `No active terminal.` once
// the last tab is closed, where it takes the focus when this pane closed that tab.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";

/** What pressing the `+` does, and whether it takes the focus as it appears. */
export interface OpenShellButtonProps {
  readonly onOpen: () => void;
  readonly isFocusedOnMount: boolean;
}

/** The `+` that opens another shell for the session. */
export function OpenShellButton(props: OpenShellButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-terminal-pane__open-shell"
      aria-label="Open a shell"
      // Mounted only where it appears, so the focus moves once, as the last tab goes.
      autoFocus={props.isFocusedOnMount}
      onClick={props.onOpen}
    >
      <Glyph name="plus" size={GLYPH_SIZE_ROW} />
    </button>
  );
}
