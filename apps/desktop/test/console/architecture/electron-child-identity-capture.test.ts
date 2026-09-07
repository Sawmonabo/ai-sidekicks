// WHEN a spawned tree's identity is taken, which is a different claim from what
// it says.
//
// `process-tree-identity.test.ts` beside this one owns the reading: what `same`,
// `gone` and `recycled` mean, and which captured members survive a stamp
// comparison. Both of its subjects are answered over inputs handed straight to
// `SpawnedTreeIdentity`, which is the right instrument for a rule and the wrong
// one for an ORDER — a capture that is never taken and a capture that is taken
// too late both read exactly like a tree with nothing under it.
//
// So this file drives the two moments through the real spawn door instead, and
// both of them are moments the round-4 design left to whoever happened to ask:
//
//   • THE CAPTURE HAS TO BE REFRESHED WHILE THE ROOT IS ALIVE. A descendant set
//     cannot be taken at the spawn — nothing has been started yet — and
//     `SpawnedTreeIdentity` otherwise refreshes it only on a VERIFIED reading.
//     On the shape the whole mechanism exists for, no such reading is ever
//     taken: the launcher exits while a descendant keeps the inherited stdout,
//     and the first question anybody asks is the disposal's, by which time the
//     root reads `gone` and the rootless arm is handed an empty kill list. The
//     child's own `exit` is the last moment the tree is addressable through its
//     root, so that is where the set is recorded.
//
//   • THE HOST QUERY HAS TO COME AFTER OWNERSHIP. Taking the identity spawns
//     `ps` or PowerShell and BLOCKS until it answers. Performed inside the
//     constructor it sat between the spawn and the settle-time registration —
//     a window in which a detached process is running and nothing anywhere has
//     been registered to kill it. A query that throws leaves that state at once;
//     one that stalls leaves it while blocking the very thread vitest's own
//     timeout runs on, so the worker is torn down with the tree still alive.
//
// THE CAPTURED SET IS SCRIPTED AND THE OWNERSHIP IS REAL, and each for its own
// reason. What was captured cannot be asserted against this host: POSIX
// reparents a descendant the instant its parent is reaped, so the table read at
// `exit` is a race rather than a fixture, and a case that asserted on it would
// be flaky on the platform the suite runs on. Who owns the child is not a
// reading at all — it is which call happened first — so that case spawns for
// real and asks the registrar.

import { once } from "node:events";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnManagedElectronChild } from "../../helpers/electron-child.js";
import { SpawnedTreeIdentity } from "../../helpers/process-tree/identity.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
  spawnChildWithGrandchild,
} from "./electron-child-lifetime.test-support.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** A pid no host will hand out, so a match is the scripted row and never a real one. */
const SCRIPTED_DESCENDANT_PID = 991_001;

/** Written the way `ps -o lstart=` emits it, double space and all. */
const SCRIPTED_DESCENDANT_STAMP = "Sun Sep  7 02:25:10 2026";

/** What a failing host query throws, so the case can name the one it expects. */
const PROBE_FAILURE_MESSAGE = "this host would not answer";

describe("a spawned tree's identity — captured while the root is still alive", () => {
  it(
    "records the tree at the root's own exit, so the rootless arm has a kill list",
    async () => {
      // THE FINDING, driven end to end. This child exits on purpose while its
      // grandchild keeps the inherited stdout — the Electron shim exactly — and
      // nothing between the spawn and the disposal asks this identity anything.
      // Before the `exit` capture, the set the rootless arm is handed here was
      // empty, so every attempt refused and the descendant outlived the run.
      const registrar = new RecordingSettleRegistrar();
      const pair = await spawnChildWithGrandchild(registrar, {
        exitHoldingStdio: true,
        captureRootIdentity: (processId) =>
          new SpawnedTreeIdentity(
            processId,
            () => "the-root-stamp",
            () => processTableOf([[SCRIPTED_DESCENDANT_PID, processId, SCRIPTED_DESCENDANT_STAMP]]),
          ),
      });

      // `exitCode` is set by the same delivery that runs the capture, so reading
      // it first is what keeps this from awaiting an event that already fired.
      if (pair.managed.child.exitCode === null) {
        await once(pair.managed.child, "exit");
      }

      expect(
        pair.managed.capturedTreeMembers,
        "the root exited with a descendant under it and nothing was captured — the rootless arm has no kill list",
      ).toStrictEqual([
        { processId: SCRIPTED_DESCENDANT_PID, startStamp: SCRIPTED_DESCENDANT_STAMP },
      ]);
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it("owns the child before it asks this host anything", async () => {
    // The ordering claim, and the only way to make a host query fail on demand.
    // With the capture inside the constructor this threw before the registrar
    // was ever reached: nothing was registered, the caller received no handle,
    // and a detached child was left running with nothing that could name it.
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

    // The query ran — so the spawn really did reach it — and the registration
    // that ran BEFORE it is what the next line is about.
    expect(rootProcessId).toBeGreaterThan(0);
    expect(
      registrar.registeredCount,
      "the host query ran before the settle-time registration — a detached child with no kill path",
    ).toBe(1);

    await registrar.settle();
    expect(terminator.requests).toStrictEqual([{ processId: rootProcessId, signal: "SIGKILL" }]);
  });
});
