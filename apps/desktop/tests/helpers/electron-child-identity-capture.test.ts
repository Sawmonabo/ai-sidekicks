// When a spawned tree's identity is taken, which is a different claim from what it says.
//
// `process-tree-identity.test.ts` owns the reading (`same`, `gone`, `recycled`) and
// `process-tree-capture.test.ts` owns what a capture may contain. Both answer over inputs handed
// straight to `SpawnedTreeIdentity`, the wrong instrument for an order: a capture never taken and
// one taken too late both read like a tree with nothing under it. So this file drives the moments
// through the real spawner:
//
//   • The set is recorded while the root is still held. A descendant set cannot be taken at the
//     spawn, and `SpawnedTreeIdentity` otherwise refreshes it only on a verified reading, which on
//     the shape this exists for is never taken: the launcher exits while a descendant keeps the
//     inherited stdout. `captureTreeDescendants` is sound because the owner has not been told its
//     child exited, so Node still holds the handle and the number is still this tree's.
//   • The root's exit may only remove. By then the child is reaped and its number may be
//     reissued, so a listing taken there can carry rows a new holder fathered; the exit
//     intersects and never records.
//   • The host query comes after ownership. Taking the identity spawns `ps` or PowerShell and
//     blocks, so inside the constructor it sat between the spawn and the settle-time registration
//     with a detached process running and nothing registered to kill it.
//
// The table is scripted because POSIX reparents a descendant the instant its parent is reaped, so
// a real table read at `exit` is a race. Ownership is real because it is which call came first.

import { once } from "node:events";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnManagedElectronChild } from "./electron-child.js";
import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type ProcessTableRow } from "./process-tree/readers.js";
import {
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-doubles.test-support.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
  spawnChildWithGrandchild,
} from "./electron-child-lifetime.test-support.js";
import { reap } from "./electron-child-liveness.test-support.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** Pids no host will hand out, so a match is a scripted row and never a real one. */
const SCRIPTED_DESCENDANT_PID = 991_001;
const REUSED_NUMBERS_NEW_CHILD_PID = 991_002;

/** Written the way `ps -o lstart=` emits it, double space and all. */
const SCRIPTED_DESCENDANT_STAMP = "Sun Sep  7 02:25:10 2026";

/** A stamp from after the root exited, which is what makes the row admissible. */
const AFTER_THE_EXIT_STAMP = "Sun Sep  7 02:31:44 2026";

/** What a failing host query throws, so the case can name the one it expects. */
const PROBE_FAILURE_MESSAGE = "this host would not answer";

/**
 * The listings one spawned tree's readings are answered from, in order.
 *
 * A class rather than a shifting array because the last table stands for every later reading, so
 * "not read" and "out of scripted answers" stay distinguishable.
 */
class ScriptedListings {
  readonly #tables: readonly ReadonlyMap<number, ProcessTableRow>[];
  #reads = 0;

  constructor(...tables: readonly ReadonlyMap<number, ProcessTableRow>[]) {
    this.#tables = tables;
  }

  get reads(): number {
    return this.#reads;
  }

  readonly read = (): ReadonlyMap<number, ProcessTableRow> => {
    const table = this.#tables[Math.min(this.#reads, this.#tables.length - 1)];
    this.#reads += 1;
    return table ?? processTableOf([]);
  };
}

/** One descendant under `rootProcessId`, as the live capture would find it. */
function liveTreeUnder(rootProcessId: number): ReadonlyMap<number, ProcessTableRow> {
  return processTableOf([[SCRIPTED_DESCENDANT_PID, rootProcessId, SCRIPTED_DESCENDANT_STAMP]]);
}

describe("a spawned tree's identity — recorded while the root is still held", () => {
  it(
    "records the tree at the owner's own moment, so the rootless arm has a kill list",
    async () => {
      // First half, end to end through the real spawner. Nothing between the spawn and the
      // disposal asks this identity anything, so without a moment the owner takes itself the
      // rootless arm's set is empty and the descendant outlives the run.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      let listings: ScriptedListings | undefined;
      const pair = await spawnChildWithGrandchild(registrar, {
        terminateProcessTree: terminator.terminate,
        captureRootIdentity: (processId) => {
          listings = new ScriptedListings(liveTreeUnder(processId));
          return new SpawnedTreeIdentity(processId, () => "the-root-stamp", listings.read);
        },
      });

      try {
        expect(
          pair.managed.capturedTreeMembers,
          "a set existed before any listing was read",
        ).toStrictEqual([]);
        expect(listings?.reads, "the spawn read a listing nobody asked it for").toBe(0);

        pair.managed.captureTreeDescendants();

        expect(
          pair.managed.capturedTreeMembers,
          "the owner's live capture recorded nothing while its child was demonstrably running — the rootless arm has no kill list",
        ).toStrictEqual([
          { processId: SCRIPTED_DESCENDANT_PID, startStamp: SCRIPTED_DESCENDANT_STAMP },
        ]);
        // Once: this is a blocking host query, and one per output chunk would spend the enclosing
        // test's whole ceiling many times over (`DESCENDANT_LISTINGS_PER_CHILD`).
        pair.managed.captureTreeDescendants();
        expect(listings?.reads, "a second live capture ran, so the reserve is a fiction").toBe(1);
      } finally {
        reap(pair.grandchildPid);
        reap(pair.childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "admits nothing at the root's exit that the live capture did not already name",
    async () => {
      // Second half. The exit-time listing is what a reissued number produces: the real
      // descendant plus a row the number's new holder fathered after the root was reaped. Its
      // parent pid and stamp pass the ancestry proof, so if recorded it would be handed to
      // `taskkill /t` as this tree's.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      let listings: ScriptedListings | undefined;
      const pair = await spawnChildWithGrandchild(registrar, {
        terminateProcessTree: terminator.terminate,
        captureRootIdentity: (processId) => {
          listings = new ScriptedListings(
            liveTreeUnder(processId),
            processTableOf([
              [SCRIPTED_DESCENDANT_PID, processId, SCRIPTED_DESCENDANT_STAMP],
              [REUSED_NUMBERS_NEW_CHILD_PID, processId, AFTER_THE_EXIT_STAMP],
            ]),
          );
          return new SpawnedTreeIdentity(processId, () => "the-root-stamp", listings.read);
        },
      });

      try {
        pair.managed.captureTreeDescendants();
        pair.managed.child.kill("SIGKILL");
        if (pair.managed.child.exitCode === null && pair.managed.child.signalCode === null) {
          await once(pair.managed.child, "exit");
        }

        expect(
          pair.managed.capturedTreeMembers.map((member) => member.processId),
          "the exit-time reading recorded a process the reused number's new holder started — the rootless kill list now addresses a tree this package never spawned",
        ).toStrictEqual([SCRIPTED_DESCENDANT_PID]);
        expect(listings?.reads, "the exit narrowed against a reading it never took").toBe(2);

        // The owner's evidence is the gate: a capture asked for after the child reported its exit
        // is refused, since the number may be somebody else's.
        pair.managed.captureTreeDescendants();
        expect(listings?.reads, "a capture ran after the root's exit had been delivered").toBe(2);
      } finally {
        reap(pair.grandchildPid);
        reap(pair.childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it("owns the child before it asks this host anything", async () => {
    // Ordering claim, and the only way to make a host query fail on demand. With the capture
    // inside the constructor this threw before the registrar was reached: nothing registered, no
    // handle returned, and a detached child left running.
    const registrar = new RecordingSettleRegistrar();
    const terminator = new ObservedTreeTerminator();
    let rootProcessId = 0;

    expect(() =>
      spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        captureRootIdentity: (processId) => {
          rootProcessId = processId;
          throw new Error(PROBE_FAILURE_MESSAGE);
        },
      }),
    ).toThrow(PROBE_FAILURE_MESSAGE);

    // The query ran, so the spawn reached it; the registration before it is what the next line
    // checks.
    expect(rootProcessId).toBeGreaterThan(0);
    expect(
      registrar.registeredCount,
      "the host query ran before the settle-time registration — a detached child with no kill path",
    ).toBe(1);

    await registrar.settle();
    expect(terminator.requests).toStrictEqual([{ processId: rootProcessId, signal: "SIGKILL" }]);
  });
});
