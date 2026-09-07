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
// Every host query here is a `spawnSync`, which blocks this thread until the
// child it started exits — and `ps` under a hung filesystem, or PowerShell on a
// runner whose CIM service is not answering, does not exit. Those calls are
// performed at the spawn of every managed Electron, again inside every disposal,
// and once more by the liveness state read next door, so an unbounded one hangs
// the worker at exactly the moment a detached browser needs killing: vitest's own
// timeout is a timer on this same blocked thread, and a worker killed while
// blocked runs no teardown at all.
//
// So there is ONE way to ask this host anything — `runBoundedHostQuery` — and the
// bound is a property of that function rather than of each call site. Three
// call sites carried their own options object and the fourth, the macOS state
// code in `liveness.ts`, carried one WITHOUT the timeout: a bound restated at
// each site is a bound one site will be written without, and it was. A query
// that spends its bound comes back as an `error`, which the one runner reads as
// an unreadable host rather than as evidence.
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

/**
 * This host's process table, as one injectable reading.
 *
 * The optional budget is what is LEFT of the caller's own deadline, and it is
 * optional because most callers hold none: the capture taken at a spawn is not
 * inside anybody's disposal. A caller that does hold one passes it, and the
 * reading is bounded by the smaller of it and `HOST_QUERY_TIMEOUT_MS`.
 */
export type ProcessTableReader = (
  remainingBudgetMilliseconds?: number,
) => ReadonlyMap<number, ProcessTableRow>;

/** How one root's per-instance start stamp is read, as one injectable reading. */
export type ProcessStartStampReader = (
  processId: number,
  remainingBudgetMilliseconds?: number,
) => string | undefined;

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
 * What running one host query needs from the platform, narrowed to three fields.
 *
 * `spawnSync`'s own shape rather than an abstraction over it, and narrowed
 * rather than aliased for one reason: the options object is what CARRIES the
 * bound, so a seam that hides it can only claim the bound in a comment. Handed
 * a recording runner, a test reads the `timeout` that was actually passed.
 */
export interface HostQueryOptions {
  /** Both readings are text, and every parser here is written against text. */
  readonly encoding: "utf8";
  /** How long the platform gives the command before it kills it. */
  readonly timeout: number;
}

/** The fields of a finished host query this module reads, and no others. */
export interface HostQueryResult {
  /** Set when the command could not be run at all, or when it spent its bound. */
  readonly error?: Error | undefined;
  /** Its exit code, or `null` when a signal ended it — a spent bound is both. */
  readonly status: number | null;
  /** Everything it wrote to standard output. */
  readonly stdout: string;
}

/** How a bounded host query is actually run, as one injectable act. */
export type HostQueryRunner = (
  command: string,
  args: readonly string[],
  options: HostQueryOptions,
) => HostQueryResult;

/** The real runner, which every production reading takes. */
const runHostCommand: HostQueryRunner = (command, args, options) =>
  spawnSync(command, [...args], options);

/**
 * Run one host command under the smaller of its own bound and what is left of
 * the caller's, or nothing at all when nothing is left.
 *
 * THE ONE DOOR, and the bound lives on it rather than at the call sites. Every
 * reading in this directory that runs a command runs it through here — both
 * process-table listings, both per-pid stamp reads, the macOS process state code
 * in `liveness.ts`, and the Windows tree kill in `arms.ts` — because a bound
 * spelled out at each site is a bound the next site is written without, and one
 * site already was.
 *
 * `HOST_QUERY_TIMEOUT_MS` IS A CEILING AND NOT THE FIGURE. It is derived against
 * the whole cleanup budget, so it is right for a query taken at the START of a
 * disposal and far too generous for one taken after that disposal has already
 * spent itself: three attempts each running a five-second query is half a minute
 * of a budget that was over before the first one. A caller holding a deadline
 * passes what remains of it and gets the smaller of the two.
 *
 * A REMAINING BUDGET AT OR BELOW ZERO SPAWNS NOTHING. There is no such thing as
 * a query that takes no time, so the honest answer to "you have no time left" is
 * the unreadable one, arrived at without starting a process this thread would
 * then block on.
 *
 * `undefined` is that single unreadable answer everywhere and it deliberately
 * does not say which of the five things happened: the bound was already spent,
 * the command would not start, it spent the bound it was given, it exited
 * non-zero, or it printed nothing. None of those is evidence about a process,
 * and every caller here treats them alike.
 */
export function runBoundedHostCommand(
  command: string,
  args: readonly string[],
  remainingBudgetMilliseconds?: number,
  runCommand: HostQueryRunner = runHostCommand,
): HostQueryResult | undefined {
  const timeout =
    remainingBudgetMilliseconds === undefined
      ? HOST_QUERY_TIMEOUT_MS
      : Math.min(HOST_QUERY_TIMEOUT_MS, remainingBudgetMilliseconds);
  if (timeout <= 0) {
    return undefined;
  }
  return runCommand(command, args, { encoding: "utf8", timeout });
}

/**
 * Ask this host one question through `runBoundedHostCommand`, as text.
 *
 * The reading half of the door: a command that did not run, would not start,
 * exited non-zero, or printed nothing is `undefined`, and everything else is its
 * output with the surrounding whitespace taken off. The stamp and state readers
 * all want exactly this, and the tree kill wants the status instead, which is
 * why the two halves are separate functions over one bound rather than one
 * function with a flag.
 */
export function runBoundedHostQuery(
  command: string,
  args: readonly string[],
  remainingBudgetMilliseconds?: number,
  runCommand: HostQueryRunner = runHostCommand,
): string | undefined {
  const reported = runBoundedHostCommand(command, args, remainingBudgetMilliseconds, runCommand);
  if (reported === undefined || reported.error !== undefined || reported.status !== 0) {
    return undefined;
  }
  const output = reported.stdout.trim();
  return output === "" ? undefined : output;
}

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
export function readProcessTable(
  remainingBudgetMilliseconds?: number,
): Map<number, ProcessTableRow> {
  const listing =
    process.platform === "win32"
      ? runBoundedHostQuery(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }',
          ],
          remainingBudgetMilliseconds,
        )
      : runBoundedHostQuery("ps", ["-Ao", "pid=,ppid=,lstart="], remainingBudgetMilliseconds);
  return listing === undefined ? new Map<number, ProcessTableRow>() : parseProcessTable(listing);
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
export function readProcessStartStamp(
  processId: number,
  remainingBudgetMilliseconds?: number,
): string | undefined {
  if (processId <= 0) {
    return undefined;
  }
  return process.platform === "win32"
    ? runBoundedHostQuery(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(processId)}").CreationDate.Ticks`,
        ],
        remainingBudgetMilliseconds,
      )
    : runBoundedHostQuery(
        "ps",
        ["-o", "lstart=", "-p", String(processId)],
        remainingBudgetMilliseconds,
      );
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
