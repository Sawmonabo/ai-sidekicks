// The resource a spawn was holding BEFORE it had a child, and who releases it.
//
// `electron-child-profile-removal.test.ts` next door asks which paths release a
// profile once a child exists. This file asks the question one moment earlier,
// and the answer used to be "nobody": the temporary Chromium profile is created
// before the spawn — its path is a spawn argument — so between `mkdtempSync` and
// a settled spawn there is a directory on disk that only this process knows
// about, and `spawnManagedElectronChild` can THROW in that window.
//
// THE WINDOW IS NOT HYPOTHETICAL. The throw is the registrar refusing, which is
// what `onTestFinished` does outside a running test — a spawn from `beforeAll`,
// the misuse the spawn door's own header names. Both of this package's Electron
// spawners wrote the same two lines in the same order, spawn and then register
// the removal, and both had the identical hole: the refusal propagated out of
// the promise executor, the removal was registered from nowhere, and the profile
// stayed on disk for the rest of the run. The kill was already covered — the
// spawn door disposes the child before it rethrows — so what survived was the
// directory alone, which is exactly the leak that is invisible until a run has
// accumulated a few dozen of them.
//
// So the ordering is owned once, by `spawnChildCleanedUpAtSettleTime`, and this
// file makes that a property in both directions: the door releases and rethrows,
// the superseded shape does not, and both spawners are on the door.
//
// The stand-ins are `electron-child-lifetime.test-support.ts`'s and the bounded
// readings are `electron-child-liveness.test-support.ts`'s, for their reasons.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cleanUpAfterChildAtSettleTime,
  spawnChildCleanedUpAtSettleTime,
} from "../../helpers/electron-child-cleanup.js";
import {
  spawnManagedElectronChild,
  type ElectronChildSpawnOptions,
} from "../../helpers/electron-child.js";
import {
  heldProfile,
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
  ObservedTreeTerminator,
  REGISTRAR_REFUSAL_MESSAGE,
  RefusingSettleRegistrar,
} from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(HERE, "..", "..");

/** The one door that owns spawn-and-release, relative to `test/`. */
const SPAWN_AND_RELEASE_DOOR = path.join("helpers", "electron-child-cleanup.ts");

/** The two spawners held to it, relative to `test/`. */
const PROFILE_HOLDING_SPAWNERS: readonly string[] = [
  path.join("helpers", "electron-probe.ts"),
  path.join("helpers", "gc-probe.ts"),
];

/** The call a spawner makes, and the one it must no longer make itself. */
const DOOR_CALL = "spawnChildCleanedUpAtSettleTime(";
const UNGUARDED_CALL = "spawnManagedElectronChild(";

function readTestSource(relativePath: string): string {
  return readFileSync(path.join(TEST_ROOT, relativePath), "utf8");
}

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
      // THE FINDING. The directory exists before the spawn does, the registrar
      // throws after it, and the caller's own registration of the removal is
      // never reached — so without the guard the refusal arrives with a profile
      // left on disk and no handle anywhere that names it.
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
        // The kill is the spawn door's own recovery and is asserted here too:
        // a guard that removed the directory while leaving the child running
        // would have traded one leak for the worse one.
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
      // THE SUPERSEDED SHAPE, written out as both spawners used to spell it: the
      // spawn on one line and `cleanUpAfterChildAtSettleTime` on the next. The
      // second line is unreachable code the moment the first one throws, which is
      // what makes the case above a property of the door rather than of `rmSync`
      // happening to run somewhere.
      const registrar = new RefusingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const profile = heldProfile();

      try {
        expect(() => {
          const managed = spawnManagedElectronChild(
            nonTerminatingChildOptions(registrar, terminator),
          );
          cleanUpAfterChildAtSettleTime(
            managed,
            profile.removeProfileDirectory,
            registrar.register,
          );
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

  it("holds both profile-holding spawners to the one door", () => {
    // The behavioural cases above prove the door is right; this proves both
    // spawners are on it. Asked of the source text because the alternative is
    // driving a real Electron spawn from a `beforeAll` — the one context in which
    // the refusal happens and the one in which no assertion can run.
    for (const spawner of PROFILE_HOLDING_SPAWNERS) {
      const source = readTestSource(spawner);
      expect(
        source.includes(DOOR_CALL),
        `${spawner} no longer spawns through the door that releases its profile on a refused registration`,
      ).toBe(true);
      expect(
        source.includes(UNGUARDED_CALL),
        `${spawner} spawns directly again — a refused registration leaves its temporary profile on disk`,
      ).toBe(false);
    }
    // Non-vacuity for the negative half: the spelling it looks for is a real one
    // that a module in this package does write, so `false` above means absence
    // rather than a needle that could never match.
    expect(readTestSource(SPAWN_AND_RELEASE_DOOR).includes(UNGUARDED_CALL)).toBe(true);
  });
});
