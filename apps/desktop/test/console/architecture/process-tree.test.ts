// The one place a spawned Electron tree is killed, and the one place that is
// checked.
//
// Two harnesses spawn Electron — the Tier-1 smoke probe and the console launcher
// — and each had grown its own terminator over the same platform facts.
// They had already disagreed: one read `taskkill`'s exit status and the other did
// not, so the second reported kills it had not performed. The implementation is
// now shared, and so are these cases; both consumers are bound to it rather than
// to a copy.
//
// What CANNOT be exercised here is the real thing. `terminateProcessTree` signals
// a real process, and on the POSIX arm the negative-pid form reaches a whole
// process GROUP — the launched tree only because playwright-core spawns detached,
// and somebody else's group for any other pid it is handed. These cases run
// inside the runner, so a terminator under test must signal nothing at all. The
// platform arms therefore stay unexecuted by construction and the decision they
// all funnel through is tested directly, with the liveness probe injected. That
// split is the reason the decision is a named function rather than a boolean
// expression at three call sites.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  isTerminatedProcessState,
  processExists,
  processHasTerminated,
  processStateFromProcStat,
  readProcessLiveness,
  terminationSucceeded,
  type ProcessLivenessProbes,
} from "../../helpers/process-tree.js";

/**
 * A liveness probe pair whose existence answers are scripted in order.
 *
 * The race under test is a SEQUENCE and not a state — existence, then a state
 * lookup, then existence again when there was no state — and the only thing
 * that separates the two cases below is what the second answer says. So the
 * answers are a queue rather than a value, and how many were taken is readable,
 * which is what turns "it asked a second time" into an assertion instead of an
 * inference. A read past the script throws rather than repeating the last
 * answer: a reading that asks more often than the case described is a different
 * reading, and it must not pass quietly.
 *
 * Injected into the real function, never a stand-in for it. The window between
 * the two questions belongs to the kernel, so it cannot be arranged against a
 * live pid — which is the same reason the refused tree kill next door is
 * injected rather than provoked.
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
    // The probe costs a syscall and, more importantly, a delivered signal is
    // already the answer. Asking anyway would make a live process — which a
    // SIGKILL has not been reaped from yet — look like a failure.
    expect(probe.asked).toStrictEqual([]);
  });

  it("counts an undelivered signal as success when nothing is left to kill", () => {
    // The ordinary case on both arms: the process exited between the close
    // timing out and the kill being issued. POSIX reports ESRCH, Windows reports
    // a non-zero taskkill, and neither is a failure — there is nothing running.
    expect(terminationSucceeded(false, existenceProbe(false))).toBe(true);
  });

  it("counts an undelivered signal as failure while the process is still there", () => {
    // THE FINDING. On Windows a taskkill that spawns and exits non-zero —
    // termination denied — leaves `error` undefined, and reporting that as a kill
    // told a reader later launches were unaffected while Electron kept its
    // profile lock. Delivery and survival are two questions.
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
    // A REAPED pid, not a large number and emphatically not 0: `process.kill(0, 0)`
    // succeeds, because on POSIX pid 0 addresses the caller's own process group
    // (measured — it reports alive), so it is the one foil that looks dead and
    // is not. `spawnSync` returns only once its child is gone, so its pid names
    // a process that certainly ran and certainly is not running.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.status).toBe(0);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(processExists(reaped.pid)).toBe(false);
  });
});

describe("process termination — a zombie is terminated, and existence cannot say so", () => {
  // WHY THE STATE READ IS A PAIR OF PURE FUNCTIONS. A zombie is not a state a
  // test can manufacture: it exists only between a process exiting and its
  // parent reaping it, and for a grandchild that parent is an init this process
  // does not own — prompt on a hosted runner, indefinite in a container whose
  // init does not reap, which is exactly the run this reading was written for.
  // So the platform I/O stays unexecuted and the two decisions it funnels
  // through are driven directly, with real text on both sides.

  it("reads the state out of a `/proc` line whose executable name has spaces and parens", () => {
    // THE PARSING TRAP, and the reason this is not a whitespace split: field 2
    // is the executable name, unescaped, in parentheses. Both samples are real
    // shapes — Firefox's content process is literally `(Web Content)`.
    expect(processStateFromProcStat("4242 (Web Content) Z 1 4242 0 0 -1 4194560")).toBe("Z");
    expect(processStateFromProcStat("4242 (a) b) S 1 4242 0")).toBe("S");
  });

  it("reports nothing readable rather than guessing at text of another shape", () => {
    // `undefined` is the caller's cue to fail towards "running", which is the
    // whole failure direction of this module: claiming a process is gone
    // without evidence is the false success it exists to prevent.
    expect(processStateFromProcStat("")).toBeUndefined();
    expect(processStateFromProcStat("4242 no-parenthesis-here Z 1")).toBeUndefined();
  });

  it("counts the exited states as terminated, decoration and all", () => {
    // `ps` decorates the code — `Z+` is a zombie in the foreground group — and
    // the modifiers say nothing about whether the process still runs, so only
    // the first letter is read. `X` is Linux's dying state; both are gone.
    expect(isTerminatedProcessState("Z")).toBe(true);
    expect(isTerminatedProcessState("Z+")).toBe(true);
    expect(isTerminatedProcessState("X")).toBe(true);
  });

  it("counts every state a process can still run in as running", () => {
    // The negative control, and the one that matters: a probe that called a
    // sleeping or stopped process terminated would report every leaked Electron
    // — which idles at 0% CPU, which is how the four orphans were found — as a
    // clean tree.
    for (const stateCode of ["R", "S", "D", "T", "I", "Ss", "S+", "R<", "U"]) {
      expect(isTerminatedProcessState(stateCode), `${stateCode} is not a terminated state`).toBe(
        false,
      );
    }
  });

  it("reads this very process as running, through the real platform arm", () => {
    // The one pid guaranteed to be alive and, being the reader itself, the one
    // whose state read is guaranteed to be legible. It is what makes the arm
    // this platform actually takes non-vacuous rather than only parsed.
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
  // WHY THE PROBES ARE INJECTED HERE AND THE PLATFORM ARMS ARE NOT. The defect
  // is a process that exits BETWEEN the existence probe and the state lookup,
  // and the width of that window is the kernel's. Against a real pid the case
  // would be a race the suite loses almost every time; against this seam it is
  // two scripted answers.

  it("reads a pid whose state vanished along with it as gone, not running", () => {
    // THE FINDING. The pid was there when existence was asked and reaped by the
    // time the state was looked up — `/proc/<pid>/stat` unreadable on Linux, `ps`
    // exiting non-zero on macOS — which is byte for byte the `undefined` a
    // platform with no state to keep returns. Reading both as `running` handed
    // `terminateProcessTree` a live process after a signal it could not deliver,
    // turning the commonest outcome there is into a refused kill: an ordinary
    // ESRCH reported as unterminable, and a caller left retrying a number the
    // operating system has already handed out again.
    const probes = new ScriptedLivenessProbes([true, false]);
    expect(readProcessLiveness(4242, probes)).toBe("gone");
    // Non-vacuity, and the line a rewrite that drops the recheck fails on: the
    // verdict came from asking a second time, not from the first answer.
    expect(
      probes.existenceReads,
      "the reading settled on one existence answer — the vanished state is not being rechecked",
    ).toBe(2);
  });

  it("still reads a pid with no state to read as running while it is demonstrably there", () => {
    // The foil, and the one that keeps the fix from becoming "no state means
    // gone". Windows keeps no exited-but-unreaped entry at all, so EVERY reading
    // on that platform reaches this branch with a live process behind it — and
    // claiming a process is gone without evidence is the false success this
    // whole module exists to prevent. The failure direction is unchanged; only
    // the pid that is no longer there moved.
    const probes = new ScriptedLivenessProbes([true, true]);
    expect(readProcessLiveness(4242, probes)).toBe("running");
    expect(probes.existenceReads).toBe(2);
  });

  it("asks nothing further once the platform did report a state", () => {
    // The recheck is scoped to the branch that has NO evidence, and the script
    // enforces that: a single answer, so a reading that asked twice here throws
    // rather than passing. A state that was read is already the evidence, and a
    // second existence read after it would collapse `zombie` into `gone` for any
    // pid an init reaped in between — losing the one distinction this three-state
    // reading exists to make.
    const zombie = new ScriptedLivenessProbes([true], "Z+");
    expect(readProcessLiveness(4242, zombie)).toBe("zombie");
    expect(zombie.existenceReads).toBe(1);

    const sleeping = new ScriptedLivenessProbes([true], "S");
    expect(readProcessLiveness(4242, sleeping)).toBe("running");
    expect(sleeping.existenceReads).toBe(1);
  });
});
