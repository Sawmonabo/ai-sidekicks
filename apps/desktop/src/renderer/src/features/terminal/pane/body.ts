// The terminal pane's body, as the pane layout's registry loads it.
//
// A loader-backed body: the emulator chunk was already lazy, and this keeps the lease line,
// the pane and its frame out of the initial graph for sessions that never open a terminal.

import { paneBodyForKind } from "#renderer/registries/panes/body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { TerminalPane } from "./components/TerminalPane.js";

/**
 * The terminal pane, as the pane layout holds it.
 *
 * It can move into a window of its own: the one console document draws every window, and each
 * shell's lease is held by a device, not by a window. `render` goes through `paneBodyForKind`,
 * which narrows the context to this kind and throws on another.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "terminal",
  TerminalPane,
);
