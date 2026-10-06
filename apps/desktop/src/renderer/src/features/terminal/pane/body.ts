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
 * It is not detachable into a window of its own: a session has one shared shell, and its write
 * lease is held from one device at a time, so a torn-off pane would put it behind two mount
 * points. `render` goes through `paneBodyForKind`, which narrows the context to this kind and
 * throws on another, so no mount at another kind's address opens a second view on that shell.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "terminal",
  TerminalPane,
);
