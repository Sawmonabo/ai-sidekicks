// Killing a spawned Electron tree, once, for every harness that spawns one.
//
// Two harnesses spawn Electron — the Tier-1 smoke probe in `electron-probe.ts`
// and the console launcher behind `test/console/bounded-cleanup.ts` — and each
// grew its own copy of the same three platform facts. They had already diverged:
// only one of them read `taskkill`'s exit status, so the other reported a kill it
// had not performed. A rule with two homes is a rule that will disagree with
// itself; this is the home.
//
// The three facts, each measured rather than assumed:
//
//   • POSIX group delivery is safe HERE and catastrophic in general.
//     `playwright-core` spawns with `detached: process.platform !== "win32"`
//     (`lib/coreBundle.js`), and the smoke probe passes `detached: true` itself,
//     so on POSIX the launched Electron LEADS its own process group and `-pid`
//     reaches the browser, its zygote, and every renderer at once. An ATTACHED
//     child shares this runner's group, and the identical call would signal
//     vitest itself — which is why the fallback below narrows to the leader and
//     never widens.
//
//   • Windows has no process group to signal, and its "signals" are
//     `TerminateProcess` calls that are never forwarded, so signalling the
//     launcher alone orphans the browser holding the inherited stdout write end.
//     `taskkill /pid N /t` walks the descendant tree: without `/f` it posts
//     WM_CLOSE to each windowed process (the graceful analog — the tree members
//     that matter here all have windows), with `/f` it terminates every node
//     outright (the SIGKILL analog). This is also the form `playwright-core`
//     itself runs for this process.
//
//   • Delivery and survival are two questions, and answering only the first was
//     the divergence. A `taskkill` that SPAWNS and exits non-zero — termination
//     denied, most of all — leaves `spawnSync`'s `error` undefined while Electron
//     keeps running. The exit code is a separate field of that result precisely
//     because it is a separate question, and a non-zero exit is not automatically
//     a failure either: a tree already gone is one of the things taskkill refuses.
//     Which one it was is asked of the OS, never read out of taskkill's message,
//     because that message is localised and this must not depend on the runner's
//     display language.

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Whether a pid names a live process, without signalling it.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing —
 * on Windows too, where Node maps it onto a handle open. `EPERM` means the
 * process is there and out of reach, which for this question is "still running":
 * reporting it gone would be the same false success this probe exists to catch.
 */
export function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a termination attempt left nothing to worry about.
 *
 * Two ways to succeed, and the second is why this is a function rather than a
 * boolean at each call site. A signal that was delivered is a success. A signal
 * that was NOT is still a success if there is nothing left to kill — which is
 * the ordinary outcome when a process exited between a close timing out and the
 * kill being issued.
 *
 * Splitting the probe out as an argument is what makes both arms testable at
 * all: the real one signals a real process, so a test exercising it would kill
 * something, and on the POSIX arm that something is this test runner's own
 * process group.
 */
export function terminationSucceeded(
  signalDelivered: boolean,
  processStillExists: () => boolean,
): boolean {
  return signalDelivered || !processStillExists();
}

/**
 * Signal the process tree led by `processId`, and say whether it landed.
 *
 * `true` means the signal was delivered or there was nothing left to signal;
 * `false` means a live process refused it. A caller escalating from `SIGTERM`
 * asks again after its grace period rather than reading `true` as "gone" — a
 * delivered graceful signal says the tree was asked to exit, not that it has.
 */
export function terminateProcessTree(
  processId: number,
  signal: NodeJS.Signals = "SIGKILL",
): boolean {
  const stillExists = (): boolean => processExists(processId);
  if (process.platform === "win32") {
    const forced = signal === "SIGKILL" ? ["/f"] : [];
    const result = spawnSync("taskkill", ["/pid", String(processId), "/t", ...forced], {
      stdio: "ignore",
    });
    return terminationSucceeded(result.error === undefined && result.status === 0, stillExists);
  }
  for (const target of [-processId, processId]) {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      // Group already reaped, or this pid does not lead one after all.
    }
  }
  // Both throws land here, and ESRCH is the commonest reason: the process was
  // already gone. Reporting that as a failed termination would tell a reader an
  // Electron may still be holding a profile when nothing is — the same
  // misdescription as the Windows arm, in the opposite direction.
  return terminationSucceeded(false, stillExists);
}
