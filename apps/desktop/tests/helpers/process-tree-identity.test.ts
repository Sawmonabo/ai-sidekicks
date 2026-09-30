// A pid is a name, and the operating system hands it back out.
//
// Split from `process-tree.test.ts`, which asks what a pid is doing (does it name anything, can it
// run) over one moment. This asks whether the pid still names the same process across two
// moments: the launcher shim exits early and is reaped, so the number a tree is addressed through
// can belong to somebody else by disposal time.
//
// The same question applies to every descendant. The captured set is what a rootless tree is
// addressed by once its root pid is gone, so a list of bare numbers would hand the arm a stranger
// to kill. Each member carries the stamp it was captured with, and `verifyCapturedMembers` spends
// that pair.
//
// Pid reuse is the kernel's bookkeeping: a test can neither ask for a number back nor wait out a
// wrap of the pid space. So the stamp reading is injected, and the real platform arm is checked in
// `process-tree-readers.test.ts` against pids whose answers are known.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type ProcessTableRow } from "./process-tree/readers.js";
import { verifyCapturedMembers, type CapturedTreeMember } from "./process-tree/start-stamps.js";
import {
  CAPTURED_CHILD_PID,
  CAPTURED_ROOT_PID,
  CAPTURED_TREE_TABLE,
  CHILD_STAMP,
  ScriptedStartStamps,
} from "./process-tree-identity.test-support.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** A child of whoever holds the root's number after the reissue. */
const IMPOSTOR_CHILD_PID = 4244;

const REISSUED_ROOT_TABLE = processTableOf([[IMPOSTOR_CHILD_PID, CAPTURED_ROOT_PID, "impostor"]]);

describe("process termination — a pid is a NAME, and the operating system reissues it", () => {
  it("captures the root's stamp at construction rather than at the kill", () => {
    // The property the fix rests on: a capture taken when the kill is issued compares the pid
    // against itself an instant later and answers `same` for every pid, a check that cannot
    // fail. So the construction read is asserted as a moment, not only a value.
    const stamps = new ScriptedStartStamps(["stamp-at-spawn", "stamp-at-spawn"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => CAPTURED_TREE_TABLE,
      () => true,
    );

    expect(
      stamps.reads,
      "no stamp was taken at construction — the capture is being deferred to the kill, where it verifies nothing",
    ).toStrictEqual([CAPTURED_ROOT_PID]);
    expect(identity.readIdentity()).toBe("same");
    expect(stamps.reads).toStrictEqual([CAPTURED_ROOT_PID, CAPTURED_ROOT_PID]);
    // With the stamp the same listing reported, which makes the set addressable after the root is
    // gone instead of a list of bare numbers.
    expect(identity.capturedDescendants).toStrictEqual([
      { processId: CAPTURED_CHILD_PID, startStamp: CHILD_STAMP },
    ]);
  });

  it("reads a reissued pid as recycled, and keeps the capture taken while it was ours", () => {
    // Between the two readings the root exited, was reaped and its number went to somebody else,
    // so the table now hangs the stranger's child off that pid. Refreshing there would hand the
    // termination arm a pid this package never started.
    let table: ReadonlyMap<number, ProcessTableRow> = CAPTURED_TREE_TABLE;
    const stamps = new ScriptedStartStamps(["stamp-at-spawn", "stamp-at-spawn", "somebody-else"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => table,
      () => true,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(identity.capturedDescendants).toStrictEqual([
      { processId: CAPTURED_CHILD_PID, startStamp: CHILD_STAMP },
    ]);

    table = REISSUED_ROOT_TABLE;

    expect(identity.readIdentity()).toBe("recycled");
    expect(
      identity.capturedDescendants,
      "the capture was refreshed under a reissued pid — the arm is being handed a stranger's child to kill",
    ).toStrictEqual([{ processId: CAPTURED_CHILD_PID, startStamp: CHILD_STAMP }]);
  });

  it("reads a pid that names nothing as gone, without asking for a stamp at all", () => {
    // Existence decides this and the stamp is never consulted: a stamp that could not be read on a
    // live process is an unreadable probe, and answering `gone` would skip the one walk that
    // reaches the tree. The script is one answer long, so a reading that asked anyway throws.
    const stamps = new ScriptedStartStamps(["stamp-at-spawn"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => CAPTURED_TREE_TABLE,
      () => false,
    );

    expect(identity.readIdentity()).toBe("gone");
    expect(stamps.reads).toStrictEqual([CAPTURED_ROOT_PID]);
  });

  it("degrades to the pre-identity reading when no stamp can be read, and captures nothing there", () => {
    // The failure direction on a host whose stamp probe does not work: refusing every kill would
    // leak every tree there, a larger failure than the one this closes. It must not spend a
    // process-table read per attempt building a capture only the reissued-root arm consumes,
    // which it can never reach.
    let processTableReads = 0;
    const stamps = new ScriptedStartStamps([undefined, undefined]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => {
        processTableReads += 1;
        return CAPTURED_TREE_TABLE;
      },
      () => true,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(
      processTableReads,
      "an unverifiable identity captured a descendant set nothing can ever consume",
    ).toBe(0);
    expect(identity.capturedDescendants).toStrictEqual([]);
  });

  it("negative control: an unverified tree asks the platform for no stamp and reads `same`", () => {
    // The degradation `terminateProcessTree` defaults to, driven. It guards the cases above
    // against a reading that always compares stamps, which would leave every caller with no spawn
    // moment, such as `BoundedCleanup` handed a pid by Playwright, unable to kill anything.
    expect(SpawnedTreeIdentity.unverified(process.pid).readIdentity()).toBe("same");
    expect(SpawnedTreeIdentity.unverified(process.pid).capturedDescendants).toStrictEqual([]);

    // And it still reads `gone` for a pid that names nothing, which decides whether the rootless
    // walk is reached. `spawnSync` returns once its child is gone, so its pid certainly ran and is
    // not running.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(SpawnedTreeIdentity.unverified(reaped.pid).readIdentity()).toBe("gone");
  });
});

describe("process termination — a captured descendant is a pair, not a pid", () => {
  // The captured set is the only handle a rootless tree has, and two arms of
  // `terminateExternalTree` spend it that cannot both be reached in one case. The rule they
  // share, refuse on a stamp that disagrees and never on one that is missing, is checked once
  // here.

  const capturedChild: CapturedTreeMember = {
    processId: CAPTURED_CHILD_PID,
    startStamp: CHILD_STAMP,
  };

  it("keeps a member the table still lists under the stamp it was captured with", () => {
    expect(verifyCapturedMembers([capturedChild], CAPTURED_TREE_TABLE)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("drops a member whose pid the table now lists under a different stamp", () => {
    // The second reissue, which a fix stopping at the root would miss: the descendant exited, was
    // reaped, and its number went to somebody else, so a pid-only capture would hand `taskkill` a
    // process this package never spawned while the root's identity check reports nothing wrong.
    expect(
      verifyCapturedMembers(
        [capturedChild],
        processTableOf([[CAPTURED_CHILD_PID, 1, "somebody-else"]]),
      ),
      "a captured pid the table convicts of being somebody else was still admitted for a kill",
    ).toStrictEqual([]);
  });

  it("keeps a member the table does not list at all, because absence convicts nobody", () => {
    // The failure direction, opposite to the case above on purpose. A missing row is the ordinary
    // shape of a descendant that already exited (the caller's liveness reading filters it), and an
    // empty listing is a failed read. Reading either as "somebody else now" would disarm the
    // rootless arm on exactly the host whose readings do not work.
    expect(verifyCapturedMembers([capturedChild], processTableOf([]))).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("keeps a member captured under no stamp, and one the table lists under none", () => {
    // The two halves of the root's degradation: a comparison needs both sides, and a side never
    // read is not evidence of a reissue.
    expect(
      verifyCapturedMembers(
        [{ processId: CAPTURED_CHILD_PID, startStamp: undefined }],
        processTableOf([[CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, "listed-under-something"]]),
      ),
    ).toStrictEqual([CAPTURED_CHILD_PID]);
    expect(
      verifyCapturedMembers(
        [capturedChild],
        processTableOf([[CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, undefined]]),
      ),
    ).toStrictEqual([CAPTURED_CHILD_PID]);
  });
});
