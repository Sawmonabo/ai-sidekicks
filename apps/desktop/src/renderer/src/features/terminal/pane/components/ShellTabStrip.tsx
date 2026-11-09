// The terminal pane's tab strip: one tab per shell in the session's list order, named by the
// shell's own title, the shown one marked current, each with its `×`, and the `+` at the end. A
// middle-click on a tab closes it exactly as its `×` does, and nothing says so. The tabs are a
// list of controls with the current one `aria-current`, as Preview's strip draws them.

import "./ShellTabStrip.css";

import type { TerminalId, TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { OpenShellButton } from "./OpenShellButton.js";

/** The shells a strip draws, the shown one, and the acts its controls send. */
export interface ShellTabStripProps {
  readonly terminals: readonly TerminalListEntry[];
  readonly activeTerminalId: TerminalId | undefined;
  readonly onSelect: (terminalId: TerminalId) => void;
  readonly onClose: (terminalId: TerminalId) => void;
  readonly onOpen: () => void;
}

/** One tab per shell and the `+` that opens another. */
export function ShellTabStrip(props: ShellTabStripProps): React.JSX.Element {
  const { terminals, activeTerminalId, onSelect, onClose, onOpen } = props;
  const stripScrollbarRef = useDrawOverlayScrollbar<HTMLDivElement>();
  return (
    <div className="meridian-terminal-tabs" ref={stripScrollbarRef}>
      <ul className="meridian-terminal-tabs__list">
        {terminals.map((shell) => (
          <li
            key={shell.terminalId}
            className={
              shell.terminalId === activeTerminalId
                ? "meridian-terminal-tab meridian-terminal-tab--selected"
                : "meridian-terminal-tab"
            }
            onMouseDown={(event) => {
              // The middle button's own press would start the platform's autoscroll.
              if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
              }
            }}
            onAuxClick={(event) => {
              if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
                onClose(shell.terminalId);
              }
            }}
          >
            <button
              type="button"
              className="meridian-terminal-tab__face"
              aria-current={shell.terminalId === activeTerminalId ? "true" : undefined}
              onClick={() => {
                onSelect(shell.terminalId);
              }}
            >
              <span className="meridian-terminal-tab__label">{shell.title}</span>
            </button>
            <button
              type="button"
              className="meridian-terminal-tab__close"
              aria-label={`Close ${shell.title}`}
              onClick={() => {
                onClose(shell.terminalId);
              }}
            >
              <Glyph name="close" size={GLYPH_SIZE_ROW} />
            </button>
          </li>
        ))}
      </ul>
      <OpenShellButton onOpen={onOpen} />
    </div>
  );
}

/** The middle button's number in `MouseEvent.button`. */
const MIDDLE_BUTTON = 1;
