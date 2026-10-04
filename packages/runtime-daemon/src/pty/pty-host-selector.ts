// Selector that picks the `PtyHost` backend for a daemon process, so the rest of the daemon does
// not branch on platform. Every platform gets `NodePtyHost` (in-process `node-pty`); no
// environment variable overrides the choice.

import { NodePtyHost } from "./node-pty-host.js";
import type { PtyHost } from "./pty-host.js";

/** Picks the `PtyHost` backend for this daemon process: `NodePtyHost` on every platform. */
export function selectPtyHost(): PtyHost {
  return new NodePtyHost();
}
