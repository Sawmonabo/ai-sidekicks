// The collaborators the spawner is given, each recording what it was asked.
//
// `electron-child-lifetime.test-support.ts` causes lifetimes with real child programs and a real
// grandchild; this file holds what the spawn is handed: the settle-time registrar, the tree
// terminator and the profile remover. None starts a process or asserts a lifetime rule; each lets
// a case read back what the module under test did with it, or make it refuse on demand.
//
// As a `.test-support` module its only legitimate dependents are the suites beside it and the
// spawn scaffolding, enforced by `test-support-has-no-shipping-reader` in
// `.dependency-cruiser.mjs`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

import type { SettleTimeDisposer, SettleTimeRegistrar } from "./electron-child.js";
import type { ProcessTreeTerminator } from "./managed-electron-child.js";
import { terminateProcessTree } from "./process-tree/termination.js";

/** A profile directory and the one function that takes it off disk, as a harness holds them. */
export interface HeldProfile {
  readonly directory: string;
  /** How many times the remover has been called. */
  readonly removalCount: () => number;
  /** The one remover, as both spawners spell it: best-effort and forced. */
  readonly removeProfileDirectory: () => void;
}

/**
 * A temporary profile plus the remover a harness reaches from every path.
 *
 * Written once so the count that proves one function serves every path is meaningful.
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
        // Best-effort, as both spawners are.
      }
    },
  };
}

/**
 * A registrar that records the disposer and also hands it to the runner.
 *
 * `settle()` stands in for a test ending by passing, failing or being killed at vitest's timeout;
 * all three run `onTestFinished` callbacks. The runner still owns the kill: with the recorder as
 * the only registrar, a setup that never returned would leave a detached child with nothing that
 * intended to kill it, the leak the mechanism exists to close.
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
   * Runs what was registered in reverse registration order, as `onTestFinished` does.
   *
   * Registration order would hide the teardown-ordering defect: the spawner's disposer would run
   * first, so a caller's later registration could never be seen removing a resource ahead of a
   * kill the runner issues after it.
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
 * One class for both roles: learning which pid was asked, and denying on demand. A refusal is the
 * case no platform produces on request: a `taskkill` that exits non-zero and leaves a live tree.
 * Once the refusals are used up the call delegates to the real terminator, so the retry actually
 * kills something and nothing is left running.
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
   * The pid of the first tree this terminator was asked about, or `0` when nothing was asked.
   *
   * `0` rather than `undefined`, as `AbandonedPair` does: `reap` refuses it, so an unrecorded pid
   * is never signaled (on POSIX `0` addresses the caller's own process group).
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
 * Stands in for a spawn from `beforeAll`: a real child, then a registrar that throws after it
 * exists. Vitest cannot produce that from inside a running test.
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
