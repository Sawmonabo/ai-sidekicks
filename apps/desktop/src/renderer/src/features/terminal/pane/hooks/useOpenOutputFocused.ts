// The emulator's output opener for a shell body that takes the focus as its emulator appears: the
// typing cursor lands in the shell this pane just opened, so the first keystroke reaches it.

import { useCallback, useRef } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import type { XtermTerminalAdapter } from "../../emulator/xterm/adapter.js";
import type { ShellOutputSink } from "../output-writer.js";

/**
 * Wrap `openOutput` so the first emulator it is handed takes the focus when `isFocusedOnOpen` was
 * set at mount; an emulator built again later for the same body leaves the focus where it is.
 */
export function useOpenOutputFocused(
  openOutput: (sink: ShellOutputSink) => Unsubscribe,
  isFocusedOnOpen: boolean,
): (adapter: XtermTerminalAdapter) => Unsubscribe {
  const isFocusPending = useRef(isFocusedOnOpen);
  return useCallback(
    (adapter: XtermTerminalAdapter) => {
      if (isFocusPending.current) {
        isFocusPending.current = false;
        adapter.focus();
      }
      return openOutput(adapter);
    },
    [openOutput],
  );
}
