// The one place a spawned Electron tree is killed, and the one place that is
// checked.
//
// Two harnesses spawn Electron — the Tier-1 smoke probe and the console launcher
// — and each had grown its own terminator over the same three platform facts.
// They had already disagreed: one read `taskkill`'s exit status and the other did
// not, so the second reported kills it had not performed. The implementation is
// now shared, and so are these cases; both consumers are bound to it rather than
// to a copy.
//
// What CANNOT be exercised here is the real thing. `terminateProcessTree` signals
// a real process, and on the POSIX arm the negative-pid form reaches the whole
// group — which, run from a test, is this runner's own. So the platform arms stay
// unexecuted by construction and the decision they all funnel through is tested
// directly, with the liveness probe injected. That split is the reason the
// decision is a named function rather than a boolean expression at three call
// sites.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { processExists, terminationSucceeded } from "./helpers/process-tree.js";

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
