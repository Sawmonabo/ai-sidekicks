// The collaborators the spawn door is GIVEN, each recording what it was asked.
//
// Split from `electron-child-lifetime.test-support.js` beside it on the seam that
// file's own header already drew and then crossed: causing a lifetime is one job
// and observing one is another. That file causes — real child programs, a real
// grandchild, the spawn that starts them. This one is what the spawn is HANDED:
// the settle-time registrar, the tree terminator, and the profile remover, none
// of which starts a process and each of which exists so a case can read back
// what the module under test did with it, or make it refuse on demand.
//
// So the members here are test DOUBLES in the ordinary sense — a recorder, a
// spy that can deny, a registrar that throws — and the members there are the
// real thing. That is the line: nothing in this file spawns, and nothing here
// asserts a lifetime rule either.
//
// It is a `.test-support` module, so its only legitimate dependents are the
// suites beside it and the spawn scaffolding it serves, which is what
// `test-support-has-no-shipping-reader` in `.dependency-cruiser.mjs` enforces.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

import type { SettleTimeDisposer, SettleTimeRegistrar } from "./electron-child.js";
import type { ProcessTreeTerminator } from "./managed-electron-child.js";
import { terminateProcessTree } from "./process-tree/dispatch.js";

/** A profile directory and the one function that takes it off disk, as a harness holds them. */
export interface HeldProfile {
  readonly directory: string;
  /** How many times the remover has been called — one per path that reached it. */
  readonly removalCount: () => number;
  /** The ONE remover, exactly as both spawners spell it: best-effort and forced. */
  readonly removeProfileDirectory: () => void;
}

/**
 * A temporary profile plus the remover a harness reaches from every path.
 *
 * Written once here because the claim two suites make with it is that ONE
 * function serves every path — a second copy would make the count that proves it
 * meaningless. A double and not a child, which is what puts it here rather than
 * beside the programs.
 */
export function heldProfile(): HeldProfile {
  const directory = mkdtempSync(path.join(tmpdir(), "sidekicks-profile-removal-"));
  let removals = 0;
  return {
    directory,
    removalCount: () => removals,
    removeProfileDirectory: () => {
      removals += 1;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort, as both spawners are: a leftover directory is a smaller
        // fact than whichever result the caller actually came for.
      }
    },
  };
}

/**
 * A registrar that records the disposer AND hands it to the runner.
 *
 * `settle()` is the suite's stand-in for the moment a test ends — by passing,
 * by failing, or by being killed at vitest's own timeout. All three run
 * `onTestFinished` callbacks, which is the property the production default
 * relies on and the reason the hook is the mechanism rather than a timer.
 *
 * The second half is not symmetry. With the recorder as the ONLY registrar, a
 * setup that never returned — a malformed announcement, a vitest timeout during
 * it — left a detached, non-terminating child with nothing anywhere that
 * intended to kill it: the leak this mechanism exists to close, reintroduced by
 * the suite that proves it closed. The recorder OBSERVES; `onTestFinished`
 * still owns the kill.
 */
export class RecordingSettleRegistrar {
  readonly #disposers: SettleTimeDisposer[] = [];

  readonly register = (dispose: SettleTimeDisposer): void => {
    this.#disposers.push(dispose);
    onTestFinished(dispose);
  };

  get registeredCount(): number {
    return this.#disposers.length;
  }

  /**
   * Run what was registered, in the order the RUNNER would run it — REVERSE
   * registration order, because that is what `onTestFinished` does. This replayed
   * in registration order, which is exactly the order under which the
   * teardown-ordering defect is INVISIBLE: the spawn door's disposer ran first,
   * so a caller's later registration could not be observed removing a resource
   * ahead of a kill the runner would really have issued after it.
   */
  async settle(): Promise<void> {
    for (const dispose of [...this.#disposers].reverse()) {
      await dispose();
    }
  }
}

/** One call the tree terminator received, as the suite reads it back. */
export interface TerminationRequest {
  readonly processId: number;
  readonly signal: NodeJS.Signals;
}

/**
 * A tree terminator that records every request and can refuse the first N kills.
 *
 * ONE CLASS FOR ONE ROLE. Two cases need this double for two reasons — one
 * needs a platform that REFUSES on demand, the other needs to learn which pid
 * the module asked to kill — and both are the same role: observing and
 * optionally denying the call. A second class would be a second home for it.
 *
 * The refusal is the case no platform can be asked to produce on demand: a
 * `taskkill` that spawns, exits non-zero, and leaves a live tree behind. Once
 * the refusals are used up the call delegates to the REAL terminator rather
 * than answering a bare `true`, so the retry it drives is a retry that actually
 * kills something and the case leaves nothing running.
 */
export class ObservedTreeTerminator {
  readonly #requests: TerminationRequest[] = [];
  #refusalsRemaining: number;

  constructor(refusedKills = 0) {
    this.#refusalsRemaining = refusedKills;
  }

  get requests(): readonly TerminationRequest[] {
    return this.#requests;
  }

  /**
   * The pid of the first tree this terminator was asked about, or `0`.
   *
   * `0` for "nothing was asked" rather than `undefined`, which is the same
   * convention `AbandonedPair` uses and for the same reason: `reap` refuses it,
   * so an unrecorded pid can never be signalled — and on POSIX `0` addresses
   * the CALLER's own process group.
   */
  get firstRequestedPid(): number {
    return this.#requests[0]?.processId ?? 0;
  }

  readonly terminate: ProcessTreeTerminator = (processId, signal) => {
    this.#requests.push({ processId, signal });
    if (signal === "SIGKILL" && this.#refusalsRemaining > 0) {
      this.#refusalsRemaining -= 1;
      return false;
    }
    return terminateProcessTree(processId, signal);
  };
}

/** What a registrar that refuses registration throws, so a case can name it. */
export const REGISTRAR_REFUSAL_MESSAGE = "onTestFinished() can only be called inside a test";

/**
 * A registrar that refuses, the way `onTestFinished` refuses outside a test.
 *
 * The misuse this stands in for is a spawn from `beforeAll`: legal-looking
 * code, a real child, and a registrar that throws AFTER the child exists.
 * Vitest cannot produce it from inside a running test — the same reason the
 * refusing terminator above is injected rather than provoked.
 */
export class RefusingSettleRegistrar {
  #registrationAttempts = 0;

  get registrationAttempts(): number {
    return this.#registrationAttempts;
  }

  readonly register: SettleTimeRegistrar = () => {
    this.#registrationAttempts += 1;
    throw new Error(REGISTRAR_REFUSAL_MESSAGE);
  };
}
