// Selector that picks the `PtyHost` backend for a daemon process, so the rest of the daemon does
// not branch on platform. Every platform gets `NodePtyHost` (in-process `node-pty`); no
// environment variable overrides the choice.

import type { TerminalOperatingSystem } from "../operating-system/contract.js";
import { NodePtyHost, type NodePtyOrphanGuard } from "./node-pty.js";
import type { PtyHost } from "./contract.js";

/**
 * Picks the `PtyHost` backend for this daemon process: `NodePtyHost` on every platform, recording
 * each child through `orphanGuard` and starting it as `operatingSystem` says.
 */
export function selectPtyHost(
  orphanGuard: NodePtyOrphanGuard,
  operatingSystem: TerminalOperatingSystem,
): PtyHost {
  return new NodePtyHost(orphanGuard, operatingSystem);
}
