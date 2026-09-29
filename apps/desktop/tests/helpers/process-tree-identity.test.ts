// A pid is a NAME, and the operating system hands it back out.
//
// Split from `process-tree.test.ts` beside it because it is a different subject
// with a different instrument. That file asks what a pid is DOING — does it name
// anything, is what it names still able to run — and answers with probes over one
// moment. This one asks whether the pid still names the same PROCESS across two
// moments, which is the question every reading over there quietly assumed an
// answer to: the launcher shim exits early and is reaped, so the number a tree is
// addressed through can belong to somebody else by the time a disposal runs.
//
// AND THE SAME QUESTION IS ASKED OF EVERY DESCENDANT. The captured set is what a
// rootless tree is addressed by once its root pid is gone, so a capture that is
// only a list of numbers hands the arm a stranger to kill one indirection along —
// the same defect as signalling a reissued root. Each member therefore carries
// the stamp it was captured with, and `verifyCapturedMembers` is where that pair
// is spent.
//
// WHAT CANNOT BE PROVOKED. Pid reuse is the kernel's own bookkeeping — a test can
// neither ask for a number back nor wait out a wrap of the pid space — so the
// stamp reading is injected here, and the real platform arm is checked in
// `process-tree-readers.test.ts` against the pids whose answers are already known.

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
  // WHY THIS IS SCRIPTED AND NOT PROVOKED. The state under test is a pid whose
  // holder CHANGED between two moments, and pid reuse is the kernel's own
  // bookkeeping: a test cannot ask for the number back, and waiting for a wrap
  // around the pid space is not a test. So the stamp reading is injected and the
  // real platform arm is checked separately, against the two pids whose answers
  // are already known — this process, and one that has certainly exited.

  it("captures the root's stamp at construction rather than at the kill", () => {
    // THE PROPERTY THE WHOLE FIX RESTS ON. A capture taken when the kill is
    // issued compares the pid against itself an instant later and answers `same`
    // for every pid on the host — a check that cannot fail wearing the shape of
    // one that can. The construction read is what makes the later comparison
    // mean anything, so it is asserted as a MOMENT and not only as a value.
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
    // WITH THE STAMP THE SAME LISTING REPORTED, which is what makes the set
    // addressable after the root is gone rather than a list of bare numbers.
    expect(identity.capturedDescendants).toStrictEqual([
      { processId: CAPTURED_CHILD_PID, startStamp: CHILD_STAMP },
    ]);
  });

  it("reads a reissued pid as recycled, and keeps the capture taken while it was ours", () => {
    // THE FINDING. Between the two readings the root exited, was reaped, and its
    // number went to somebody else — so the process table now hangs the
    // STRANGER's child off that pid. A capture refreshed there would hand the
    // termination arm a pid to kill that this package never started, which is
    // the same defect as signalling the root, one indirection along.
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
    // Existence decides this one and the stamp is never consulted, which is the
    // ORDER rather than an economy: a stamp that could not be read on a live
    // process is an unreadable probe, and answering `gone` to that would skip the
    // one walk that reaches the tree. The script is one answer long, so a reading
    // that asked anyway throws instead of passing quietly.
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
    // The honest failure direction on a host whose stamp probe does not work.
    // Refusing every kill there would leak every tree on that host, which is a
    // larger failure than the one this reading closes — and detection is
    // impossible by construction rather than by choice. What it must NOT do is
    // spend a process-table read per attempt building a capture that the
    // reissued-root arm, which it can never reach, is the only consumer of.
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
    // The named degradation `terminateProcessTree` defaults to, driven rather
    // than described. Without this the cases above are ambiguous between "the
    // reading compares stamps" and "the reading always compares stamps", and the
    // second would make every caller that holds no spawn moment — `BoundedCleanup`,
    // handed a pid by Playwright — unable to kill anything at all.
    expect(SpawnedTreeIdentity.unverified(process.pid).readIdentity()).toBe("same");
    expect(SpawnedTreeIdentity.unverified(process.pid).capturedDescendants).toStrictEqual([]);

    // And it still reads `gone` for a pid that names nothing, which is the arm
    // that decides whether the rootless walk is even reached. `spawnSync` returns
    // only once its child is gone, so its pid names a process that certainly ran
    // and certainly is not running.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(SpawnedTreeIdentity.unverified(reaped.pid).readIdentity()).toBe("gone");
  });
});

describe("process termination — a captured descendant is a pair, not a pid", () => {
  // WHY VERIFICATION IS ITS OWN FUNCTION. The captured set is the only handle a
  // rootless tree has, and it is spent by two arms of `terminateExternalTree`
  // that cannot both be reached in one case. The rule they share — refuse on a
  // stamp that DISAGREES, never on one that is missing — is therefore checked
  // once, here, against the table shapes each arm is handed.

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
    // THE SECOND REISSUE, and the one a fix that stopped at the root would miss.
    // The descendant exited, was reaped, and its number went to somebody else —
    // so a capture that carried only the pid would hand `taskkill` a process
    // this package never spawned, with the root's own identity check reporting
    // nothing wrong because the root is not what moved.
    expect(
      verifyCapturedMembers(
        [capturedChild],
        processTableOf([[CAPTURED_CHILD_PID, 1, "somebody-else"]]),
      ),
      "a captured pid the table convicts of being somebody else was still admitted for a kill",
    ).toStrictEqual([]);
  });

  it("keeps a member the table does not list at all, because absence convicts nobody", () => {
    // THE FAILURE DIRECTION, and it is the opposite of the case above on purpose.
    // A row missing from the listing is the ordinary shape of a descendant that
    // has already exited — the caller's own liveness reading filters that one
    // before anything is signalled — and an EMPTY listing is a read that failed.
    // Reading either as "this member is somebody else now" would disarm the
    // rootless arm on exactly the host whose readings do not work.
    expect(verifyCapturedMembers([capturedChild], processTableOf([]))).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("keeps a member captured under no stamp, and one the table lists under none", () => {
    // The two halves of the same degradation the root takes: a comparison needs
    // both sides, and a side that was never read is not evidence of a reissue.
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
