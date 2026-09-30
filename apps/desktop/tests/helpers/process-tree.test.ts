// Checks the shared Electron tree terminator without signaling anything real.
//
// `terminateProcessTree` signals a real process, and on the POSIX arm the negative-pid form
// reaches a whole process group, which is the launched tree only because playwright-core spawns
// detached. These cases run inside the runner, so the platform arms stay unexecuted and the
// decision they all funnel through is tested directly, with the liveness probe injected.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { terminationSucceeded } from "./process-tree/platform-termination.js";
import { PROCESS_TREE_TERMINATION_MODE } from "./process-tree/termination.js";
import {
  isTerminatedProcessState,
  processExists,
  processGroupExists,
  processHasTerminated,
  processStateFromProcStat,
  readProcessLiveness,
  readProcessStateCode,
  type ProcessLivenessProbes,
} from "./process-tree/liveness.js";

/**
 * A liveness probe pair whose existence answers are scripted in order.
 *
 * The race under test is a sequence (existence, state lookup, existence again), so the answers
 * are a queue and the number taken is readable. A read past the script throws, so a reading that
 * asks more often than the case described cannot pass quietly. The window between the two
 * questions belongs to the kernel and cannot be arranged against a live pid.
 */
class ScriptedLivenessProbes implements ProcessLivenessProbes {
  readonly #existenceAnswers: readonly boolean[];
  readonly #reportedStateCode: string | undefined;
  #existenceReads = 0;

  constructor(existenceAnswers: readonly boolean[], reportedStateCode?: string) {
    this.#existenceAnswers = [...existenceAnswers];
    this.#reportedStateCode = reportedStateCode;
  }

  /** How many times the reading asked whether the pid names anything. */
  get existenceReads(): number {
    return this.#existenceReads;
  }

  readonly exists = (): boolean => {
    const answer = this.#existenceAnswers[this.#existenceReads];
    this.#existenceReads += 1;
    if (answer === undefined) {
      throw new Error(
        `the reading asked about existence ${String(this.#existenceReads)} times, past the ${String(this.#existenceAnswers.length)} this case scripted`,
      );
    }
    return answer;
  };

  readonly stateCode = (): string | undefined => this.#reportedStateCode;
}

describe("process termination — a kill that was refused is not a kill", () => {
  /** A probe that records whether it was consulted, so "not consulted" is checkable. */
  function existenceProbe(stillRunning: boolean): (() => boolean) & { readonly asked: boolean[] } {
    const asked: boolean[] = [];
    const probe = (): boolean => {
      asked.push(stillRunning);
      return stillRunning;
    };
    return Object.assign(probe, { asked });
  }

  it("counts a delivered signal as success without asking anything further", () => {
    const probe = existenceProbe(true);
    expect(terminationSucceeded(true, probe)).toBe(true);
    // A delivered signal is already the answer; asking anyway would make a SIGKILLed process that
    // is not yet reaped look like a failure.
    expect(probe.asked).toStrictEqual([]);
  });

  it("counts an undelivered signal as success when nothing is left to kill", () => {
    // The process exited between the close timing out and the kill; POSIX reports ESRCH and
    // Windows a non-zero taskkill, and neither is a failure.
    expect(terminationSucceeded(false, existenceProbe(false))).toBe(true);
  });

  it("counts an undelivered signal as failure while the process is still there", () => {
    // A taskkill that spawns and exits non-zero (termination denied) leaves `error` undefined;
    // reporting that as a kill left Electron holding its profile lock.
    const probe = existenceProbe(true);
    expect(terminationSucceeded(false, probe)).toBe(false);
    // Non-vacuous: the verdict came from consulting the OS, not from the flag.
    expect(probe.asked).toStrictEqual([true]);
  });
});

describe("process termination — asking whether a pid is still there", () => {
  it("finds this very process, which is the one pid guaranteed to be alive", () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it("does not find a process that has already exited", () => {
    // A reaped pid, not a large number and not 0: `process.kill(0, 0)` succeeds because pid 0
    // addresses the caller's own group on POSIX. `spawnSync` returns only after its child is gone.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.status).toBe(0);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(processExists(reaped.pid)).toBe(false);
  });
});

describe("process termination — the group handle that outlives a root", () => {
  // On POSIX the handle that survives the root's exit is the process group; reading the root
  // instead reported a rootless tree as terminated. Windows answers from its process table,
  // which `process-tree-readers.test.ts` covers.

  it("finds the group this process is in, which is the one group guaranteed to hold a member", () => {
    // Asked of this runner's own group, which certainly holds this process. The id is read from
    // the platform because a worker is usually not its own group's leader, so neither
    // `process.pid` nor `process.ppid` is right.
    if (PROCESS_TREE_TERMINATION_MODE !== "signal") {
      // Windows has no process group to ask about.
      return;
    }
    const reported = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    expect(reported.status).toBe(0);
    const processGroupId = Number(reported.stdout.trim());
    expect(processGroupId).toBeGreaterThan(0);
    expect(processGroupExists(processGroupId)).toBe(true);
  });

  it("refuses the pid that would report this runner as the live tree", () => {
    // `kill(-0, 0)` is `kill(0, 0)`, which addresses the caller's own group, so an unrecorded pid
    // would report the test runner itself as the live tree.
    expect(processGroupExists(0)).toBe(false);
  });
});

describe("process termination — a zombie is terminated, and existence cannot say so", () => {
  // A zombie cannot be manufactured: it exists only until its parent reaps it, and for a
  // grandchild that parent is an init this process does not own. The two decisions the platform
  // I/O funnels through are driven directly, with real text on both sides.

  it("reads the state out of a `/proc` line whose executable name has spaces and parens", () => {
    // Field 2 is the unescaped executable name in parentheses, so a whitespace split fails on
    // both samples; Firefox's content process is literally `(Web Content)`.
    expect(processStateFromProcStat("4242 (Web Content) Z 1 4242 0 0 -1 4194560")).toBe("Z");
    expect(processStateFromProcStat("4242 (a) b) S 1 4242 0")).toBe("S");
  });

  it("reports nothing readable rather than guessing at text of another shape", () => {
    // `undefined` makes the caller fail towards "running"; claiming a process is gone without
    // evidence is the false success this module exists to prevent.
    expect(processStateFromProcStat("")).toBeUndefined();
    expect(processStateFromProcStat("4242 no-parenthesis-here Z 1")).toBeUndefined();
  });

  it("counts the exited states as terminated, decoration and all", () => {
    // `ps` decorates the code (`Z+` is a foreground zombie), so only the first letter is read.
    expect(isTerminatedProcessState("Z")).toBe(true);
    expect(isTerminatedProcessState("Z+")).toBe(true);
    expect(isTerminatedProcessState("X")).toBe(true);
  });

  it("counts every state a process can still run in as running", () => {
    // Negative control: calling an idle or stopped process terminated would report every leaked
    // Electron, which idles at 0% CPU, as a clean tree.
    for (const stateCode of ["R", "S", "D", "T", "I", "Ss", "S+", "R<", "U"]) {
      expect(isTerminatedProcessState(stateCode), `${stateCode} is not a terminated state`).toBe(
        false,
      );
    }
  });

  it("reads this very process as running, through the real platform arm", () => {
    // The reader's own pid is alive and legible, so the arm this platform takes is not vacuous.
    expect(readProcessLiveness(process.pid)).toBe("running");
    expect(processHasTerminated(process.pid)).toBe(false);
  });

  it("reads a reaped pid as gone without asking the platform for a state", () => {
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(readProcessLiveness(reaped.pid)).toBe("gone");
    expect(processHasTerminated(reaped.pid)).toBe(true);
  });
});

describe("process termination — a state that vanished is not a process still running", () => {
  // The defect is a process exiting between the existence probe and the state lookup; against a
  // real pid that window is a race the suite would almost always lose, so the answers are scripted.

  it("reads a pid whose state vanished along with it as gone, not running", () => {
    // The pid was there at the existence check and reaped by the state lookup, which looks like a
    // platform with no state to keep. Reading that as `running` turned an ordinary ESRCH into a
    // refused kill and left a caller retrying a number the OS had reissued.
    const probes = new ScriptedLivenessProbes([true, false]);
    expect(readProcessLiveness(4242, probes)).toBe("gone");
    // Non-vacuity: the verdict came from a second existence read, not the first answer.
    expect(
      probes.existenceReads,
      "the reading settled on one existence answer — the vanished state is not being rechecked",
    ).toBe(2);
  });

  it("still reads a pid with no state to read as running while it is demonstrably there", () => {
    // Foil: Windows keeps no unreaped entry, so every reading there reaches this branch with a
    // live process behind it, and "no state" must not mean "gone".
    const probes = new ScriptedLivenessProbes([true, true]);
    expect(readProcessLiveness(4242, probes)).toBe("running");
    expect(probes.existenceReads).toBe(2);
  });

  it("asks nothing further once the platform did report a state", () => {
    // The recheck applies only when there is no state; the script throws on a second read. A
    // second read after a state would collapse `zombie` into `gone` for a pid init reaped in
    // between.
    const zombie = new ScriptedLivenessProbes([true], "Z+");
    expect(readProcessLiveness(4242, zombie)).toBe("zombie");
    expect(zombie.existenceReads).toBe(1);

    const sleeping = new ScriptedLivenessProbes([true], "S");
    expect(readProcessLiveness(4242, sleeping)).toBe("running");
    expect(sleeping.existenceReads).toBe(1);
  });
});

describe("process termination — the macOS state read is a command, and a command must be bounded", () => {
  // The macOS arm once ran its own unbounded `spawnSync("ps")`; a stalled `ps` blocks the thread
  // vitest's timeout runs on and the detached Electron outlives the run. A runner takes only one
  // of the three arms, so the others are injected.

  /** A bounded-query stand-in that records what it was asked, and what it was charged. */
  function recordingQuery(answer: string | undefined): {
    readonly ask: (
      command: string,
      args: readonly string[],
      remainingBudgetMilliseconds?: number,
    ) => string | undefined;
    readonly asked: {
      command: string;
      args: readonly string[];
      remainingBudgetMilliseconds: number | undefined;
    }[];
  } {
    const asked: {
      command: string;
      args: readonly string[];
      remainingBudgetMilliseconds: number | undefined;
    }[] = [];
    return {
      asked,
      ask: (command, args, remainingBudgetMilliseconds) => {
        asked.push({ command, args, remainingBudgetMilliseconds });
        return answer;
      },
    };
  }

  it("asks `ps` through the one bounded host query, and charges the caller's remainder to it", () => {
    const query = recordingQuery("Z+");
    expect(readProcessStateCode(4242, 1_000, "darwin", query.ask)).toBe("Z+");
    expect(
      query.asked,
      "the macOS state lookup is running its own query rather than the bounded one",
    ).toStrictEqual([
      {
        command: "ps",
        args: ["-o", "stat=", "-p", "4242"],
        remainingBudgetMilliseconds: 1_000,
      },
    ]);
  });

  it("negative control: the two arms that read no command run no query at all", () => {
    // Without this the case above cannot tell "the macOS arm asks" from "every arm asks", which
    // would run `ps` on Windows inside the disposal the bound protects.
    const query = recordingQuery("Z+");
    expect(readProcessStateCode(4242, undefined, "win32", query.ask)).toBeUndefined();
    // Linux reads a file rather than running a command.
    readProcessStateCode(4242, undefined, "linux", query.ask);
    expect(query.asked).toStrictEqual([]);
  });

  it("reads a live process as not terminated on a budget that is already spent", () => {
    // With the budget spent the state probe runs nothing and the existence recheck answers
    // `running`; the opposite would report a tree clean because there was no time to look.
    expect(processHasTerminated(process.pid, 0)).toBe(false);
    // A reaped pid still reads as terminated, which needs no command either.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(processHasTerminated(reaped.pid, 0)).toBe(true);
  });
});
