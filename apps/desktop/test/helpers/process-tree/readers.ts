// What this host will tell you about a process, and nothing about what to do
// with it.
//
// The role split this directory is: `liveness.ts` asks what a pid is DOING,
// `identity.ts` asks whether it still names the same PROCESS, `arms.ts` decides
// what to signal and `dispatch.ts` picks the arm. This module is underneath all
// four and owns only the readings — the two commands, their parsers, and the
// walk over what they return. It decides nothing, which is why every arm above
// can be driven without it.
//
// ONE READ FOR THE WHOLE TABLE, AND THE STAMPS COME WITH IT
//
// The table used to be `pid → ppid` and the per-instance start stamp was a
// separate per-pid command. That was fine while only the ROOT's stamp was ever
// wanted; it stopped being fine the moment a DESCENDANT had to prove its own
// identity, because a tree is a dozen processes and a dozen `Get-CimInstance`
// spawns is a dozen PowerShell starts inside a disposal that is already racing a
// teardown. Both platforms will emit the stamp as a third column of the same
// listing, so the row carries it and the whole verification costs one spawn.
//
// A STAMP IS COMPARED ONLY AGAINST A STAMP FROM THE SAME READER. `readProcessStartStamp`
// and the table's third column are two commands with two formats — `ps -o lstart=`
// pads a single-digit day where a joined field might not, and PowerShell is asked
// for `CreationDate.Ticks` in one place and the same property in the other — so
// they are equal in practice and are deliberately never relied on to be. The root
// is captured and re-read through the per-pid reader; a descendant is captured and
// re-read through the table. Nothing crosses.
//
// AND EVERY READ IS BOUNDED, BECAUSE AN UNBOUNDED ONE IS A LEAK
//
// Both commands are `spawnSync`, which blocks this thread until the child it
// started exits — and `ps` under a hung filesystem, or PowerShell on a runner
// whose CIM service is not answering, does not exit. That call is performed at
// the spawn of every managed Electron and again inside every disposal, so an
// unbounded one hangs the worker at exactly the moment a detached browser needs
// killing: vitest's own timeout is a timer on this same blocked thread, and a
// worker killed while blocked runs no teardown at all. So both reads carry a
// `timeout`, and a read that spends it comes back as an `error` — which both
// readers below already treat as an unreadable host rather than as evidence.
//
// AND A PARSE THAT WOULD RATHER SKIP A ROW THAN INVENT ONE. Neither command's
// output is only rows: `ps` prints a header under some option sets and a warning
// under others, and PowerShell prints its own diagnostics on the stream it is
// asked for. A line whose first two fields are not integers contributes nothing,
// because a banner in a kill list is a pid this package never spawned.

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * One process, as the two facts a termination decision reads about it.
 *
 * `startStamp` is `undefined` when the listing carried no third column — a
 * platform whose reader emits two, or a row that was cut short. That is not
 * evidence of anything and the identity check treats it as such: absence of a
 * stamp never convicts a pid of being somebody else.
 */
export interface ProcessTableRow {
  /** The pid this row records as its parent, whether or not that pid still exists. */
  readonly parentProcessId: number;
  /** This instance's per-instance start stamp, or `undefined` if none was read. */
  readonly startStamp: string | undefined;
}

/** This host's process table, as one injectable reading. */
export type ProcessTableReader = () => ReadonlyMap<number, ProcessTableRow>;

/** How one root's per-instance start stamp is read, as one injectable reading. */
export type ProcessStartStampReader = (processId: number) => string | undefined;

/**
 * How long either host query gets before it is abandoned as unreadable.
 *
 * ONE BOUND FOR BOTH READS, because they are one question asked of one host and
 * two figures here would be two things to keep in step. It is applied as
 * `spawnSync`'s own `timeout`, so a query that overruns is killed and reported
 * through the `error` field both readers already treat as "this host would not
 * answer" — the degradation is the one that was already specified, not a new one.
 *
 * The figure is derived from what it must not disturb rather than from a
 * measurement of `ps`, which answers in single-digit milliseconds on every
 * healthy host and is not the case this exists for. Two properties fix it:
 * PowerShell's cold start on a loaded Windows runner is seconds rather than
 * milliseconds, so a bound near a second would abandon readable hosts; and the
 * disposal this read sits inside is held to `CLEANUP_BUDGET_MS`, so a single
 * query must not be able to spend that whole budget and leave no time for the
 * kill it was taken for. Half of it is the largest value with both properties,
 * and `process-tree-readers.test.ts` holds the relation rather than this comment.
 */
export const HOST_QUERY_TIMEOUT_MS = 5_000;

/**
 * A process table out of whitespace-separated `pid ppid [start stamp]` lines.
 *
 * One parser for both platforms, which is why both readers below are asked to
 * emit that shape rather than their native one: two parsers over two output
 * formats are two things that drift, and the format is the caller's to choose.
 *
 * The stamp is taken as the REMAINDER of the line rather than as a third field,
 * and that is not tidiness: `ps -o lstart=` emits `Sun Sep  7 02:25:10 2026`,
 * five whitespace-separated tokens for one value. It is kept VERBATIM apart from
 * the surrounding whitespace — re-joining split tokens would collapse the double
 * space a single-digit day is padded with, and a stamp normalised on one read and
 * not on the other compares unequal and reports every descendant as reissued.
 *
 * A line whose first two fields are not integers is a header or a warning and
 * contributes nothing. That check is what admits the remainder safely: it is the
 * two integers that make a line a row, so a banner cannot become one by having
 * words after them.
 */
export function parseProcessTable(tableText: string): Map<number, ProcessTableRow> {
  const rowByProcessId = new Map<number, ProcessTableRow>();
  for (const line of tableText.split("\n")) {
    const fields = /^\s*(\S+)\s+(\S+)(?:\s+(\S.*?))?\s*$/.exec(line);
    if (fields === null) {
      continue;
    }
    const childProcessId = Number(fields[1]);
    const parentProcessId = Number(fields[2]);
    if (!Number.isInteger(childProcessId) || !Number.isInteger(parentProcessId)) {
      continue;
    }
    rowByProcessId.set(childProcessId, { parentProcessId, startStamp: fields[3] });
  }
  return rowByProcessId;
}

/**
 * This host's process table, or an empty one if it could not be read.
 *
 * Platform-dispatched rather than Windows-only, even though the arm that
 * consumes it is Windows'. A reader nothing on this runner ever executes is a
 * reader nothing checks, and the parsing above is only half the claim — that the
 * command emits the shape it is parsed as is the other half, and the POSIX
 * branch is what makes it checkable here.
 *
 * An empty table is the honest answer to an unreadable one: it names no
 * descendant, so the arm above reports a refusal rather than inventing pids.
 * It is deliberately NOT read as "every captured member has exited" either —
 * `identity.ts` refuses a captured pid only on a stamp that disagrees, never on
 * a row that is missing, so an unreadable listing disarms nothing.
 */
export function readProcessTable(): Map<number, ProcessTableRow> {
  const listing =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }',
          ],
          { encoding: "utf8", timeout: HOST_QUERY_TIMEOUT_MS },
        )
      : spawnSync("ps", ["-Ao", "pid=,ppid=,lstart="], {
          encoding: "utf8",
          timeout: HOST_QUERY_TIMEOUT_MS,
        });
  if (listing.error !== undefined || listing.status !== 0) {
    return new Map<number, ProcessTableRow>();
  }
  return parseProcessTable(listing.stdout);
}

/**
 * The per-instance start stamp for ONE `processId`, or `undefined`.
 *
 * THE READING THAT SEPARATES A PID FROM THE PROCESS HOLDING IT. Every other
 * reading in this directory answers a question about a NUMBER, and a number is
 * reissued: the launcher shim exits, it is reaped, and the pid every later
 * disposal is addressed through can by then belong to somebody else. A start
 * stamp is the one thing the operating system does not reissue with it, so
 * comparing the stamp read now against the stamp read at spawn is what makes
 * "this is still the tree I spawned" answerable at all.
 *
 * Asked per pid rather than off the table above, and only for the ROOT: the root
 * is captured at the spawn, where the tree has no descendants to read and a
 * whole-host listing would be a hundred rows to keep one. Descendants are
 * captured from the table because by then there are several of them and the
 * listing is one spawn for all.
 *
 * Platform-dispatched for `readProcessTable`'s reason and with its posture.
 * Windows is asked through the same `Win32_Process` view, as `CreationDate.Ticks`,
 * which is an integer rather than a locale-formatted date; POSIX is asked through
 * `ps -o lstart=`, whose one-second resolution is enough for a comparison and is
 * deliberately not claimed to be more.
 *
 * `undefined` means the stamp could not be read, which is not evidence of
 * anything — `SpawnedTreeIdentity` settles what to do about it.
 */
export function readProcessStartStamp(processId: number): string | undefined {
  if (processId <= 0) {
    return undefined;
  }
  const reported =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(processId)}").CreationDate.Ticks`,
          ],
          { encoding: "utf8", timeout: HOST_QUERY_TIMEOUT_MS },
        )
      : spawnSync("ps", ["-o", "lstart=", "-p", String(processId)], {
          encoding: "utf8",
          timeout: HOST_QUERY_TIMEOUT_MS,
        });
  if (reported.error !== undefined || reported.status !== 0) {
    return undefined;
  }
  const stamp = reported.stdout.trim();
  return stamp === "" ? undefined : stamp;
}

/**
 * Every process below `rootProcessId` in `processTable`, transitively.
 *
 * A breadth walk with a visited set rather than recursion, and the set is
 * load-bearing rather than tidy: a process table is a snapshot of a host whose
 * pids are reused, so a row pair naming each other as parents is representable
 * and a walk without the set would never return. The root is not in the result —
 * the caller already holds it, and the two are terminated for different reasons.
 *
 * WHAT THIS IS EVIDENCE OF, AND WHAT IT IS NOT. Windows does not reparent, so a
 * live descendant of a tree keeps recording that tree's root pid after the root
 * has exited — which makes the absence of a row sound evidence that nothing
 * claims the root, and the presence of one no evidence at all that the claimant
 * is this tree's: the number gets reissued, and a child of the pid's FORMER
 * holder records it exactly as a child of the current one does. `arms.ts` is
 * where that asymmetry is spent; here it is only the reason this returns pids and
 * not a verdict.
 */
export function descendantsOf(
  rootProcessId: number,
  processTable: ReadonlyMap<number, ProcessTableRow>,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [childProcessId, row] of processTable) {
    const siblings = childrenByParent.get(row.parentProcessId);
    if (siblings === undefined) {
      childrenByParent.set(row.parentProcessId, [childProcessId]);
    } else {
      siblings.push(childProcessId);
    }
  }
  const discovered = new Set<number>([rootProcessId]);
  const pending = [rootProcessId];
  const descendants: number[] = [];
  while (pending.length > 0) {
    const parentProcessId = pending.shift() as number;
    for (const childProcessId of childrenByParent.get(parentProcessId) ?? []) {
      if (discovered.has(childProcessId)) {
        continue;
      }
      discovered.add(childProcessId);
      descendants.push(childProcessId);
      pending.push(childProcessId);
    }
  }
  return descendants;
}
