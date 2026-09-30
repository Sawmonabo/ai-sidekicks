// Who holds each of a session's shells, as the session roster reads it.
import type { TerminalControlHolder, TerminalId } from "@ai-sidekicks/contracts";

/**
 * One held shell: the shell, and the device holding it, with the run and its command
 * while an agent's running command holds it.
 */
export interface SessionTerminalControlEntry extends TerminalControlHolder {
  terminalId: TerminalId;
}

/**
 * The roster's reading of a session's shell leases: one entry per held shell.
 *
 * The lease is per shell, so a session with several shells has a holder for each, and
 * this device may hold one while another device or a run holds another. A shell
 * nobody holds has no entry. Neither does a shell held by a node the control plane
 * reads as `offline`: no client should offer to write against a holder that cannot be
 * vouched live, so both read as a free shell. The suppression binds at `offline` and
 * nothing weaker; `degraded` is a band a node recovers from.
 */
export interface SessionTerminalControlReading {
  controlHolder: readonly SessionTerminalControlEntry[];
}
