// What this host will tell you about a process, and nothing about what to do with it. It owns the
// two commands, their parsers and the walk, underneath `liveness.ts`, `identity.ts`,
// `platform-termination.ts` and `termination.ts`.
//
// The whole table is read once and carries each row's start stamp as a third column, so verifying a
// tree costs one spawn rather than one PowerShell start per process inside a disposal already
// racing a teardown. A stamp is compared only against a stamp from the same reader, because the two
// commands format differently (`ps -o lstart=` pads a single-digit day): the root is captured and
// re-read through the per-pid reader, a descendant through the table.
//
// Every read is bounded, because each is a `spawnSync` that blocks this thread and `ps` on a hung
// filesystem or PowerShell with an unresponsive CIM service does not exit; vitest's timeout is a
// timer on the same thread, and a worker killed while blocked runs no teardown.
// `runBoundedHostQuery` is the one way to ask this host anything, and a query that spends its bound
// comes back as an `error`, read as an unreadable host rather than as evidence.
//
// The parser skips a row rather than inventing one: a line whose first two fields are not integers
// is a header or warning, and a banner in a kill list is a pid this package never spawned.

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * One process, as the two facts a termination decision reads about it.
 *
 * `startStamp` is `undefined` when the listing carried no third column; the identity check
 * treats that as no evidence and never convicts a pid on it.
 */
export interface ProcessTableRow {
  /** The pid this row records as its parent, whether or not that pid still exists. */
  readonly parentProcessId: number;
  /** This instance's per-instance start stamp, or `undefined` if none was read. */
  readonly startStamp: string | undefined;
}

/**
 * This host's process table, or `undefined` when it would not answer.
 *
 * The sentinel is not an empty map: an empty table is the evidence that clears a rootless
 * verdict, and an unreadable one must refuse it, so consumers must not treat a failure as
 * evidence. The optional budget is what is left of the caller's deadline (most callers hold
 * none); the reading is bounded by the smaller of it and `HOST_QUERY_TIMEOUT_MS`.
 */
export type ProcessTableReader = (
  remainingBudgetMilliseconds?: number,
) => ReadonlyMap<number, ProcessTableRow> | undefined;

/** How one root's per-instance start stamp is read, as one injectable reading. */
export type ProcessStartStampReader = (
  processId: number,
  remainingBudgetMilliseconds?: number,
) => string | undefined;

/**
 * How long either host query gets before it is abandoned as unreadable.
 *
 * Applied as `spawnSync`'s `timeout`, so an overrun is killed and reported through the `error`
 * field both readers treat as "this host would not answer". PowerShell's cold start on a loaded
 * Windows runner takes seconds, so a bound near a second would abandon readable hosts; and a
 * single query must not spend the whole `CLEANUP_BUDGET_MS`, so this is at most half of it.
 * `process-tree-readers.test.ts` holds that relation.
 */
export const HOST_QUERY_TIMEOUT_MS = 5_000;

/**
 * What running one host query needs from the platform, narrowed to three fields.
 *
 * The options object carries the bound, so a recording runner lets a test read the `timeout`
 * that was actually passed.
 */
export interface HostQueryOptions {
  /** Both readings are text, and every parser here is written against text. */
  readonly encoding: "utf8";
  /** How long the platform gives the command before it kills it. */
  readonly timeout: number;
}

/** The fields of a finished host query this module reads. */
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
 * Run one host command under the smaller of its own bound and what is left of the caller's, or
 * nothing at all when nothing is left.
 *
 * Every command in this directory goes through here, including the Windows tree kill in
 * `platform-termination.ts`, so the bound cannot be forgotten at a call site.
 * `HOST_QUERY_TIMEOUT_MS` is a ceiling suited to a query at the start of a disposal; a caller
 * holding a deadline passes what remains so later queries are not each granted five seconds.
 * A remaining budget at or below zero spawns nothing and returns `undefined`.
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
 * A command that did not run, would not start, exited non-zero, or printed nothing is
 * `undefined`; anything else is its output with the surrounding whitespace trimmed. The tree
 * kill wants the status instead, which is why the two halves are separate functions over one
 * bound.
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
 * One parser serves both platforms because both readers are asked to emit that shape. The stamp
 * is the remainder of the line, kept verbatim: `ps -o lstart=` emits `Sun Sep  7 02:25:10 2026`,
 * five tokens for one value, and re-joining them would collapse the double space a single-digit
 * day is padded with, making a normalized stamp compare unequal to an unnormalized one. A line
 * whose first two fields are not integers is a header or warning and contributes nothing.
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
 * This host's process table, or `undefined` when it could not be read.
 *
 * Platform-dispatched although only the Windows arm consumes it, so the POSIX branch lets the
 * suite check that the command emits the shape the parser expects.
 *
 * An unreadable host answers with the sentinel and never an empty table. A listing that ran and
 * named no row under a dead pid is the positive evidence a rootless verdict clears on (Windows
 * does not reparent, so a live descendant would still record that pid), while a query that
 * would not start, spent its bound, or exited non-zero is evidence of nothing.
 */
export function readProcessTable(
  remainingBudgetMilliseconds?: number,
): Map<number, ProcessTableRow> | undefined {
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
  return listing === undefined ? undefined : parseProcessTable(listing);
}

/**
 * The per-instance start stamp for one `processId`, or `undefined`.
 *
 * A number is reissued and a start stamp is not, so comparing the stamp read now with the one
 * read at spawn is what makes "this is still the tree I spawned" answerable. It is asked per pid
 * and only for the root, captured at spawn when there are no descendants to list; descendants
 * come from the table. Windows is asked for `CreationDate.Ticks`, an integer rather than a
 * locale-formatted date; POSIX for `ps -o lstart=`, whose one-second resolution is enough for
 * a comparison. `undefined` means the stamp could not be read, which is not evidence of
 * anything; `SpawnedTreeIdentity` settles what to do about it.
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
 * Every process below `rootProcessId` in `processTable`, transitively, excluding the root.
 *
 * A breadth walk with a visited set: a table is a snapshot of a host whose pids are reused, so
 * two rows naming each other as parents are representable and a walk without the set would
 * never return. Windows does not reparent, so the absence of a row is sound evidence that
 * nothing claims the root, while the presence of one is no evidence that the claimant is this
 * tree's: a child of the pid's former holder records it the same way.
 * `platform-termination.ts` is where that asymmetry is spent.
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
