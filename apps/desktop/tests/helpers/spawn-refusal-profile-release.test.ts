// A temporary profile exists before its child does, so a spawn that throws in between (the
// settle-time registrar refuses, as `onTestFinished` does outside a running test) must still
// remove it. `spawnChildCleanedUpAtSettleTime` owns that ordering; these cases prove it releases
// and rethrows and that the spawn-then-register shape does not. Doubles come from
// `electron-child-doubles.test-support.ts`, child programs from
// `electron-child-lifetime.test-support.ts`, bounded readings from
// `electron-child-liveness.test-support.ts`.

import { existsSync, rmSync } from "node:fs";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnChildCleanedUpAtSettleTime } from "./electron-child-cleanup.js";
import {
  disposeWhenTestFinishes,
  spawnManagedElectronChild,
  type ElectronChildSpawnOptions,
} from "./electron-child.js";
import {
  heldProfile,
  ObservedTreeTerminator,
  RefusingSettleRegistrar,
  REGISTRAR_REFUSAL_MESSAGE,
} from "./electron-child-doubles.test-support.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
} from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

/** The spawn options every case here uses: a child that will not exit on its own. */
function nonTerminatingChildOptions(
  registrar: RefusingSettleRegistrar,
  terminator: ObservedTreeTerminator,
): ElectronChildSpawnOptions {
  return {
    command: process.execPath,
    args: ["-e", NON_TERMINATING_PROGRAM],
    cwd: process.cwd(),
    env: process.env,
    registerSettleTimeTermination: registrar.register,
    terminateProcessTree: terminator.terminate,
  };
}

describe("a spawn that refuses releases what it was already holding", () => {
  it(
    "removes the profile and rethrows when the settle-time registration refuses",
    async () => {
      // The directory exists before the spawn and the registrar throws after it, so without the
      // guard the profile stays on disk with no handle naming it.
      const registrar = new RefusingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const profile = heldProfile();

      try {
        expect(existsSync(profile.directory)).toBe(true);

        expect(() => {
          spawnChildCleanedUpAtSettleTime(
            nonTerminatingChildOptions(registrar, terminator),
            profile.removeProfileDirectory,
          );
        }, "the refusal was swallowed — a caller that spawned from `beforeAll` is told nothing").toThrow(
          REGISTRAR_REFUSAL_MESSAGE,
        );

        expect(
          existsSync(profile.directory),
          "the profile outlived the refusal — the removal is still reachable only from a registration the refusal skipped",
        ).toBe(false);
        expect(profile.removalCount()).toBe(1);
        // The spawner's own kill recovery: removing the directory while the child kept running
        // would trade one leak for a worse one.
        await expectTerminatedWithin(
          terminator.firstRequestedPid,
          "the child whose registration refused",
        );
      } finally {
        reap(terminator.firstRequestedPid);
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: spawning first and registering the removal after leaves the profile behind",
    async () => {
      // The shape a spawner could spell: spawn, then register the removal. The second step
      // never runs once the first throws, so the case above tests the guard and not an incidental
      // `rmSync`.
      const registrar = new RefusingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const profile = heldProfile();

      try {
        expect(() => {
          const managed = spawnManagedElectronChild(
            nonTerminatingChildOptions(registrar, terminator),
          );
          disposeWhenTestFinishes(() => {
            managed.dispose();
            profile.removeProfileDirectory();
          }, registrar.register);
        }).toThrow(REGISTRAR_REFUSAL_MESSAGE);

        expect(
          existsSync(profile.directory),
          "the profile came off disk without the guard — the control no longer reproduces the leak",
        ).toBe(true);
        expect(profile.removalCount()).toBe(0);
        await expectTerminatedWithin(
          terminator.firstRequestedPid,
          "the child the control abandoned",
        );
      } finally {
        reap(terminator.firstRequestedPid);
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
