// What this host says about its processes, and whether it is read as it is said.
//
// Split from `process-tree.test.ts` beside it when the module was, and for the
// same reason the module was: that file asks what a pid is DOING and answers
// with probes over one moment, and this one asks what the host's own listing
// says — a different subject with a different instrument, where the thing that
// can be wrong is a PARSE rather than a decision.
//
// TWO HALVES, AND ONLY ONE OF THEM IS PARSING. That the text is read correctly
// is checkable against text written here. That the command emits the shape it is
// parsed as is not: it is a claim about `ps` and about PowerShell, and the only
// way to check it is to run the real thing and look for a row whose answer is
// already known. This process is that row — its own pid, its own parent, and a
// start stamp that must not move between two reads.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { CLEANUP_BUDGET_MS } from "../launch-budgets.js";
import {
  descendantsOf,
  HOST_QUERY_TIMEOUT_MS,
  parseProcessTable,
  readProcessStartStamp,
  readProcessTable,
  runBoundedHostCommand,
  runBoundedHostQuery,
  type HostQueryOptions,
} from "../../helpers/process-tree/readers.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

describe("the process table — parsed as the platform emits it", () => {
  it("takes two integers and keeps the rest of the line as the stamp, verbatim", () => {
    // THE REMAINDER IS ONE VALUE AND NOT A THIRD FIELD. `ps -o lstart=` emits
    // `Sun Sep  7 02:25:10 2026` — five whitespace-separated tokens, with the
    // day padded — and a parser that took a third field would keep `Sun`, while
    // one that re-joined split tokens would collapse that double space. Either
    // is a stamp that compares unequal to the same process read again, which
    // reports every descendant as reissued and refuses every rootless kill.
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
      // A listing with no stamp column is not a listing of reissued pids: the
      // absent stamp is what `verifyCapturedMembers` reads as "no comparison was
      // possible", so it has to arrive as `undefined` rather than as `""`.
      [4244, { parentProcessId: 4243, startStamp: undefined }],
    ]);
  });

  it("negative control: a header and a warning contribute no row", () => {
    // Without this the case above is ambiguous between "it skips text that is
    // not a row" and "it kept everything and the rows happened to be first",
    // and the second puts a `ps` banner in a kill list. Both foils lead with a
    // word rather than an integer, which is the whole discriminator — and the
    // one that admits the free-text remainder safely.
    expect([...parseProcessTable("  PID  PPID\nwarning: something happened")]).toStrictEqual([]);
  });

  it("reads this very process out of the table, through the real platform arm", () => {
    // The half the parser cannot claim: that the command emits the shape it is
    // parsed as. This process is the one row whose answer is already known.
    expect(readProcessTable()?.get(process.pid)?.parentProcessId).toBe(process.ppid);
  });

  it("reads a stamp for this very process out of the table, and the same one twice", () => {
    // The column the whole descendant check rests on, asked of the only pid
    // whose stamp is guaranteed to be legible. Stability is the property rather
    // than the format: a stamp that moved between two reads would convict every
    // captured member of being somebody else and disarm the rootless arm.
    const stamp = readProcessTable()?.get(process.pid)?.startStamp;
    expect(stamp).toBeTypeOf("string");
    expect(stamp).not.toBe("");
    expect(readProcessTable()?.get(process.pid)?.startStamp).toBe(stamp);
  });

  it("answers the unreadable sentinel rather than an empty table when it cannot look", () => {
    // THE DISCRIMINATOR THE VERDICT PATH SPENDS. A listing that ran and named
    // nothing beneath a dead pid is positive evidence nothing survives it; a
    // query that never ran is evidence of nothing at all, and returning an
    // empty map for the second let `terminateExternalTree` report a live
    // browser under a reaped launcher as a terminated tree. An exhausted
    // budget is the one way to reach that state without breaking the host:
    // the shared door spawns nothing at or below zero.
    expect(readProcessTable(0)).toBeUndefined();
    // The foil, and what makes the sentinel a reading rather than the only
    // answer: a real listing on this host is a table, and it is not empty.
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
    // Not hypothetical on a table read as a snapshot: pids are reused, and a
    // reused pid can appear as its own descendant's parent between two rows.
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
    // Without this the closure cases above are ambiguous between "it walks the
    // table" and "it returns everything in it", and the second would hand a
    // rootless kill every pid on the host.
    expect(descendantsOf(4242, processTableOf([[9999, 1]]))).toStrictEqual([]);
  });
});

describe("the per-pid start stamp — the reading a root is captured by", () => {
  it("reads a stable stamp for this very process, through the real platform arm", () => {
    // The half no scripted reader can claim: that this platform HAS such a
    // reading and that two reads of it agree. A stamp that moved between reads
    // would report every root as recycled and refuse every kill on the host, so
    // stability is the property rather than a detail of the format.
    const stamp = readProcessStartStamp(process.pid);
    expect(stamp).toBeTypeOf("string");
    expect(stamp).not.toBe("");
    expect(readProcessStartStamp(process.pid)).toBe(stamp);
  });

  it("reads no stamp for a pid that names nothing, and none for the group-addressing 0", () => {
    // `spawnSync` returns only once its child is gone, so its pid names a process
    // that certainly ran and certainly is not running. `0` is the same foil the
    // group probe refuses: on POSIX it addresses the CALLER, and a stamp read for
    // it would identify this runner as the spawned tree's root.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(readProcessStartStamp(reaped.pid)).toBeUndefined();
    expect(readProcessStartStamp(0)).toBeUndefined();
  });
});

describe("the host query bound — a relation rather than a number", () => {
  it("leaves the disposal it sits inside more time than it can spend", () => {
    // The derivation the constant states, held here so it is a claim that can
    // fail. A query bounded at or above the cleanup budget can spend the whole
    // of it and leave nothing for the kill the query was taken for — and both
    // readers run inside that disposal, so the bound is on the ONE query and
    // the budget is on everything the disposal does.
    expect(HOST_QUERY_TIMEOUT_MS * 2).toBeLessThanOrEqual(CLEANUP_BUDGET_MS);
    // Not the other direction either: a bound under a second would abandon a
    // readable host, since PowerShell's cold start on a loaded Windows runner
    // is measured in seconds. The two together are what fix the figure.
    expect(HOST_QUERY_TIMEOUT_MS).toBeGreaterThan(1_000);
  });
});

describe("the one bounded door — every host command this package runs goes through it", () => {
  // WHY THE BOUND IS ON THE DOOR AND NOT AT THE CALL SITES. Every reading here
  // is a `spawnSync`, which blocks this thread until its child exits, and each
  // one is taken from inside a disposal that is already racing a teardown: a
  // `ps` under a hung filesystem, or PowerShell whose CIM service is not
  // answering, blocks the very thread vitest's timeout runs on, and a worker
  // killed while blocked runs no teardown at all. Four sites carried their own
  // options object and a fifth — the macOS state code — was written without the
  // timeout at all, which is what a bound restated per site eventually costs.

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
    // THE FINDING BEHIND THE PARAMETER. `HOST_QUERY_TIMEOUT_MS` is derived
    // against the WHOLE cleanup budget, so it is right for a query taken at the
    // start of a disposal and far too generous for one taken after that disposal
    // has spent itself — three escalations each spending five seconds is half a
    // minute outside a budget that was already over.
    const tight = recordingRunner("S");
    runBoundedHostQuery("ps", [], 1_000, tight.run);
    expect(tight.calls[0]?.options.timeout).toBe(1_000);

    // And never LARGER than its own bound, whatever the caller has left.
    const generous = recordingRunner("S");
    runBoundedHostQuery("ps", [], HOST_QUERY_TIMEOUT_MS * 4, generous.run);
    expect(generous.calls[0]?.options.timeout).toBe(HOST_QUERY_TIMEOUT_MS);
  });

  it("runs nothing at all once the caller's budget is spent", () => {
    // There is no query that takes no time, so the honest answer to "you have no
    // time left" is the unreadable one — arrived at without starting a process
    // this thread would then block on, which is the whole point of asking.
    const spent = recordingRunner("S");
    expect(runBoundedHostQuery("ps", [], 0, spent.run)).toBeUndefined();
    expect(runBoundedHostCommand("taskkill", ["/pid", "4242"], -1, spent.run)).toBeUndefined();
    expect(
      spent.calls,
      "a query ran on an exhausted budget — the deadline it was charged to is already over",
    ).toStrictEqual([]);
  });

  it("negative control: every other way a query can fail reads unreadable too", () => {
    // Without this the cases above are ambiguous between "it reports what the
    // command said" and "it reports whatever came back", and the second puts a
    // timed-out query's empty output into a parser as though it were a listing.
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
