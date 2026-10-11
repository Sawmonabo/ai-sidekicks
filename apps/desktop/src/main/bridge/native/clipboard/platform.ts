// Picks this operating system's clipboards.

import type { ClipboardHost, ClipboardHosts } from "./host.js";
import { linuxClipboardHost } from "./linux.js";
import { macClipboardHost } from "./mac.js";
import { windowsClipboardHost } from "./windows.js";

/**
 * This operating system's clipboards over Electron's, each read and written in the system's own
 * way: the system one everywhere, and the selection one on Linux alone, the one system that keeps
 * it. Every other system keeps its clipboards as Linux does.
 */
export function clipboardHostsFor(
  platform: NodeJS.Platform,
  electronClipboard: Electron.Clipboard,
): ClipboardHosts {
  const hostOf = HOST_OF_PLATFORM.get(platform) ?? linuxClipboardHost;
  return {
    system: hostOf(electronClipboard),
    selection: platform === "linux" ? hostOf(electronClipboard.selection) : undefined,
  };
}

/** Each system's clipboard over Electron's, by the platform Node names. */
const HOST_OF_PLATFORM: ReadonlyMap<
  NodeJS.Platform,
  (electronClipboard: Electron.Clipboard) => ClipboardHost
> = new Map([
  ["darwin", macClipboardHost],
  ["win32", windowsClipboardHost],
]);
