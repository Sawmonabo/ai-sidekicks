// The line a person reads while the service repairs its database file, drawn in parts so each
// count can take the reader's own form of a figure.
import { DAEMON_REPAIRING_LINE, type DaemonRepairProgress } from "../generated/daemon/recovery.js";

/**
 * The repair's line in parts, `<line> · <done> of <total>`, or the line ending in `…` when there
 * is no count; `drawCount` turns each figure into the reader's own form of it, such as a string
 * in the reader's locale.
 */
export function describeDaemonRepairingLine<Figure>(
  progress: DaemonRepairProgress | undefined,
  drawCount: (count: number) => Figure,
): (string | Figure)[] {
  return progress === undefined
    ? [`${DAEMON_REPAIRING_LINE}…`]
    : [`${DAEMON_REPAIRING_LINE} · `, drawCount(progress.done), " of ", drawCount(progress.total)];
}
