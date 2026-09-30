// What this host says about its processes, and whether it is read as it is said.
//
// Split from `process-tree.test.ts`, which asks what a pid is doing with probes over one moment;
// this asks what the host's own listing says, where the thing that can be wrong is a parse.
//
// Only half is parsing. That the text is read correctly is checkable against text written here.
// That the command emits the shape it is parsed as is a claim about `ps` and PowerShell,
// checkable only by running the real thing against a row whose answer is known: this process,
// with its own pid, its own parent and a start stamp that must not move between two reads.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { CLEANUP_BUDGET_MS } from "./launch-budgets.js";
import {
  descendantsOf,
  HOST_QUERY_TIMEOUT_MS,
  parseProcessTable,
  readProcessStartStamp,
  readProcessTable,
  runBoundedHostCommand,
  runBoundedHostQuery,
  type HostQueryOptions,
} from "./process-tree/readers.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

describe("the process table — parsed as the platform emits it", () => {
  it("takes two integers and keeps the rest of the line as the stamp, verbatim", () => {
    // The remainder is one value, not a third field. `ps -o lstart=` emits
    // `Sun Sep  7 02:25:10 2026`, five tokens with the day padded; a parser taking a third field
    // would keep `Sun`, and one re-joining split tokens would collapse the double space. Either
    // yields a stamp unequal to the same process read again, reporting every descendant as
    // reissued and refusing every rootless kill.
    const parsed = parseProcessTable(
      [
        "  PID  PPID STARTED",
        " 4242   4241 Sun Sep  7 02:25:10 2026",
        "4243 4242 638600000000000000",
        "4244 4243",
        "",
        "warning: something happened",
      ].join("\n"),
    );

    expect([...parsed]).toStrictEqual([
      [4242, { parentProcessId: 4241, startStamp: "Sun Sep  7 02:25:10 2026" }],
      [4243, { parentProcessId: 4242, startStamp: "638600000000000000" }],
      // A listing with no stamp column is not one of reissued pids: the absent stamp is what
      // `verifyCapturedMembers` reads as "no comparison possible", so it arrives as `undefined`.
      [4244, { parentProcessId: 4243, startStamp: undefined }],
    ]);
  });

  it("negative control: a header and a warning contribute no row", () => {
    // Guards the case above against "kept everything and the rows happened to be first", which
    // puts a `ps` banner in a kill list. Both foils lead with a word rather than an integer, the
    // discriminator that safely admits the free-text remainder.
    expect([...parseProcessTable("  PID  PPID\nwarning: something happened")]).toStrictEqual([]);
  });

  it("reads this very process out of the table, through the real platform arm", () => {
    // That the command emits the shape it is parsed as; this process is the one row whose answer
    // is known.
    expect(readProcessTable()?.get(process.pid)?.parentProcessId).toBe(process.ppid);
  });

  it("reads a stamp for this very process out of the table, and the same one twice", () => {
    // The column the descendant check rests on, asked of the only pid whose stamp is guaranteed
    // legible. Stability is the property: a stamp that moved between reads would convict every
    // captured member and disarm the rootless arm.
    const stamp = readProcessTable()?.get(process.pid)?.startStamp;
    expect(stamp).toBeTypeOf("string");
    expect(stamp).not.toBe("");
    expect(readProcessTable()?.get(process.pid)?.startStamp).toBe(stamp);
  });

  it("answers the unreadable sentinel rather than an empty table when it cannot look", () => {
    // The verdict path spends this discriminator. A listing that ran and named nothing beneath a
    // dead pid is evidence nothing survives it; a query that never ran is evidence of nothing, and
    // an empty map for it let `terminateExternalTree` report a live browser under a reaped
    // launcher as terminated. An exhausted budget reaches that state without breaking the host:
    // `runBoundedHostCommand` spawns nothing at or below zero.
    expect(readProcessTable(0)).toBeUndefined();
    // The foil: a real listing on this host is a table, and not empty.
    const readable = readProcessTable();
    expect(readable).toBeDefined();
    expect(readable?.size).toBeGreaterThan(0);
  });
});

describe("the process table — the descendant walk over it", () => {
  it("walks the descendant closure transitively, so a browser's own children are in the tree", () => {
    expect(
      descendantsOf(
        4242,
        processTableOf([
          [4243, 4242],
          [4244, 4243],
          [4245, 4244],
          [9999, 1],
        ]),
      ).sort(),
    ).toStrictEqual([4243, 4244, 4245]);
  });

  it("terminates the closure over a parent cycle rather than walking one forever", () => {
    // Pids are reused, so in a snapshot a reused pid can appear as its own descendant's parent
    // between two rows.
    expect(
      descendantsOf(
        4242,
        processTableOf([
          [4243, 4242],
          [4242, 4243],
        ]),
      ),
    ).toStrictEqual([4243]);
  });

  it("negative control: a root with no children yields nothing to address", () => {
    // Guards the closure cases against "returns everything in the table", which would hand a
    // rootless kill every pid on the host.
    expect(descendantsOf(4242, processTableOf([[9999, 1]]))).toStrictEqual([]);
  });
});

describe("the per-pid start stamp — the reading a root is captured by", () => {
  it("reads a stable stamp for this very process, through the real platform arm", () => {
    // That this platform has such a reading and two reads agree; a stamp that moved between reads
    // would report every root recycled and refuse every kill.
    const stamp = readProcessStartStamp(process.pid);
    expect(stamp).toBeTypeOf("string");
    expect(stamp).not.toBe("");
    expect(readProcessStartStamp(process.pid)).toBe(stamp);
  });

  it("reads no stamp for a pid that names nothing, and none for the group-addressing 0", () => {
    // `spawnSync` returns once its child is gone, so its pid certainly ran and is not running.
    // `0` is the foil the group probe refuses: on POSIX it addresses the caller, and a stamp read
    // for it would identify this runner as the spawned tree's root.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(readProcessStartStamp(reaped.pid)).toBeUndefined();
    expect(readProcessStartStamp(0)).toBeUndefined();
  });
});

describe("the host query bound — a relation rather than a number", () => {
  it("leaves the disposal it sits inside more time than it can spend", () => {
    // The derivation the constant states, as a claim that can fail. A query bounded at or above
    // the cleanup budget can spend all of it and leave nothing for the kill; both readers run
    // inside that disposal, so the bound is on one query and the budget on everything it does.
    expect(HOST_QUERY_TIMEOUT_MS * 2).toBeLessThanOrEqual(CLEANUP_BUDGET_MS);
    // And not below a second: PowerShell's cold start on a loaded Windows runner is measured in
    // seconds, so a lower bound would abandon a readable host.
    expect(HOST_QUERY_TIMEOUT_MS).toBeGreaterThan(1_000);
  });
});

describe("`runBoundedHostCommand` — every host command this package runs goes through it", () => {
  // Every reading is a `spawnSync`, which blocks this thread until its child exits, and each is
  // taken inside a disposal already racing a teardown: a `ps` under a hung filesystem, or
  // PowerShell whose CIM service is not answering, blocks the thread vitest's timeout runs on, and
  // a worker killed while blocked runs no teardown. One function holds the bound so no site
  // restates it or omits it.

  /** A runner that records the command, its arguments, and the options it was given. */
  function recordingRunner(stdout: string): {
    readonly run: (
      command: string,
      args: readonly string[],
      options: HostQueryOptions,
    ) => { readonly status: number; readonly stdout: string };
    readonly calls: { command: string; args: readonly string[]; options: HostQueryOptions }[];
  } {
    const calls: { command: string; args: readonly string[]; options: HostQueryOptions }[] = [];
    return {
      calls,
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout };
      },
    };
  }

  it("gives an unbudgeted query the whole bound, as text with the whitespace off", () => {
    const runner = recordingRunner("  S+  \n");
    expect(runBoundedHostQuery("ps", ["-o", "stat=", "-p", "4242"], undefined, runner.run)).toBe(
      "S+",
    );
    expect(runner.calls).toStrictEqual([
      {
        command: "ps",
        args: ["-o", "stat=", "-p", "4242"],
        options: { encoding: "utf8", timeout: HOST_QUERY_TIMEOUT_MS },
      },
    ]);
  });

  it("gives a budgeted query the smaller of the caller's remainder and its own bound", () => {
    // `HOST_QUERY_TIMEOUT_MS` is derived against the whole cleanup budget, so it fits a query at
    // the start of a disposal and is far too generous after the disposal has spent itself: three
    // escalations at five seconds each is half a minute outside a budget already over.
    const tight = recordingRunner("S");
    runBoundedHostQuery("ps", [], 1_000, tight.run);
    expect(tight.calls[0]?.options.timeout).toBe(1_000);

    // And never larger than its own bound, whatever the caller has left.
    const generous = recordingRunner("S");
    runBoundedHostQuery("ps", [], HOST_QUERY_TIMEOUT_MS * 4, generous.run);
    expect(generous.calls[0]?.options.timeout).toBe(HOST_QUERY_TIMEOUT_MS);
  });

  it("runs nothing at all once the caller's budget is spent", () => {
    // No query takes no time, so "no time left" is answered unreadable without starting a
    // process this thread would block on.
    const spent = recordingRunner("S");
    expect(runBoundedHostQuery("ps", [], 0, spent.run)).toBeUndefined();
    expect(runBoundedHostCommand("taskkill", ["/pid", "4242"], -1, spent.run)).toBeUndefined();
    expect(
      spent.calls,
      "a query ran on an exhausted budget — the deadline it was charged to is already over",
    ).toStrictEqual([]);
  });

  it("negative control: every other way a query can fail reads unreadable too", () => {
    // Guards the cases above against "reports whatever came back", which puts a timed-out
    // query's empty output into a parser as a listing.
    expect(
      runBoundedHostQuery("ps", [], undefined, () => ({
        error: new Error("spawnSync ps ETIMEDOUT"),
        status: null,
        stdout: "",
      })),
    ).toBeUndefined();
    expect(
      runBoundedHostQuery("ps", [], undefined, () => ({ status: 1, stdout: "no such process" })),
    ).toBeUndefined();
    expect(
      runBoundedHostQuery("ps", [], undefined, () => ({ status: 0, stdout: "   \n" })),
    ).toBeUndefined();
  });
});
